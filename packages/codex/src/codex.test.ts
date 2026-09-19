import { describe, expect, test } from "vitest";
import path from "node:path";
import * as codexModule from "./index";
import { buildContextBundle, codexProcessEnvironment, JsonLineRpcClient, normalizeCodexEvent } from "./index";

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
  test("normalizes a failed tool item to a typed blocker", () => {
    expect(normalizeCodexEvent({
      method: "item/completed",
      params: { item: { id: "item-1", type: "commandExecution", status: "failed", error: "permission denied" } }
    })).toEqual({
      type: "blocked",
      itemId: "item-1",
      blocker: { code: "CODEX_TOOL_FAILED", message: "permission denied" }
    });
  });

  test("context bundle keeps global, identity, and task scope explicit", () => {
    expect(buildContextBundle({
      ownerId: "owner-1",
      workspaceId: "workspace-1",
      identityId: "research",
      taskId: "task-1",
      globalContextVersion: 3,
      identityPackVersion: 2,
      allowedRoots: ["C:\\Research", "C:\\Papers"]
    })).toEqual({
      version: "3:research:2:task-1",
      ownerId: "owner-1",
      workspaceId: "workspace-1",
      identityId: "research",
      taskId: "task-1",
      allowedRoots: ["C:\\Research", "C:\\Papers"]
    });
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
  const fork = path.resolve(import.meta.dirname, "../../../.vendor/codex-fork/codex-rs/target/debug/codex.exe");
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

  test("a changed executable is refused before app-server starts", () => {
    expect(() => codexModule.resolveCodexCommand({ CROSSLINE_CODEX_PATH: fork },
      (file) => file === fork, "win32", () => "different"))
      .toThrow("CODEX_FORK_BINARY_MISMATCH");
  });
});
