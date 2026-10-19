import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { conformanceCases, summarizeConformance } from "@crossline/core";
import { decideRoute, setUsageSink } from "@crossline/codex";
import { CrosslineStore, SPONSOR_SETTING } from "@crossline/db";
import { createModelProviderService, RUNTIME_VERSION } from "./model-provider";
import { createSponsorService, extractRecall, SPONSOR_DIALOGUE_SCRIPT, SPONSOR_EVAL_VERSION, SPONSOR_EXTRACT_EXPECTED, type SponsorDialogueLog, type SponsorExtractLog, type SponsorRunLog } from "./sponsor";
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
  const { rpc } = scriptedRuntime(["crossline:crossline-conformance", "crossline:crossline-onboarding"], () => "{}");
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
    expect(lines).toHaveLength(conformanceCases().reduce((sum, item) => sum + item.runs, 0));
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
