import { expect, test } from "vitest";
import { pairRelation, publicType } from "./public-type";

test("a public type carries no answers, names both poles, marks near-middle axes and ranks each axis", () => {
  const view = publicType({ lines: 80, purpose: 45, collab: 20, build: 90 }, {}, "", undefined, ["写初稿"]);
  expect(view.code).toBe("ROHG");
  expect(view.name).toBe("时间管理大师");
  expect(view.subtitle.length).toBeGreaterThan(4);
  expect(view.axes.map((axis) => axis.ambiguous)).toEqual([false, true, false, false]);
  expect(view.axes[0]).toMatchObject({ letter: "R", rank: { pole: "接力", estimated: true } });
  expect(view).toMatchObject({ aiDoes: ["写初稿"], aiKeeps: expect.any(String), kindred: { name: "理查德·布兰森" } });
  expect(view.lines).toHaveLength(3);
  expect(view.best.code).not.toBe(view.hardest.code);
  expect(JSON.stringify(view)).not.toMatch(/@|answers|appearance/);
});

test("a pair names its relations and the lines both types suit", () => {
  const pair = pairRelation("ROBA", "ROHA");
  expect(pair.primary.name).toBe("图纸派和手感派");
  expect(pair.secondary?.name).toBe("同频搭子");
  expect(pairRelation("ROBA", "RUHG").sharedLines).toEqual(["创业者"]);
  expect(pairRelation("ROBA", "RUHA").sharedLines).toEqual([]);
});

test("a strong lean's rank is capped and keyed by the result: one result always shows the same number", () => {
  const strong = { lines: 98, purpose: 2, collab: 97, build: 99 };
  const one = publicType(strong, {}, "result-a").axes.map((axis) => axis.rank.percent);
  expect(publicType(strong, {}, "result-a").axes.map((axis) => axis.rank.percent)).toEqual(one);
  for (const percent of one) expect(percent).toBeGreaterThanOrEqual(91), expect(percent).toBeLessThanOrEqual(96);
  const others = Array.from({ length: 30 }, (_, index) => publicType(strong, {}, `result-${index}`).axes[0]!.rank.percent);
  expect(new Set(others).size).toBeGreaterThan(1);
});
