import { expect, test } from "vitest";
import { dayText, entryDay, minutesText, punct, shortDate } from "./format";

test("durations and days read as before in Chinese and as English in English", () => {
  expect([45, 90, 120].map((minutes) => minutesText(undefined, minutes))).toEqual(["45 分", "1 时 30 分", "2 小时"]);
  expect([45, 90, 120].map((minutes) => minutesText("en", minutes))).toEqual(["45 min", "1 h 30 min", "2 h"]);
  expect(dayText("zh", "2026-10-16")).toBe("10/16 周五");
  expect(dayText("en", "2026-10-16T09:00:00Z")).toBe("Oct 16 Fri");
  expect(shortDate("zh", "2026-10-06")).toBe("10/6");
  expect(shortDate("en", "2026-10-06")).toBe("Oct 6");
  expect(entryDay("zh", "2026-10-20")).toBe("10-20");
  expect(entryDay("en", "2026-10-20")).toBe("Oct 20");
  expect(["a", "b"].join(punct("zh", "、"))).toBe("a、b");
  expect(["a", "b"].join(punct("en", "；"))).toBe("a; b");
});
