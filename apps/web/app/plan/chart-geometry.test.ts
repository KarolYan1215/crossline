import { describe, expect, test } from "vitest";
import { bands, dayAt, dayTicks, heatLevel, hours, labelEvery, linear, linearTicks, logDomain, logScale, md, minuteLabel, monthTicks, packLabels, textWidth } from "./chart-geometry";

describe("chart geometry", () => {
  test("linear ticks are round, start at zero and reach the maximum", () => {
    expect(linearTicks(17)).toEqual([0, 5, 10, 15, 20]);
    expect(linearTicks(3.2)).toEqual([0, 1, 2, 3, 4]);
    expect(linearTicks(0)).toEqual([0, 1]);
    expect(linearTicks(40, 4).at(-1)).toBeGreaterThanOrEqual(40);
  });

  test("a linear y scale runs downwards and a log scale clamps", () => {
    const y = linear(20, 100, 0);
    expect(y(0)).toBe(100);
    expect(y(10)).toBe(50);
    expect(y(-5)).toBe(100);
    const x = logScale(10, 1000, 0, 200);
    expect(x(10)).toBe(0);
    expect(x(100)).toBeCloseTo(100);
    expect(x(5)).toBe(0);
    expect(x(5000)).toBe(200);
  });

  test("the log domain brackets the values with readable minute ticks", () => {
    expect(logDomain([40, 95])).toEqual({ min: 30, max: 120, ticks: [30, 60, 120] });
    expect(logDomain([20, 50, 300])).toMatchObject({ min: 15, max: 480 });
    expect(logDomain([])).toMatchObject({ min: 10, max: 240 });
    expect(minuteLabel(30)).toBe("30 分");
    expect(minuteLabel(120)).toBe("2 时");
  });

  test("bands centre their bars and labels thin out when bands are narrow", () => {
    const layout = bands(4, 400, 0.5);
    expect(layout.band).toBe(100);
    expect(layout.x(1)).toBe(125);
    expect(layout.centre(3)).toBe(350);
    expect(labelEvery(100, 40)).toBe(1);
    expect(labelEvery(12, 40)).toBe(4);
  });

  test("days are placed on the axis, and days off it are clamped and marked", () => {
    expect(dayAt("2026-10-17", "2026-10-10", 56)).toEqual({ at: 0.125, clipped: null });
    expect(dayAt("2026-10-01", "2026-10-10", 56)).toEqual({ at: 0, clipped: "before" });
    expect(dayAt("2027-01-01", "2026-10-10", 56)).toEqual({ at: 1, clipped: "after" });
    expect(dayTicks("2026-10-10", 28)).toEqual(["2026-10-10", "2026-10-17", "2026-10-24", "2026-10-31", "2026-11-07"]);
    expect(dayTicks("2026-10-10", 182)).toHaveLength(7);
  });

  test("formatting and heat levels", () => {
    expect(hours(270)).toBe(4.5);
    expect(md("2026-10-07")).toBe("10/7");
    expect(heatLevel(0, 60)).toBe(0);
    expect(heatLevel(1, 60)).toBe(1);
    expect(heatLevel(60, 60)).toBe(4);
  });

  test("labels are packed into the fewest rows that keep them apart, and turn back at the right edge", () => {
    expect(textWidth("ECE 548 期中")).toBe(Math.ceil(12 * 0.68 * 3 + 12 * 0.58 * 3 + 12 * 0.3 * 2 + 24));
    const packed = packLabels([{ x: 10, width: 100 }, { x: 60, width: 100 }, { x: 130, width: 40 }, { x: 390, width: 100 }], 400);
    expect(packed.map((item) => item.row)).toEqual([0, 1, 0, 0]);
    // The last would run past 400: it ends at its point instead.
    expect(packed[3]).toEqual({ row: 0, left: 294 });
  });

  test("month ticks carry the year where it turns, and thin out over long spans", () => {
    expect(monthTicks("2026-10-07", "2027-02-15").map((tick) => tick.label)).toEqual(["2026年11月", "12月", "2027年1月", "2月"]);
    expect(monthTicks("2026-10-01", "2027-10-01").map((tick) => tick.day)).toEqual(["2026-10-01", "2026-12-01", "2027-02-01", "2027-04-01", "2027-06-01", "2027-08-01", "2027-10-01"]);
    expect(monthTicks("2026-10-01", "2027-10-01")[2]!.label).toBe("2027年2月");
  });
});
