import { expect, test } from "vitest";
import { bandAxis } from "./helper-window";

/** The narrow 小帮手's band spans the day's blocks and now, in whole hours, never narrower than 08:00–20:00. */
test("the band covers the blocks and now in whole hours", () => {
  expect(bandAxis([], undefined)).toEqual({ from: 480, to: 1200 });
  expect(bandAxis([{ start: "06:40", end: "07:30" }, { start: "21:10", end: "22:20" }], 600)).toEqual({ from: 360, to: 1380 });
  expect(bandAxis([{ start: "23:00", end: "00:00" }], 1430)).toEqual({ from: 480, to: 1440 });
});
