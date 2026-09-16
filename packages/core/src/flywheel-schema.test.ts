import { expect, test } from "vitest";
import { validateFlywheelExpansion, type FlywheelContext } from "./flywheel-schema";

const context: FlywheelContext = {
  version: "crossline.flywheel.v1",
  openMilestones: [{ id: "m1", identityId: "research", title: "稳定推进实验", successCriteria: [] }],
  recentOutputs: []
};
const finding = (over: Record<string, unknown> = {}) => ({
  milestoneId: "m1", summary: "一种更快的标定方法", sourceUrl: "https://example.org/paper",
  sourceTitle: "A faster calibration", retrievedAt: "2026-09-20T03:00:00.000Z",
  staleWhen: "该方法被后续工作证伪，或仪器换代", helpsHow: "可直接用于第二条成功标准", ...over
});

test("a finding must hang off a milestone that exists, or it is just a feed item", () => {
  expect(() => validateFlywheelExpansion({ findings: [finding({ milestoneId: "nope" })], blockers: [] }, context))
    .toThrow("FLYWHEEL_MILESTONE_UNKNOWN");
  expect(validateFlywheelExpansion({ findings: [finding()], blockers: [] }, context).findings).toHaveLength(1);
});

test("a finding without a real source or a retrieval date cannot be checked later, so it is refused", () => {
  for (const bad of [{ sourceUrl: "" }, { sourceUrl: "not-a-url" }, { retrievedAt: "sometime" }]) {
    expect(() => validateFlywheelExpansion({ findings: [finding(bad)], blockers: [] }, context))
      .toThrow("FLYWHEEL_SOURCE_REQUIRED");
  }
});

test("every finding must say what would make it stale", () => {
  expect(() => validateFlywheelExpansion({ findings: [finding({ staleWhen: "  " })], blockers: [] }, context))
    .toThrow("FLYWHEEL_STALENESS_REQUIRED");
});

test("an empty expansion is valid: finding nothing is a real outcome", () => {
  // An answer that predates `relations` is not rejected for lacking a field it never had; it simply
  // proposes none.
  expect(validateFlywheelExpansion({ findings: [], blockers: [] }, context))
    .toEqual({ findings: [], relations: [], blockers: [] });
});

const relation = (overrides: Record<string, unknown> = {}) => ({
  fromMilestoneId: "m1", toMilestoneId: "m2", kind: "reuses",
  explanation: "m1 产出的访谈记录可以直接当作 m2 的素材来源。",
  refutedWhen: "如果 m2 的素材要求改为需要一手影像，这条就不成立。",
  sourceUrl: "https://example.org/guide", sourceTitle: "Guide", retrievedAt: "2026-09-16",
  ...overrides
});
const expansion = (relations: unknown[]) => ({ findings: [], relations, blockers: [] });
// A relation needs two ends, so these tests use their own context rather than widening the one the
// finding tests rely on.
const pair: FlywheelContext = {
  ...context,
  openMilestones: [
    ...context.openMilestones,
    { id: "m2", identityId: "media", title: "建立内容闭环", successCriteria: [] }
  ]
};

test("a relation must connect two different milestones that already exist", () => {
  expect(validateFlywheelExpansion(expansion([relation()]), pair).relations).toHaveLength(1);
  // Proposing a relation into a milestone the user never approved is how a research note quietly
  // becomes a new commitment.
  expect(() => validateFlywheelExpansion(expansion([relation({ toMilestoneId: "nope" })]), pair))
    .toThrow("FLYWHEEL_MILESTONE_UNKNOWN");
  expect(() => validateFlywheelExpansion(expansion([relation({ toMilestoneId: "m1" })]), pair))
    .toThrow("FLYWHEEL_RELATION_SELF_LOOP");
});

test("a relation without a falsifier is refused", () => {
  // Without `refutedWhen` the graph could only ever grow: nothing could ever show a relation wrong.
  expect(() => validateFlywheelExpansion(expansion([relation({ refutedWhen: "  " })]), pair))
    .toThrow("FLYWHEEL_RELATION_FALSIFIER_REQUIRED");
  expect(() => validateFlywheelExpansion(expansion([relation({ explanation: "" })]), pair))
    .toThrow("FLYWHEEL_RELATION_EXPLANATION_REQUIRED");
});

test("a relation is held to the same source standard as a finding", () => {
  expect(() => validateFlywheelExpansion(expansion([relation({ sourceUrl: "内部推断" })]), pair))
    .toThrow("FLYWHEEL_SOURCE_REQUIRED");
  expect(() => validateFlywheelExpansion(expansion([relation({ retrievedAt: "最近" })]), pair))
    .toThrow("FLYWHEEL_SOURCE_REQUIRED");
});

test("the same relation cannot be proposed twice in one run", () => {
  expect(() => validateFlywheelExpansion(expansion([relation(), relation()]), pair))
    .toThrow("FLYWHEEL_RELATION_DUPLICATE");
  // A different kind between the same pair is a different claim, so it is allowed.
  expect(validateFlywheelExpansion(expansion([relation(), relation({ kind: "informs" })]), pair).relations)
    .toHaveLength(2);
});
