import { describe, expect, test } from "vitest";
import path from "node:path";
import * as codexModule from "./index";
import { codexProcessEnvironment, JsonLineRpcClient } from "./index";
import { signCapability } from "./capability";

type TestSupervisor = {
  url: string;
  stop: () => Promise<void>;
};

type StartSupervisor = (options: {
  port: number;
  sidecarFactory: () => Promise<unknown>;
}) => Promise<TestSupervisor>;

function supervisorStarter(): StartSupervisor | undefined {
  return (codexModule as unknown as { startCodexSupervisor?: StartSupervisor }).startCodexSupervisor;
}

function fakeSidecar() {
  let stopped = false;
  let notificationHandler: ((message: Record<string, unknown>) => void) | undefined;
  let exitHandler: (() => void) | undefined;
  const requests: Array<{ method: string; params: unknown }> = [];
  const account = {
    account: { type: "chatgpt", email: "person@example.test", planType: "pro" },
    requiresOpenaiAuth: false
  };
  return {
    handle: {
      client: {
        request: async (method: string, params: unknown) => {
          requests.push({ method, params });
          if (method === "account/login/start") {
            return { type: "chatgpt", loginId: "login-1", authUrl: "https://auth.example.test" };
          }
          if (method === "account/login/cancel") return { status: "canceled" };
          if (method === "account/read") return account;
          if (method === "plugin/install") return { authPolicy: "on_install", appsNeedingAuth: [] };
          if (method === "app/installed") return { apps: [{ id: "connector_947e0d954944416db111db556030eea6", runtimeName: "Google Calendar", enabled: true, callable: true }] };
          if (method === "app/read") return { apps: [{ id: "connector_e6a7394682e24467ac68c60696f275a4", installUrl: "https://chatgpt.com/apps/microsoft-outlook-calendar/connector_e6a7394682e24467ac68c60696f275a4" }], missingAppIds: [] };
          if (method === "app/list") throw new Error("Request failed with status 403 Forbidden");
          if (method === "skills/list") return { data: [{ cwd: "C:\\repo", errors: [], skills: [{ name: "crossline-automation-stripper", path: "C:\\skill\\SKILL.md", enabled: true }] }] };
          throw new Error(`unexpected method: ${method}`);
        },
        onNotification: (handler: (message: Record<string, unknown>) => void) => {
          notificationHandler = handler;
          return () => { notificationHandler = undefined; };
        }
      },
      initializeResult: { userAgent: "codex-cli/0.154.0-alpha.6.2" },
      process: { pid: 4242 },
      onExit: (handler: () => void) => {
        exitHandler = handler;
        return () => { exitHandler = undefined; };
      },
      stop: () => { stopped = true; }
    },
    requests,
    isStopped: () => stopped,
    notify: (message: Record<string, unknown>) => notificationHandler?.(message),
    exit: () => exitHandler?.()
  };
}

describe("Codex app-server boundary", () => {
  test("Analyze reaches the worker-owned sidecar and supports explicit cancellation", async () => {
    const sidecar = fakeSidecar();
    const seen: string[] = [];
    const supervisor = await codexModule.startCodexSupervisor({ port: 0, sidecarFactory: async () => sidecar.handle,
      analyzeCapture: async (client, id) => { expect(client).toBe(sidecar.handle.client); seen.push(id); return { state: "awaiting_plan_approval" }; }
    });
    try {
      const response = await fetch(`${supervisor.url}/v1/captures/capture-1/analyze`, { method: "POST", headers: { "content-type": "application/json" } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ state: "awaiting_plan_approval" });
      expect(seen).toEqual(["capture-1"]);
      expect(sidecar.isStopped()).toBe(false);
    } finally { await supervisor.stop(); }
  });

  test("a long run answers with its status line at once and still delivers its result as JSON", async () => {
    // A client's fetch gives up after five minutes without a byte; a Skill may run for ten. The route sends the
    // headers first and keeps the body alive, so the body arrives with a run's own outcome in it.
    const sidecar = fakeSidecar();
    const supervisor = await codexModule.startCodexSupervisor({
      port: 0, sidecarFactory: async () => sidecar.handle,
      proposeMilestones: async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return { state: "proposed", drafts: [] }; }
    });
    try {
      const response = await fetch(`${supervisor.url}/v1/milestones/propose`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ state: "proposed", drafts: [] });
    } finally { await supervisor.stop(); }
  });

  test("a long run that throws is reported as a blocked result, not a second set of headers", async () => {
    const sidecar = fakeSidecar();
    const supervisor = await codexModule.startCodexSupervisor({
      port: 0, sidecarFactory: async () => sidecar.handle,
      proposeMilestones: async () => { throw new Error("boom"); }
    });
    try {
      const response = await fetch(`${supervisor.url}/v1/milestones/propose`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ state: "blocked", code: "SUPERVISOR_RUN_FAILED" });
    } finally { await supervisor.stop(); }
  });

  test("a detached job that throws is contained, not fatal to the worker", async () => {
    // `void job().finally(...)` reads as "detached" but still propagates the rejection, and since Node
    // 15 an unhandled rejection terminates the process by default. The two run-it-now routes answer 202
    // and leave the job running, so one click on a work order the store then refuses — it throws
    // `GATE_ALREADY_APPLIED` and `EVIDENCE_REVIEW_NOT_READY` — would have taken the whole worker down.
    const sidecar = fakeSidecar();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    let started = 0;
    const supervisor = await codexModule.startCodexSupervisor({
      port: 0, sidecarFactory: async () => sidecar.handle,
      prepareMaterials: async () => { started += 1; throw new Error("GATE_ALREADY_APPLIED"); },
      judgeMilestone: async () => { started += 1; throw new Error("EVIDENCE_REVIEW_NOT_READY"); }
    });
    try {
      for (const path of ["prepare-materials", "milestone-gate"]) {
        const response = await fetch(`${supervisor.url}/v1/work-orders/wo-1/${path}`, {
          method: "POST", headers: { "content-type": "application/json" }
        });
        // Answered immediately: the outcome lives in the ledger, not in this response.
        expect(response.status).toBe(202);
        expect(await response.json()).toEqual({ started: true });
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(started).toBe(2);
      expect(unhandled).toEqual([]);
      // Still serving, and the id is released so a second attempt is not refused as already running.
      expect((await fetch(`${supervisor.url}/v1/codex/status`)).status).toBe(200);
      expect((await fetch(`${supervisor.url}/v1/work-orders/wo-1/prepare-materials`, {
        method: "POST", headers: { "content-type": "application/json" }
      })).status).toBe(202);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await supervisor.stop();
    }
  });

  test("classifying new captures now answers at once, runs in the background, and refuses a browser origin", async () => {
    const sidecar = fakeSidecar();
    let runs = 0;
    const supervisor = await codexModule.startCodexSupervisor({
      port: 0, sidecarFactory: async () => sidecar.handle,
      autoAnalyzeCaptures: async () => { runs += 1; throw new Error("the pass failing must not take the supervisor down"); }
    });
    try {
      const response = await fetch(`${supervisor.url}/v1/captures/auto-analyze`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ started: true });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(runs).toBe(1);
      const forged = await fetch(`${supervisor.url}/v1/captures/auto-analyze`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}" });
      expect(forged.status).toBe(403);
      expect(runs).toBe(1);
    } finally { await supervisor.stop(); }
  });

  test("working back from newly approved milestones answers at once, runs in the background, and refuses a browser origin", async () => {
    const sidecar = fakeSidecar();
    let runs = 0;
    const supervisor = await codexModule.startCodexSupervisor({
      port: 0, sidecarFactory: async () => sidecar.handle,
      autoBackplanGoals: async () => { runs += 1; throw new Error("the pass failing must not take the supervisor down"); }
    });
    try {
      const response = await fetch(`${supervisor.url}/v1/goals/auto-backplan`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(response.status).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(runs).toBe(1);
      const forged = await fetch(`${supervisor.url}/v1/goals/auto-backplan`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}" });
      expect(forged.status).toBe(403);
      expect(runs).toBe(1);
    } finally { await supervisor.stop(); }
  });

  test("startup installs the local plugin and verifies every required skill", async () => {
    const sidecar = fakeSidecar();
    const supervisor = await codexModule.startCodexSupervisor({
      port: 0,
      sidecarFactory: async () => sidecar.handle,
      plugin: { name: "crossline", marketplacePath: "C:\\repo\\skills\\marketplace\\.agents\\plugins\\marketplace.json", cwd: "C:\\repo", requiredSkills: ["crossline-automation-stripper"] }
    });
    try {
      const response = await fetch(`${supervisor.url}/v1/codex/status`);
      expect(await response.json()).toMatchObject({ state: "ready", plugin: { name: "crossline", state: "installed" } });
      expect(sidecar.requests.slice(0, 2)).toEqual([
        { method: "plugin/install", params: { marketplacePath: "C:\\repo\\skills\\marketplace\\.agents\\plugins\\marketplace.json", pluginName: "crossline" } },
        { method: "skills/list", params: { cwds: ["C:\\repo"], forceReload: true } }
      ]);
    } finally { await supervisor.stop(); }
  });

  test("JSON line RPC correlates app-server responses", async () => {
    const written: string[] = [];
    const client = new JsonLineRpcClient((line) => written.push(line));
    const pending = client.request("initialize", {
      clientInfo: { name: "crossline", title: "Crossline", version: "0.1.0" },
      capabilities: { experimentalApi: false, requestAttestation: false }
    });
    expect(JSON.parse(written[0]!)).toMatchObject({ id: 1, method: "initialize" });
    client.receiveLine(JSON.stringify({ id: 1, result: { userAgent: "codex-cli/0.133.0" } }));
    await expect(pending).resolves.toEqual({ userAgent: "codex-cli/0.133.0" });
  });

  test("JSON line RPC rejects pending and future requests after the app-server exits", async () => {
    const written: string[] = [];
    const client = new JsonLineRpcClient((line) => written.push(line));
    const pending = client.request("account/read", { refreshToken: false });

    const disconnect = (client as unknown as { disconnect?: (error: Error) => void }).disconnect;
    expect(disconnect).toBeTypeOf("function");
    if (!disconnect) return;
    disconnect.call(client, new Error("CODEX_APP_SERVER_EXITED"));

    await expect(pending).rejects.toThrow("CODEX_APP_SERVER_EXITED");
    await expect(client.request("account/read", { refreshToken: false })).rejects.toThrow("CODEX_APP_SERVER_EXITED");
    expect(written).toHaveLength(1);
  });

  test("sidecar authentication is isolated from Codex Desktop state", () => {
    const env = codexProcessEnvironment({ CODEX_HOME: "C:\\Users\\karol\\.codex", SAFE: "1",
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" }, "C:\\Users\\karol\\AppData\\Local");
    expect(env.CODEX_HOME).toBe("C:\\Users\\karol\\AppData\\Local\\Crossline\\codex-home");
    expect(env.CROSSLINE_CODEX_HOME).toBe(env.CODEX_HOME);
    expect(env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE).toBeUndefined();
    expect(env.SAFE).toBe("1");
  });

  test("an installed copy's state folder keeps its Codex home apart from a resident app's", () => {
    const env = codexProcessEnvironment({ CROSSLINE_STATE_DIR: "C:\\Users\\k\\AppData\\Local\\Crossline\\state" }, "C:\\Users\\k\\AppData\\Local");
    expect(env.CODEX_HOME).toBe("C:\\Users\\k\\AppData\\Local\\Crossline\\state\\codex-home");
  });

  test("sidecar keeps the completed login outside a packaged app LOCALAPPDATA redirect", () => {
    const base = {
      USERPROFILE: "C:\\Users\\karol",
      LOCALAPPDATA: "C:\\Users\\karol\\AppData\\Local\\Packages\\OpenAI.Codex_2p2nqsd0c76g0\\LocalCache\\Local"
    };
    const env = codexProcessEnvironment(base, base.LOCALAPPDATA);
    expect(env.CODEX_HOME).toBe("C:\\Users\\karol\\AppData\\Local\\Crossline\\codex-home");
  });

  test("a login request leaves the owning sidecar alive and account reads cross the durable boundary", async () => {
    const startSupervisor = supervisorStarter();
    expect(startSupervisor).toBeTypeOf("function");
    if (!startSupervisor) return;
    const sidecar = fakeSidecar();
    const supervisor = await startSupervisor({ port: 0, sidecarFactory: async () => sidecar.handle });
    try {
      const loginResponse = await fetch(`${supervisor.url}/v1/codex/login`, { method: "POST" });
      expect(loginResponse.status).toBe(200);
      expect(await loginResponse.json()).toMatchObject({ loginId: "login-1", authUrl: "https://auth.example.test" });
      expect(sidecar.isStopped()).toBe(false);

      const accountResponse = await fetch(`${supervisor.url}/v1/codex/account`);
      expect(accountResponse.status).toBe(200);
      expect(await accountResponse.json()).toEqual({
        account: { type: "chatgpt", email: "person@example.test", planType: "pro" },
        requiresOpenaiAuth: false
      });
      expect(sidecar.requests.map(({ method }) => method)).toEqual(["account/login/start", "account/read"]);
    } finally {
      await supervisor.stop();
    }
    expect(sidecar.isStopped()).toBe(true);
  });

  test("calendar connection status comes from app/installed and app/read, never from the app/list directory", async () => {
    const sidecar = fakeSidecar();
    const supervisor = await codexModule.startCodexSupervisor({ port: 0, sidecarFactory: async () => sidecar.handle });
    try {
      const response = await fetch(`${supervisor.url}/v1/apps/calendar`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ apps: [
        { app: "google_calendar", label: "Google 日历", connected: true, callable: true, installUrl: null },
        { app: "microsoft_outlook_calendar", label: "Outlook 日历", connected: false, callable: false,
          installUrl: "https://chatgpt.com/apps/microsoft-outlook-calendar/connector_e6a7394682e24467ac68c60696f275a4" }
      ] });
      expect(sidecar.requests.map(({ method }) => method).sort()).toEqual(["app/installed", "app/read"]);
    } finally {
      await supervisor.stop();
    }
  });

  test("login completion and account update notifications change observable supervisor status", async () => {
    const startSupervisor = supervisorStarter();
    expect(startSupervisor).toBeTypeOf("function");
    if (!startSupervisor) return;
    const sidecar = fakeSidecar();
    const supervisor = await startSupervisor({ port: 0, sidecarFactory: async () => sidecar.handle });
    try {
      await fetch(`${supervisor.url}/v1/codex/login`, { method: "POST" });
      sidecar.notify({
        method: "account/login/completed",
        params: { loginId: "login-1", success: true, error: null, onboardingEntrypoint: null }
      });
      sidecar.notify({ method: "account/updated", params: { authMode: "chatgpt", planType: "pro" } });

      const response = await fetch(`${supervisor.url}/v1/codex/status`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        state: "ready",
        login: { loginId: "login-1", state: "completed" },
        accountRevision: 1,
        contract: {
          runtimeVersion: "codex-cli/0.154.0-alpha.6.2",
          sourceBaseline: codexModule.CODEX_BASELINE_COMMIT,
          generatedProtocolSha256: codexModule.CODEX_GENERATED_PROTOCOL_SHA256,
          contractTestResult: "passed",
          relationStatus: "unverified"
        }
      });
    } finally {
      await supervisor.stop();
    }
  });

  test("a failed login notification exposes a safe typed blocker without its raw error", async () => {
    const startSupervisor = supervisorStarter();
    expect(startSupervisor).toBeTypeOf("function");
    if (!startSupervisor) return;
    const sidecar = fakeSidecar();
    const supervisor = await startSupervisor({ port: 0, sidecarFactory: async () => sidecar.handle });
    try {
      await fetch(`${supervisor.url}/v1/codex/login`, { method: "POST" });
      sidecar.notify({
        method: "account/login/completed",
        params: { loginId: "login-1", success: false, error: "sensitive callback detail", onboardingEntrypoint: null }
      });

      const response = await fetch(`${supervisor.url}/v1/codex/status`);
      const body = await response.json();
      expect(body).toMatchObject({
        state: "ready",
        login: {
          loginId: "login-1",
          state: "failed",
          blocker: { code: "CODEX_LOGIN_FAILED", message: "Codex login failed" }
        }
      });
      expect(JSON.stringify(body)).not.toContain("sensitive callback detail");
    } finally {
      await supervisor.stop();
    }
  });

  test("a sidecar exit changes status and account reads to a typed runtime blocker", async () => {
    const startSupervisor = supervisorStarter();
    expect(startSupervisor).toBeTypeOf("function");
    if (!startSupervisor) return;
    const sidecar = fakeSidecar();
    const supervisor = await startSupervisor({ port: 0, sidecarFactory: async () => sidecar.handle });
    try {
      sidecar.exit();

      const statusResponse = await fetch(`${supervisor.url}/v1/codex/status`);
      expect(await statusResponse.json()).toMatchObject({
        state: "blocked",
        blocker: { code: "CODEX_RUNTIME_EXITED", message: "Codex app-server exited" }
      });
      const accountResponse = await fetch(`${supervisor.url}/v1/codex/account`);
      expect(accountResponse.status).toBe(503);
      expect(await accountResponse.json()).toEqual({
        blocker: { code: "CODEX_RUNTIME_EXITED", message: "Codex app-server exited" }
      });
    } finally {
      await supervisor.stop();
    }
  });

  test("the durable boundary cancels the active login without stopping the sidecar", async () => {
    const startSupervisor = supervisorStarter();
    expect(startSupervisor).toBeTypeOf("function");
    if (!startSupervisor) return;
    const sidecar = fakeSidecar();
    const supervisor = await startSupervisor({ port: 0, sidecarFactory: async () => sidecar.handle });
    try {
      await fetch(`${supervisor.url}/v1/codex/login`, { method: "POST" });
      const response = await fetch(`${supervisor.url}/v1/codex/login/cancel`, { method: "POST" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "canceled" });
      expect(sidecar.requests.at(-1)).toEqual({ method: "account/login/cancel", params: { loginId: "login-1" } });
      expect(sidecar.isStopped()).toBe(false);
    } finally {
      await supervisor.stop();
    }
  });
});

describe("codex executable resolution", () => {
  const fork = path.resolve(import.meta.dirname, "../../../vendor/codex/codex-rs/target/debug/codex.exe");
  const desktop = "C:\\Users\\k\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe";

  test("the pinned fork build is selected even when Desktop is on PATH", () => {
    const resolved = codexModule.resolveCodexCommand({ Path: path.dirname(desktop) },
      (file) => file === fork || file === desktop, "win32", () => codexModule.CODEX_FORK_BINARY_SHA256);
    expect(resolved).toEqual({ command: fork, args: [] });
  });

  test("status identifies a sidecar launched from the pinned fork", async () => {
    const sidecar = fakeSidecar();
    const supervisor = await codexModule.startCodexSupervisor({ port: 0,
      sidecarFactory: async () => ({ ...sidecar.handle, forkVerified: true }) });
    try {
      const status = await (await fetch(`${supervisor.url}/v1/codex/status`)).json() as { contract: { relationStatus: string } };
      expect(status.contract.relationStatus).toBe("verified");
    } finally { await supervisor.stop(); }
  });

  test("an absent fork never falls back to Desktop", () => {
    expect(() => codexModule.resolveCodexCommand({ Path: path.dirname(desktop) },
      (file) => file === desktop, "win32", () => codexModule.CODEX_FORK_BINARY_SHA256))
      .toThrow("CODEX_FORK_BINARY_NOT_FOUND");
  });

  test("the release build an installed copy ships is accepted by its own hash", () => {
    const shipped = "C:\\Users\\k\\AppData\\Local\\Crossline\\app\\codex\\codex.exe";
    expect(codexModule.resolveCodexCommand({ CROSSLINE_CODEX_PATH: shipped }, (file) => file === shipped, "win32",
      () => codexModule.CODEX_RELEASE_BINARY_SHA256)).toEqual({ command: shipped, args: [] });
  });

  test("a changed executable is refused before app-server starts", () => {
    expect(() => codexModule.resolveCodexCommand({ CROSSLINE_CODEX_PATH: fork },
      (file) => file === fork, "win32", () => "different"))
      .toThrow("CODEX_FORK_BINARY_MISMATCH");
  });
});

describe("supervisor capability enforcement", () => {
  const SECRET = "test-capability-secret";
  const claims = (operation: string, bootId: string) => ({
    principalId: "p1", workspaceId: "w1", role: "owner" as const, operation, requestId: "req-1", supervisorBootId: bootId
  });

  test("/v1/codex/status stays reachable with no token, even when a secret is configured", async () => {
    const sidecar = fakeSidecar();
    const supervisor = await codexModule.startCodexSupervisor({
      port: 0, sidecarFactory: async () => sidecar.handle, capabilitySecret: SECRET
    });
    try {
      const response = await fetch(`${supervisor.url}/v1/codex/status`);
      expect(response.status).toBe(200);
      expect(typeof (await response.json() as { supervisorBootId?: unknown }).supervisorBootId).toBe("string");
    } finally { await supervisor.stop(); }
  });

  test("a real action route refuses no token, a wrong-operation token, and a token for a different boot", async () => {
    const sidecar = fakeSidecar();
    let prepared = 0;
    const supervisor = await codexModule.startCodexSupervisor({
      port: 0, sidecarFactory: async () => sidecar.handle, capabilitySecret: SECRET,
      prepareMaterials: async () => { prepared += 1; return { state: "ready" }; }
    });
    try {
      const status = await (await fetch(`${supervisor.url}/v1/codex/status`)).json() as { supervisorBootId: string };
      const target = "POST /v1/work-orders/wo-1/prepare-materials";
      const post = (headers: Record<string, string>) => fetch(`${supervisor.url}/v1/work-orders/wo-1/prepare-materials`, {
        method: "POST", headers: { "content-type": "application/json", ...headers }
      });

      const noToken = await post({});
      expect(noToken.status).toBe(401);
      expect(await noToken.json()).toMatchObject({ blocker: { code: "CAPABILITY_MISSING" } });

      const wrongOperation = signCapability(claims("GET /v1/codex/account", status.supervisorBootId), SECRET);
      expect((await post({ "x-crossline-capability": wrongOperation })).status).toBe(401);

      const wrongBoot = signCapability(claims(target, "some-other-boot"), SECRET);
      expect((await post({ "x-crossline-capability": wrongBoot })).status).toBe(401);

      expect(prepared).toBe(0);

      const valid = signCapability(claims(target, status.supervisorBootId), SECRET);
      const accepted = await post({ "x-crossline-capability": valid });
      expect(accepted.status).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(prepared).toBe(1);

      // The same token again is a replay, not a second legitimate call.
      const replayed = await post({ "x-crossline-capability": valid });
      expect(replayed.status).toBe(401);
      expect(await replayed.json()).toMatchObject({ blocker: { code: "CAPABILITY_REPLAYED" } });
    } finally { await supervisor.stop(); }
  });

  test("no capabilitySecret configured means no enforcement — the pre-stage-four behaviour every other test in this file relies on", async () => {
    const sidecar = fakeSidecar();
    const supervisor = await codexModule.startCodexSupervisor({
      port: 0, sidecarFactory: async () => sidecar.handle,
      prepareMaterials: async () => ({ state: "ready" })
    });
    try {
      const response = await fetch(`${supervisor.url}/v1/work-orders/wo-1/prepare-materials`, {
        method: "POST", headers: { "content-type": "application/json" }
      });
      expect(response.status).toBe(202);
    } finally { await supervisor.stop(); }
  });
});

describe("requests from the runtime", () => {
  test("an approval request is answered by the handler, with the id it came with, and cannot be mistaken for a response to ours", async () => {
    const written: Array<Record<string, unknown>> = [];
    const client = new JsonLineRpcClient((line) => written.push(JSON.parse(line)));
    client.onServerRequest(async (method, params) => ({ decision: method === "item/commandExecution/requestApproval" && (params as { command: string }).command === "ls" ? "accept" : "decline" }));
    const ours = client.request("thread/start", {});
    // The runtime's request happens to carry the same numeric id as our pending one.
    client.receiveLine(JSON.stringify({ id: 1, method: "item/commandExecution/requestApproval", params: { command: "ls" } }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(written.at(-1)).toEqual({ id: 1, result: { decision: "accept" } });
    let settled = false;
    void ours.then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(settled).toBe(false);
    client.receiveLine(JSON.stringify({ id: 1, result: { ok: true } }));
    await expect(ours).resolves.toEqual({ ok: true });
  });

  test("with no handler, or a handler that throws, the runtime gets an error back instead of silence", async () => {
    const written: Array<Record<string, unknown>> = [];
    const client = new JsonLineRpcClient((line) => written.push(JSON.parse(line)));
    client.receiveLine(JSON.stringify({ id: "a", method: "item/fileChange/requestApproval", params: {} }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(written.at(-1)).toMatchObject({ id: "a", error: { message: expect.stringContaining("no handler") } });
    client.onServerRequest(() => { throw new Error("nope"); });
    client.receiveLine(JSON.stringify({ id: "b", method: "item/fileChange/requestApproval", params: {} }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(written.at(-1)).toMatchObject({ id: "b", error: { message: "nope" } });
  });
});

describe("each account's own Codex", () => {
  const SECRET = "test-capability-secret";
  const sign = (workspaceId: string, operation: string, bootId: string) => signCapability({ principalId: `p-${workspaceId}`, workspaceId, role: "owner",
    operation, requestId: `r-${Math.random()}`, supervisorBootId: bootId }, SECRET);

  test("a guest that has not connected its own runtime is refused model work, and the owner's runtime is never used for it", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(path.join(tmpdir(), "crossline-guest-"));
    const owner = fakeSidecar();
    const guest = fakeSidecar();
    let started = 0;
    const supervisor = await codexModule.startCodexSupervisor({ port: 0, sidecarFactory: async () => owner.handle, capabilitySecret: SECRET,
      runtimes: { baseDir: dir, ownerWorkspaceId: () => "ws-owner", start: async () => { started += 1; return guest.handle as never; } },
      autoAnalyzeCaptures: async () => undefined });
    try {
      const { supervisorBootId } = await (await fetch(`${supervisor.url}/v1/codex/status`)).json() as { supervisorBootId: string };
      const call = (workspaceId: string, method: string, pathname: string, body?: unknown) => fetch(`${supervisor.url}${pathname}`, { method,
        headers: { "content-type": "application/json", "x-crossline-capability": sign(workspaceId, `${method} ${pathname}`, supervisorBootId) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      const refused = await call("ws-guest", "POST", "/v1/captures/auto-analyze", {});
      expect(refused.status).toBe(503);
      expect(await refused.json()).toMatchObject({ blocker: { code: "RUNTIME_UNCONNECTED" } });
      expect(await (await call("ws-guest", "GET", "/v1/codex/cost")).json()).toEqual({ available: false, reason: "RUNTIME_UNCONNECTED" });
      expect(await (await call("ws-guest", "GET", "/v1/codex/account")).json()).toMatchObject({ account: null, login: null });
      expect(owner.requests.filter((item) => item.method === "account/read")).toHaveLength(0);
      expect(started).toBe(0);
      // The owner's own work still runs on the owner's runtime.
      expect((await call("ws-owner", "POST", "/v1/captures/auto-analyze", {})).status).toBe(202);
      expect(supervisor.clientFor("ws-guest")).toBeUndefined();
      expect(supervisor.clientFor("ws-owner")).toBe(owner.handle.client);
    } finally { await supervisor.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
});

test("an API-key login has no quota windows; its month's spend against the cap is the reading", async () => {
  const sidecar = fakeSidecar();
  const original = sidecar.handle.client.request;
  (sidecar.handle.client as { request: (method: string, params: unknown) => Promise<unknown> }).request = async (method, params) =>
    method === "account/read" ? { account: { type: "apiKey" }, requiresOpenaiAuth: true } : original(method, params);
  const supervisor = await codexModule.startCodexSupervisor({ port: 0, sidecarFactory: async () => sidecar.handle as never,
    monthSpend: () => ({ spent: 4, cap: 10 }) });
  try {
    expect(await supervisor.readCostSignal()).toMatchObject({ available: true, limitReached: false, money: { spent: 4, cap: 10 }, long: { usedPercent: 40 } });
  } finally { await supervisor.stop(); }
});

test("authorized folders: exclusions travel with the authorization and can be changed, revoking purges only when asked, and a browser cannot call any of it", async () => {
  const sidecar = fakeSidecar();
  const calls: unknown[][] = [];
  const supervisor = await codexModule.startCodexSupervisor({ port: 0, sidecarFactory: async () => sidecar.handle as never,
    sourceFolders: {
      preview: async (...args) => { calls.push(["preview", ...args]); return { state: "preview" }; },
      add: async (...args) => { calls.push(["add", ...args]); return { state: "added" }; },
      remove: async (...args) => { calls.push(["remove", ...args]); return { removed: true, purged: args[2] ? 2 : 0 }; },
      setLines: async (...args) => { calls.push(["lines", ...args]); return { saved: true }; },
      setRules: async (...args) => { calls.push(["rules", ...args]); return { saved: true, removed: 1 }; }
    } });
  const call = (method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}) => fetch(`${supervisor.url}${pathname}`, { method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    expect((await call("POST", "/v1/sources/folders", { path: "D:/Downloads", exclude: ["Tax", 3], include: ["a.pdf"], names: ["Kai Yan"] })).status).toBe(200);
    expect((await call("POST", "/v1/sources/folders/f1/exclusions", { exclude: ["old"], include: [] })).status).toBe(200);
    expect((await call("POST", "/v1/sources/folders/f1/exclusions", { exclude: "old" })).status).toBe(400);
    expect(await (await call("DELETE", "/v1/sources/folders/f1")).json()).toEqual({ removed: true, purged: 0 });
    expect(await (await call("DELETE", "/v1/sources/folders/f1/purge")).json()).toEqual({ removed: true, purged: 2 });
    expect((await call("DELETE", "/v1/sources/folders/f1/purge", undefined, { origin: "https://evil.example" })).status).toBe(403);
    expect(calls.map(([kind, , ...rest]) => [kind, ...rest])).toEqual([
      ["add", "D:/Downloads", { exclude: ["Tax"], include: ["a.pdf"], names: ["Kai Yan"] }],
      ["rules", "f1", { exclude: ["old"], include: [], names: [] }],
      ["remove", "f1", false],
      ["remove", "f1", true]]);
  } finally { await supervisor.stop(); }
});
