import { expect, test } from "vitest";
import {
  MAIL_DRAFT_NOTE, draftBodyOf, isMailReminderTitle, draftFileText, mailReplyQuiet, replyDraftsOn, replyReminderDue, validateMailReplyDraft, validateMailTriage, type MailReplyDraft
} from "./mail";

test("a reply with no wait behind it is a message that needs the person's answer; a named wait must still be open", () => {
  const item = (waitingId: string) => ({ items: [{ uid: 1, kind: "reply" as const, title: "", waitingId, why: "导师要数据" }] });
  expect(validateMailTriage(item(""), [1], [])).toMatchObject({ items: [{ waitingId: "" }] });
  expect(validateMailTriage(item("wait-1"), [1], ["wait-1"])).toMatchObject({ items: [{ waitingId: "wait-1" }] });
  expect(() => validateMailTriage(item("wait-gone"), [1], ["wait-1"])).toThrow("MAIL_TRIAGE_INVALID");
});

test("a draft needs a body and its points, a day as YYYY-MM-DD, and never says it was sent", () => {
  const good = { needsReply: true, why: "导师要周五前的数据", subject: "Re: 数据", body: "老师好，数据【请确认：周五前】发您。", points: ["确认周五前发数据", " "], replyBy: "2026-10-23" };
  expect(validateMailReplyDraft(good).points).toEqual(["确认周五前发数据"]);
  expect(() => validateMailReplyDraft({ ...good, body: "" })).toThrow("MAIL_REPLY_DRAFT_INVALID");
  expect(() => validateMailReplyDraft({ ...good, replyBy: "周五" })).toThrow("MAIL_REPLY_DRAFT_INVALID");
  expect(() => validateMailReplyDraft({ ...good, body: "已为你发送了回复。" })).toThrow("MAIL_REPLY_DRAFT_INVALID");
  // No answer needed: nothing else is required.
  expect(validateMailReplyDraft({ needsReply: false, why: "自动通知", subject: "", body: "", points: [], replyBy: "" }).needsReply).toBe(false);
});

test("the draft file starts with the note that the person sends it; a copy takes the body alone", () => {
  const text = draftFileText({ from: "Prof Lin <lin@uni.edu>", subject: "测量数据", date: "2026-10-19T08:00:00Z" },
    { subject: "", body: "老师好，\n\n数据周五前发您。\n\n【署名】" });
  expect(text.split("\n")[0]).toBe(`> ${MAIL_DRAFT_NOTE}`);
  expect(text).toContain("主题：Re: 测量数据");
  expect(draftBodyOf(text)).toBe("老师好，\n\n数据周五前发您。\n\n【署名】");
  expect(draftBodyOf(text)).not.toContain("Crossline");
});

test("messages about drafts follow the nudges' quiet rules", () => {
  const base = { clock: "10:00", timerRunning: false, inMeeting: false, answeredRecently: false, level: "normal", muted: false };
  expect(mailReplyQuiet(base)).toBeUndefined();
  expect(mailReplyQuiet({ ...base, clock: "23:30" })).toBe("night");
  expect(mailReplyQuiet({ ...base, clock: "07:59" })).toBe("night");
  expect(mailReplyQuiet({ ...base, timerRunning: true })).toBe("busy");
  expect(mailReplyQuiet({ ...base, inMeeting: true })).toBe("busy");
  expect(mailReplyQuiet({ ...base, answeredRecently: true })).toBe("busy");
  expect(mailReplyQuiet({ ...base, muted: true })).toBe("muted");
  expect(mailReplyQuiet({ ...base, level: "off" })).toBe("notify_off");
  expect(replyDraftsOn(undefined)).toBe(true);
  expect(replyDraftsOn("off")).toBe(false);
});

test("one reminder, 48 hours after the person was told, only when the mail named a day to answer by", () => {
  const draft = { notifiedAt: "2026-10-19T10:00:00Z", replyBy: "2026-10-23" } as MailReplyDraft;
  expect(replyReminderDue(draft, new Date("2026-10-21T09:59:00Z"))).toBe(false);
  expect(replyReminderDue(draft, new Date("2026-10-21T10:00:00Z"))).toBe(true);
  expect(replyReminderDue({ ...draft, remindedAt: "2026-10-21T10:00:00Z" }, new Date("2026-10-22T10:00:00Z"))).toBe(false);
  expect(replyReminderDue({ ...draft, replyBy: "" }, new Date("2026-10-22T10:00:00Z"))).toBe(false);
  expect(replyReminderDue({ ...draft, notifiedAt: undefined } as unknown as MailReplyDraft, new Date("2026-10-22T10:00:00Z"))).toBe(false);
});

test("a mail to-do that only asks to look at something is a reminder", () => {
  expect(isMailReminderTitle("核查 Render 公告涉及应用")).toBe(true);
  expect(isMailReminderTitle("核查 Crossline beta 失败")).toBe(true);
  expect(isMailReminderTitle("10/30 前交 ECE 555 HW4")).toBe(false);
});
