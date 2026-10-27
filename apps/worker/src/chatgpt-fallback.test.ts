import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { backgroundSpend, CHATGPT_EXHAUSTED_SETTING, conformanceCases, spendAllows, summarizeConformance, type CostSignal } from "@crossline/core";
import { continueSkillTurn, decideRoute, enterUsageWorkspace, runCodexSkill, setProviderResolver, setUsageLimitHandler } from "@crossline/codex";
import { CrosslineStore, SPONSOR_SETTING } from "@crossline/db";
import { createModelProviderService, RUNTIME_VERSION } from "./model-provider";
import { createSponsorService, SPONSOR_EVAL_VERSION } from "./sponsor";
import { scriptedRuntime } from "./testing/fake-runtime";

/**
 * An account with its own ChatGPT and the developer's model (2026-10-21): ChatGPT first; while its quota is spent the developer's model
 * carries on, what it cannot do stops with that said, and ChatGPT takes over again once the quota is back.
 */
const dirs: string[] = [];
afterEach(() => {
  setProviderResolver(undefined);
  setUsageLimitHandler(undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const MODEL = "deepseek-ai/DeepSeek-V4.1";
const RESET = "2026-10-21T07:57:42.000Z";
const spentReading: CostSignal = { available: true, limitReached: true,
  short: { usedPercent: 100, windowDurationMins: 300, resetsAt: Date.parse(RESET) / 1000 }, long: { usedPercent: 60, windowDurationMins: 10080, resetsAt: null } };
const freshReading: CostSignal = { available: true, limitReached: false,
  short: { usedPercent: 3, windowDurationMins: 300, resetsAt: null }, long: { usedPercent: 61, windowDurationMins: 10080, resetsAt: null } };

function setup(options: { signedIn?: boolean; sponsored?: boolean } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "chatgpt-fallback-"));
  dirs.push(dataDir);
  const clock = { now: new Date("2026-10-21T06:00:00.000Z") };
  const record = summarizeConformance({ providerId: "sponsor", model: MODEL, runtimeVersion: RUNTIME_VERSION, ranAt: clock.now.toISOString() },
    conformanceCases().flatMap((item) => Array.from({ length: item.runs }, () => ({ caseId: item.id, ok: true, repairs: 0, ms: 900 }))));
  writeFileSync(path.join(dataDir, "sponsor.json"), JSON.stringify({ evaluations: [{ model: MODEL, record, yuanPerRun: 0.02,
    tokens: { input: 100_000, cached: 0, output: 10_000, runs: 10 }, version: SPONSOR_EVAL_VERSION }] }));
  const store = new CrosslineStore(":memory:");
  const workspaceId = store.createPrincipalWithWorkspace("owner", "个人").workspace.id;
  if (options.sponsored ?? true) store.setSetting(workspaceId, SPONSOR_SETTING, JSON.stringify({ inviteId: "inv", since: clock.now.toISOString() }));
  const gateway = { urlFor: (ws: string, providerId: string) => `http://127.0.0.1:1/${ws}/${providerId}`, port: 1, close: async () => {} };
  const env = { CROSSLINE_SPONSOR_API_KEY: "sk-test", CROSSLINE_SPONSOR_MODELS: `${MODEL}=4:16:1024` } as NodeJS.ProcessEnv;
  let sponsor: ReturnType<typeof createSponsorService> | undefined;
  const providers = createModelProviderService({ store, cwd: dataDir, gateway, signedIn: () => options.signedIn ?? true, client: async () => undefined,
    secrets: { read: async () => undefined, write: async () => {}, remove: () => {} } as never, search: null, image: null, sponsor: () => sponsor, now: () => clock.now });
  sponsor = createSponsorService({ store, dataDir, cwd: dataDir, gateway, capabilities: providers.capabilities, client: () => undefined, env, now: () => clock.now });
  return { store, providers, workspaceId, clock };
}

test("with ChatGPT and the developer's model, ChatGPT serves; a spent reading moves every Skill the developer's model passed onto it", () => {
  const { store, providers, workspaceId } = setup();
  // ChatGPT first: no provider route, and the quota is read from ChatGPT itself.
  expect(providers.routing(workspaceId)).toBeUndefined();
  expect(providers.cost(workspaceId)).toBeUndefined();
  expect(providers.afterChatgptCost(workspaceId, freshReading)).toBe(freshReading);
  // The quota is spent: marked until its reset, and background work goes by the developer's month instead of pausing.
  const reading = providers.afterChatgptCost(workspaceId, spentReading);
  expect(JSON.parse(store.getSetting(workspaceId, CHATGPT_EXHAUSTED_SETTING)!)).toMatchObject({ source: "quota", until: RESET });
  expect(reading).toMatchObject({ available: true, limitReached: false, money: { cap: 30 } });
  const spend = backgroundSpend(reading);
  expect(spend.blocker).toBeUndefined();
  expect(spendAllows(spend, "core")).toBe(true);
  const routing = providers.routing(workspaceId)!;
  expect(routing).toMatchObject({ codexSignedIn: false, chatgptExhausted: { until: RESET } });
  expect(decideRoute("crossline:crossline-onboarding", routing)).toMatchObject({ via: "provider", provider: { model: MODEL } });
  expect(decideRoute("crossline:crossline-automation-stripper", routing)).toMatchObject({ via: "provider" });
  // What the developer's model cannot do (web research here) stops with the reason, never back to the spent ChatGPT.
  expect(decideRoute("crossline:crossline-due-diligence", routing)).toEqual({ via: "blocked", code: "MODEL_CAPABILITY_MISSING",
    message: expect.stringContaining("ChatGPT 额度已用尽") });
});

test("past the reset, or on a reading that shows the quota back, ChatGPT serves again", () => {
  const { store, providers, workspaceId, clock } = setup();
  providers.afterChatgptCost(workspaceId, spentReading);
  expect(providers.routing(workspaceId)).toBeDefined();
  clock.now = new Date(Date.parse(RESET) + 1_000);
  expect(providers.routing(workspaceId)).toBeUndefined();
  clock.now = new Date("2026-10-21T07:00:00.000Z");
  expect(providers.routing(workspaceId)).toBeDefined();
  expect(providers.afterChatgptCost(workspaceId, freshReading)).toBe(freshReading);
  expect(store.getSetting(workspaceId, CHATGPT_EXHAUSTED_SETTING)).toBe("");
  expect(providers.routing(workspaceId)).toBeUndefined();
});

test("a run refused for the quota holds the developer's model for half an hour, even against a reading that lags", () => {
  const { store, providers, workspaceId, clock } = setup();
  providers.noteUsageLimit(workspaceId);
  expect(JSON.parse(store.getSetting(workspaceId, CHATGPT_EXHAUSTED_SETTING)!)).toMatchObject({ source: "usage_limit" });
  expect(providers.routing(workspaceId)).toBeDefined();
  expect(providers.afterChatgptCost(workspaceId, freshReading)).toMatchObject({ money: { cap: 30 } });
  clock.now = new Date(clock.now.getTime() + 31 * 60_000);
  expect(providers.routing(workspaceId)).toBeUndefined();
  expect(providers.afterChatgptCost(workspaceId, freshReading)).toBe(freshReading);
});

test("without the developer's model, or with its month spent, a spent ChatGPT pauses as before", () => {
  const plain = setup({ sponsored: false });
  expect(plain.providers.afterChatgptCost(plain.workspaceId, spentReading)).toBe(spentReading);
  plain.providers.noteUsageLimit(plain.workspaceId);
  expect(plain.store.getSetting(plain.workspaceId, CHATGPT_EXHAUSTED_SETTING)).toBeUndefined();
  expect(plain.providers.routing(plain.workspaceId)).toBeUndefined();

  const capped = setup();
  capped.store.saveModelUsage({ workspaceId: capped.workspaceId, skill: "crossline:crossline-onboarding", tier: "", model: MODEL, effort: "", spendMode: "normal",
    threadId: "", ok: true, errorCode: "", repairs: 0, turns: 1, inputTokens: 2_000_000, cachedInputTokens: 0, outputTokens: 1_500_000, reasoningTokens: 0,
    totalTokens: 3_500_000, durationMs: 1, at: "2026-10-05T00:00:00.000Z" });
  expect(capped.providers.afterChatgptCost(capped.workspaceId, spentReading)).toBe(spentReading);
  expect(backgroundSpend(spentReading).blocker?.code).toBe("RATE_LIMIT_REACHED");
  expect(capped.providers.routing(capped.workspaceId)).toBeUndefined();
});

test("an account with no ChatGPT of its own keeps running on the developer's model as before", () => {
  const { providers, workspaceId } = setup({ signedIn: false });
  expect(decideRoute("crossline:crossline-onboarding", providers.routing(workspaceId))).toMatchObject({ via: "provider" });
  expect(providers.cost(workspaceId)).toMatchObject({ available: true, money: { cap: 30 } });
});

test("a conversation started on ChatGPT is rebuilt once the route moved, or when ChatGPT refuses its next turn for the quota", async () => {
  const { providers, workspaceId } = setup();
  setProviderResolver((id) => providers.routing(id));
  setUsageLimitHandler((id) => providers.noteUsageLimit(id));
  const { rpc, prompts } = scriptedRuntime(["crossline:crossline-concierge"], () => JSON.stringify({ ok: true }),
    { failWith: (_prompt, turn) => turn === 2 ? "usageLimitExceeded" : undefined });
  const options = { skillName: "crossline:crossline-concierge", cwd: "C:\\repo", developerInstructions: "x", keepThread: true,
    outputSchema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" } }, required: ["ok"] },
    prepareInput: () => ({}), validateOutput: (output: unknown) => output, onAudit: () => {} };
  enterUsageWorkspace(workspaceId);
  const first = await runCodexSkill(rpc, {}, options);
  expect(first.ok).toBe(true);
  const threadId = first.audit.threadId!;
  // The next turn is refused for the quota: the conversation is to be rebuilt, which the next run does on the developer's model.
  const refused = await continueSkillTurn(rpc, threadId, "再来一句", options);
  expect(refused).toMatchObject({ ok: false, blocker: { code: "SKILL_THREAD_LOST" } });
  // Any later turn on that ChatGPT thread is answered the same without reaching the runtime.
  const before = prompts().length;
  expect(await continueSkillTurn(rpc, threadId, "还在吗", options)).toMatchObject({ ok: false, blocker: { code: "SKILL_THREAD_LOST" } });
  expect(prompts()).toHaveLength(before);
}, 30_000);

test("a run ChatGPT refuses for the quota is run once more on the developer's model", async () => {
  const { store, providers, workspaceId } = setup();
  setProviderResolver((id) => providers.routing(id));
  setUsageLimitHandler((id) => providers.noteUsageLimit(id));
  const { rpc, prompts } = scriptedRuntime(["crossline:crossline-task-titler"], () => JSON.stringify({ titles: [] }),
    { failWith: (_prompt, turn) => turn === 1 ? "usageLimitExceeded" : undefined });
  const starts: Array<Record<string, unknown>> = [];
  const request = rpc.request.bind(rpc);
  rpc.request = ((method: string, params?: unknown) => {
    if (method === "thread/start") starts.push(params as Record<string, unknown>);
    return request(method, params as never);
  }) as typeof rpc.request;
  enterUsageWorkspace(workspaceId);
  const result = await runCodexSkill(rpc, {}, { skillName: "crossline:crossline-task-titler", cwd: "C:\\repo", developerInstructions: "x",
    outputSchema: { type: "object", additionalProperties: false, properties: { titles: { type: "array", items: { type: "string" } } }, required: ["titles"] },
    prepareInput: () => ({}), validateOutput: (output) => output, onAudit: () => {} });
  expect(result.ok).toBe(true);
  expect(prompts()).toHaveLength(2);
  expect(starts[0]?.modelProvider).toBeUndefined();
  expect(starts[1]?.modelProvider).toBe("crossline-sponsor");
  expect(JSON.parse(store.getSetting(workspaceId, CHATGPT_EXHAUSTED_SETTING)!)).toMatchObject({ source: "usage_limit" });
}, 30_000);
