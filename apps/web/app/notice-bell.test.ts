import { expect, test } from "vitest";
import { isReminderKind } from "./notice-kinds";
import { toastCandidate } from "./notice-bell";

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
