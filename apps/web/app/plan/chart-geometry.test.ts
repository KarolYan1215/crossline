import { describe, expect, test } from "vitest";
import { bands, dayTicks, heatLevel, hours, labelEvery, linear, linearTicks, logDomain, logScale, md, minuteLabel, scatterMargins, textWidth } from "./chart-geometry";

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

  test("day ticks step weekly, then every two or four weeks over longer spans", () => {
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

  test("text width counts CJK, curly quotes and the ellipsis as one em", () => {
    expect(textWidth("ECE 548 期中")).toBe(Math.ceil(12 * 0.68 * 3 + 12 * 0.58 * 3 + 12 * 0.3 * 2 + 24));
    expect(textWidth("“科研”")).toBe(48);
    expect(textWidth("超载…")).toBe(36);
  });

  test("the estimate chart's axis title clears the top tick label, and the last x label fits inside the chart", () => {
    const size = 220, px = 12;
    const domain = logDomain([15, 480]);
    const margins = scatterMargins(domain.ticks, px);
    const y = logScale(domain.min, domain.max, size - margins.bottom, margins.top);
    const x = logScale(domain.min, domain.max, margins.left, size - margins.right);
    // 「实际」 occupies about one line above its baseline; the top y label is centred on the top tick.
    const titleBottom = margins.titleBaseline + px * 0.3;
    const topLabelTop = y(domain.ticks.at(-1)!) - px / 2;
    expect(topLabelTop).toBeGreaterThan(titleBottom);
    // The last x label is centred on the last tick and must end inside the chart.
    const last = minuteLabel(domain.ticks.at(-1)!);
    expect(x(domain.ticks.at(-1)!) + textWidth(last, px) / 2).toBeLessThanOrEqual(size);
    // Every y label fits in the left margin.
    for (const tick of domain.ticks) expect(textWidth(minuteLabel(tick), px) + 4).toBeLessThanOrEqual(margins.left);
  });
});
