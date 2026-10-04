import { expect, test } from "vitest";
import { categoryMinutesOnly, classifyWindow, inferWorkState, isPrivateWindow, type ActivitySegment } from "./activity-state";

test("banking, password managers and private windows are never recorded, and the person's own words are added", () => {
  expect(isPrivateWindow("1Password.exe", "Vault")).toBe(true);
  expect(isPrivateWindow("chrome.exe", "Bank of America - Account Summary")).toBe(true);
  expect(isPrivateWindow("chrome.exe", "招商银行 - 登录")).toBe(true);
  expect(isPrivateWindow("msedge.exe", "New tab - InPrivate")).toBe(true);
  expect(isPrivateWindow("chrome.exe", "Reset your password")).toBe(true);
  expect(isPrivateWindow("Code.exe", "activity.ts - Crossline")).toBe(false);
  expect(isPrivateWindow("chrome.exe", "我的心理咨询预约", ["心理咨询"])).toBe(true);
});

test("an app picks its category, a browser's title can move it, and the person's rules win over both", () => {
  expect(classifyWindow("Code.exe", "x.ts")).toBe("coding");
  expect(classifyWindow("virtuoso.exe", "Library Manager")).toBe("research_tool");
  expect(classifyWindow("Spotify.exe", "")).toBe("leisure");
  expect(classifyWindow("chrome.exe", "Attention Is All You Need - arXiv")).toBe("reading");
  expect(classifyWindow("chrome.exe", "Lo-fi beats - YouTube")).toBe("leisure");
  expect(classifyWindow("chrome.exe", "some page")).toBe("browsing");
  // A title cannot turn a document editor into entertainment.
  expect(classifyWindow("WINWORD.EXE", "YouTube notes.docx")).toBe("writing");
  expect(classifyWindow("mystery.exe", "")).toBe("other");
  expect(classifyWindow("chrome.exe", "小红书 创作中心", [{ match: "创作中心", category: "writing" }])).toBe("writing");
});

const at = (minutesAgo: number) => new Date(Date.parse("2026-10-02T15:00:00.000Z") - minutesAgo * 60_000).toISOString();
const seg = (from: number, to: number, app: string, category: ActivitySegment["category"], idle = false): ActivitySegment =>
  ({ start: at(from), end: at(to), app, category, idle });
const state = (segments: ActivitySegment[], calendar: Array<{ start: string; end: string }> = []) => inferWorkState({ segments, now: at(0), calendar });

test("a long stretch in work apps is focus, and says how long", () => {
  const result = state([seg(15, 0, "Code.exe", "coding")]);
  expect(result).toMatchObject({ state: "focused", confidence: "high", dominant: "coding", switches: 0 });
  expect(result.reasons[0]).toContain("连续最长 15 分钟");
});

test("constant app changes are switching, not focus, even when every app is a work app", () => {
  const apps = ["Code.exe", "acrobat.exe", "WINWORD.EXE"] as const;
  const cats = ["coding", "reading", "writing"] as const;
  const segments = Array.from({ length: 10 }, (_, i) => seg(15 - i * 1.5, 15 - (i + 1) * 1.5, apps[i % 3]!, cats[i % 3]!));
  expect(state(segments)).toMatchObject({ state: "switching" });
});

test("mostly idle is away, mostly entertainment is leisure, and a mix says it cannot tell", () => {
  expect(state([seg(15, 3, "x", "other", true), seg(3, 0, "Code.exe", "coding")])).toMatchObject({ state: "away", confidence: "high" });
  expect(state([seg(15, 2, "Spotify.exe", "leisure"), seg(2, 0, "Code.exe", "coding")])).toMatchObject({ state: "leisure" });
  expect(state([seg(15, 8, "Code.exe", "coding"), seg(8, 0, "chrome.exe", "browsing")])).toMatchObject({ state: "mixed", confidence: "low" });
});

test("a meeting on the calendar explains silence, and too little data stays unknown", () => {
  const meeting = [{ start: at(30), end: at(-30) }];
  expect(state([seg(15, 0, "x", "other", true)], meeting)).toMatchObject({ state: "in_meeting", inMeeting: true });
  expect(state([seg(3, 0, "Code.exe", "coding")])).toMatchObject({ state: "unknown", confidence: "low" });
  expect(state([])).toMatchObject({ state: "unknown" });
});

test("what may leave the machine is minutes per category: no app names, no titles", () => {
  const out = categoryMinutesOnly([seg(30, 20, "Code.exe", "coding"), seg(20, 10, "Code.exe", "coding"), seg(10, 0, "x", "other", true)]);
  expect(out).toEqual({ coding: 20, idle: 10 });
  // A segment has no title field to carry one.
  expect(Object.keys(seg(1, 0, "a", "coding"))).toEqual(["start", "end", "app", "category", "idle"]);
});
