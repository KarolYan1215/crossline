import { expect, test } from "vitest";
import { validateWeeklyInsight, type WeeklyInsightContext } from "./weekly-insight-schema";

const context: WeeklyInsightContext = {
  version: "crossline.weekly-insight.v1",
  period: { from: "2026-09-20T00:00:00.000Z", to: "2026-09-27T00:00:00.000Z" },
  executions: [
    { id: "e-1", workOrderId: "w-1", identityId: "research", family: "deep_work", startedAt: "2026-09-21T10:00:00.000Z", endedAt: "2026-09-21T11:00:00.000Z", pauseMinutes: 0, durationObserved: true },
    { id: "e-2", workOrderId: "w-2", identityId: "research", family: "deep_work", startedAt: "2026-09-22T10:00:00.000Z", endedAt: "2026-09-22T12:00:00.000Z", pauseMinutes: 10, durationObserved: true },
    { id: "e-3", workOrderId: "w-3", identityId: "research", family: "deep_work", startedAt: "2026-09-23T10:00:00.000Z", endedAt: "2026-09-23T13:00:00.000Z", pauseMinutes: 5, durationObserved: true }
  ],
  estimates: [{ workOrderId: "w-1", identityId: "research", family: "deep_work", p50Minutes: 60 }],
  energyObservations: [],
  notificationEvents: [{ id: "n-1", type: "work_order.transitioned", entityId: "w-1", createdAt: "2026-09-21T10:00:00.000Z" }],
  planChanges: [],
  approvedMilestones: [{ id: "m-1", identityId: "research", title: "稳定推进当前实验与论文" }]
};

const output = (overrides: Partial<{
  insightProposals: Array<{ id: string; claim: string; observationCount: number; period: string; supportingEventIds: string[]; counterexampleEventIds: string[]; proposedOverlayPatch: string }>;
  estimateUpdates: unknown[]; retentionActions: unknown[]; blockers: Array<{ code: string; message: string }>;
}> = {}) => ({
  insightProposals: [{ id: "insight-1", claim: "深度写作类任务实际耗时经常超过 p50 估时", observationCount: 3,
    period: "2026-09-20/2026-09-27", supportingEventIds: ["e-1", "e-2", "e-3"], counterexampleEventIds: [],
    proposedOverlayPatch: "把 research·deep_work 的 p50 从 60 分钟上调到 90 分钟" }],
  estimateUpdates: [], retentionActions: [], blockers: [],
  ...overrides
});

test("a well-formed result with three real observations passes through", () => {
  const result = validateWeeklyInsight(output(), context);
  expect(result.insightProposals).toHaveLength(1);
});

test("fewer than three observations is refused even if the model claims otherwise", () => {
  expect(() => validateWeeklyInsight(output({ insightProposals: [{ ...output().insightProposals[0]!, observationCount: 2 }] }), context))
    .toThrow("WEEKLY_INSIGHT_INSUFFICIENT_EVIDENCE");
});

test("citing an event id never supplied in context is refused", () => {
  expect(() => validateWeeklyInsight(output({
    insightProposals: [{ ...output().insightProposals[0]!, supportingEventIds: ["e-999"] }]
  }), context)).toThrow("WEEKLY_INSIGHT_UNKNOWN_EVENT_ID");
});

test("a reported blocker surfaces its message", () => {
  expect(() => validateWeeklyInsight(output({ blockers: [{ code: "WEEKLY_INSIGHT_NO_INPUT", message: "没有可分析的记录" }] }), context))
    .toThrow("WEEKLY_INSIGHT_BLOCKED");
});
