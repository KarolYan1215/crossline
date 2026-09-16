import { describe, expect, test } from "vitest";
import { planSchedule, recommendNextActions } from "./index";

const start = new Date("2026-09-14T14:00:00.000Z");

describe("energy-aware planning", () => {
  test("keeps approved blocks inside the 24 hour freeze zone", () => {
    const result = planSchedule({
      now: start,
      horizonDays: 14,
      tasks: [{
        id: "research",
        title: "写论文",
        identityId: "research",
        milestoneId: "m1",
        estimate: { p25Minutes: 45, p50Minutes: 60, p85Minutes: 90, confidence: "low" },
        inputsReady: true,
        deadlineTier: 1,
        energy: "high",
        interruptible: false,
        deadline: "2026-09-16T22:00:00.000Z"
      }],
      availability: [{ start: "2026-09-14T14:00:00.000Z", end: "2026-09-14T17:00:00.000Z", energy: "high" }],
      frozenBlocks: [{ taskId: "research", start: "2026-09-14T15:00:00.000Z", end: "2026-09-14T16:00:00.000Z" }]
    });
    expect(result.status).toBe("feasible");
    if (result.status === "feasible") {
      expect(result.plan.blocks[0]).toMatchObject({
        taskId: "research",
        start: "2026-09-14T15:00:00.000Z",
        end: "2026-09-14T16:00:00.000Z",
        frozen: true
      });
    }
  });

  test("returns a typed blocker when continuous time is unavailable", () => {
    const result = planSchedule({
      now: start,
      horizonDays: 14,
      tasks: [{
        id: "experiment",
        title: "连续实验",
        identityId: "research",
        milestoneId: "m1",
        estimate: { p25Minutes: 70, p50Minutes: 90, p85Minutes: 110, confidence: "high" },
        inputsReady: true,
        deadlineTier: 1,
        energy: "high",
        interruptible: false,
        deadline: "2026-09-14T18:00:00.000Z"
      }],
      availability: [
        { start: "2026-09-14T14:00:00.000Z", end: "2026-09-14T14:45:00.000Z", energy: "high" },
        { start: "2026-09-14T15:00:00.000Z", end: "2026-09-14T15:45:00.000Z", energy: "high" }
      ],
      frozenBlocks: []
    });
    expect(result).toEqual({
      status: "infeasible",
      blockers: [{
        code: "NO_CONTINUOUS_SLOT",
        taskId: "experiment",
        message: "连续实验需要连续 90 分钟"
      }]
    });
  });

  test("offers primary, low-energy, and short-gap actions", () => {
    const actions = recommendNextActions([
      { id: "paper", title: "写论文", estimate: { p25Minutes: 45, p50Minutes: 60, p85Minutes: 90, confidence: "low" }, energy: "high", inputsReady: true, deadlineTier: 1, deadline: "2026-09-14T18:00:00.000Z" },
      { id: "meal", title: "准备晚饭", estimate: { p25Minutes: 15, p50Minutes: 25, p85Minutes: 35, confidence: "high" }, energy: "low", inputsReady: true, deadlineTier: 2 },
      { id: "reply", title: "确认会议", estimate: { p25Minutes: 5, p50Minutes: 10, p85Minutes: 15, confidence: "high" }, energy: "medium", inputsReady: true, deadlineTier: 2 }
    ], 30);
    expect(actions.primary?.id).toBe("paper");
    expect(actions.lowEnergy?.id).toBe("meal");
    expect(actions.shortGap?.id).toBe("reply");
  });

  test("does not relabel uncalibrated work as a low-energy option", () => {
    const actions = recommendNextActions([
      { id: "known", title: "已标定", estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 30, confidence: "high" }, energy: "low", inputsReady: true, deadlineTier: 1 },
      { id: "unknown", title: "未标定", estimate: { p25Minutes: 5, p50Minutes: 10, p85Minutes: 15, confidence: "high" }, inputsReady: true, deadlineTier: 2 }
    ], 0);
    expect(actions.lowEnergy).toBeUndefined();
  });

  test("low-confidence estimates reserve p85 instead of p50", () => {
    const result = planSchedule({
      now: start,
      horizonDays: 14,
      tasks: [{
        id: "uncertain",
        title: "未知资料准备",
        estimate: { p25Minutes: 20, p50Minutes: 30, p85Minutes: 50, confidence: "low" },
        energy: "medium",
        inputsReady: true,
        deadlineTier: 2
      }],
      availability: [{ start: "2026-09-14T14:00:00.000Z", end: "2026-09-14T14:40:00.000Z", energy: "high" }],
      frozenBlocks: []
    });
    expect(result.status).toBe("infeasible");
  });
});
