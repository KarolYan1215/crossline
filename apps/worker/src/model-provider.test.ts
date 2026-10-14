import { afterEach, beforeEach, expect, test } from "vitest";
import { conformanceCases, summarizeConformance, TASK_TITLES_SCHEMA, validateTaskTitles } from "@crossline/core";
import { enterUsageWorkspace, runCodexSkill, setProviderResolver, startModelGateway, type ModelGateway } from "@crossline/codex";
import { createMemorySecretStore, type SecretStore } from "@crossline/connectors";
import { CrosslineStore } from "@crossline/db";
import { CONFORMANCE_EVENT, createModelProviderService, RUNTIME_VERSION } from "./model-provider";
import { fakeRuntime } from "./testing/fake-runtime";

let store: CrosslineStore;
let secrets: SecretStore;
let gateway: ModelGateway;
let workspaceId: string;
let signedIn = false;
let clock = new Date("2026-10-13T10:00:00.000Z");
const service = () => createModelProviderService({ store, secrets, gateway, signedIn: () => signedIn, client: async () => undefined, cwd: "C:\\repo", now: () => clock });

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
  // Another address: the key is dropped and asked for again.
  expect(await providers.handle("POST", "/v1/model/provider", workspaceId, { ...deepseek, apiKey: "", baseUrl: "https://elsewhere.example/v1" })).toMatchObject({ status: 400 });
  expect(await secrets.read(workspaceId, "provider-key")).toBeUndefined();
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
  const providers = createModelProviderService({ store, secrets, gateway, signedIn: () => false, client: async () => runtime.rpc, cwd: "C:\\repo", now: () => clock });
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
