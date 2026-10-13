import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { planSchedule, recommendNextActions } from "./index";
import { fallbackSchedule } from "./optimizer";

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

  test("a calibrated (non-low) confidence reserves p50, not the conservative p85 low confidence reserves", async () => {
    // Same p25/p50/p85 spread, same everything else — only `confidence` differs. This is the direct
    // proof that `durationOf`'s `confidence === "low" ? p85 : p50` branch is not dead code: nothing in
    // this codebase ever emitted anything but "low" until real personal-history calibration existed.
    const estimate = { p25Minutes: 30, p50Minutes: 50, p85Minutes: 90 };
    const uncalibrated = await planSchedule({ now: start, horizonDays: 1, mode: "asap", tasks: [
      { id: "task", title: "作业", estimate: { ...estimate, confidence: "low" as const }, inputsReady: true, deadlineTier: 2 }
    ], availability: [{ start: "2026-09-14T14:00:00.000Z", end: "2026-09-14T18:00:00.000Z", energy: "high" }], frozenBlocks: [] });
    const calibrated = await planSchedule({ now: start, horizonDays: 1, mode: "asap", tasks: [
      { id: "task", title: "作业", estimate: { ...estimate, confidence: "medium" as const }, inputsReady: true, deadlineTier: 2 }
    ], availability: [{ start: "2026-09-14T14:00:00.000Z", end: "2026-09-14T18:00:00.000Z", energy: "high" }], frozenBlocks: [] });

    const minutesOf = (result: typeof uncalibrated) =>
      result.plan.blocks.reduce((sum, block) => sum + (Date.parse(block.end) - Date.parse(block.start)) / 60_000, 0);
    expect(minutesOf(uncalibrated)).toBe(estimate.p85Minutes);
    expect(minutesOf(calibrated)).toBe(estimate.p50Minutes);
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

  describe("energy is how much an hour yields, not whether it may be used", () => {
    const at = (time: string) => `2026-09-14T${time}:00.000Z`;
    const exact = (minutes: number) => ({ p25Minutes: minutes, p50Minutes: minutes, p85Minutes: minutes, confidence: "high" as const });
    const minutesOf = (block: { start: string; end: string }) => (Date.parse(block.end) - Date.parse(block.start)) / 60_000;
    const workOf = (blocks: Array<{ start: string; end: string; efficiency?: number }>) =>
      blocks.reduce((sum, block) => sum + minutesOf(block) * (block.efficiency ?? 1), 0);

    test("when the matching hour is full, work goes on in a slot one level short, taking a quarter longer", async () => {
      const result = await planSchedule({ now: start, horizonDays: 1, mode: "asap", tasks: [
        { id: "due", title: "今晚截止的作业", estimate: exact(90), inputsReady: true, deadlineTier: 1, energy: "high", deadline: at("19:00") }
      ], availability: [{ start: at("14:00"), end: at("15:00"), energy: "high" }, { start: at("16:00"), end: at("19:00"), energy: "medium" }],
      frozenBlocks: [] });
      const blocks = result.plan.blocks.filter((block) => block.taskId === "due");
      expect(blocks.filter((block) => !block.efficiency).map(minutesOf)).toEqual([60]);
      // 30 minutes of work left, at 0.8 of an hour per hour: 38 minutes on the clock.
      expect(blocks.filter((block) => block.efficiency === .8).reduce((sum, block) => sum + minutesOf(block), 0)).toBe(38);
      expect(workOf(blocks)).toBeGreaterThanOrEqual(90);
    });

    test("a matching hour is taken before a weaker one, even a day later", async () => {
      const result = await planSchedule({ now: start, horizonDays: 2, mode: "asap", tasks: [
        { id: "think", title: "推导", estimate: exact(60), inputsReady: true, deadlineTier: 3, energy: "high" }
      ], availability: [{ start: at("14:00"), end: at("16:00"), energy: "medium" },
        { start: "2026-09-15T14:00:00.000Z", end: "2026-09-15T15:00:00.000Z", energy: "high" }], frozenBlocks: [] });
      expect(result.plan.blocks).toEqual([{ taskId: "think", start: "2026-09-15T14:00:00.000Z", end: "2026-09-15T15:00:00.000Z" }]);
    });

    test("two levels short only under a deadline, in even sessions of at most 45 minutes with rests between", async () => {
      const task = { id: "hard", title: "难题", estimate: exact(120), inputsReady: true, deadlineTier: 1 as const, energy: "high" as const };
      const evening = [{ start: at("14:00"), end: at("18:00"), energy: "low" as const }];
      const waiting = await planSchedule({ now: start, horizonDays: 1, mode: "asap", tasks: [{ ...task, deadlineTier: 3 }], availability: evening, frozenBlocks: [] });
      expect(waiting.plan.blocks).toEqual([]);
      const pressed = await planSchedule({ now: start, horizonDays: 1, mode: "asap", tasks: [{ ...task, deadline: at("18:00") }], availability: evening, frozenBlocks: [] });
      const blocks = pressed.plan.blocks;
      // 120 minutes of work at 0.65: 185 on the clock, as five sessions of 37 with four ten-minute rests.
      expect(blocks.map(minutesOf)).toEqual([37, 37, 37, 37, 37]);
      expect(blocks.every((block) => block.efficiency === .65)).toBe(true);
      for (let i = 1; i < blocks.length; i += 1) expect(Date.parse(blocks[i]!.start) - Date.parse(blocks[i - 1]!.end)).toBeGreaterThanOrEqual(10 * 60_000);
      expect(workOf(blocks)).toBeGreaterThanOrEqual(120);
    });

    test("long work in a matching slot is cut into even sessions of at most 90 minutes, with rests", async () => {
      const result = await planSchedule({ now: start, horizonDays: 1, mode: "asap", tasks: [
        { id: "outline", title: "整理复习提纲", estimate: exact(200), inputsReady: true, deadlineTier: 2 }
      ], availability: [{ start: at("14:00"), end: at("18:00"), energy: "high" }], frozenBlocks: [] });
      const blocks = result.plan.blocks;
      expect(blocks.map(minutesOf)).toEqual([67, 67, 66]);
      for (let i = 1; i < blocks.length; i += 1) expect(Date.parse(blocks[i]!.start) - Date.parse(blocks[i - 1]!.end)).toBeGreaterThanOrEqual(10 * 60_000);
    });

    test("work that cannot be interrupted stays one block, lengthened", async () => {
      const result = await planSchedule({ now: start, horizonDays: 1, mode: "asap", tasks: [
        { id: "one", title: "一口气做完", estimate: exact(60), inputsReady: true, deadlineTier: 1, energy: "high", interruptible: false, deadline: at("18:00") }
      ], availability: [{ start: at("14:00"), end: at("18:00"), energy: "medium" }], frozenBlocks: [] });
      expect(result.plan.blocks.map(minutesOf)).toEqual([75]);
    });

    test("the greedy fallback fills earlier days after placing a task late in the week", () => {
      const day = (n: number, time: string) => `2026-09-${String(14 + n).padStart(2, "0")}T${time}:00.000Z`;
      const result = fallbackSchedule({ now: start, horizonDays: 5, mode: "asap", tasks: [
        { id: "later", title: "周四才能开始", estimate: exact(60), inputsReady: true, deadlineTier: 1, notBefore: day(3, "00:00") },
        { id: "now", title: "随时可做", estimate: exact(60), inputsReady: true, deadlineTier: 2 }
      ], availability: [0, 1, 2, 3].map((n) => ({ start: day(n, "14:00"), end: day(n, "16:00"), energy: "high" as const })), frozenBlocks: [] });
      expect(result.plan.blocks.find((block) => block.taskId === "now")?.start).toBe(day(0, "14:00"));
    });

    test("the greedy fallback follows the same rules: matching hours first, then sessions in a weaker slot", () => {
      const result = fallbackSchedule({ now: start, horizonDays: 1, mode: "asap", tasks: [
        { id: "due", title: "截止作业", estimate: exact(90), inputsReady: true, deadlineTier: 1, energy: "high", deadline: at("19:00") }
      ], availability: [{ start: at("14:00"), end: at("14:30"), energy: "high" }, { start: at("16:00"), end: at("19:00"), energy: "medium" }],
      frozenBlocks: [] });
      const blocks = result.plan.blocks;
      expect(blocks[0]).toMatchObject({ start: at("14:00"), end: at("14:30") });
      expect(blocks[0]!.efficiency).toBeUndefined();
      expect(blocks.slice(1).every((block) => minutesOf(block) <= 60 && block.efficiency === .8)).toBe(true);
      expect(workOf(blocks)).toBeGreaterThanOrEqual(90);
      // Matching slots only, when they suffice: nothing goes to the weaker one.
      const roomy = fallbackSchedule({ now: start, horizonDays: 1, mode: "asap", tasks: [
        { id: "due", title: "截止作业", estimate: exact(30), inputsReady: true, deadlineTier: 1, energy: "high", deadline: at("19:00") }
      ], availability: [{ start: at("16:00"), end: at("19:00"), energy: "medium" }, { start: at("14:00"), end: at("15:00"), energy: "high" }], frozenBlocks: [] });
      expect(roomy.plan.blocks.map((block) => block.efficiency)).toEqual([undefined]);
    });
  });

  test("only the work with a deadline is relaxed; undated work around it keeps the gap", async () => {
    const exact = (minutes: number) => ({ p25Minutes: minutes, p50Minutes: minutes, p85Minutes: minutes, confidence: "high" as const });
    const result = await planSchedule({ now: start, horizonDays: 2, mode: "buffered", tasks: [
      // 170 of 180 minutes is more than the daily share allows: placing it needs the relaxed run.
      { id: "due", title: "今天截止", estimate: exact(170), inputsReady: true, deadlineTier: 1, deadline: "2026-09-14T17:00:00.000Z" },
      { id: "a", title: "随时可做 A", estimate: exact(50), inputsReady: true, deadlineTier: 3 },
      { id: "b", title: "随时可做 B", estimate: exact(50), inputsReady: true, deadlineTier: 3 }
    ], availability: [{ start: "2026-09-14T14:00:00.000Z", end: "2026-09-14T17:00:00.000Z", energy: "high" },
      { start: "2026-09-15T14:00:00.000Z", end: "2026-09-15T16:00:00.000Z", energy: "high" }], frozenBlocks: [] });
    expect(result.bufferRelaxed).toBe(true);
    expect(result.plan.blocks.find((block) => block.taskId === "due")).toBeDefined();
    const undated = result.plan.blocks.filter((block) => block.taskId === "a" || block.taskId === "b").sort((x, y) => x.start.localeCompare(y.start));
    expect(undated).toHaveLength(2);
    expect(Date.parse(undated[1]!.start) - Date.parse(undated[0]!.end)).toBeGreaterThanOrEqual(10 * 60_000);
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

  test("a caller-set time limit cuts the solve short and the result is still a legal plan", async () => {
    const tasks = Array.from({ length: 50 }, (_, index) => ({ id: `job-${index}`,
      title: `作业 ${index}`, estimate: { p25Minutes: 25, p50Minutes: 30, p85Minutes: 40, confidence: "high" as const },
      inputsReady: true, deadlineTier: 3 as const, interruptible: false }));
    const availability = Array.from({ length: 7 }, (_, day) => ({
      day: `2026-09-${String(14 + day).padStart(2, "0")}`,
      start: `2026-09-${String(14 + day).padStart(2, "0")}T14:00:00.000Z`,
      end: `2026-09-${String(14 + day).padStart(2, "0")}T21:00:00.000Z`,
      energy: "high" as const }));
    const result = await planSchedule({ now: start, horizonDays: 7, tasks, availability, frozenBlocks: [] }, { timeLimitSeconds: 0.01 });
    expect(["feasible_time_limit", "fallback"]).toContain(result.solver);
    const blocks = [...result.plan.blocks].sort((a, b) => a.start.localeCompare(b.start));
    expect(blocks.length).toBeGreaterThan(0);
    for (const [index, block] of blocks.entries())
      if (index) expect(Date.parse(block.start)).toBeGreaterThanOrEqual(Date.parse(blocks[index - 1]!.end));
  }, 15_000);

  test("solver \"none\" places with the greedy pass only; an injected solver replaces the in-process one with the same answer", async () => {
    const tasks = Array.from({ length: 4 }, (_, index) => ({ id: `t${index}`, title: `任务 ${index}`,
      estimate: { p25Minutes: 40, p50Minutes: 60, p85Minutes: 80, confidence: "high" as const }, inputsReady: true, deadlineTier: 3 as const }));
    const availability = [{ day: "2026-09-14", start: "2026-09-14T14:00:00.000Z", end: "2026-09-14T20:00:00.000Z", energy: "high" as const }];
    const input = { now: start, horizonDays: 1, tasks, availability, frozenBlocks: [] };
    expect((await planSchedule(input, { solver: "none" })).solver).toBe("fallback");
    const loadHighs = createRequire(import.meta.url)("highs") as typeof import("highs").default;
    const highs = await loadHighs();
    const models: string[] = [];
    const injected = await planSchedule(input, { solver: async (model, limit) => {
      models.push(model);
      return highs.solve(model, { output_flag: false, time_limit: limit });
    } });
    expect(models.length).toBeGreaterThanOrEqual(1);
    const inProcess = await planSchedule(input);
    expect(injected.solver).toBe(inProcess.solver);
    expect(injected.plan.blocks).toEqual(inProcess.plan.blocks);
  }, 15_000);

  test("a frozen block freezes that segment only: the rest of the task is still planned", async () => {
    const day = (h: number) => `2026-09-14T${String(h).padStart(2, "0")}:00:00.000Z`;
    const availability = [{ day: "2026-09-14", start: day(14), end: day(20), energy: "high" as const }];
    const task = { id: "essay", title: "论文", estimate: { p25Minutes: 120, p50Minutes: 120, p85Minutes: 120, confidence: "high" as const },
      inputsReady: true, deadlineTier: 3 as const };
    const half = await planSchedule({ now: start, horizonDays: 1, tasks: [task], availability,
      frozenBlocks: [{ taskId: "essay", start: day(14), end: day(15) }] });
    const placed = half.plan.blocks.filter((block) => block.taskId === "essay" && !block.frozen);
    expect(placed.reduce((sum, block) => sum + (Date.parse(block.end) - Date.parse(block.start)) / 60_000, 0)).toBe(60);
    expect(half.blockers).toEqual([]);

    const whole = await planSchedule({ now: start, horizonDays: 1, tasks: [task], availability,
      frozenBlocks: [{ taskId: "essay", start: day(14), end: day(16) }] });
    expect(whole.plan.blocks.filter((block) => block.taskId === "essay" && !block.frozen)).toEqual([]);
    expect(whole.blockers).toEqual([]);

    // Work that must sit in one slot is not cut: a frozen block means it is placed.
    const unbroken = await planSchedule({ now: start, horizonDays: 1, tasks: [{ ...task, interruptible: false }], availability,
      frozenBlocks: [{ taskId: "essay", start: day(14), end: day(15) }] });
    expect(unbroken.plan.blocks.filter((block) => block.taskId === "essay" && !block.frozen)).toEqual([]);
  });

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
        message: "连续实验需要连续 90 分钟，但最长的连续空档只有 45 分钟；可以补充更长的可用时间，或确认它其实可以分几次做"
      }]
    });
  });

  describe("long estimates", () => {
    const day = (n: number) => `2026-09-${14 + n}`;
    const slot = (n: number, from: string, to: string) => ({ start: `${day(n)}T${from}:00.000Z`, end: `${day(n)}T${to}:00.000Z`, energy: "high" as const });
    const task = (extra: object) => ({ id: "long", title: "长作业", inputsReady: true, deadlineTier: 2 as const,
      estimate: { p25Minutes: 90, p50Minutes: 180, p85Minutes: 360, confidence: "low" as const }, ...extra });

    test("an uninterruptible low-confidence job is reserved at what one slot can hold, not at an unreachable p85", async () => {
      // p85 is 360 but the longest free stretch is 240: asking for 360 in one piece could never succeed.
      const result = await planSchedule({ now: start, horizonDays: 3, mode: "asap", tasks: [task({ interruptible: false })],
        availability: [slot(0, "14:00", "18:00"), slot(1, "14:00", "16:00")], frozenBlocks: [] });
      expect(result.status).toBe("feasible");
      const [block] = result.plan.blocks;
      expect((Date.parse(block!.end) - Date.parse(block!.start)) / 60_000).toBe(240);
      expect(result.notes).toEqual([expect.objectContaining({ taskId: "long", code: "BUFFER_CLAMPED" })]);
      expect(result.notes![0]!.message).toContain("240");
    });

    test("when even the expected time will not fit one slot, the blocker names the longest slot", async () => {
      const result = await planSchedule({ now: start, horizonDays: 3, mode: "asap", tasks: [task({ interruptible: false })],
        availability: [slot(0, "14:00", "16:00"), slot(1, "14:00", "16:30")], frozenBlocks: [] });
      expect(result.status).toBe("infeasible");
      expect(result.notes).toBeUndefined();
      expect(result.blockers[0]).toMatchObject({ code: "NO_CONTINUOUS_SLOT", taskId: "long" });
      expect(result.blockers[0]!.message).toContain("150");
    });

    test("an interruptible 360-minute job is simply split across days", async () => {
      const result = await planSchedule({ now: start, horizonDays: 3, mode: "asap", tasks: [task({})],
        availability: [slot(0, "14:00", "17:00"), slot(1, "14:00", "17:00"), slot(2, "14:00", "17:00")], frozenBlocks: [] });
      expect(result.status).toBe("feasible");
      const minutes = result.plan.blocks.reduce((sum, block) => sum + (Date.parse(block.end) - Date.parse(block.start)) / 60_000, 0);
      expect(minutes).toBe(360);
      expect(result.notes).toBeUndefined();
    });

    test("slots too low-energy for the job do not count toward the longest stretch", async () => {
      const result = await planSchedule({ now: start, horizonDays: 2, mode: "asap",
        tasks: [task({ interruptible: false, energy: "high" })],
        availability: [{ ...slot(0, "14:00", "20:00"), energy: "low" }, slot(1, "14:00", "16:30")], frozenBlocks: [] });
      expect(result.blockers[0]!.message).toContain("150");
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

test("an empty week is reported as empty, not as a solver failure; tasks with no free time say so", async () => {
  const now = new Date("2026-10-05T14:00:00.000Z");
  const empty = await planSchedule({ now, horizonDays: 7, tasks: [], frozenBlocks: [],
    availability: [{ start: "2026-10-06T14:00:00.000Z", end: "2026-10-06T17:00:00.000Z", day: "2026-10-06", energy: "high" }] });
  expect(empty.solver).toBe("empty");
  expect(empty.plan.blocks).toEqual([]);
  const full = await planSchedule({ now, horizonDays: 7, frozenBlocks: [], availability: [],
    tasks: [{ id: "t", title: "画图", identityId: "research",
      estimate: { p25Minutes: 30, p50Minutes: 60, p85Minutes: 90, confidence: "low" as const },
      inputsReady: true, deadlineTier: 2, interruptible: true }] });
  expect(full.solver).toBe("no_capacity");
});

// 「师兄 10/8 左右给数据」: the work is not placed before the data can have arrived.
test("a task waiting for something is never placed before its release date", async () => {
  const now = new Date("2026-10-06T14:00:00.000Z");
  const day = (d: string) => ({ start: `${d}T14:00:00.000Z`, end: `${d}T17:00:00.000Z`, day: d, energy: "high" as const });
  const result = await planSchedule({ now, horizonDays: 7, frozenBlocks: [],
    availability: [day("2026-10-06"), day("2026-10-07"), day("2026-10-08"), day("2026-10-09")],
    tasks: [{ id: "sim", title: "跑真实数据仿真", estimate: { p25Minutes: 60, p50Minutes: 90, p85Minutes: 120, confidence: "high" as const },
      inputsReady: true, deadlineTier: 1, interruptible: true, notBefore: "2026-10-08T05:00:00.000Z" }] });
  const blocks = result.plan.blocks.filter((block) => block.taskId === "sim");
  expect(blocks.length).toBeGreaterThan(0);
  expect(blocks.every((block) => block.start >= "2026-10-08")).toBe(true);
});

describe("schedule parameters and importance", () => {
  const now = new Date("2026-10-06T14:00:00.000Z");
  const estimate = (minutes: number) => ({ p25Minutes: minutes, p50Minutes: minutes, p85Minutes: minutes, confidence: "high" as const });
  const day = (d: string, from = "14:00", to = "18:00") => ({ start: `${d}T${from}:00.000Z`, end: `${d}T${to}:00.000Z`, day: d, energy: "high" as const });

  test("the focus cap splits one long task across slots instead of filling one slot with it", async () => {
    const task = { id: "essay", title: "写论文", estimate: estimate(180), inputsReady: true, deadlineTier: 2 as const, interruptible: true };
    const capped = await planSchedule({ now, horizonDays: 3, frozenBlocks: [], tasks: [task],
      params: { gapMinutes: 0, maxDailyShare: 1, focusCapMinutes: 60, deadlineBufferDays: 0 },
      availability: [day("2026-10-06"), day("2026-10-07"), day("2026-10-08")] });
    const blocks = capped.plan.blocks.filter((block) => block.taskId === "essay");
    expect(blocks.every((block) => (Date.parse(block.end) - Date.parse(block.start)) / 60_000 <= 60)).toBe(true);
    expect(blocks.reduce((sum, block) => sum + (Date.parse(block.end) - Date.parse(block.start)) / 60_000, 0)).toBe(180);
  });

  test("the daily share limits how much of a day is filled, and the gap separates blocks", async () => {
    const tasks = ["a", "b", "c"].map((id) => ({ id, title: id, estimate: estimate(60), inputsReady: true, deadlineTier: 2 as const, interruptible: false }));
    const result = await planSchedule({ now, horizonDays: 1, frozenBlocks: [], tasks,
      params: { gapMinutes: 15, maxDailyShare: 0.5, focusCapMinutes: 0, deadlineBufferDays: 0 }, availability: [day("2026-10-06")] });
    const placed = result.plan.blocks.filter((block) => !block.frozen);
    expect(placed).toHaveLength(2);
    expect(Date.parse(placed[1]!.start) - Date.parse(placed[0]!.end)).toBeGreaterThanOrEqual(15 * 60_000);
  });

  test("a deadline buffer finishes work early when there is room, and never makes a deadline impossible", async () => {
    const task = { id: "hw", title: "作业", estimate: estimate(60), inputsReady: true, deadlineTier: 2 as const, interruptible: false,
      deadline: "2026-10-09T23:00:00.000Z" };
    const params = { gapMinutes: 0, maxDailyShare: 1, focusCapMinutes: 0, deadlineBufferDays: 2 };
    const early = await planSchedule({ now, horizonDays: 4, frozenBlocks: [], tasks: [task], params,
      availability: [day("2026-10-09"), day("2026-10-06", "17:00", "18:00")] });
    expect(early.plan.blocks.find((block) => block.taskId === "hw")?.start.slice(0, 10)).toBe("2026-10-06");
    const late = await planSchedule({ now, horizonDays: 4, frozenBlocks: [], tasks: [task], params, availability: [day("2026-10-09")] });
    expect(late.plan.blocks.find((block) => block.taskId === "hw")?.start.slice(0, 10)).toBe("2026-10-09");
  });

  test("inside one tier the heavier milestone goes first; a lighter one in a more urgent tier still wins", async () => {
    const task = (id: string, tier: 1 | 2, weight: number) => ({ id, title: id, estimate: estimate(60), inputsReady: true, deadlineTier: tier, interruptible: false, weight });
    const result = await planSchedule({ now, horizonDays: 1, frozenBlocks: [], availability: [day("2026-10-06", "14:00", "16:00")],
      params: { gapMinutes: 0, maxDailyShare: 1, focusCapMinutes: 0, deadlineBufferDays: 0 },
      tasks: [task("light", 2, 20), task("heavy", 2, 90), task("urgent", 1, 10)] });
    expect(result.plan.blocks.map((block) => block.taskId).sort()).toEqual(["heavy", "urgent"]);
  });
});

describe("line floors (each line's share of the week, from what the person said)", () => {
  const estimate = (minutes: number) => ({ p25Minutes: minutes, p50Minutes: minutes, p85Minutes: minutes, confidence: "high" as const });
  // Four hours a day for three days: room for six two-hour tasks, eight are offered.
  const availability = [14, 15, 16].map((day) => ({ start: `2026-09-${day}T14:00:00.000Z`, end: `2026-09-${day}T18:00:00.000Z`, energy: "high" as const }));
  const research = Array.from({ length: 6 }, (_, i) => ({ id: `r${i}`, title: `研究 ${i}`, identityId: "research", estimate: estimate(120),
    inputsReady: true, deadlineTier: 3 as const, weight: 90 }));
  const startup = [0, 1].map((i) => ({ id: `s${i}`, title: `创业 ${i}`, identityId: "startup", estimate: estimate(120), inputsReady: true,
    deadlineTier: 3 as const, floorOnly: true }));

  test("work from the task library gets time only to meet its line's floor — the 100% / 0% week of the real account", async () => {
    const without = await planSchedule({ now: start, horizonDays: 3, mode: "asap", tasks: [...research, ...startup], availability, frozenBlocks: [] });
    expect(without.plan.blocks.some((block) => block.taskId.startsWith("s"))).toBe(false);
    // Library work never shows up as 「未排入」: it was not asked for this week.
    expect(without.blockers.some((blocker) => blocker.taskId.startsWith("s"))).toBe(false);
    const withFloor = await planSchedule({ now: start, horizonDays: 3, mode: "asap", tasks: [...research, ...startup], availability, frozenBlocks: [],
      lineShares: { research: 64, startup: 20 } });
    const startupMinutes = withFloor.plan.blocks.filter((block) => block.taskId.startsWith("s"))
      .reduce((sum, block) => sum + (Date.parse(block.end) - Date.parse(block.start)) / 60_000, 0);
    expect(startupMinutes).toBeGreaterThanOrEqual(120);
    // Only the floor: 20% of 12 hours is 2.4 hours, so one task, not both.
    expect(startupMinutes).toBeLessThanOrEqual(240);
  });

  test("a floor never pushes out work with a deadline", async () => {
    const due = research.map((task) => ({ ...task, deadlineTier: 2 as const, deadline: "2026-09-16T18:00:00.000Z" }));
    const result = await planSchedule({ now: start, horizonDays: 3, mode: "asap", tasks: [...due, ...startup], availability, frozenBlocks: [],
      lineShares: { research: 50, startup: 50 } });
    // Every one of the six placed (long ones now in sessions, so counted by task, not by block).
    expect(new Set(result.plan.blocks.filter((block) => block.taskId.startsWith("r")).map((block) => block.taskId)).size).toBe(6);
  });
});
