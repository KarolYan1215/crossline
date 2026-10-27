import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { conformanceCases, summarizeConformance } from "@crossline/core";
import { decideRoute, setUsageSink } from "@crossline/codex";
import { CrosslineStore, SPONSOR_SETTING } from "@crossline/db";
import { createModelProviderService, RUNTIME_VERSION } from "./model-provider";
import { createSponsorService, extractRecall, SPONSOR_DIALOGUE_SCRIPT, SPONSOR_DIALOGUE_VERSION, SPONSOR_EARLY_STOP_RUNS, SPONSOR_EFFORT_VERSION, SPONSOR_EVAL_VERSION, SPONSOR_EXTRACT_EXPECTED, type SponsorDialogueLog, type SponsorExtractLog, type SponsorRunLog } from "./sponsor";
import { scriptedRuntime } from "./testing/fake-runtime";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const NOW = new Date("2026-10-18T12:00:00.000Z");
const MODEL = "deepseek-ai/DeepSeek-V4.1";

function setup(withEvaluation = true) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "sponsor-"));
  dirs.push(dataDir);
  if (withEvaluation) {
    const record = summarizeConformance({ providerId: "sponsor", model: MODEL, runtimeVersion: RUNTIME_VERSION, ranAt: NOW.toISOString() },
      conformanceCases().flatMap((item) => Array.from({ length: item.runs }, () => ({ caseId: item.id, ok: true, repairs: 0, ms: 900 }))));
    writeFileSync(path.join(dataDir, "sponsor.json"), JSON.stringify({ evaluations: [{ model: MODEL, record, yuanPerRun: 0.02, tokens: { input: 100_000, cached: 0, output: 10_000, runs: 10 }, version: SPONSOR_EVAL_VERSION }] }));
  }
  const store = new CrosslineStore(":memory:");
  const gateway = { urlFor: (workspaceId: string, providerId: string) => `http://127.0.0.1:1/${workspaceId}/${providerId}`, port: 1, close: async () => {} };
  const env = { CROSSLINE_SPONSOR_API_KEY: "sk-test", CROSSLINE_SPONSOR_MODELS: `${MODEL}=4:16:1024` } as NodeJS.ProcessEnv;
  let sponsor: ReturnType<typeof createSponsorService> | undefined;
  const providers = createModelProviderService({ store, cwd: dataDir, gateway, signedIn: () => false, client: async () => undefined,
    secrets: { read: async () => undefined, write: async () => {}, remove: () => {} } as never, search: null, image: null, sponsor: () => sponsor, now: () => NOW });
  sponsor = createSponsorService({ store, dataDir, cwd: dataDir, gateway, capabilities: providers.capabilities, client: () => undefined, env, now: () => NOW });
  return { store, providers, sponsor };
}

test("an account that redeemed a code runs on the chosen model through the gateway, with the server key", async () => {
  const { store, providers } = setup();
  expect(providers.routing("ws")).toBeUndefined();
  expect(providers.hasProvider("ws")).toBe(false);
  store.setSetting("ws", SPONSOR_SETTING, JSON.stringify({ inviteId: "inv", since: NOW.toISOString() }));
  const routing = providers.routing("ws")!;
  expect(routing.provider).toMatchObject({ id: "sponsor", model: MODEL, kind: "chat" });
  expect(decideRoute("crossline:crossline-onboarding", routing)).toMatchObject({ via: "provider", provider: { model: MODEL } });
  expect(providers.hasProvider("ws")).toBe(true);
  expect(await providers.upstream("ws", "sponsor")).toMatchObject({ key: "sk-test", baseUrl: "https://api.siliconflow.cn/v1" });
  // An account that did not redeem gets nothing through the sponsor route.
  expect(await providers.upstream("other", "sponsor")).toBeUndefined();
  expect(providers.view("ws").features.find((feature) => feature.skill === "crossline-onboarding")?.served).toBe(true);
});

test("the month's cap stops the account with the reason, and its quota reads as spent", () => {
  const { store, providers } = setup();
  store.setSetting("ws", SPONSOR_SETTING, JSON.stringify({ inviteId: "inv", since: NOW.toISOString() }));
  // 2M input × 4 + 1.5M output (reasoning inside it) × 16 = 32 yuan this month; last month's use does not count.
  for (const at of ["2026-10-05T00:00:00.000Z", "2026-09-30T00:00:00.000Z"]) store.saveModelUsage({ workspaceId: "ws", skill: "crossline:crossline-onboarding", tier: "", model: MODEL,
    effort: "", spendMode: "normal", threadId: "", ok: true, errorCode: "", repairs: 0, turns: 1, inputTokens: 2_000_000, cachedInputTokens: 0,
    outputTokens: 1_500_000, reasoningTokens: 500_000, totalTokens: 3_500_000, durationMs: 1, at });
  const routing = providers.routing("ws")!;
  expect(routing.blocked?.code).toBe("MODEL_SPONSOR_BUDGET");
  expect(decideRoute("crossline:crossline-onboarding", routing)).toMatchObject({ via: "blocked", code: "MODEL_SPONSOR_BUDGET" });
  expect(providers.cost("ws")).toMatchObject({ available: true, limitReached: true, money: { spent: 32, cap: 30 } });
});

test("while a new evaluation has chosen nothing, the last choice keeps serving; the Skill names its thread, and refusals may go elsewhere", async () => {
  const { store, providers, sponsor } = setup(false);
  store.setSetting("ws", SPONSOR_SETTING, JSON.stringify({ inviteId: "inv", since: NOW.toISOString() }));
  const dataDir = dirs.at(-1)!;
  const record = summarizeConformance({ providerId: "sponsor", model: MODEL, runtimeVersion: RUNTIME_VERSION, ranAt: NOW.toISOString() },
    conformanceCases().flatMap((item) => Array.from({ length: item.runs }, () => ({ caseId: item.id, ok: true, repairs: 0, ms: 900 }))));
  // Records of an older measuring version (as after a prompt change), with the choice they made kept as the last one.
  writeFileSync(path.join(dataDir, "sponsor.json"), JSON.stringify({ evaluations: [{ model: MODEL, record, yuanPerRun: 0.02, version: SPONSOR_EVAL_VERSION - 1 }],
    lastChosen: { model: MODEL, record, yuanPerRun: 0.02 } }));
  expect(sponsor!.chosen()?.model).toBe(MODEL);
  const decision = decideRoute("crossline:crossline-onboarding", providers.routing("ws"));
  expect(decision).toMatchObject({ via: "provider", provider: { model: MODEL, definition: { http_headers: { "x-crossline-skill": "crossline-onboarding" } } } });
  // A person's refused turn can go to another candidate; an evaluation's run never leaves the model it measures.
  expect(typeof (await providers.upstream("ws", "sponsor"))?.fallback).toBe("function");
  expect((await providers.upstream("sponsor-eval:x", "sponsor"))?.fallback).toBeUndefined();
});

test("until a model has passed, the account is told it is being tested", () => {
  const { store, providers } = setup(false);
  store.setSetting("ws", SPONSOR_SETTING, JSON.stringify({ inviteId: "inv", since: NOW.toISOString() }));
  expect(decideRoute("crossline:crossline-onboarding", providers.routing("ws"))).toMatchObject({ via: "blocked", code: "MODEL_SPONSOR_PENDING" });
});

test("an evaluation logs every run with what the validator sent back, and a model that never recovers is not chosen", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "sponsor-eval-"));
  dirs.push(dataDir);
  const store = new CrosslineStore(":memory:");
  const gateway = { urlFor: (workspaceId: string, providerId: string) => `http://127.0.0.1:1/${workspaceId}/${providerId}`, port: 1, close: async () => {} };
  const env = { CROSSLINE_SPONSOR_API_KEY: "sk-test", CROSSLINE_SPONSOR_MODELS: "org/Broken=1:2:1024" } as NodeJS.ProcessEnv;
  // Every answer is an empty object: valid JSON that no case's schema accepts, so each run is sent back for repair and still fails.
  const { rpc } = scriptedRuntime(["crossline:crossline-conformance", "crossline:crossline-onboarding"], () => "{}", { usage: { input: 1000, output: 100 } });
  const providers = createModelProviderService({ store, cwd: dataDir, gateway, signedIn: () => false, client: async () => undefined,
    secrets: { read: async () => undefined, write: async () => {}, remove: () => {} } as never, search: null, image: null, sponsor: () => undefined, now: () => NOW });
  const sponsor = createSponsorService({ store, dataDir, cwd: dataDir, gateway, capabilities: providers.capabilities, client: () => rpc, env, now: () => NOW,
    fetch: (async () => new Response(JSON.stringify({ data: [{ id: "org/Broken" }] }), { status: 200 })) as typeof fetch });
  setUsageSink((usage) => { sponsor.noteEvalUsage(usage); });
  try {
    const result = await sponsor.evaluate();
    expect(result.tested).toEqual(["org/Broken"]);
    expect(result.chosen).toBeUndefined();
    const lines = readFileSync(path.join(dataDir, "sponsor-eval", "org_Broken.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as SponsorRunLog);
    // Every run failed for a reason of its own: the measurement stops after the first few, and what was measured is kept.
    expect(lines).toHaveLength(SPONSOR_EARLY_STOP_RUNS);
    expect(lines[0]).toMatchObject({ model: "org/Broken", ok: false, repairs: 2, unparsed: 0 });
    expect(lines[0]!.rejections).toHaveLength(3);
    expect(lines[0]!.rejections[0]!.answer).toBe("{}");
    expect(lines[0]!.serviceMs).toEqual(expect.any(Number));
    // The sample interview ran first on a throwaway ledger; its one failed turn is logged and the script stops there.
    const dialogue = readFileSync(path.join(dataDir, "sponsor-eval", "org_Broken.dialogue.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as SponsorDialogueLog);
    expect(dialogue).toHaveLength(1);
    expect(dialogue[0]).toMatchObject({ model: "org/Broken", turn: 1, ok: false });
    // The extraction is tried on the reply that was stored; its failure is logged, not thrown.
    const extract = readFileSync(path.join(dataDir, "sponsor-eval", "org_Broken.extract.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as SponsorExtractLog);
    expect(extract.every((line) => line.kind === "extract" && line.ok === false)).toBe(true);
  } finally { setUsageSink(undefined); }
}, 60_000);

test("the sample's own replies hold every statement the extraction is scored on", () => {
  expect(extractRecall(SPONSOR_DIALOGUE_SCRIPT.join("\n"))).toHaveLength(SPONSOR_EXTRACT_EXPECTED.length);
  expect(extractRecall("研究者/ms/stage=研二 (confirmed)\n研究者/ms/deadline=12 月中投会议论文 (confirmed)")).toEqual(["研二", "12 月中投稿"]);
});

test("a spent key stops the measurement without a record, so the candidate is measured again once there is money", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "sponsor-spent-"));
  dirs.push(dataDir);
  const store = new CrosslineStore(":memory:");
  const gateway = { urlFor: (workspaceId: string, providerId: string) => `http://127.0.0.1:1/${workspaceId}/${providerId}`, port: 1, close: async () => {} };
  const env = { CROSSLINE_SPONSOR_API_KEY: "sk-test", CROSSLINE_SPONSOR_MODELS: `${MODEL}=4:16:1024,org/Other=1:2:1024` } as NodeJS.ProcessEnv;
  const record = summarizeConformance({ providerId: "sponsor", model: MODEL, runtimeVersion: RUNTIME_VERSION, ranAt: NOW.toISOString() },
    conformanceCases().flatMap((item) => Array.from({ length: item.runs }, () => ({ caseId: item.id, ok: true, repairs: 0, ms: 900 }))));
  // Only an older measurement exists (no choice was kept from it), and the trial already ran on it.
  writeFileSync(path.join(dataDir, "sponsor.json"), JSON.stringify({ evaluations: [{ model: MODEL, record, yuanPerRun: 0.02,
    tokens: { input: 100_000, cached: 0, output: 10_000, runs: 10 }, version: SPONSOR_EVAL_VERSION - 1, effortVersion: SPONSOR_EFFORT_VERSION }] }));
  // Every turn is refused at once the way a spent balance is.
  const { rpc, prompts } = scriptedRuntime(["crossline:crossline-conformance", "crossline:crossline-onboarding"], () => "{}", { failWith: () => "usageLimitExceeded" });
  const providers = createModelProviderService({ store, cwd: dataDir, gateway, signedIn: () => false, client: async () => undefined,
    secrets: { read: async () => undefined, write: async () => {}, remove: () => {} } as never, search: null, image: null, sponsor: () => undefined, now: () => NOW });
  const sponsor = createSponsorService({ store, dataDir, cwd: dataDir, gateway, capabilities: providers.capabilities, client: () => rpc, env, now: () => NOW,
    fetch: (async (url: string) => new Response(JSON.stringify(String(url).endsWith("/user/info") ? { data: { balance: "0", totalBalance: "0", status: "normal" } }
      : { data: [{ id: MODEL }, { id: "org/Other" }] }), { status: 200 })) as typeof fetch });
  setUsageSink((usage) => { sponsor.noteEvalUsage(usage); });
  try {
    const result = await sponsor.evaluate();
    expect(result.exhausted).toBe(true);
    expect(result.tested).toEqual([]);
    // Nothing was written over the older record, and each candidate stopped at its first refused call (one sample turn, one case).
    const saved = JSON.parse(readFileSync(path.join(dataDir, "sponsor.json"), "utf8")) as { evaluations: Array<{ model: string; version: number }> };
    expect(saved.evaluations).toEqual([expect.objectContaining({ model: MODEL, version: SPONSOR_EVAL_VERSION - 1 })]);
    expect(prompts().length).toBeLessThanOrEqual(4);
    // The older record serves meanwhile, so invited accounts are not paused for the re-measurement.
    expect(sponsor.chosen()?.model).toBe(MODEL);
    expect(await sponsor.balance()).toEqual({ balance: "0", chargeBalance: "", totalBalance: "0", status: "normal" });
  } finally { setUsageSink(undefined); }
}, 60_000);

test("a measurement the runtime cut short is not a record: it stops there, and a record taken while the runtime was down is measured again", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "sponsor-down-"));
  dirs.push(dataDir);
  const store = new CrosslineStore(":memory:");
  const gateway = { urlFor: (workspaceId: string, providerId: string) => `http://127.0.0.1:1/${workspaceId}/${providerId}`, port: 1, close: async () => {} };
  const env = { CROSSLINE_SPONSOR_API_KEY: "sk-test", CROSSLINE_SPONSOR_MODELS: `${MODEL}=2:8:1024,org/Glm=0.8:2.8:1024`,
    CROSSLINE_SPONSOR_PLANNING_MODEL: "org/Glm" } as NodeJS.ProcessEnv;
  const cases = conformanceCases().flatMap((item) => Array.from({ length: item.runs }, () => item.id));
  const record = (model: string, downAfter?: number) => summarizeConformance({ providerId: "sponsor", model, runtimeVersion: RUNTIME_VERSION, ranAt: NOW.toISOString() },
    cases.map((caseId, index) => downAfter !== undefined && index >= downAfter
      ? { caseId, ok: false, repairs: 0, ms: 1, code: "SKILL_LIST_FAILED" } : { caseId, ok: true, repairs: 0, ms: 900 }));
  const tokens = { input: 100_000, cached: 0, output: 10_000, runs: 10 };
  // The 2026-10-20 shape: both candidates' records end in the same second with the runtime gone; the last choice is kept from before.
  const good = { model: MODEL, record: record(MODEL), yuanPerRun: 0.03, tokens, version: SPONSOR_EVAL_VERSION, effortVersion: SPONSOR_EFFORT_VERSION };
  writeFileSync(path.join(dataDir, "sponsor.json"), JSON.stringify({ lastChosen: good, evaluations: [
    { ...good, record: record(MODEL, 8) }, { model: "org/Glm", record: record("org/Glm", 8), yuanPerRun: 0.01, tokens, version: SPONSOR_EVAL_VERSION, effortVersion: SPONSOR_EFFORT_VERSION }] }));
  let down = true;
  const { rpc } = scriptedRuntime(["crossline:crossline-conformance", "crossline:crossline-onboarding"], () => "{}", { usage: { input: 1000, output: 100 }, listFails: () => down });
  const providers = createModelProviderService({ store, cwd: dataDir, gateway, signedIn: () => false, client: async () => undefined,
    secrets: { read: async () => undefined, write: async () => {}, remove: () => {} } as never, search: null, image: null, sponsor: () => undefined, now: () => NOW });
  const sponsor = createSponsorService({ store, dataDir, cwd: dataDir, gateway, capabilities: providers.capabilities, client: () => rpc, env, now: () => NOW,
    fetch: (async () => new Response(JSON.stringify({ data: [{ id: MODEL }, { id: "org/Glm" }] }), { status: 200 })) as typeof fetch });
  setUsageSink((usage) => { sponsor.noteEvalUsage(usage); });
  try {
    // Neither broken record counts: the last choice serves and the planning model is not used on a record that says nothing.
    expect(sponsor.chosen()?.model).toBe(MODEL);
    expect(sponsor.modelFor("crossline-step-planner")).toBe(MODEL);
    // Measured again while the runtime is still down: stopped without writing anything over the records, and to be tried again.
    const stopped = await sponsor.evaluate();
    expect(stopped).toMatchObject({ interrupted: true, tested: [] });
    const saved = JSON.parse(readFileSync(path.join(dataDir, "sponsor.json"), "utf8")) as { evaluations: Array<{ record: { failures: Array<{ code: string }> } }>; pruned?: unknown };
    expect(saved.evaluations.every((item) => item.record.failures.some((failure) => failure.code === "SKILL_LIST_FAILED"))).toBe(true);
    expect(saved.pruned).toBeUndefined();
    // With the runtime back, both are measured whole.
    down = false;
    const again = await sponsor.evaluate();
    expect(again.interrupted).toBe(false);
    expect([...again.tested].sort()).toEqual(["org/Glm", MODEL].sort());
  } finally { setUsageSink(undefined); }
}, 120_000);

test("a candidate off the frontier is neither measured again nor used, for the chosen model or a simple Skill", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "sponsor-frontier-"));
  dirs.push(dataDir);
  const store = new CrosslineStore(":memory:");
  const gateway = { urlFor: (workspaceId: string, providerId: string) => `http://127.0.0.1:1/${workspaceId}/${providerId}`, port: 1, close: async () => {} };
  // "org/Dear" costs more per run and is slower at the same pass rate; "org/New" has no record yet.
  const env = { CROSSLINE_SPONSOR_API_KEY: "sk-test", CROSSLINE_SPONSOR_MODELS: `org/Dear=8:28:1024,${MODEL}=2:8:1024,org/New=0.4:3.2:262` } as NodeJS.ProcessEnv;
  const record = (model: string, ms: number) => summarizeConformance({ providerId: "sponsor", model, runtimeVersion: RUNTIME_VERSION, ranAt: NOW.toISOString() },
    conformanceCases().flatMap((item) => Array.from({ length: item.runs }, () => ({ caseId: item.id, ok: true, repairs: 0, ms }))));
  const tokens = { input: 100_000, cached: 0, output: 10_000, runs: 10 };
  writeFileSync(path.join(dataDir, "sponsor.json"), JSON.stringify({ evaluations: [
    { model: "org/Dear", record: record("org/Dear", 2000), yuanPerRun: 0, tokens, version: SPONSOR_EVAL_VERSION, effortVersion: SPONSOR_EFFORT_VERSION },
    { model: MODEL, record: record(MODEL, 900), yuanPerRun: 0, tokens, version: SPONSOR_EVAL_VERSION, effortVersion: SPONSOR_EFFORT_VERSION }] }));
  const measured: string[] = [];
  const { rpc } = scriptedRuntime(["crossline:crossline-conformance", "crossline:crossline-onboarding"], (prompt) => { measured.push(prompt); return "{}"; }, { usage: { input: 1000, output: 100 } });
  const providers = createModelProviderService({ store, cwd: dataDir, gateway, signedIn: () => false, client: async () => undefined,
    secrets: { read: async () => undefined, write: async () => {}, remove: () => {} } as never, search: null, image: null, sponsor: () => undefined, now: () => NOW });
  const sponsor = createSponsorService({ store, dataDir, cwd: dataDir, gateway, capabilities: providers.capabilities, client: () => rpc, env, now: () => NOW,
    fetch: (async () => new Response(JSON.stringify({ data: [{ id: "org/Dear" }, { id: MODEL }] }), { status: 200 })) as typeof fetch });
  setUsageSink((usage) => { sponsor.noteEvalUsage(usage); });
  try {
    const result = await sponsor.evaluate();
    // The new candidate the key does not list is skipped; the dominated one is not measured again.
    expect(result).toMatchObject({ tested: [], skipped: ["org/New"], chosen: MODEL });
    expect(measured).toEqual([]);
    expect(sponsor.modelFor("crossline-task-titler")).toBe(MODEL);
    // Written down for good: with the record that beat it gone (a later measuring version), it is still not measured.
    const saved = JSON.parse(readFileSync(path.join(dataDir, "sponsor.json"), "utf8")) as { evaluations: Array<{ model: string }>; pruned: Record<string, { by: string }> };
    expect(saved.pruned["org/Dear"]?.by).toBe(MODEL);
    writeFileSync(path.join(dataDir, "sponsor.json"), JSON.stringify({ ...saved, evaluations: saved.evaluations.filter((item) => item.model === "org/Dear") }));
    const again = await sponsor.evaluate();
    expect(again.tested).toEqual([MODEL]);
    expect(existsSync(path.join(dataDir, "sponsor-eval", "org_Dear.jsonl"))).toBe(false);
  } finally { setUsageSink(undefined); }
}, 60_000);

test("the owner's main and planning models are held whatever the automatic choice, and a pruning made under the old rule is dropped", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "sponsor-pinned-"));
  dirs.push(dataDir);
  const store = new CrosslineStore(":memory:");
  const gateway = { urlFor: (workspaceId: string, providerId: string) => `http://127.0.0.1:1/${workspaceId}/${providerId}`, port: 1, close: async () => {} };
  // As on 2026-10-21: "org/Cheap" is cheaper and faster than both, but needed repairs where they did not.
  const models = `${MODEL}=2:8:1024,org/Glm=0.8:2.8:1024,org/Cheap=0.4:3.2:1024`;
  const record = (model: string, ms: number, repaired: boolean) => summarizeConformance({ providerId: "sponsor", model, runtimeVersion: RUNTIME_VERSION, ranAt: NOW.toISOString() },
    conformanceCases().flatMap((item, index) => Array.from({ length: item.runs }, () => ({ caseId: item.id, ok: true, repairs: repaired && index % 5 === 0 ? 1 : 0, ms }))));
  const tokens = { input: 100_000, cached: 0, output: 10_000, runs: 10 };
  const evaluation = (model: string, ms: number, repaired: boolean) => ({ model, record: record(model, ms, repaired), yuanPerRun: 0, tokens,
    version: SPONSOR_EVAL_VERSION, effortVersion: SPONSOR_EFFORT_VERSION, dialogueVersion: SPONSOR_DIALOGUE_VERSION });
  // Pruned on cost and speed alone, before the repair share was compared.
  const pruned = { [MODEL]: { by: "org/Cheap", at: NOW.toISOString(), version: SPONSOR_EVAL_VERSION }, "org/Glm": { by: "org/Cheap", at: NOW.toISOString(), version: SPONSOR_EVAL_VERSION } };
  writeFileSync(path.join(dataDir, "sponsor.json"), JSON.stringify({ evaluations: [evaluation(MODEL, 2000, false), evaluation("org/Glm", 4000, false),
    evaluation("org/Cheap", 500, true)], lastChosen: evaluation("org/Cheap", 500, true), pruned }));
  const { rpc } = scriptedRuntime(["crossline:crossline-conformance", "crossline:crossline-onboarding"], () => "{}", { usage: { input: 1000, output: 100 } });
  const providers = createModelProviderService({ store, cwd: dataDir, gateway, signedIn: () => false, client: async () => undefined,
    secrets: { read: async () => undefined, write: async () => {}, remove: () => {} } as never, search: null, image: null, sponsor: () => undefined, now: () => NOW });
  const service = (extra: Record<string, string>) => createSponsorService({ store, dataDir, cwd: dataDir, gateway, capabilities: providers.capabilities,
    client: () => rpc, now: () => NOW, env: { CROSSLINE_SPONSOR_API_KEY: "sk-test", CROSSLINE_SPONSOR_MODELS: models, ...extra } as NodeJS.ProcessEnv,
    fetch: (async () => new Response(JSON.stringify({ data: [{ id: MODEL }, { id: "org/Glm" }, { id: "org/Cheap" }] }), { status: 200 })) as typeof fetch });
  // Left to the automatic choice, the cheapest that passed serves; the old prunings no longer stand, so nothing is pruned.
  const automatic = service({});
  expect(automatic.chosen()?.model).toBe("org/Cheap");
  expect(automatic.modelFor("crossline-step-planner")).toBe("org/Cheap");
  // The owner's main model serves the main Skills, the planning model the planning Skills.
  const pinned = service({ CROSSLINE_SPONSOR_MAIN_MODEL: MODEL, CROSSLINE_SPONSOR_PLANNING_MODEL: "org/Glm" });
  expect(pinned.chosen()?.model).toBe(MODEL);
  expect(pinned.modelFor("crossline-automation-stripper")).toBe(MODEL);
  expect(pinned.modelFor("crossline-step-planner")).toBe("org/Glm");
  expect(pinned.modelFor("crossline-goal-backplanner")).toBe("org/Glm");
  // A run of the evaluation measures nothing (every record is current), keeps the main model as the last choice and drops the old prunings.
  const result = await pinned.evaluate();
  expect(result).toMatchObject({ tested: [], chosen: MODEL });
  const saved = JSON.parse(readFileSync(path.join(dataDir, "sponsor.json"), "utf8")) as { lastChosen: { model: string }; pruned: Record<string, unknown> };
  expect(saved.lastChosen.model).toBe(MODEL);
  expect(saved.pruned).toEqual({});
}, 60_000);

test("a model the owner named for a use is never pruned, even by a candidate that beats it on every count", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "sponsor-pinned-prune-"));
  dirs.push(dataDir);
  const store = new CrosslineStore(":memory:");
  const gateway = { urlFor: (workspaceId: string, providerId: string) => `http://127.0.0.1:1/${workspaceId}/${providerId}`, port: 1, close: async () => {} };
  const record = (model: string, ms: number) => summarizeConformance({ providerId: "sponsor", model, runtimeVersion: RUNTIME_VERSION, ranAt: NOW.toISOString() },
    conformanceCases().flatMap((item) => Array.from({ length: item.runs }, () => ({ caseId: item.id, ok: true, repairs: 0, ms }))));
  const tokens = { input: 100_000, cached: 0, output: 10_000, runs: 10 };
  const evaluation = (model: string, ms: number) => ({ model, record: record(model, ms), yuanPerRun: 0, tokens, version: SPONSOR_EVAL_VERSION,
    effortVersion: SPONSOR_EFFORT_VERSION, dialogueVersion: SPONSOR_DIALOGUE_VERSION });
  writeFileSync(path.join(dataDir, "sponsor.json"), JSON.stringify({ evaluations: [evaluation("org/Glm", 4000), evaluation(MODEL, 900)] }));
  const { rpc } = scriptedRuntime(["crossline:crossline-conformance", "crossline:crossline-onboarding"], () => "{}", { usage: { input: 1000, output: 100 } });
  const providers = createModelProviderService({ store, cwd: dataDir, gateway, signedIn: () => false, client: async () => undefined,
    secrets: { read: async () => undefined, write: async () => {}, remove: () => {} } as never, search: null, image: null, sponsor: () => undefined, now: () => NOW });
  // "org/Glm" costs more per run and is slower than MODEL at the same pass rate and repair share: dominated, but named for planning.
  const sponsor = createSponsorService({ store, dataDir, cwd: dataDir, gateway, capabilities: providers.capabilities, client: () => rpc, now: () => NOW,
    env: { CROSSLINE_SPONSOR_API_KEY: "sk-test", CROSSLINE_SPONSOR_MODELS: `org/Glm=8:28:1024,${MODEL}=2:8:1024`, CROSSLINE_SPONSOR_PLANNING_MODEL: "org/Glm" } as NodeJS.ProcessEnv,
    fetch: (async () => new Response(JSON.stringify({ data: [{ id: "org/Glm" }, { id: MODEL }] }), { status: 200 })) as typeof fetch });
  await sponsor.evaluate();
  const saved = JSON.parse(readFileSync(path.join(dataDir, "sponsor.json"), "utf8")) as { pruned?: Record<string, unknown> };
  expect(saved.pruned?.["org/Glm"]).toBeUndefined();
  expect(sponsor.modelFor("crossline-step-planner")).toBe("org/Glm");
  expect(sponsor.chosen()?.model).toBe(MODEL);
}, 60_000);
