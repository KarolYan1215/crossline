import { describe, expect, test } from "vitest";
import { compareInGroup, currentStep, dueDistance, groupOf, stepSegments, waitReason, type CardDetail } from "./card-model";

type Step = NonNullable<CardDetail["stepPlan"]>["steps"][number];
const step = (id: string, over: Partial<Step> = {}): Step => ({
  id, workOrderId: "wo", seq: 1, role: "do", title: `步骤 ${id}`, deliverable: "", doneCriterion: "", share: 0.25,
  estimate: { p25Minutes: 20, p50Minutes: 30, p85Minutes: 45 }, dependsOn: [], schedulable: true, executor: "human",
  status: "planned", progressQuarter: 0, updatedAt: "2026-10-01T00:00:00Z", ...over
} as Step);
const plan = (steps: Step[]): NonNullable<CardDetail["stepPlan"]> => ({ archetypeLabel: "练习", quantity: { basis: "", amount: 0, unit: "" }, rationale: "", progress: 0.4, steps, units: [], questions: [] });
const detail = (over: Partial<CardDetail> = {}): CardDetail => ({ state: "approved", paused: false, window: {}, ...over });
const TODAY = "2026-10-15";

describe("the card's reading of a task", () => {
  test("the current step is the person's first open step; the assistant's preparation is skipped", () => {
    const d = detail({ stepPlan: plan([step("a", { status: "done" }), step("b", { executor: "agent" }), step("c"), step("d")]) });
    expect(currentStep(d)?.id).toBe("c");
    expect(stepSegments(d).map((segment) => segment.kind)).toEqual(["done", "agent", "current", "open"]);
    expect(stepSegments(d)[0]!.fill).toBe(1);
  });

  test("a step that waits makes the task wait, and says for what and from when", () => {
    const d = detail({ stepPlan: plan([step("a", { title: "等待 作业发布", schedulable: false, notBefore: "2026-10-20" })]) });
    expect(waitReason(d, TODAY)).toEqual({ kind: "input", label: "等待 · 作业发布（10/20 起）" });
    expect(stepSegments(d)[0]!.kind).toBe("waiting");
    expect(groupOf(d, { today: TODAY })).toBe("waiting");
  });

  test("each state that is not the person's to work on is a wait, with its reason", () => {
    expect(waitReason(detail({ state: "awaiting_plan_approval" }), TODAY)?.label).toBe("等本人批准 · 步骤规划中");
    expect(waitReason(detail({ state: "blocked", blocker: { reason: "证据不足" } }), TODAY)?.label).toBe("已退回 · 证据不足");
    expect(waitReason(detail({ state: "preparing", materialBlocker: { message: "缺讲义" } }), TODAY)?.label).toBe("材料准备已停止 · 缺讲义");
    expect(waitReason(detail({ state: "evidence_review" }), TODAY)?.kind).toBe("gate");
    expect(waitReason(detail({ window: { notBefore: "2026-10-18" } }), TODAY)?.label).toBe("10/18 起可开始");
    expect(waitReason(detail(), TODAY)).toBeUndefined();
  });

  test("the four groups: running or due today is now, a later block is next, the library and the finished apart", () => {
    expect(groupOf(detail({ state: "active" }), { today: TODAY, library: "2026-11-01" })).toBe("library");
    expect(groupOf(detail({ state: "active" }), { today: TODAY })).toBe("now");
    expect(groupOf(detail(), { today: TODAY, slot: { day: TODAY, start: "14:00", end: "15:00" } })).toBe("now");
    expect(groupOf(detail({ window: { dueBy: "2026-10-14" } }), { today: TODAY })).toBe("now");
    expect(groupOf(detail(), { today: TODAY, slot: { day: "2026-10-17", start: "09:00", end: "10:00" } })).toBe("next");
    expect(groupOf(detail(), { today: TODAY })).toBe("next");
    expect(groupOf(detail({ state: "accepted" }), { today: TODAY })).toBe("done");
  });

  test("now puts the running task first, then by today's time; waiting puts what asks the person first", () => {
    const entries = [
      { id: "later", detail: detail(), slot: { day: TODAY, start: "16:00", end: "17:00" } },
      { id: "running", detail: detail({ state: "active" }) },
      { id: "earlier", detail: detail(), slot: { day: TODAY, start: "09:00", end: "10:00" } }
    ];
    expect([...entries].sort(compareInGroup("now", TODAY)).map((entry) => entry.id)).toEqual(["running", "earlier", "later"]);
    const waiting = [
      { id: "gate", detail: detail({ state: "evidence_review" }) },
      { id: "approve", detail: detail({ state: "awaiting_plan_approval" }) },
      { id: "returned", detail: detail({ state: "blocked" }) }
    ];
    expect([...waiting].sort(compareInGroup("waiting", TODAY)).map((entry) => entry.id)).toEqual(["returned", "approve", "gate"]);
  });

  test("the due day says how far off it is", () => {
    expect(dueDistance("2026-10-15", TODAY)).toEqual({ text: "今天截止", overdue: false });
    expect(dueDistance("2026-10-16", TODAY).text).toBe("明天截止");
    expect(dueDistance("2026-10-20", TODAY).text).toBe("还剩 5 天");
    expect(dueDistance("2026-10-13", TODAY)).toEqual({ text: "已过 2 天", overdue: true });
  });
});

test("a task sent back with a ledger code reads in words, never the code", () => {
  expect(waitReason(detail({ state: "blocked", blocker: { reason: "MILESTONE_GATE_INSUFFICIENT" } }), TODAY)?.label).toBe("已退回 · 验收证据不足");
  expect(waitReason(detail({ state: "blocked", blocker: { reason: "SOME_NEW_CODE" } }), TODAY)?.label).toBe("已退回");
});
