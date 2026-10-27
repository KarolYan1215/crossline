import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore, createRefBook, extractLessons, lessonsFor, lessonsPass, withRef, type StepPlanInput } from "./index";

let store: CrosslineStore;
beforeEach(() => { store = new CrosslineStore(":memory:"); });
afterEach(() => store.close());

const estimate = { p25Minutes: 20, p50Minutes: 30, p85Minutes: 40, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const };
const order = (id: string, payload: Record<string, unknown> = {}, identityId = "media") => store.saveWorkOrder({ id, ownerId: "o", workspaceId: "w", identityId,
  projectId: "p", milestoneId: "", intent: `任务 ${id}`, state: "approved", riskTier: "routine", payload: { title: `任务 ${id}`, ...payload }, estimate });
const plan = (archetypeId = "draft_publish"): StepPlanInput => ({ archetypeId, quantity: { basis: "篇", amount: 1, unit: "篇" }, rationale: "r",
  steps: [{ id: "s1", role: "draft", title: "写初稿", deliverable: "d", doneCriterion: "c", share: 1, estimate: { p25Minutes: 20, p50Minutes: 30, p85Minutes: 40 },
    dependsOn: [], notBefore: "", dueBy: "", schedulable: true, executor: "human", tickOutcome: "" }] });
const event = (type: string, entityId: string, payload: Record<string, unknown>, key = `${type}:${entityId}:${JSON.stringify(payload)}`) =>
  store.appendEvent({ ownerId: "o", workspaceId: "w", idempotencyKey: key, type, entityId, payload });

test("the rules draw lessons from a rejected result, a 「部分符合」, an overrun and a repeated error, once each, with no model", () => {
  order("wo-1");
  store.saveStepPlan("w", "wo-1", plan(), "o", "initial");
  event("agent.task.requested", "t1", { title: "小红书提纲", category: "draft_text", workOrderId: "wo-1" });
  event("agent.task.reviewed", "t1", { decision: "rejected", note: "要先制造冲突再给方案，不要写成研究报告" });
  event("agent.task.requested", "t2", { title: "素材清单", category: "draft_text", workOrderId: "wo-1" });
  event("agent.task.reviewed", "t2", { decision: "accepted", note: "很好" });
  order("wo-2", { gateReview: { verdict: "partial", fit: { fits: false, violated: ["开头三秒抛出冲突"], why: "开头平铺直叙" } } });
  const step = store.getStepPlan("w", "wo-1")!.steps[0]!;
  event("block.confirmed", "m1", { workOrderId: "wo-1", stepId: step.id, outcome: "over", minutes: 50, blockMinutes: 30 });
  event("block.confirmed", "m2", { workOrderId: "wo-1", stepId: step.id, outcome: "as_estimated", blockMinutes: 30 });
  const usage = { workspaceId: "w", skill: "crossline:crossline-step-planner", tier: "mid", model: "m", effort: "low", spendMode: "normal", threadId: "",
    ok: false, errorCode: "SKILL_SCHEMA_INVALID", repairs: 2, turns: 3, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0,
    durationMs: 0, at: "2026-10-20T00:00:00.000Z" };
  for (let i = 0; i < 3; i += 1) store.saveModelUsage(usage);
  for (let i = 0; i < 5; i += 1) store.saveModelUsage({ ...usage, errorCode: "SKILL_THREAD_LOST" });

  const now = new Date("2026-10-21T12:00:00.000Z");
  expect(extractLessons(store, "w", now)).toEqual({ review: 1, gate: 1, overrun: 1, error: 1 });
  // A second run adds nothing: every lesson is keyed on what it came from.
  expect(extractLessons(store, "w", now)).toEqual({ review: 0, gate: 0, overrun: 0, error: 0 });
  const lessons = store.listLessons("w");
  expect(lessons.map((lesson) => lesson.source).sort()).toEqual(["rule:error_repeat", "rule:estimate_overrun", "rule:gate_partial", "rule:review_note"]);
  expect(lessons.find((lesson) => lesson.source === "rule:review_note")).toMatchObject({ lineId: "media", archetypeId: "draft_publish", kind: "failure" });
  expect(lessons.find((lesson) => lesson.source === "rule:estimate_overrun")!.text).toContain("实际约 80 分钟，保守估计 40 分钟");

  // The planner gets this line's lessons and its own repeated error; the assistant is not given the planner's error.
  const forPlanner = lessonsFor(store, "w", { lineId: "media", archetypeId: "draft_publish", skill: "crossline:crossline-step-planner" });
  expect(forPlanner.map((lesson) => lesson.source)).toContain("rule:error_repeat");
  expect(forPlanner.length).toBeLessThanOrEqual(5);
  expect(forPlanner.reduce((sum, lesson) => sum + lesson.text.length, 0)).toBeLessThanOrEqual(600);
  expect(lessonsFor(store, "w", { lineId: "media", skill: ["crossline-agent", "crossline-agent-tools"] }).map((lesson) => lesson.source)).not.toContain("rule:error_repeat");
  expect(lessonsFor(store, "w", { lineId: "research", skill: "crossline-step-planner" }).map((lesson) => lesson.source)).toEqual(["rule:error_repeat"]);
});

test("cited ids are counted when the answer takes effect, and order what a context gets", () => {
  store.upsertProfileFact({ workspaceId: "w", identityId: "media", projectId: "p", slot: "audience", value: "大学生", status: "confirmed", sourceRef: "r", sourceQuote: "", updatedAt: "2026-10-01T00:00:00.000Z" });
  const a = store.addPreference({ workspaceId: "w", source: "estimate", scope: "media", weight: 0.3, refId: "a", text: "估时放宽" });
  const b = store.addPreference({ workspaceId: "w", source: "estimate", scope: "media", weight: 0.3, refId: "b", text: "写作上午做" });
  const book = createRefBook();
  const fact = store.listProfileFacts("w")[0]!;
  expect(withRef(book.fact(fact), "x")).toBe("[f1] x");
  expect(book.pref(a)).toBe("p1");
  expect(book.pref(b)).toBe("p2");
  expect(book.pref(a)).toBe("p1");
  const refs = book.resolve(["[p2]", "f1", "f9", 3]);
  expect(refs).toEqual([{ kind: "pref", id: b.id }, { kind: "fact", identityId: "media", projectId: "p", slot: "audience" }]);
  expect(store.markUsed("w", refs, "2026-10-21T00:00:00.000Z")).toBe(2);
  expect(store.listProfileFacts("w")[0]).toMatchObject({ useCount: 1, lastUsedAt: "2026-10-21T00:00:00.000Z" });
  // The used preference now comes first among equals.
  expect(store.preferenceLines("w", ["media"])).toEqual(["写作上午做", "估时放宽"]);

  // A proposal's cited preferences count once it takes effect, and once only.
  store.saveWorkOrder({ id: "wo-9", ownerId: "o", workspaceId: "w", identityId: "media", projectId: "p", milestoneId: "", intent: "x", state: "awaiting_plan_approval",
    riskTier: "routine", payload: { usedRefKeys: [{ kind: "pref", id: a.id }] }, estimate });
  store.transitionWorkOrder("w", "wo-9", { type: "plan.approved", approvalId: "o" }, "approve:wo-9");
  expect(store.listPreferences("w").find((entry) => entry.id === a.id)?.useCount).toBe(1);
});

test("an edit-read preference lapses after 30 days unused, can be restored for good; a lesson lapses after 60", () => {
  const old = "2026-09-01T00:00:00.000Z";
  const lapsing = store.addPreference({ workspaceId: "w", source: "estimate", scope: "media", weight: 0.3, refId: "a", text: "估时放宽", createdAt: old });
  store.addPreference({ workspaceId: "w", source: "correction", scope: "media", weight: 1, refId: "", text: "先冲突后方案", createdAt: old });
  const used = store.addPreference({ workspaceId: "w", source: "importance", scope: "media", weight: 0.3, refId: "b", text: "这条线重要", createdAt: old });
  store.markUsed("w", [{ kind: "pref", id: used.id }], "2026-10-15T00:00:00.000Z");
  store.saveLesson({ workspaceId: "w", lineId: null, archetypeId: null, kind: "failure", text: "旧教训", source: "rule:x", sourceRef: "1", keywords: "", createdAt: "2026-08-01T00:00:00.000Z" });
  const result = lessonsPass(store, "w", new Date("2026-10-21T12:00:00.000Z"));
  expect(result?.lapsed).toEqual({ preferences: 1, lessons: 1 });
  expect(lessonsPass(store, "w", new Date("2026-10-21T13:00:00.000Z"))).toBeUndefined();
  expect(store.preferenceLines("w", ["media"])).toEqual(["先冲突后方案", "这条线重要"]);
  expect(store.listPreferences("w", { includeInvalidated: true }).find((entry) => entry.id === lapsing.id)?.invalidatedAt).toBeTruthy();
  expect(store.restorePreference("w", lapsing.id)).toBe(true);
  expect(store.expireUnused("w", new Date("2027-01-01T00:00:00.000Z")).preferences).toBe(1);
  expect(store.preferenceLines("w", ["media"])).toContain("估时放宽");
  expect(store.listLessons("w")).toHaveLength(0);
  expect(store.listLessons("w", { includeInvalidated: true })).toHaveLength(1);
});

test("lessons travel with an export and a restore, and go with the workspace", () => {
  store.saveLesson({ workspaceId: "w", lineId: "media", archetypeId: null, kind: "preference", text: "先冲突后方案", source: "codex-memory", sourceRef: "t:1", keywords: "" });
  const snapshot = store.exportSnapshot("w");
  expect(snapshot.tables.run_lessons).toHaveLength(1);
  const restored = new CrosslineStore(":memory:");
  restored.importSnapshot(snapshot);
  expect(restored.listLessons("w").map((lesson) => lesson.text)).toEqual(["先冲突后方案"]);
  restored.close();
  store.purgeWorkspace("w");
  expect(store.listLessons("w", { includeInvalidated: true })).toHaveLength(0);
});
