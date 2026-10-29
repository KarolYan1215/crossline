import { expect, test } from "vitest";
import { tFor } from "../../lib/i18n";
import { capacityBasisText } from "./capacity-basis";

test("the plan's basis says the stated hours beside the measured ones, which the plan follows, and the adaptive factor (closed-loop-1030 §1)", () => {
  const t = tFor("zh");
  expect(capacityBasisText(t, { statedWeekly: 72, measuredWeekly: 19.4, basis: "measured", factor: 1.1, realization: 0.88 }))
    .toBe("所述 72 h/周 · 实测近 28 天 19.4 h/周 · 按实测排 · 系数 1.1（上周兑现 88%）");
  expect(capacityBasisText(t, { statedWeekly: 72, measuredWeekly: 19.4, basis: "measured", factor: 1 })).toBe("所述 72 h/周 · 实测近 28 天 19.4 h/周 · 按实测排 · 系数 1");
  expect(capacityBasisText(t, { statedWeekly: 72, measuredWeekly: null, basis: "stated", factor: 1 })).toBe("所述 72 h/周 · 实测不足 5 天 · 按所述的一半排");
  expect(capacityBasisText(t, { statedWeekly: 72, measuredWeekly: null, basis: "off", factor: 1 })).toBe("所述 72 h/周 · 按所述排");
  expect(capacityBasisText(tFor("en"), { statedWeekly: 72, measuredWeekly: 19.4, basis: "screen", factor: 1.2, realization: 0.9 }))
    .toBe("Stated 72 h/week · measured 19.4 h/week over the last 28 days · planned on what was measured · factor 1.2 (90% of last week's plan kept)");
});
