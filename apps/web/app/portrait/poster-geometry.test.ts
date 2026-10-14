import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { SCHWARTZ_VALUES, validatePortrait, type PortraitReport } from "@crossline/core";
import { axisBar, dodgeMatrix, energyLegend, hourClock, posterSerifText, radarValues, rhythmStats } from "./poster-geometry";

const fixture = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../../../e2e/fixtures/portrait-report.json"), "utf8")) as PortraitReport;

test("an axis bar grows from the middle towards the pole leaned to; a strong lean carries its percentage inside", () => {
  expect(axisBar(94)).toEqual({ side: "right", percent: 94, from: 50, width: 44, inside: true });
  expect(axisBar(22)).toEqual({ side: "left", percent: 78, from: 22, width: 28, inside: true });
  expect(axisBar(69)).toEqual({ side: "right", percent: 69, from: 50, width: 19, inside: true });
  expect(axisBar(52)).toEqual({ side: "right", percent: 52, from: 50, width: 2, inside: false });
  expect(axisBar(50)).toMatchObject({ width: 0, inside: false });
});

test("advice on the same matrix cell is spread around it, never on top of each other", () => {
  const r = 11;
  const spread = dodgeMatrix(Array.from({ length: 6 }, () => ({ x: 100, y: 100 })), r);
  for (let a = 0; a < spread.length; a += 1) for (let b = a + 1; b < spread.length; b += 1) {
    expect(Math.hypot(spread[a]!.x - spread[b]!.x, spread[a]!.y - spread[b]!.y)).toBeGreaterThanOrEqual(2 * r + 2);
  }
  expect(dodgeMatrix([{ x: 10, y: 20 }, { x: 60, y: 20 }], r)).toEqual([{ x: 10, y: 20 }, { x: 60, y: 20 }]);
  // Near but not on one spot (two activities a few points apart) are pushed apart too.
  const near = dodgeMatrix([{ x: 100, y: 100 }, { x: 105, y: 103 }, { x: 98, y: 108 }], r);
  for (let a = 0; a < near.length; a += 1) for (let b = a + 1; b < near.length; b += 1) {
    expect(Math.hypot(near[a]!.x - near[b]!.x, near[a]!.y - near[b]!.y)).toBeGreaterThanOrEqual(2 * r + 2 - 0.01);
  }
});

test("the energy legend groups by the six categories, ranks within a group, and numbers once for plane and legend", () => {
  const map: PortraitReport["energy"]["map"] = [
    { activity: "行政", skill: "low", love: "low", charge: "drain", skillScore: 30, loveScore: 20, category: "行政事务" },
    { activity: "旧报告", skill: "high", love: "high", charge: "charge", skillScore: 90, loveScore: 90 },
    { activity: "精读", skill: "high", love: "high", charge: "charge", skillScore: 60, loveScore: 60, category: "学习输入" },
    { activity: "构想", skill: "high", love: "high", charge: "charge", skillScore: 70, loveScore: 70, category: "深度工作" },
    { activity: "调试", skill: "high", love: "high", charge: "charge", skillScore: 90, loveScore: 80, category: "深度工作" }];
  const groups = energyLegend(map);
  expect(groups.map((group) => group.category)).toEqual(["深度工作", "学习输入", "行政事务", "未分类"]);
  expect(groups.flatMap((group) => group.entries.map((entry) => [entry.number, entry.activity]))).toEqual([[1, "调试"], [2, "构想"], [3, "精读"], [4, "行政"], [5, "旧报告"]]);
});

test("the radar is drawn only for exactly Schwartz's ten, in the circle's order", () => {
  const values = [...SCHWARTZ_VALUES].reverse().map((value, index) => ({ name: value.name, score: index * 10, evidence: "" }));
  expect(radarValues(values)!.map((value) => value.name)).toEqual(SCHWARTZ_VALUES.map((value) => value.name));
  expect(radarValues(values.slice(1))).toBeNull();
  expect(radarValues([...values.slice(1), { name: "求真", score: 90, evidence: "" }])).toBeNull();
});

test("the e2e fixture is a report the validator accepts", () => {
  expect(() => validatePortrait(fixture, ["research", "startup", "media", "investment"])).not.toThrow();
});

test("every character set in the poster's serif is in the self-hosted subset, so none falls back to another face", () => {
  const glyphs = new Set(readFileSync(path.resolve(import.meta.dirname, "../../public/fonts/poster-serif.glyphs.txt"), "utf8"));
  expect([...posterSerifText()].filter((char) => !glyphs.has(char))).toEqual([]);
});

test("the rhythm page's four readings: the best window as a clock range, signed social jetlag, and what is missing said instead of a number", () => {
  const base = { curve: [], sleep: { from: 23.5, to: 7.5 }, peak: { start: 9.5, end: 12.5 }, thresholds: { low: 9.5, high: 12.5 }, reports: [], nights: 0 };
  expect(hourClock(25.25)).toBe("1:15");
  const empty = rhythmStats({ ...base, chronotype: null, debt: { perNight: 0, nights: 0 } });
  expect(empty.map((cell) => [cell.title, cell.value])).toEqual([["最佳时段", "9:30–12:30"], ["早晚型", "待定"], ["社会时差", "待定"], ["睡眠债", "待定"]]);
  const full = rhythmStats({ ...base, nights: 20, debt: { perNight: 0.6, nights: 14 },
    chronotype: { sdWork: 7, sdFree: 8.5, sdWeek: 7.4, msw: 3.5, msf: 4.25, msfSc: 3.9, sjlRel: 0.75, sjl: 0.75, chronotype: "intermediate" } });
  expect(full.map((cell) => cell.value)).toEqual(["9:30–12:30", "中间型", "+0.8 小时", "每晚少 0.6 小时"]);
  expect(full[2]!.detail).toBe("休息日睡眠中点比工作日晚");
});
