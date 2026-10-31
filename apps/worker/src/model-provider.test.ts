import { afterEach, beforeEach, expect, test } from "vitest";
import { conformanceCases, summarizeConformance, TASK_TITLES_SCHEMA, validateTaskTitles } from "@crossline/core";
import { enterUsageWorkspace, runCodexSkill, setProviderResolver, startModelGateway, type ModelGateway } from "@crossline/codex";
import { createMemorySecretStore, type SecretStore } from "@crossline/connectors";
import { CrosslineStore } from "@crossline/db";
import { CONFORMANCE_EVENT, createModelProviderService, RUNTIME_VERSION } from "./model-provider";
import { fakeRuntime } from "./testing/fake-runtime";
import type { ProbeDeps } from "./provider-probe";

let store: CrosslineStore;
let secrets: SecretStore;
let gateway: ModelGateway;
let workspaceId: string;
let signedIn = false;
let clock = new Date("2026-10-13T10:00:00.000Z");
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** Every address public and every request answered: what a working provider looks like to the connection tried before saving. */
const reachable: ProbeDeps = { isPublicHost: async () => true, fetchImpl: (async () => json({ data: [] })) as typeof fetch };
const service = (probe: ProbeDeps = reachable, allowLoopback = true) => createModelProviderService({ store, secrets, gateway, signedIn: () => signedIn,
  client: async () => undefined, cwd: "C:\\repo", now: () => clock, probe, allowLoopback, testOnSave: false });

beforeEach(async () => {
  store = new CrosslineStore(":memory:");
  secrets = createMemorySecretStore();
  workspaceId = store.createPrincipalWithWorkspace("guest", "个人").workspace.id;
  gateway = await startModelGateway({ resolve: () => undefined });
  signedIn = false;
  clock = new Date("2026-10-13T10:00:00.000Z");
});
afterEach(async () => { setProviderResolver(undefined); await gateway.close(); });

const deepseek = { id: "deepseek", kind: "chat", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1/", model: "deepseek-chat", apiKey: "sk-live-secret-9xyz" };

test("saving keeps the key out of the ledger and every answer: only its last four are stored or shown", async () => {
  const providers = service();
  const saved = await providers.handle("POST", "/v1/model/provider", workspaceId, deepseek);
  expect(saved?.status).toBe(200);
  expect(await secrets.read(workspaceId, "provider-key")).toBe("sk-live-secret-9xyz");
  const everything = JSON.stringify([store.exportSnapshot(workspaceId), saved, await providers.handle("GET", "/v1/model/provider", workspaceId, undefined)]);
  expect(everything).not.toContain("sk-live-secret");
  expect(JSON.parse(store.getSetting(workspaceId, "model.provider")!)).toMatchObject({ baseUrl: "https://api.deepseek.com/v1", keyLast4: "9xyz" });
  // The gateway gets the key; nothing else does.
  expect(await providers.upstream(workspaceId, "deepseek")).toEqual({ kind: "chat", baseUrl: "https://api.deepseek.com/v1", key: "sk-live-secret-9xyz" });
  expect(await providers.upstream(workspaceId, "other")).toBeUndefined();
});

test("a paid address needs a key, a bad address is refused in words, and a key does not follow a change of address", async () => {
  const providers = service();
  expect(await providers.handle("POST", "/v1/model/provider", workspaceId, { ...deepseek, apiKey: "" })).toMatchObject({ status: 400, body: { blocker: { code: "PROVIDER_KEY_MISSING" } } });
  expect(await providers.handle("POST", "/v1/model/provider", workspaceId, { ...deepseek, baseUrl: "http://api.deepseek.com" })).toMatchObject({ status: 400 });
  await providers.handle("POST", "/v1/model/provider", workspaceId, deepseek);
  // Same address, no key typed: the saved one stays.
  expect(await providers.handle("POST", "/v1/model/provider", workspaceId, { ...deepseek, apiKey: "", model: "deepseek-reasoner" })).toMatchObject({ status: 200 });
  expect(await secrets.read(workspaceId, "provider-key")).toBe("sk-live-secret-9xyz");
  // Another address: the key does not follow it and is asked for again; the saved provider stays as it was.
  expect(await providers.handle("POST", "/v1/model/provider", workspaceId, { ...deepseek, apiKey: "", baseUrl: "https://elsewhere.example/v1" }))
    .toMatchObject({ status: 400, body: { blocker: { code: "PROVIDER_KEY_MISSING" } } });
  expect(JSON.parse(store.getSetting(workspaceId, "model.provider")!)).toMatchObject({ baseUrl: "https://api.deepseek.com/v1" });
  // A local model takes no key.
  expect(await providers.handle("POST", "/v1/model/provider", workspaceId, { id: "ollama", kind: "responses", label: "本机", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen3:8b" }))
    .toMatchObject({ status: 200 });
  expect(providers.cost(workspaceId)).toEqual({ available: true, limitReached: false });
  await providers.handle("DELETE", "/v1/model/provider", workspaceId, undefined);
  expect(providers.hasProvider(workspaceId)).toBe(false);
});

test("a paid provider has no budget the app can read: background work stays paused; a Codex sign-in keeps its own reading", async () => {
  const providers = service();
  await providers.handle("POST", "/v1/model/provider", workspaceId, deepseek);
  expect(providers.cost(workspaceId)).toEqual({ available: false, reason: "PROVIDER_BUDGET_UNKNOWN" });
  signedIn = true;
  expect(providers.cost(workspaceId)).toBeUndefined();
});

test("nothing is routed to a provider before it passes; a record from before the last save, or for another model, does not count", async () => {
  const providers = service();
  await providers.handle("POST", "/v1/model/provider", workspaceId, deepseek);
  expect([...providers.routing(workspaceId)!.admitted]).toEqual([]);
  const runs = conformanceCases().flatMap((item) => Array.from({ length: item.runs }, () => ({ caseId: item.id, ok: true, repairs: 0, ms: 1 })));
  const write = (model: string, ranAt: string) => store.appendEvent({ ownerId: "o", workspaceId, idempotencyKey: `c:${model}:${ranAt}`, type: CONFORMANCE_EVENT, entityId: "deepseek",
    payload: summarizeConformance({ providerId: "deepseek", model, runtimeVersion: RUNTIME_VERSION, ranAt }, runs) });
  write("deepseek-chat", "2026-10-13T09:00:00.000Z");
  expect(providers.routing(workspaceId)!.admitted.size).toBe(0);
  write("deepseek-reasoner", "2026-10-13T11:00:00.000Z");
  expect(providers.routing(workspaceId)!.admitted.size).toBe(0);
  write("deepseek-chat", "2026-10-13T11:00:01.000Z");
  const admitted = providers.routing(workspaceId)!.admitted;
  expect(admitted.has("crossline-milestone-gate")).toBe(true);
  expect(admitted.has("crossline-due-diligence")).toBe(false);
  const view = providers.view(workspaceId);
  expect(view.features.find((feature) => feature.skill === "crossline-due-diligence")).toMatchObject({ served: false, reason: expect.stringContaining("联网") });
  expect(view.features.some((feature) => feature.skill === "crossline-conformance")).toBe(false);
});

test("an admitted Skill runs on the provider's thread: the provider defined on the thread, memories off, no sign-in asked for", async () => {
  const providers = service();
  await providers.handle("POST", "/v1/model/provider", workspaceId, deepseek);
  const runs = conformanceCases().flatMap((item) => Array.from({ length: item.runs }, () => ({ caseId: item.id, ok: true, repairs: 0, ms: 1 })));
  store.appendEvent({ ownerId: "o", workspaceId, idempotencyKey: "c", type: CONFORMANCE_EVENT, entityId: "deepseek",
    payload: summarizeConformance({ providerId: "deepseek", model: "deepseek-chat", runtimeVersion: RUNTIME_VERSION, ranAt: "2026-10-13T11:00:00.000Z" }, runs) });
  setProviderResolver((id) => providers.routing(id));
  const runtime = fakeRuntime([JSON.stringify({ titles: [{ id: "t1", title: "整理 ECE 555 笔记" }] })], "crossline:crossline-task-titler",
    { threadResponse: {} });
  enterUsageWorkspace(workspaceId);
  const result = await runCodexSkill(runtime.rpc, {}, { skillName: "crossline:crossline-task-titler", cwd: "C:\\repo", developerInstructions: "x",
    outputSchema: TASK_TITLES_SCHEMA, prepareInput: () => ({}), validateOutput: (output) => validateTaskTitles(output, ["t1"]), onAudit: () => {} });
  expect(result.ok).toBe(true);
  const start = runtime.threadStarts()[0]!;
  expect(start.modelProvider).toBe("crossline-deepseek");
  expect(start.model).toBe("deepseek-chat");
  const config = start.config as Record<string, unknown>;
  expect(config["model_providers.crossline-deepseek"]).toMatchObject({ base_url: gateway.urlFor(workspaceId, "deepseek"), requires_openai_auth: false });
  expect(config["memories.use_memories"]).toBe(false);
  expect(config["memories.generate_memories"]).toBe(false);
  expect(JSON.stringify(start)).not.toContain("sk-live-secret");
});

test("a run on a Skill's own model that needed a repair is run again on the provider's model, and that answer is kept", async () => {
  const provider = { id: "sponsor", kind: "chat" as const, label: "开发者提供的模型", baseUrl: "https://api.example.com/v1", model: "main",
    keyLast4: null, updatedAt: "1970-01-01T00:00:00.000Z" };
  setProviderResolver(() => ({ provider, gatewayUrl: gateway.urlFor(workspaceId, "sponsor"), admitted: new Set(["crossline-task-titler"]),
    codexSignedIn: false, modelFor: () => "cheap" }));
  const valid = (title: string) => JSON.stringify({ titles: [{ id: "t1", title }] });
  const options = { skillName: "crossline:crossline-task-titler", cwd: "C:\\repo", developerInstructions: "x", outputSchema: TASK_TITLES_SCHEMA,
    prepareInput: () => ({}), validateOutput: (output: unknown) => validateTaskTitles(output, ["t1"]), onAudit: () => {} };
  enterUsageWorkspace(workspaceId);
  // First answer is not JSON (a rejection), the repair passes on the cheap model; the redo on the main model is the answer kept.
  const runtime = fakeRuntime(["不是 JSON", valid("便宜模型的标题"), valid("整理 ECE 555 笔记")], "crossline:crossline-task-titler", { threadResponse: {} });
  const result = await runCodexSkill(runtime.rpc, {}, { ...options, redoOnRepair: true });
  expect(result).toMatchObject({ ok: true, output: { titles: [{ title: "整理 ECE 555 笔记" }] }, audit: { redone: { repairs: 1 } } });
  expect(runtime.threadStarts().map((start) => start.model)).toEqual(["cheap", "main"]);
  // Passed first time, or without the option: one run on the cheap model.
  const once = fakeRuntime([valid("整理 ECE 555 笔记")], "crossline:crossline-task-titler", { threadResponse: {} });
  expect(await runCodexSkill(once.rpc, {}, { ...options, redoOnRepair: true })).toMatchObject({ ok: true });
  expect(once.threadStarts().map((start) => start.model)).toEqual(["cheap"]);
  const without = fakeRuntime(["不是 JSON", valid("整理 ECE 555 笔记")], "crossline:crossline-task-titler", { threadResponse: {} });
  expect(await runCodexSkill(without.rpc, {}, options)).toMatchObject({ ok: true, audit: { repairs: 1 } });
  expect(without.threadStarts()).toHaveLength(1);
});

test("a Skill the provider has not passed, in a workspace with no Codex sign-in, stops with a blocker and never starts a thread", async () => {
  const providers = service();
  await providers.handle("POST", "/v1/model/provider", workspaceId, deepseek);
  setProviderResolver((id) => providers.routing(id));
  const runtime = fakeRuntime(["{}"], "crossline:crossline-milestone-gate");
  enterUsageWorkspace(workspaceId);
  const result = await runCodexSkill(runtime.rpc, {}, { skillName: "crossline:crossline-milestone-gate", cwd: "C:\\repo", developerInstructions: "x",
    outputSchema: {}, prepareInput: () => ({}), validateOutput: (output) => output, onAudit: () => {} });
  expect(result).toMatchObject({ ok: false, blocker: { code: "MODEL_NOT_ADMITTED", message: expect.stringContaining("验收判定") } });
  expect(runtime.threadStarts()).toHaveLength(0);
});

test("conformance: each case runs on the provider through the repair loop, and the record lands in the ledger", async () => {
  const runtime = fakeRuntime([
    JSON.stringify({ titles: [{ id: "t1", title: "x".repeat(80) }] }),      // too long: sent back
    JSON.stringify({ titles: [{ id: "t1", title: "整理笔记" }] }),
    JSON.stringify({ items: [{ kind: "note", text: "a" }, { kind: "task", title: "b", minutes: 30 }, { kind: "note", text: "c" }], note: null })
  ], "crossline:crossline-conformance");
  const providers = createModelProviderService({ store, secrets, gateway, signedIn: () => false, client: async () => runtime.rpc, cwd: "C:\\repo", now: () => clock,
    probe: reachable, testOnSave: false });
  await providers.handle("POST", "/v1/model/provider", workspaceId, deepseek);
  clock = new Date("2026-10-13T10:05:00.000Z");
  const cases = conformanceCases().filter((item) => item.id === "TASK_TITLES_SCHEMA" || item.id === "ADVERSARIAL_UNION");
  const record = await providers.runConformance(workspaceId, cases);
  expect(record).toMatchObject({ providerId: "deepseek", model: "deepseek-chat", passRate: 1, repairRate: 0.5,
    runs: [{ caseId: "TASK_TITLES_SCHEMA", ok: true, repairs: 1 }, { caseId: "ADVERSARIAL_UNION", ok: true, repairs: 0 }] });
  expect(runtime.threadStarts().every((start) => start.modelProvider === "crossline-deepseek")).toBe(true);
  expect(runtime.prompts()[1]).toContain("characters, at most 60");
  expect(store.listEvents(workspaceId, { type: CONFORMANCE_EVENT })).toHaveLength(1);
});

test("a relay (中转站): the pasted endpoint is cut to its base, one real request goes out with the key, and the check starts after saving", async () => {
  const sent: Array<{ url: string; auth: string | undefined }> = [];
  const probe: ProbeDeps = { isPublicHost: async () => true, fetchImpl: (async (url: string, init?: RequestInit) => {
    sent.push({ url, auth: (init?.headers as Record<string, string>).authorization });
    return url.endsWith("/models") ? json({ data: [{ id: "gpt-4o-mini" }] }) : json({ choices: [{ message: { content: "OK" } }] });
  }) as typeof fetch };
  const started: string[] = [];
  const providers = createModelProviderService({ store, secrets, gateway, signedIn: () => false, cwd: "C:\\repo", now: () => clock, probe,
    client: async (id) => { started.push(id); return undefined; } });
  const relay = { id: "relay", kind: "chat", label: "中转站", baseUrl: "https://relay.example.com/v1/chat/completions", model: "gpt-4o-mini", apiKey: "sk-relay-secret-ab12" };
  const saved = await providers.handle("POST", "/v1/model/provider", workspaceId, relay);
  expect(saved).toMatchObject({ status: 200, body: { provider: { baseUrl: "https://relay.example.com/v1", keyLast4: "ab12" } } });
  expect(sent.map((item) => item.url)).toEqual(["https://relay.example.com/v1/models", "https://relay.example.com/v1/chat/completions"]);
  expect(sent.every((item) => item.auth === "Bearer sk-relay-secret-ab12")).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(started).toEqual([workspaceId]);
  expect(JSON.stringify([saved, store.exportSnapshot(workspaceId)])).not.toContain("sk-relay-secret");
});

test("a connection that fails is not saved, and its message never repeats the key even when the relay echoes it", async () => {
  const echo: ProbeDeps = { isPublicHost: async () => true,
    fetchImpl: (async () => json({ error: { message: "Invalid token: sk-relay-secret-ab12 (request id 9)" } }, 401)) as typeof fetch };
  const relay = { id: "relay", kind: "chat", label: "中转站", baseUrl: "https://relay.example.com/v1", model: "gpt-4o-mini", apiKey: "sk-relay-secret-ab12" };
  const answer = await service(echo).handle("POST", "/v1/model/provider", workspaceId, relay);
  expect(answer).toMatchObject({ status: 400, body: { blocker: { code: "PROVIDER_KEY_INVALID" } } });
  expect(JSON.stringify(answer)).not.toContain("sk-relay-secret");
  expect(store.getSetting(workspaceId, "model.provider")).toBeFalsy();
  expect(await secrets.read(workspaceId, "provider-key")).toBeUndefined();
  // A name that resolves to a private address is refused before anything is sent to it.
  let contacted = false;
  const privateName: ProbeDeps = { isPublicHost: async () => false, fetchImpl: (async () => { contacted = true; return json({}); }) as typeof fetch };
  expect(await service(privateName).handle("POST", "/v1/model/provider", workspaceId, relay))
    .toMatchObject({ status: 400, body: { blocker: { code: "PROVIDER_ADDRESS_PRIVATE" } } });
  expect(contacted).toBe(false);
});

test("the gateway's upstream is refused when the saved name stops resolving publicly, and loopback is refused on the hosted server", async () => {
  let isPublic = true;
  const providers = service({ ...reachable, isPublicHost: async () => isPublic });
  await providers.handle("POST", "/v1/model/provider", workspaceId, deepseek);
  expect((await providers.upstream(workspaceId, "deepseek"))?.refused).toBeUndefined();
  isPublic = false;
  expect((await providers.upstream(workspaceId, "deepseek"))?.refused).toContain("public");
  const hosted = service(reachable, false);
  const local = { id: "ollama", kind: "responses", label: "本机", baseUrl: "http://127.0.0.1:3211/v1", model: "x" };
  expect(await hosted.handle("POST", "/v1/model/provider", workspaceId, local)).toMatchObject({ status: 400, body: { blocker: { code: "PROVIDER_CONFIG_INVALID" } } });
  // A loopback provider saved before (or by hand) is not forwarded on the server.
  store.setSetting(workspaceId, "model.provider", JSON.stringify({ ...local, keyLast4: null, updatedAt: clock.toISOString() }));
  expect((await hosted.upstream(workspaceId, "ollama"))?.refused).toContain("loopback");
});
