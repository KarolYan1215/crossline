import { expect, test } from "vitest";
import { asLocale, joinList, localeFromCookieHeader, monthDay, pickOf, registerCatalog, tFor, weekdayShort } from "./index";

test("Chinese is the key: shown as written, values filled in, and English read from the catalogue", () => {
  registerCatalog({ "已完成 {{n}} 项": "{{n}} done", "{{count}} 个任务_one": "{{count}} task", "{{count}} 个任务_other": "{{count}} tasks" });
  expect(tFor("zh")("已完成 {{n}} 项", { n: 3 })).toBe("已完成 3 项");
  expect(tFor("en")("已完成 {{n}} 项", { n: 3 })).toBe("3 done");
  expect(tFor("en")("{{count}} 个任务", { count: 1 })).toBe("1 task");
  expect(tFor("en")("{{count}} 个任务", { count: 2 })).toBe("2 tasks");
  expect(tFor("zh")("{{count}} 个任务", { count: 2 })).toBe("2 个任务");
  // A key with no English shows the Chinese rather than nothing; the catalogue test keeps it from reaching a person.
  expect(tFor("en")("没有译文：{{x}}", { x: 1 })).toBe("没有译文：1");
  expect(tFor(undefined)("待确认")).toBe("待确认");
  expect(asLocale("fr")).toBe("zh");
  expect(pickOf("en", { zh: "主线", en: "Track" })).toBe("Track");
});

test("one Chinese word with two English readings is told apart by a context", () => {
  registerCatalog({ "开启_state": "On", "开启": "Turn on" });
  expect(tFor("en")("开启", { context: "state" })).toBe("On");
  expect(tFor("en")("开启")).toBe("Turn on");
  expect(tFor("zh")("开启", { context: "state" })).toBe("开启");
});

test("days, weekdays and lists in each language's own form", () => {
  expect(monthDay("zh", "2026-10-17")).toBe("10月17日");
  expect(monthDay("en", "2026-10-17")).toBe("Oct 17");
  expect(weekdayShort("zh", 3)).toBe("周三");
  expect(weekdayShort("en", 3)).toBe("Wed");
  expect(joinList("zh", ["A", "B", "C"])).toBe("A、B和C");
  expect(joinList("en", ["A", "B", "C"])).toBe("A, B and C");
});

test("the cookie names the language only with a known value", () => {
  expect(localeFromCookieHeader("a=1; crossline-locale=en; b=2")).toBe("en");
  expect(localeFromCookieHeader("crossline-locale=fr")).toBeUndefined();
  expect(localeFromCookieHeader(undefined)).toBeUndefined();
});
