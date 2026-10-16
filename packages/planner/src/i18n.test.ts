import "@crossline/i18n/catalog/worker";
import { describe, expect, test } from "vitest";
import { forecastGoals, planSchedule, type ForecastDay, type PlannerTask } from "./index";

// The blockers and forecast notes the pages show as written follow the planning input's language (docs/i18n.md).
const start = new Date("2026-09-14T13:00:00.000Z");
const days: ForecastDay[] = Array.from({ length: 56 }, (_, index) => ({
  day: new Date(Date.UTC(2026, 8, 18 + index)).toISOString().slice(0, 10), netMinutes: 100, source: "declared"
}));
const task = (id: string, milestoneId: string, minutes: number): PlannerTask => ({
  id, title: id, milestoneId, estimate: { p25Minutes: minutes / 2, p50Minutes: minutes, p85Minutes: minutes * 2, confidence: "low" },
  inputsReady: true, deadlineTier: 3
});

describe("planner text in either language", () => {
  test("a forecast bottleneck is Chinese by default and English when asked", () => {
    const goal = { id: "g", title: "G", importance: "ordinary" as const, confirmedDeadline: null };
    expect(forecastGoals([goal], [task("w", "g", 100)], days).goals[0]!.bottleneck).toBe("第四象限暂缓；请确认日期或提升重要性");
    expect(forecastGoals([goal], [task("w", "g", 100)], days, new Set(), "en").goals[0]!.bottleneck)
      .toBe("On hold (no deadline, ordinary importance); confirm a date or raise its importance");
    const empty = { ...goal, importance: "important" as const };
    expect(forecastGoals([empty], [], days, new Set(), "en").goals[0]!.bottleneck).toBe("No tasks bound yet; work back the steps first");
  });

  test("a task that does not fit says so in the plan's language", async () => {
    const input = (locale?: "en") => ({ now: start, horizonDays: 1, mode: "asap" as const, frozenBlocks: [], ...(locale ? { locale } : {}),
      tasks: [{ id: "large", title: "Thesis draft", estimate: { p25Minutes: 300, p50Minutes: 400, p85Minutes: 480, confidence: "high" as const },
        inputsReady: true, deadlineTier: 2 as const }],
      availability: [{ start: "2026-09-14T14:00:00.000Z", end: "2026-09-14T15:00:00.000Z", energy: "high" as const }] });
    const chinese = await planSchedule(input());
    expect(chinese.blockers[0]?.message).toBe("Thesis draft在排程窗口内没有可用容量");
    const english = await planSchedule(input("en"));
    expect(english.blockers[0]?.message).toBe("Thesis draft has no available capacity within the scheduling window");
  });
});
