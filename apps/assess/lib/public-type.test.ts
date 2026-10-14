import { expect, test } from "vitest";
import { pairRelation, publicType } from "./public-type";

test("a public type carries no answers, names both poles, marks near-middle axes and ranks each axis", () => {
  const view = publicType({ scope: 80, basis: 45, output: 20, rhythm: 90 });
  expect(view.code).toBe("GEMA");
  expect(view.name).toBe("改装师");
  expect(view.subtitle.length).toBeGreaterThan(4);
  expect(view.axes.map((axis) => axis.ambiguous)).toEqual([false, true, false, false]);
  expect(view.axes[0]).toMatchObject({ letter: "G", rank: { pole: "跨界", estimated: true } });
  expect(view.lines).toHaveLength(3);
  expect(view.best.code).not.toBe(view.hardest.code);
  expect(JSON.stringify(view)).not.toMatch(/@|answers|appearance/);
});

test("a pair names its relations and the lines both types suit", () => {
  const pair = pairRelation("SEMP", "SEMA");
  expect(pair.primary.name).toBe("进度条之争");
  expect(pair.secondary?.name).toBe("复刻搭子");
  expect(pairRelation("GEMA", "GIMA").sharedLines).toEqual(expect.arrayContaining(["创业者", "内容作者"]));
});
