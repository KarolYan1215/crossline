import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore, personQuestionKey, recordPersonQuestion, joinPersonQuestion } from "@crossline/db";
vi.mock("server-only", () => ({}));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn(async () => ({})), CodexSupervisorRequestError: class extends Error {} }));
import { answerAsk, collectAsks, reviewAsks } from "./asks";
import { TEST_CTX } from "./test-support";

/** A Skill's `ask_person` question on 待确认 (docs/plans/harness-1125.md 「主动提问」): the card, the answer as a fact, the rerun. */
afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); });

const ws = TEST_CTX.workspaceId, owner = TEST_CTX.principalId;
const NOW = new Date("2026-11-25T15:00:00.000Z");
const estimate = { p25Minutes: 60, p50Minutes: 60, p85Minutes: 90, source: "llm_prior" as const, observationCount: 0, confidence: "high" as const };

function setup() {
  vi.stubEnv("CROSSLINE_FIXED_NOW", NOW.toISOString());
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.saveWorkOrder({ id: "hw4", ownerId: owner, workspaceId: ws, identityId: "research", projectId: "ece555", milestoneId: "", intent: "完成 ECE 555 作业 4",
    state: "approved", riskTier: "routine", estimate, payload: { dueDate: "2026-11-27" } });
  return store;
}
const question = (over: Record<string, unknown> = {}) => ({ question: "这次作业打算用 Python 还是 MATLAB？", why: "决定要不要排环境配置步骤", knownBy: "person" as const,
  options: ["Python", "MATLAB"], answerType: "choice" as const, assumption: "Python", blocking: true, skill: "crossline:crossline-step-planner",
  ref: { kind: "task" as const, id: "hw4" }, identityId: "research", projectId: "ece555", dueBy: "2026-11-27", origin: "own" as const, ...over });

test("a blocking question is a card on 待确认; its answer is the person's confirmed fact and the task's steps are planned again", async () => {
  const store = setup();
  const id = recordPersonQuestion(store, ws, question(), NOW.toISOString());
  const card = collectAsks(TEST_CTX, NOW).find((ask) => ask.kind === "skill_question")!;
  expect(card).toMatchObject({ id: `pq:${id}`, title: "这次作业打算用 Python 还是 MATLAB？", urgency: "now", important: true, line: "research" });
  expect(card.inReview).toBeUndefined();
  expect(card.options.map((option) => [option.label, option.recommended ?? false])).toEqual([["Python", true], ["MATLAB", false]]);
  expect(card.why).toContain("回答前按「Python」做");
  expect(await answerAsk(TEST_CTX, card.id, { optionIds: ["o1"] }, {}, NOW)).toMatchObject({ ok: true });
  const fact = store.listProfileFacts(ws).find((item) => item.sourceRef === personQuestionKey(id))!;
  expect(fact).toMatchObject({ status: "confirmed", sourceQuote: "MATLAB", projectId: "ece555" });
  expect(store.questionByKey(ws, personQuestionKey(id))).toMatchObject({ status: "answered", answer: "MATLAB" });
  const replan = store.listEvents(ws, { type: "task.steps_replan_requested", entityId: "hw4" });
  expect(replan).toHaveLength(1);
  expect(String((replan[0]!.payload as { feedback?: string }).feedback)).toContain("MATLAB");
  expect(collectAsks(TEST_CTX, NOW).some((ask) => ask.kind === "skill_question")).toBe(false);
});

test("a milestone waiting on the same question is worked backwards again; keeping the assumption reruns nothing", async () => {
  const store = setup();
  const id = recordPersonQuestion(store, ws, question({ blocking: false }), NOW.toISOString());
  joinPersonQuestion(store, ws, id, { skill: "crossline:crossline-goal-backplanner", ref: { kind: "milestone", id: "m-1" }, blocking: true });
  const card = collectAsks(TEST_CTX, NOW).find((ask) => ask.kind === "skill_question")!;
  expect(await answerAsk(TEST_CTX, card.id, { optionIds: [], note: "两个都用" }, {}, NOW)).toMatchObject({ ok: true });
  expect(store.listEvents(ws, { type: "goal.backplan_rerun_requested", entityId: "m-1" })).toHaveLength(1);
  // The task asked without blocking: nothing to redo there.
  expect(store.listEvents(ws, { type: "task.steps_replan_requested" })).toHaveLength(0);

  const second = recordPersonQuestion(store, ws, question({ question: "每周能给这门课几个小时？", answerType: "text", options: [], assumption: "6 小时" }), NOW.toISOString());
  const text = collectAsks(TEST_CTX, NOW).find((ask) => ask.id === `pq:${second}`)!;
  expect(await answerAsk(TEST_CTX, text.id, { optionIds: ["assume"] }, {}, NOW)).toMatchObject({ ok: true });
  expect(store.questionByKey(ws, personQuestionKey(second))).toMatchObject({ status: "assumed", answer: "6 小时" });
  expect(store.listEvents(ws, { type: "task.steps_replan_requested" })).toHaveLength(0);
});

test("a question that blocks nothing and is not due this week waits for the weekly review; one from an untrusted run says so", () => {
  const store = setup();
  recordPersonQuestion(store, ws, question({ blocking: false, dueBy: "", origin: "untrusted" }), NOW.toISOString());
  const card = collectAsks(TEST_CTX, NOW).find((ask) => ask.kind === "skill_question")!;
  expect(card.inReview).toBe(true);
  expect(card.tags).toEqual([{ kind: "type", label: "来自读过外部内容的运行" }]);
  expect(card.why).toContain("读过网页或邮件");
  expect(reviewAsks(TEST_CTX, NOW).some((ask) => ask.id === card.id)).toBe(true);
});

test("a question whose task closed is no longer asked", () => {
  const store = setup();
  recordPersonQuestion(store, ws, question(), NOW.toISOString());
  store.saveWorkOrder({ ...store.getWorkOrder(ws, "hw4")!, state: "archived" });
  expect(collectAsks(TEST_CTX, NOW).some((ask) => ask.kind === "skill_question")).toBe(false);
});
