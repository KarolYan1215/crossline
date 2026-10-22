import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore, type StoredProfileFact } from "@crossline/db";
import { existingTaskIds, validateAnalysisContext, validateAnalysisProposal } from "@crossline/core";
import { analysisLedger, buildAnalysisContext, createCaptureAnalyzer } from "./analysis";
import { factLedger, relevantFacts } from "./material-context";
import { ledgerId, ledgerLookup, ledgerSummary } from "./ledger-index";
import { createStepPlanner } from "./step-planner";
import { fakeRuntime, scriptedRuntime } from "./testing/fake-runtime";
import { setProviderResolver } from "@crossline/codex";

/** The ledger index (token-economy.md §2): one short line per entry where the route calls functions, read whole through read_ledger. */

const WS = "personal-crossline";
const now = "2026-10-21T00:00:00.000Z";
const fact = (identityId: string, projectId: string, slot: string, value: string): StoredProfileFact =>
  ({ workspaceId: WS, identityId, projectId, slot, value, status: "confirmed", sourceRef: "", sourceQuote: "", updatedAt: now });
const LONG = "期中考试覆盖第 1 到第 7 讲，题型为计算与推导，允许一张手写公式纸；去年平均分 72，本人目标 85 分以上，需要重点复习时序分析与功耗估算两章";

test("a summary is whole when short and cut with 「…」 at 60 characters; an id is stable for its key", () => {
  expect(ledgerSummary("每周三组会")).toBe("每周三组会");
  expect(ledgerSummary(LONG)).toBe(`${LONG.slice(0, 60)}…`);
  expect(ledgerId("f", "research|ece548|grading")).toBe(ledgerId("f", "research|ece548|grading"));
  const taken = new Set<string>();
  expect(ledgerId("f", "a", taken)).not.toBe(ledgerId("f", "a", taken));
});

test("facts: the task's own and those naming its terms carry their opening, the line's others only their slot, every one readable whole", () => {
  const facts = [fact("research", "ece548", "grading", LONG), fact("research", "", "timing", "midterm 前要复习 timing"),
    fact("research", "mos2", "date_20261102_review", "2026-11-02 MoS₂ 评审"), fact("startup", "", "funding", "天使轮")];
  const task = { query: "ECE 548 midterm timing", projectId: "ece548", identityId: "research" };
  const ledger = factLedger(facts, task);
  expect(ledger.full).toEqual(relevantFacts(facts, task));
  expect(ledger.index).toHaveLength(3);
  const [grading, timing, other] = ledger.index;
  expect(grading).toMatch(/^f[0-9a-f]{5} grading：期中考试/);
  expect(grading!.endsWith("…")).toBe(true);
  expect(timing).toMatch(/timing：midterm 前要复习 timing$/);
  expect(other).toMatch(/^f[0-9a-f]{5} \[mos2\] date_20261102_review：…$/);
  expect(ledger.index.some((line) => line.includes("funding"))).toBe(false);
  // Same facts, same ids: the index reads the same on the next run.
  expect(factLedger(facts, task).index).toEqual(ledger.index);

  const id = grading!.split(" ")[0]!;
  const read = String(ledger.tools.call("read_ledger", { ids: [id, "f00000"] }));
  expect(read).toContain(LONG);
  expect(read).toContain("f00000：没有这个 id 的条目");
  expect(ledger.stats()).toMatchObject({ readCalls: 1, readIds: 1 });
});

test("read_ledger stops at its budget for the run and says so", () => {
  const entries = Array.from({ length: 5 }, (_, index) => ({ id: `e${index}`, label: "条目", text: "字".repeat(300) }));
  const lookup = ledgerLookup(entries, 700);
  expect(String(lookup.tools.call("read_ledger", { ids: ["e0", "e1"] }))).not.toContain("上限");
  expect(String(lookup.tools.call("read_ledger", { ids: ["e2"] }))).toContain("本次读取已到上限");
  expect(lookup.stats().readIds).toBe(2);
});

let store: CrosslineStore;
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  store.capture({ id: "c", ownerId: "local-owner", workspaceId: WS, title: "ECE 548 期中复习再加一章", context: "" }, "capture:c");
  store.saveMilestone({ id: "m", ownerId: "local-owner", workspaceId: WS, identityId: "research", projectId: "ece548", title: "期中 85 分", version: 1, status: "approved" });
  store.saveWorkOrder({ id: "wo-review", ownerId: "local-owner", workspaceId: WS, identityId: "research", projectId: "ece548", milestoneId: "m",
    intent: `复习 ECE 548 期中：${LONG}`, state: "approved", riskTier: "routine",
    estimate: { p25Minutes: 30, p50Minutes: 60, p85Minutes: 120, source: "llm_prior", observationCount: 0, confidence: "low" },
    payload: { title: "复习 ECE 548 期中", dueDate: "2026-11-02" } });
  store.saveWorkOrder({ id: "wo-hw", ownerId: "local-owner", workspaceId: WS, identityId: "research", projectId: "ece548", milestoneId: "",
    intent: "完成 ECE 548 作业 3", state: "approved", riskTier: "routine",
    estimate: { p25Minutes: 30, p50Minutes: 60, p85Minutes: 120, source: "llm_prior", observationCount: 0, confidence: "low" },
    payload: { title: "完成 ECE 548 作业 3" } });
});
afterEach(() => store.close());

test("the analysis index: open tasks as one line each, ids readable and namable, the whole context unchanged", () => {
  const context = buildAnalysisContext(store, WS, { id: "c", title: "ECE 548 期中复习再加一章", context: "" });
  expect(context.taskIndex).toEqual([]);
  expect(context.existingTasks!.map((task) => task.id).sort()).toEqual(["wo-hw", "wo-review"]);
  const ledger = analysisLedger(context, store, WS);
  expect(ledger.indexed.existingTasks).toEqual([]);
  const lines = ledger.indexed.taskIndex!;
  expect(lines.find((line) => line.startsWith("wo-review｜"))).toMatch(/^wo-review｜复习 ECE 548 期中｜research\/ece548｜截止 2026-11-02｜approved｜复习 ECE 548 期中：.*…$/);
  // A description that only repeats the title is left out.
  expect(lines.find((line) => line.startsWith("wo-hw｜"))).toBe("wo-hw｜完成 ECE 548 作业 3｜research/ece548｜无截止｜approved");
  expect([...existingTaskIds(ledger.indexed)].sort()).toEqual(["wo-hw", "wo-review"]);
  expect(String(ledger.tools.call("read_ledger", { ids: ["wo-review"] }))).toContain(LONG);

  // An answer naming an indexed task keeps it, against the index as against the whole context.
  const answer = { identityId: "research", projectId: "ece548", milestoneId: "m", title: "复习 ECE 548 期中", intent: "再复习一章", family: "deep_work",
    automationParts: [], humanCore: [{ id: "h", intent: "复习", energy: "medium", interruptible: true, quote: "ECE 548 期中复习再加一章", rationale: "本人" }],
    materialContract: [], evidenceContract: [{ kind: "record", description: "复习记录", why: "交付物", required: true }],
    estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior", observationCount: 0, confidence: "low" }, riskTier: "routine",
    blockers: [], estimateBreakdown: [{ step: "复习", minutes: 20 }], dates: [], waitingOn: { who: "", what: "", expectedDate: "", quote: "" },
    byproducts: [], completion: { mode: "self_evident", reason: "", why: "复习", question: "", askAfterHours: 0 }, extendsTaskId: "wo-review" };
  expect(validateAnalysisProposal(answer, ledger.indexed).extendsTaskId).toBe("wo-review");
  expect(validateAnalysisProposal(answer, context).extendsTaskId).toBe("wo-review");
});

test("a context stored before the task index still reads", () => {
  const context = buildAnalysisContext(store, WS, { id: "c", title: "x", context: "" });
  const { taskIndex: _dropped, ...stored } = context;
  expect(validateAnalysisContext(stored).taskIndex).toEqual([]);
});

for (const functionCalls of [true, false]) test(`the step planner's facts: ${functionCalls ? "an index with read_ledger where the route calls functions" : "whole where it does not"}`, async () => {
  if (!functionCalls) setProviderResolver(() => ({ provider: { id: "sf", kind: "chat", label: "SF", baseUrl: "https://api.siliconflow.cn/v1", model: "glm",
    keyLast4: "abcd", updatedAt: now }, gatewayUrl: "http://127.0.0.1:5555/x", admitted: new Set(["crossline-step-planner"]), codexSignedIn: false, functionCalls: false }));
  try {
    store.upsertProfileFact(fact("research", "ece548", "exam_scope", LONG));
    const plan = { archetypeId: "problem_set", quantity: { basis: "题目数", amount: 1, unit: "题" }, rationale: "", steps: [{ id: "s", role: "solve", title: "解题",
      deliverable: "答案", doneCriterion: "完成 1 题", share: 1, estimate: { p25Minutes: 20, p50Minutes: 30, p85Minutes: 50 }, dependsOn: [], notBefore: "", dueBy: "",
      schedulable: true, executor: "human", tickOutcome: "" }] };
    const runtime = scriptedRuntime(["crossline:crossline-step-planner"], () => JSON.stringify(plan));
    await createStepPlanner(store, WS, "C:\\repo", () => runtime.rpc)("wo-hw");
    const prompt = runtime.prompts()[0]!;
    if (functionCalls) {
      // The step planner names facts by the run's short ids (createRefBook), so usedRefs and read_ledger use the same ones.
      expect(prompt).toMatch(/f\d+ exam_scope：期中考试.*…/);
      expect(prompt).not.toContain(LONG);
    } else expect(prompt).toContain(`exam_scope：${LONG}`);
  } finally { setProviderResolver(undefined); }
});

test("on the account's own Codex the analysis is sent the index with read_ledger", async () => {
  const runtime = fakeRuntime([JSON.stringify({ identityId: "research", projectId: "ece548", milestoneId: "m", intent: "再复习一章", family: "deep_work",
    automationParts: [], humanCore: [{ id: "h", intent: "复习", energy: "medium", interruptible: true, quote: "ECE 548 期中复习再加一章", rationale: "本人" }],
    materialContract: [], evidenceContract: [{ kind: "record", description: "复习记录", why: "交付物", required: true }],
    estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior", observationCount: 0, confidence: "low" }, riskTier: "routine", blockers: [] })],
  "crossline:crossline-automation-stripper");
  const outcome = await createCaptureAnalyzer(store, WS, "C:\\repo")(runtime.rpc, "c");
  expect(outcome.state).not.toBe("blocked");
  expect((runtime.threadStarts()[0]!.dynamicTools as Array<{ name: string }>).map((tool) => tool.name)).toEqual(["read_ledger"]);
  expect(runtime.prompts()[0]).toContain("wo-hw｜完成 ECE 548 作业 3");
  expect(runtime.prompts()[0]).not.toContain(LONG);
});
