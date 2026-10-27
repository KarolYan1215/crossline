import { describe, expect, test } from "vitest";
import { AXIS_LABEL, axisLabelBox, axisLabelLeader, bands, dayAt, dayTicks, fitText, heatLevel, hours, labelEvery, layoutAxisLabels, linear, linearTicks, logDomain, logScale, md, minuteLabel, monthTicks, scatterMargins, textWidth, type AxisLabel } from "./chart-geometry";

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

  test("text width counts CJK, curly quotes and the ellipsis as one em; a name is cut with 「…」 to fit", () => {
    expect(textWidth("ECE 548 期中")).toBe(Math.ceil(12 * 0.68 * 3 + 12 * 0.58 * 3 + 12 * 0.3 * 2 + 24));
    expect(textWidth("“科研”")).toBe(48);
    expect(fitText("真实数据仿真图表已获合作师兄接收", 1000)).toBe("真实数据仿真图表已获合作师兄接收");
    expect(fitText("真实数据仿真图表已获合作师兄接收", 60)).toBe("真实数据…");
    expect(fitText("真实数据", 10)).toBe("");
  });

  describe("milestone axis names", () => {
    const axisY = 200;
    const bounds = { left: 96, right: 1100 };
    const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
      a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    /** Every geometric promise the chart makes, checked on one layout. */
    const check = (items: Array<{ x: number; text: string }>, placed: Array<AxisLabel | null>) => {
      const boxes = placed.map((label) => label ? axisLabelBox(label, axisY) : null);
      placed.forEach((label, index) => {
        if (!label) return;
        const box = boxes[index]!;
        // Inside the plot, above the marker, the text as wide as its box and as wide as it says.
        expect(box.x).toBeGreaterThanOrEqual(bounds.left);
        expect(box.x + box.w).toBeLessThanOrEqual(bounds.right);
        expect(box.y + box.h).toBeLessThanOrEqual(axisY - AXIS_LABEL.marker);
        expect(textWidth(label.text)).toBe(label.width);
        expect(label.text === items[index]!.text || label.text.endsWith("…")).toBe(true);
        // The name sits at its own marker: starting at it, or ending at it.
        const x = items[index]!.x;
        expect(x).toBeGreaterThanOrEqual(box.x - 2);
        expect(x).toBeLessThanOrEqual(box.x + box.w + 2);
        // No two names touch.
        boxes.forEach((other, otherIndex) => { if (other && otherIndex !== index) expect(overlaps(box, other), `${label.text} / ${placed[otherIndex]!.text}`).toBe(false); });
        // Its leader crosses no other name.
        const leader = axisLabelLeader(x, label, axisY);
        boxes.forEach((other, otherIndex) => {
          if (!other || otherIndex === index) return;
          const crosses = leader.x >= other.x && leader.x <= other.x + other.w && leader.y2 < other.y + other.h && leader.y1 > other.y;
          expect(crosses, `leader of ${label.text} through ${placed[otherIndex]!.text}`).toBe(false);
        });
      });
    };

    test("the real account's crowded fortnight: names in lanes, none on top of another, none crossed by a leader", () => {
      // About 4.4px a day on a 1440px screen; 10/26–11/3 on the research line, as found on 2026-10-21.
      const at = (day: number) => 300 + day * 4.4;
      const items = [
        { x: at(0), text: "Sleep replay 硬件机制已通过导师设计评审" },
        { x: at(2), text: "真实数据仿真图表已获合作师兄接收" },
        { x: at(8), text: "科研过程与多主线任务样本包已整理完成" },
        { x: at(22), text: "ECE 548 期中考试" },
        { x: at(30), text: "论文初稿" },
        { x: 1099, text: "期末项目报告提交" }
      ];
      const placed = layoutAxisLabels(items, bounds, { lanes: 3 });
      check(items, placed);
      // The first three, which used to pile up, each get a lane of their own and keep a readable name.
      expect(placed.slice(0, 3).map((label) => label?.lane).sort()).toEqual([0, 1, 2]);
      for (const label of placed.slice(0, 3)) expect(label!.width).toBeGreaterThanOrEqual(AXIS_LABEL.minWidth);
      // A marker at the plot's right edge ends its name there instead of running off.
      expect(placed[5]).toMatchObject({ anchor: "end", text: "期末项目报告提交" });
    });

    test("more names than lanes: the rest are left out, never drawn over", () => {
      const items = Array.from({ length: 12 }, (_, index) => ({ x: 400 + index * 3, text: `里程碑名称很长的一项第${index}号` }));
      const placed = layoutAxisLabels(items, bounds, { lanes: 3 });
      check(items, placed);
      expect(placed.filter(Boolean).length).toBeLessThanOrEqual(3);
      expect(placed.filter((label) => !label).length).toBeGreaterThan(0);
    });

    test("markers a day apart stack as a staircase, the later one lowest; two on one day keep one name", () => {
      const items = [{ x: 500, text: "一号里程碑" }, { x: 504.4, text: "二号里程碑" }, { x: 508.8, text: "三号里程碑" }];
      const placed = layoutAxisLabels(items, bounds);
      check(items, placed);
      expect(placed.map((label) => label?.lane)).toEqual([2, 1, 0]);
      const same = [{ x: 600, text: "期中考试" }, { x: 600, text: "实验报告" }];
      const twins = layoutAxisLabels(same, bounds);
      check(same, twins);
      expect(twins.filter(Boolean)).toHaveLength(1);
    });

    test("names with room keep their full text in the lowest lane", () => {
      const items = [{ x: 120, text: "期中考试" }, { x: 400, text: "论文投稿" }, { x: 800, text: "导师评审" }];
      expect(layoutAxisLabels(items, bounds).map((label) => label && [label.lane, label.text])).toEqual([[0, "期中考试"], [0, "论文投稿"], [0, "导师评审"]]);
    });

    test("random crowded axes keep every promise", () => {
      let seed = 7;
      const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
      const words = ["Sleep replay", "硬件", "机制已通过", "导师设计评审", "ECE 555", "“科研如何实际发生”", "样本包", "数据", "投资复盘", "第3期"];
      for (let round = 0; round < 200; round += 1) {
        const count = 2 + Math.floor(random() * 14);
        const items = Array.from({ length: count }, () => ({ x: bounds.left + random() * (bounds.right - bounds.left),
          text: Array.from({ length: 1 + Math.floor(random() * 4) }, () => words[Math.floor(random() * words.length)]).join("") }));
        check(items, layoutAxisLabels(items, bounds, { lanes: 1 + Math.floor(random() * 3) }));
      }
    });
  });

  test("month ticks carry the year where it turns, and thin out over long spans", () => {
    expect(monthTicks("2026-10-07", "2027-02-15").map((tick) => tick.label)).toEqual(["2026年11月", "12月", "2027年1月", "2月"]);
    expect(monthTicks("2026-10-01", "2027-10-01").map((tick) => tick.day)).toEqual(["2026-10-01", "2026-12-01", "2027-02-01", "2027-04-01", "2027-06-01", "2027-08-01", "2027-10-01"]);
    expect(monthTicks("2026-10-01", "2027-10-01")[2]!.label).toBe("2027年2月");
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
