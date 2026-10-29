import { expect, test } from "vitest";
import { isReminderKind } from "./notice-kinds";
import { noticeGroups, toastCandidate } from "./notice-bell";

test("the bell lists today's messages apart from earlier ones, leaving an empty group out", () => {
  const now = new Date(2026, 9, 27, 12, 0);
  const item = (id: string, at: Date) => ({ id, kind: "mail_check", text: id, at: at.toISOString(), links: [], actionable: false });
  const groups = noticeGroups([item("a", new Date(2026, 9, 27, 9, 0)), item("b", new Date(2026, 9, 26, 18, 0))], now);
  expect(groups.map((group) => [group.today, group.items.map((entry) => entry.id)])).toEqual([[true, ["a"]], [false, ["b"]]]);
  expect(noticeGroups([item("b", new Date(2026, 9, 26, 18, 0))], now).map((group) => group.today)).toEqual([false]);
});

test("what asks for an answer stays with the helper; everything else is a reminder", () => {
  expect(isReminderKind("block_confirm")).toBe(false);
  expect(isReminderKind("opener")).toBe(false);
  expect(isReminderKind("mail_check")).toBe(true);
  expect(isReminderKind("date_advance")).toBe(true);
  expect(isReminderKind(undefined)).toBe(true);
});

test("the newest unread reminder pops once", () => {
  const body = { readAt: "2026-10-27T08:00:00.000Z", unread: 1, items: [
    { id: "b", kind: "mail_check", text: "核实一笔交易", at: "2026-10-27T09:00:00.000Z", links: [], actionable: true },
    { id: "a", kind: "date_advance", text: "整理", at: "2026-10-27T07:00:00.000Z", links: [], actionable: false }] };
  expect(toastCandidate(body, "")?.id).toBe("b");
  expect(toastCandidate(body, "b")).toBeUndefined();
  expect(toastCandidate({ ...body, readAt: "2026-10-27T10:00:00.000Z" }, "")).toBeUndefined();
});
