import { describe, expect, it } from "vitest";
import { hoursFromText, presetImportance } from "./importance";

describe("importance preset", () => {
  const base = { weeklyHoursByLine: { research: 15, startup: 20, media: 10 }, line: "research", relations: 2, maxRelations: 4,
    graded: true, daysToDeadline: 10, pastAdjustments: [] };

  it("adds up four named reasons, each visible on its own", () => {
    const preset = presetImportance(base);
    expect(preset.basis.map((item) => [item.key, item.points])).toEqual([["priority", 23], ["centrality", 8], ["consequence", 25], ["history", 0]]);
    expect(preset.weight).toBe(20 + 23 + 8 + 25);
  });

  it("moves with the person's own past adjustments on the line, within bounds", () => {
    expect(presetImportance({ ...base, pastAdjustments: [-40, -30] }).basis.find((item) => item.key === "history")!.points).toBe(-15);
    expect(presetImportance({ ...base, pastAdjustments: [6, 10] }).weight).toBe(presetImportance(base).weight + 8);
  });

  it("stays inside 0–100 and takes a middle value when nothing is known", () => {
    const unknown = presetImportance({ weeklyHoursByLine: {}, line: "media", relations: 0, maxRelations: 0, graded: false, daysToDeadline: null, pastAdjustments: [] });
    expect(unknown.weight).toBe(35);
    expect(presetImportance({ ...base, line: "startup", relations: 4, daysToDeadline: 3, pastAdjustments: [40] }).weight).toBeLessThanOrEqual(100);
  });

  it("reads stated weekly hours, taking the upper end of a range", () => {
    expect(hoursFromText("每周投入 10–20 小时。")).toBe(20);
    expect(hoursFromText("ECE 555 与 ECE 548 合计每周约 15 小时。")).toBe(15);
    expect(hoursFromText("没有")).toBeNull();
  });
});
