import { describe, expect, test } from "vitest";
import { planSchedule, recommendNextActions } from "./index";

const start = new Date("2026-09-14T14:00:00.000Z");

describe("energy-aware planning", () => {
  test("keeps five scheduled jobs visible when the sixth cannot fit", async () => {
    const tasks = Array.from({ length: 5 }, (_, index) => ({
      id: `small-${index}`, title: `短作业 ${index}`,
      estimate: { p25Minutes: 20, p50Minutes: 30, p85Minutes: 40, confidence: "high" as const },
      inputsReady: true, deadlineTier: 2 as const, energy: "medium" as const
    }));
    tasks.push({ id: "large", title: "大作业", estimate: {
      p25Minutes: 160, p50Minutes: 200, p85Minutes: 240, confidence: "high"
    }, inputsReady: true, deadlineTier: 2, energy: "medium" });
    const result = await planSchedule({ now: start, horizonDays: 1, mode: "asap", tasks,
      availability: [{ start: "2026-09-14T14:00:00.000Z", end: "2026-09-14T16:30:00.000Z", energy: "high" }],
      frozenBlocks: [] });
    expect(result.status).toBe("partial");
    expect(result.plan.blocks).toHaveLength(5);
    expect(result.blockers).toEqual([expect.objectContaining({ taskId: "large" })]);
  });

  test("rearranges jobs across slots so all fit when greedy first-fit would fail", async () => {
    const estimate = (minutes: number) => ({ p25Minutes: minutes, p50Minutes: minutes,
      p85Minutes: minutes, confidence: "high" as const });
    const result = await planSchedule({ now: start, horizonDays: 1, mode: "asap", tasks: [
      { id: "flex", title: "可放两处", estimate: estimate(60), inputsReady: true, deadlineTier: 1 },
      { id: "tight", title: "只能放第一处", estimate: estimate(60), inputsReady: true, deadlineTier: 2,
        deadline: "2026-09-14T15:00:00.000Z" }
    ], availability: [
      { start: "2026-09-14T14:00:00.000Z", end: "2026-09-14T15:00:00.000Z", energy: "high" },
      { start: "2026-09-14T16:00:00.000Z", end: "2026-09-14T17:00:00.000Z", energy: "high" }
    ], frozenBlocks: [] });
    expect(result.status).toBe("feasible");
    expect(result.plan.blocks.map((block) => block.taskId)).toEqual(["tight", "flex"]);
  });

  test("splits an interruptible job across real free slots", async () => {
    const result = await planSchedule({ now: start, horizonDays: 1, mode: "asap",
      tasks: [{ id: "draft", title: "草稿", estimate: { p25Minutes: 90, p50Minutes: 90,
        p85Minutes: 90, confidence: "high" }, inputsReady: true, deadlineTier: 2, interruptible: true }],
      availability: [
        { start: "2026-09-14T14:00:00.000Z", end: "2026-09-14T14:45:00.000Z", energy: "high" },
        { start: "2026-09-14T15:00:00.000Z", end: "2026-09-14T15:45:00.000Z", energy: "high" }
      ], frozenBlocks: [] });
    expect(result.status).toBe("feasible");
    expect(result.plan.blocks).toHaveLength(2);
    expect(result.plan.blocks.reduce((sum, block) => sum +
      (Date.parse(block.end) - Date.parse(block.start)) / 60_000, 0)).toBe(90);
  });

  test("keeps a dependent step after its prerequisite", async () => {
    const estimate = { p25Minutes: 60, p50Minutes: 60, p85Minutes: 60, confidence: "high" as const };
    const result = await planSchedule({ now: start, horizonDays: 1, mode: "asap", tasks: [
      { id: "prepare", title: "准备", estimate, inputsReady: true, deadlineTier: 3, interruptible: false },
      { id: "submit", title: "提交", estimate, inputsReady: true, deadlineTier: 1, interruptible: false,
        dependsOn: ["prepare"] }
    ], availability: [
      { start: "2026-09-14T14:00:00.000Z", end: "2026-09-14T15:00:00.000Z", energy: "high" },
      { start: "2026-09-14T16:00:00.000Z", end: "2026-09-14T17:00:00.000Z", energy: "high" }
    ], frozenBlocks: [] });
    expect(result.plan.blocks.map((block) => block.taskId)).toEqual(["prepare", "submit"]);
  });

  test("relaxes daily buffer before missing a confirmed deadline", async () => {
    const result = await planSchedule({ now: start, horizonDays: 1, tasks: [{
      id: "due", title: "截止作业", estimate: { p25Minutes: 60, p50Minutes: 60, p85Minutes: 60,
        confidence: "high" }, inputsReady: true, deadlineTier: 1, deadline: "2026-09-14T15:00:00.000Z"
    }], availability: [{ start: "2026-09-14T14:00:00.000Z", end: "2026-09-14T15:00:00.000Z",
      energy: "high" }], frozenBlocks: [] });
    expect(result.status).toBe("feasible");
    expect(result.plan.blocks[0]?.taskId).toBe("due");
  });

  test("holds undated fourth-quadrant work with an actionable reason", async () => {
    const result = await planSchedule({ now: start, horizonDays: 7, mode: "asap",
      tasks: [{ id: "optional", title: "普通事项", estimate: { p25Minutes: 20,
        p50Minutes: 30, p85Minutes: 40, confidence: "high" },
        inputsReady: true, deadlineTier: 4 }],
      availability: [{ start: "2026-09-14T14:00:00.000Z", end: "2026-09-14T16:00:00.000Z",
        energy: "high" }], frozenBlocks: [] });
    expect(result.plan.blocks).toEqual([]);
    expect(result.blockers).toEqual([expect.objectContaining({ taskId: "optional",
      code: "Q4_NEEDS_DATE_OR_PROMOTION" })]);
  });

  test("a dated fourth-quadrant task wakes at its latest feasible start", async () => {
    const input = { horizonDays: 1, mode: "asap" as const,
      tasks: [{ id: "optional-due", title: "普通截止事项",
        estimate: { p25Minutes: 30, p50Minutes: 30, p85Minutes: 30, confidence: "high" as const },
        inputsReady: true, deadlineTier: 4 as const,
        deadline: "2026-09-14T16:00:00.000Z" }],
      availability: [{ start: "2026-09-14T14:00:00.000Z",
        end: "2026-09-14T16:00:00.000Z", energy: "high" as const }], frozenBlocks: [] };
    const early = await planSchedule({ ...input, now: start });
    expect(early.blockers[0]?.code).toBe("Q4_WAITING_LATEST_START");
    const wake = await planSchedule({ ...input, now: new Date("2026-09-14T15:30:00.000Z") });
    expect(wake.status).toBe("feasible");
    expect(wake.plan.blocks[0]?.start).toBe("2026-09-14T15:30:00.000Z");
  });

  test("fourth-quadrant wake-up uses eight-week capacity without scheduling outside the near week", async () => {
    const task = { id: "later", title: "稍后事项", estimate: { p25Minutes: 30,
      p50Minutes: 60, p85Minutes: 60, confidence: "high" as const },
      inputsReady: true, deadlineTier: 4 as const, deadline: "2026-09-24T17:00:00.000Z" };
    const result = await planSchedule({ now: start, horizonDays: 1, mode: "asap", tasks: [task],
      availability: [{ start: "2026-09-14T14:00:00.000Z", end: "2026-09-14T14:30:00.000Z", energy: "high" }],
      lookaheadAvailability: [{ start: "2026-09-24T15:00:00.000Z",
        end: "2026-09-24T17:00:00.000Z", energy: "high" }], frozenBlocks: [] });
    expect(result.plan.blocks).toEqual([]);
    expect(result.blockers[0]).toMatchObject({ code: "Q4_WAITING_LATEST_START" });
    expect(result.blockers[0]?.message).toContain("2026-09-24T16:00:00.000Z");
  });

  test("a fourth-quadrant date outside known capacity stays held without a false latest-start claim", async () => {
    const result = await planSchedule({ now: start, horizonDays: 1, mode: "asap",
      tasks: [{ id: "far", title: "远期事项", estimate: { p25Minutes: 30,
        p50Minutes: 60, p85Minutes: 60, confidence: "high" }, inputsReady: true,
        deadlineTier: 4, deadline: "2027-01-01T17:00:00.000Z" }],
      availability: [], lookaheadAvailability: [{ start: "2026-09-24T15:00:00.000Z",
        end: "2026-09-24T17:00:00.000Z", energy: "high" }], frozenBlocks: [] });
    expect(result.blockers[0]?.code).toBe("Q4_BEYOND_FORECAST_HORIZON");
    expect(result.plan.blocks).toEqual([]);
  });

  test("buffered mode spreads work over days; ASAP can fill the first day", async () => {
    const estimate = { p25Minutes: 55, p50Minutes: 55, p85Minutes: 55, confidence: "high" as const };
    const input = { now: start, horizonDays: 2, tasks: [
      { id: "a", title: "A", estimate, inputsReady: true, deadlineTier: 3 as const,
        interruptible: false },
      { id: "b", title: "B", estimate, inputsReady: true, deadlineTier: 3 as const,
        interruptible: false }
    ], availability: [
      { start: "2026-09-14T14:00:00.000Z", end: "2026-09-14T16:00:00.000Z",
        day: "2026-09-14", energy: "high" as const },
      { start: "2026-09-15T14:00:00.000Z", end: "2026-09-15T16:00:00.000Z",
        day: "2026-09-15", energy: "high" as const }
    ], frozenBlocks: [] };
    const buffered = await planSchedule({ ...input, mode: "buffered" });
    expect(buffered.plan.blocks.map((block) => block.start.slice(0, 10)))
      .toEqual(["2026-09-14", "2026-09-15"]);
    const asap = await planSchedule({ ...input, mode: "asap" });
    expect(asap.plan.blocks.map((block) => block.start.slice(0, 10)))
      .toEqual(["2026-09-14", "2026-09-14"]);
  });

  test("50 jobs return only complete, non-overlapping blocks within the solver limit", async () => {
    const tasks = Array.from({ length: 50 }, (_, index) => ({ id: `job-${index}`,
      title: `作业 ${index}`, estimate: { p25Minutes: 25, p50Minutes: 30,
        p85Minutes: 40, confidence: "high" as const },
      inputsReady: true, deadlineTier: 3 as const, interruptible: false }));
    const availability = Array.from({ length: 7 }, (_, day) => ({
      day: `2026-09-${String(14 + day).padStart(2, "0")}`,
      start: `2026-09-${String(14 + day).padStart(2, "0")}T14:00:00.000Z`,
      end: `2026-09-${String(14 + day).padStart(2, "0")}T21:00:00.000Z`,
      energy: "high" as const }));
    const result = await planSchedule({ now: start, horizonDays: 7, tasks, availability,
      frozenBlocks: [] });
    expect(result.solver).not.toBe("fallback");
    expect(result.plan.blocks.length).toBeGreaterThan(0);
    const blocks = [...result.plan.blocks].sort((a, b) => a.start.localeCompare(b.start));
    for (const [index, block] of blocks.entries()) {
      expect(Date.parse(block.end) - Date.parse(block.start)).toBe(30 * 60_000);
      if (index) expect(Date.parse(block.start)).toBeGreaterThanOrEqual(Date.parse(blocks[index - 1]!.end));
    }
  }, 15_000);

  test("buffered mode keeps its ten-minute gap across adjacent availability windows", async () => {
    const tasks = ["first", "second"].map((id) => ({ id, title: id,
      estimate: { p25Minutes: 60, p50Minutes: 60, p85Minutes: 60, confidence: "high" as const },
      inputsReady: true, deadlineTier: 3 as const, interruptible: false }));
    const result = await planSchedule({ now: start, horizonDays: 1, mode: "buffered", tasks,
      availability: [
        { day: "2026-09-14", start: "2026-09-14T14:00:00.000Z", end: "2026-09-14T15:00:00.000Z", energy: "high" },
        { day: "2026-09-14", start: "2026-09-14T15:00:00.000Z", end: "2026-09-14T16:00:00.000Z", energy: "high" },
        { day: "2026-09-14", start: "2026-09-14T18:00:00.000Z", end: "2026-09-14T18:40:00.000Z", energy: "high" }
      ], frozenBlocks: [] });
    expect(result.status).toBe("partial");
    expect(result.plan.blocks).toHaveLength(1);
  });

  test("reserves a weekly 45-minute progress block when an important undated task cannot fit in full", async () => {
    const result = await planSchedule({ now: start, horizonDays: 7, mode: "buffered",
      tasks: [{ id: "long-goal", title: "长期目标", milestoneId: "goal-1",
        estimate: { p25Minutes: 90, p50Minutes: 90, p85Minutes: 90, confidence: "high" },
        inputsReady: true, deadlineTier: 3, interruptible: true }],
      availability: [{ day: "2026-09-14", start: "2026-09-14T14:00:00.000Z",
        end: "2026-09-14T15:00:00.000Z", energy: "high" }], frozenBlocks: [] });
    expect(result.status).toBe("partial");
    expect(result.plan.blocks).toEqual([expect.objectContaining({ taskId: "long-goal", progressOnly: true })]);
    expect((Date.parse(result.plan.blocks[0]!.end) - Date.parse(result.plan.blocks[0]!.start)) / 60_000).toBe(45);
    expect(result.blockers).toEqual([expect.objectContaining({ taskId: "long-goal", code: "PROGRESS_ONLY" })]);
  });

  test("keeps approved blocks inside the 24 hour freeze zone", async () => {
    const result = await planSchedule({
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

  test("returns a typed blocker when continuous time is unavailable", async () => {
    const result = await planSchedule({
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
    expect(result).toMatchObject({
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

  test("a fresh low or high self-report changes the primary without hiding higher priority work", () => {
    const estimate = { p25Minutes: 30, p50Minutes: 45, p85Minutes: 60,
      confidence: "high" as const };
    const tasks = [
      { id: "deep", title: "深度工作", estimate, energy: "high" as const,
        inputsReady: true, deadlineTier: 1 as const },
      { id: "light", title: "轻任务", estimate, energy: "low" as const,
        inputsReady: true, deadlineTier: 3 as const }
    ];
    const low = recommendNextActions(tasks, 60, "low");
    const high = recommendNextActions(tasks, 60, "high");
    expect(low.primary?.id).toBe("light");
    expect(low.higherPriority?.id).toBe("deep");
    expect(high.primary?.id).toBe("deep");
  });

  test("personal transition evidence only softly breaks ties among equal-priority matching tasks", () => {
    const estimate = (minutes: number) => ({ p25Minutes: minutes, p50Minutes: minutes,
      p85Minutes: minutes, confidence: "high" as const });
    const tasks = [
      { id: "draining", title: "较耗精力", estimate: estimate(20), energy: "medium" as const,
        inputsReady: true, deadlineTier: 3 as const },
      { id: "stable", title: "较稳定", estimate: estimate(40), energy: "medium" as const,
        inputsReady: true, deadlineTier: 3 as const }
    ];
    expect(recommendNextActions(tasks, 60, "medium", start).primary?.id).toBe("draining");
    expect(recommendNextActions(tasks, 60, "medium", start,
      { draining: "low", stable: "medium" }).primary?.id).toBe("stable");
  });

  test("does not relabel uncalibrated work as a low-energy option", () => {
    const actions = recommendNextActions([
      { id: "known", title: "已标定", estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 30, confidence: "high" }, energy: "low", inputsReady: true, deadlineTier: 1 },
      { id: "unknown", title: "未标定", estimate: { p25Minutes: 5, p50Minutes: 10, p85Minutes: 15, confidence: "high" }, inputsReady: true, deadlineTier: 2 }
    ], 0);
    expect(actions.lowEnergy).toBeUndefined();
  });

  test("low-confidence estimates reserve p85 instead of p50", async () => {
    const result = await planSchedule({
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
