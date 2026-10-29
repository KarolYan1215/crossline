import { expect, test } from "vitest";
import { tFor } from "../../lib/i18n";
import { capacityBasisText } from "./capacity-basis";

test("the plan's basis says the stated hours beside the measured ones, and which the plan follows (closed-loop-1030 §1)", () => {
  const t = tFor("zh");
  expect(capacityBasisText(t, { statedWeekly: 72, measuredWeekly: 19.4, basis: "measured" })).toBe("所述 72 h/周 · 实测近 28 天 19.4 h/周 · 按实测排");
  expect(capacityBasisText(t, { statedWeekly: 72, measuredWeekly: null, basis: "stated" })).toBe("所述 72 h/周 · 实测不足 5 天 · 按所述的一半排");
  expect(capacityBasisText(t, { statedWeekly: 72, measuredWeekly: null, basis: "off" })).toBe("所述 72 h/周 · 按所述排");
  expect(capacityBasisText(tFor("en"), { statedWeekly: 72, measuredWeekly: 19.4, basis: "screen" }))
    .toBe("Stated 72 h/week · measured 19.4 h/week over the last 28 days · planned on what was measured");
});
