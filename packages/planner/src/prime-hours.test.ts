import { describe, expect, test } from "vitest";
import { isPrimeWork, planSchedule, type PlannerTask, type PlanningInput } from "./index";
import { fallbackSchedule } from "./optimizer";

/**
 * Walkthrough W-153 (2026-10-29, the owner's board): the morning's four blocks went to creator work due a day earlier, while the at-risk
 * research decision (weight 80, its milestone forecast to miss) was cut into two evening blocks. Earliest-deadline-first plus first-fit
 * gives the morning to whatever is due first; at-risk important work should get the day's best hours while that costs nothing its place.
 */
const now = new Date("2026-10-29T13:00:00.000Z"); // 08:00 in Chicago
const estimate = (minutes: number) => ({ p25Minutes: minutes, p50Minutes: minutes, p85Minutes: minutes, confidence: "high" as const });
const creator = (id: string): PlannerTask => ({ id, title: `创作 ${id}`, identityId: "media", estimate: estimate(45), inputsReady: true,
  deadlineTier: 1, energy: "medium", weight: 40, deadline: "2026-10-30T23:00:00.000Z" });
const research: PlannerTask = { id: "review", title: "界定评审机制决策项", identityId: "research", estimate: estimate(90), inputsReady: true,
  deadlineTier: 1, energy: "medium", weight: 80, deadline: "2026-10-31T23:00:00.000Z", atRisk: true };
const day = (from: string, to: string, energy: "low" | "medium" | "high") => ({ start: `2026-10-29T${from}:00:00.000Z`, end: `2026-10-29T${to}:00:00.000Z`, energy });
// A morning 09:00–12:00 (medium, the clearest hours) and two evening slots 17:00–18:00 and 20:00–21:30 (low), in UTC−5.
const input = (tasks: PlannerTask[]): PlanningInput => ({ now, horizonDays: 2, mode: "asap", tasks, frozenBlocks: [],
  availability: [day("14", "17", "medium"), day("22", "23", "low"), { start: "2026-10-30T01:00:00.000Z", end: "2026-10-30T02:30:00.000Z", energy: "low" }] });
const morning = (iso: string) => iso < "2026-10-29T17:00:00.000Z";

describe("at-risk important work takes the day's best hours (W-153)", () => {
  test("prime means at risk and weighted 60 or more, never library work", () => {
    expect(isPrimeWork(research)).toBe(true);
    expect(isPrimeWork({ ...research, weight: 50 })).toBe(false);
    expect(isPrimeWork({ ...research, atRisk: false })).toBe(false);
    expect(isPrimeWork({ ...research, floorOnly: true })).toBe(false);
  });

  test("before: earliest deadline first sent the at-risk research to the evening", () => {
    const plain = fallbackSchedule(input([creator("a"), creator("b"), creator("c"), creator("d"), { ...research, atRisk: false }]));
    expect(plain.plan.blocks.filter((block) => block.taskId === "review").some((block) => !morning(block.start))).toBe(true);
  });

  test("the research gets the morning and the creator work still fits before its own deadline", () => {
    const result = fallbackSchedule(input([creator("a"), creator("b"), creator("c"), creator("d"), research]));
    const review = result.plan.blocks.filter((block) => block.taskId === "review");
    expect(review.length).toBeGreaterThan(0);
    expect(review.every((block) => morning(block.start))).toBe(true);
    for (const id of ["a", "b", "c", "d"]) expect(result.plan.blocks.some((block) => block.taskId === id)).toBe(true);
  });

  test("never at the cost of another task's place: work due this morning keeps it", () => {
    const due = { ...creator("due"), estimate: estimate(150), deadline: "2026-10-29T17:00:00.000Z" };
    const result = fallbackSchedule(input([due, research]));
    expect(result.plan.blocks.some((block) => block.taskId === "due")).toBe(true);
    expect(result.blockers.map((blocker) => blocker.taskId)).not.toContain("due");
  });

  test("the solver gives the morning to the prime work too", async () => {
    const result = await planSchedule(input([creator("a"), creator("b"), research]));
    expect(result.plan.blocks.filter((block) => block.taskId === "review").every((block) => morning(block.start))).toBe(true);
  });
});
