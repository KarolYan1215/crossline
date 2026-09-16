import { describe, expect, test } from "vitest";
import {
  ContentOpsConnector,
  graphAuthority,
  MicrosoftGraphConnector,
  connectorWritePolicy,
  graphCacheConfiguration,
  longbridgeToolAllowed,
  reconcileExternalItems
} from "./index";

describe("connector reconciliation", () => {
  test("deduplicates exact provider identifiers but preserves fuzzy matches", () => {
    const result = reconcileExternalItems([
      { provider: "google", externalId: "g-1", iCalUid: "event-1", title: "Group meeting", start: "2026-09-15T15:00:00Z" },
      { provider: "outlook", externalId: "o-1", iCalUid: "event-1", title: "Group meeting", start: "2026-09-15T15:00:00Z" },
      { provider: "outlook", externalId: "o-2", title: "Group Meeting", start: "2026-09-15T15:05:00Z" }
    ]);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.sources).toHaveLength(2);
    expect(result.fuzzyGroups).toEqual([["event-1", "outlook:o-2"]]);
  });

  test("surfaces divergent versions as a conflict", () => {
    const result = reconcileExternalItems([
      { provider: "todo", externalId: "t-1", title: "Read paper", etag: "v1" },
      { provider: "todo", externalId: "t-1", title: "Read revised paper", etag: "v2" }
    ]);
    expect(result.conflicts).toContainEqual({
      code: "SOURCE_VERSION_CONFLICT",
      externalKey: "todo:t-1",
      versions: ["v1", "v2"]
    });
  });

  test("only personal Crossline Graph targets can write", () => {
    expect(connectorWritePolicy("personal_graph", "calendar:Crossline")).toBe("batch_approval");
    expect(connectorWritePolicy("personal_graph", "todo:Crossline")).toBe("two_way");
    expect(connectorWritePolicy("uw_outlook_plugin", "calendar:default")).toBe("read_only");
    expect(connectorWritePolicy("google_plugin", "calendar:primary")).toBe("read_only");
  });

  test("Longbridge allowlist excludes account and trading tools", () => {
    expect(longbridgeToolAllowed("longbridge_quote")).toBe(true);
    expect(longbridgeToolAllowed("longbridge_financial_report")).toBe(true);
    expect(longbridgeToolAllowed("longbridge_account_balance")).toBe(false);
    expect(longbridgeToolAllowed("longbridge_submit_order")).toBe(false);
  });

  test("content-ops sends idempotent jobs and verifies their real status", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), ...(init ? { init } : {}) });
      return String(input).endsWith("/v1/jobs/job-1")
        ? Response.json({ id: "job-1", status: "completed" })
        : Response.json({ job_id: "job-1" }, { status: 202 });
    };
    const connector = new ContentOpsConnector({ baseUrl: "http://127.0.0.1:8787", token: "secret", fetchImpl });
    const receipt = await connector.push({ kind: "content_job", payload: { kind: "render_video", input: { draftId: "d-1" } } }, "idem-1");
    expect(receipt).toEqual({ provider: "content-ops", externalId: "job-1", status: "accepted" });
    expect(calls[0]).toMatchObject({
      url: "http://127.0.0.1:8787/v1/jobs",
      init: { method: "POST", headers: { authorization: "Bearer secret", "content-type": "application/json", "x-idempotency-key": "idem-1" } }
    });
    expect(await connector.verify(receipt)).toEqual({ verified: true, status: "completed" });
  });

  test("personal Graph fails closed without a native credential", async () => {
    const connector = new MicrosoftGraphConnector({
      credential: { getAccessToken: async () => undefined },
      calendar: { id: "calendar-id", name: "Crossline" },
      todoList: { id: "todo-id", name: "Crossline" }
    });
    await expect(connector.pull()).rejects.toThrow("GRAPH_CREDENTIAL_UNAVAILABLE");
    expect(await connector.health()).toMatchObject({ status: "unavailable", message: "GRAPH_CREDENTIAL_UNAVAILABLE" });
  });

  test("Graph token cache is isolated and forbids plaintext fallback", () => {
    expect(graphCacheConfiguration("C:\\Users\\karol\\AppData\\Local")).toMatchObject({
      cachePath: "C:\\Users\\karol\\AppData\\Local\\Crossline\\auth\\msal-cache.lock",
      serviceName: "Crossline.Graph",
      accountName: "personal-workspace",
      usePlaintextFileOnLinux: false
    });
  });

  test("personal Graph only writes approved Crossline mutations with version checks", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), ...(init ? { init } : {}) });
      return Response.json({ id: "event-1", subject: "Deep work", "@odata.etag": "v2" });
    };
    const connector = new MicrosoftGraphConnector({
      credential: { getAccessToken: async () => "token" },
      calendar: { id: "calendar-id", name: "Crossline" },
      todoList: { id: "todo-id", name: "Crossline" },
      writeEnabled: true,
      fetchImpl
    });
    await expect(connector.push({ kind: "calendar.create", payload: { approved: false, body: {} } }, "command-1"))
      .rejects.toThrow("GRAPH_APPROVAL_REQUIRED");
    await expect(connector.push({ kind: "calendar.update", payload: { approved: true, externalId: "event-1", body: {} } }, "command-2"))
      .rejects.toThrow("GRAPH_ETAG_REQUIRED");

    const receipt = await connector.push({
      kind: "calendar.create",
      payload: { approved: true, body: { subject: "Deep work" } }
    }, "command-3");
    expect(receipt).toEqual({
      provider: "personal_graph",
      externalId: "event-1",
      status: "written",
      target: "calendar:Crossline"
    });
    expect(calls.at(-1)).toMatchObject({
      url: "https://graph.microsoft.com/v1.0/me/calendars/calendar-id/events",
      init: {
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer token", "x-crossline-idempotency-key": "command-3" })
      }
    });
    expect(JSON.parse(String(calls.at(-1)?.init?.body))).toMatchObject({ subject: "Deep work", transactionId: "command-3" });
  });

  test("personal Graph read session cannot write even when a plan is approved", async () => {
    const connector = new MicrosoftGraphConnector({
      credential: { getAccessToken: async () => "read-token" },
      calendar: { id: "calendar-id", name: "Crossline" },
      todoList: { id: "todo-id", name: "Crossline" }
    });
    expect(await connector.probe()).toMatchObject({ read: true, write: false });
    await expect(connector.push({ kind: "calendar.create", payload: { approved: true, body: {} } }, "command-read-only"))
      .rejects.toThrow("GRAPH_WRITE_SCOPE_NOT_ENABLED");
  });

  test("personal Graph cold start requests the configured 90-day/30-day window and preserves delta cursor", async () => {
    const calls: string[] = [];
    const connector = new MicrosoftGraphConnector({
      credential: { getAccessToken: async () => "token" },
      calendar: { id: "calendar-id", name: "Crossline" },
      todoList: { id: "todo-id", name: "Crossline" },
      now: () => new Date("2026-09-13T12:00:00.000Z"),
      fetchImpl: async (input) => {
        calls.push(String(input));
        return Response.json({ value: [], "@odata.deltaLink": "https://graph.microsoft.com/delta-2" });
      }
    });
    const batch = await connector.pull();
    expect(calls[0]).toContain("startDateTime=2026-06-15T12%3A00%3A00.000Z");
    expect(calls[0]).toContain("endDateTime=2026-10-13T12%3A00%3A00.000Z");
    expect(batch.cursor).toBe("https://graph.microsoft.com/delta-2");
  });

  test("personal Graph keeps independent calendar and To Do delta cursors", async () => {
    const connector = new MicrosoftGraphConnector({
      credential: { getAccessToken: async () => "token" },
      calendar: { id: "calendar-id", name: "Crossline" },
      todoList: { id: "todo-id", name: "Crossline" },
      fetchImpl: async (input) => String(input).includes("/todo/")
        ? Response.json({ value: [{ id: "t-1", title: "Review brief", "@odata.etag": "tv1" }], "@odata.deltaLink": "todo-delta" })
        : Response.json({ value: [{ id: "e-1", subject: "Group meeting" }], "@odata.deltaLink": "calendar-delta" })
    });
    const result = await connector.pullAll();
    expect(result.cursors).toEqual({ calendar: "calendar-delta", todo: "todo-delta" });
    expect(result.items).toEqual([
      expect.objectContaining({ provider: "personal_graph", externalId: "e-1" }),
      expect.objectContaining({ provider: "personal_graph_todo", externalId: "t-1", title: "Review brief" })
    ]);
  });
});

test("a single-tenant registration gets its tenant endpoint, because /common is refused for one", () => {
  // Entra answers /common for a single-tenant app with AADSTS50194, which is the case a work or
  // university account is always in.
  expect(graphAuthority("2ca68321-0eda-4908-88b2-424a8cb4b0f9"))
    .toBe("https://login.microsoftonline.com/2ca68321-0eda-4908-88b2-424a8cb4b0f9");
  expect(graphAuthority(undefined)).toBe("https://login.microsoftonline.com/common");
  expect(graphAuthority("  ")).toBe("https://login.microsoftonline.com/common");
  expect(graphAuthority("tenant", "https://login.microsoftonline.com/other")).toBe("https://login.microsoftonline.com/other");
});
