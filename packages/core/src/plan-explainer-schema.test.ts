import { expect, test } from "vitest";
import { validatePlanExplanation, type PlanExplainerContext } from "./plan-explainer-schema";

const context: PlanExplainerContext = {
  version: "crossline.plan-explainer.v1",
  today: "2026-09-27",
  nextActionId: "w-1",
  alternativeIds: ["w-2"],
  activeWorkOrders: [
    { id: "w-1", intent: "写论文结果段", identityId: "research", estimateP50Minutes: 60, energy: "high", important: true, confirmedDeadline: null },
    { id: "w-2", intent: "整理关注清单", identityId: "investment", estimateP50Minutes: 20, energy: "low", important: false, confirmedDeadline: null }
  ],
  currentEnergy: "high",
  approvedMilestones: [{ id: "m-1", identityId: "research", title: "稳定推进当前实验与论文" }]
};

const output = (overrides: Partial<{ summary: string; nextActionReason: string; alternatives: Array<{ id: string; reason: string }>; blockers: Array<{ code: string; message: string }> }> = {}) => ({
  summary: "当前精力高，优先做需要高精力的写作任务。",
  nextActionReason: "所需精力与当前自评匹配，且没有更紧急的截止日期。",
  alternatives: [{ id: "w-2", reason: "所需精力低，适合精力不足时再做" }],
  blockers: [],
  ...overrides
});

test("a well-formed explanation passes through unchanged", () => {
  const result = validatePlanExplanation(output(), context);
  expect(result.nextActionReason).toContain("匹配");
});

test("citing a work order id the context never mentioned is refused", () => {
  expect(() => validatePlanExplanation(output({ alternatives: [{ id: "w-999", reason: "invented" }] }), context))
    .toThrow("PLAN_EXPLAINER_UNKNOWN_ID");
});

test("a reported blocker surfaces its message instead of being silently accepted", () => {
  expect(() => validatePlanExplanation(output({ blockers: [{ code: "PLAN_EXPLAINER_NO_INPUT", message: "没有可解释的排程" }] }), context))
    .toThrow("PLAN_EXPLAINER_BLOCKED");
});

test("a malformed shape is refused rather than passed through as-is", () => {
  expect(() => validatePlanExplanation({ summary: "x" }, context)).toThrow("PLAN_EXPLAINER_SCHEMA_INVALID");
});
