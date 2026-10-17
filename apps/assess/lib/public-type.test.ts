import { expect, test } from "vitest";
import { pairRelation, publicType } from "./public-type";

test("a public type carries no answers, names both poles, marks near-middle axes and ranks each axis", () => {
  const view = publicType({ concentration: 80, orientation: 45, boundary: 20, pacing: 90 });
  expect(view.code).toBe("DLWV");
  expect(view.name).toBe("改装师");
  expect(view.subtitle.length).toBeGreaterThan(4);
  expect(view.axes.map((axis) => axis.ambiguous)).toEqual([false, true, false, false]);
  expect(view.axes[0]).toMatchObject({ letter: "D", rank: { pole: "多线并行", estimated: true }, balance: null });
  expect(view.lines).toHaveLength(3);
  expect(view.best.code).not.toBe(view.hardest.code);
  expect(JSON.stringify(view)).not.toMatch(/@|answers|appearance/);
});

test("a pair names its relations and the lines both types suit", () => {
  const pair = pairRelation("CLWU", "CLWV");
  expect(pair.primary.name).toBe("进度条之争");
  expect(pair.secondary?.name).toBe("复刻搭子");
  expect(pairRelation("CLWU", "DXWV").sharedLines).toEqual(["创业者"]);
  expect(pairRelation("CLWU", "CXWV").sharedLines).toEqual([]);
});

test("a strong lean's rank is capped and keyed by the result: one result always shows the same number", () => {
  const strong = { concentration: 98, orientation: 2, boundary: 97, pacing: 99 };
  const one = publicType(strong, {}, "result-a").axes.map((axis) => axis.rank.percent);
  expect(publicType(strong, {}, "result-a").axes.map((axis) => axis.rank.percent)).toEqual(one);
  for (const percent of one) expect(percent).toBeGreaterThanOrEqual(91), expect(percent).toBeLessThanOrEqual(96);
  const others = Array.from({ length: 30 }, (_, index) => publicType(strong, {}, `result-${index}`).axes[0]!.rank.percent);
  expect(new Set(others).size).toBeGreaterThan(1);
});
