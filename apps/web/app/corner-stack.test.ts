import { expect, test } from "vitest";
import { nextTucked } from "./corner-stack";

const page = { viewport: 800, documentHeight: 3000 };

test("the 小帮手 bubble steps aside while the page scrolls down and comes back on scrolling up, at the top and at the foot", () => {
  expect(nextTucked({ ...page, tucked: false, previousY: 400, y: 460 })).toBe(true);
  expect(nextTucked({ ...page, tucked: true, previousY: 460, y: 420 })).toBe(false);
  // A few pixels of jitter keep whatever it was.
  expect(nextTucked({ ...page, tucked: true, previousY: 460, y: 457 })).toBe(true);
  expect(nextTucked({ ...page, tucked: false, previousY: 460, y: 463 })).toBe(false);
  // Near the top nothing is under it yet; at the foot the page keeps room for it (`--corner-clearance`).
  expect(nextTucked({ ...page, tucked: true, previousY: 20, y: 60 })).toBe(false);
  expect(nextTucked({ ...page, tucked: true, previousY: 2150, y: 2190 })).toBe(false);
});
