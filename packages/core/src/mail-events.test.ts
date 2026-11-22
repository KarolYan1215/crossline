import { expect, test } from "vitest";
import {
  attendedText, dateItemAttributes, mailEventClash, mailEventFrom, mailEventRulesAfter, mailEventsOnSchedule, mailObligation, parseTimeRange, readMailEventRules, structureEvidence,
  decideMailEvent, withMailEvent, type MailEvent, type MailMeetReading, type MailStructure
} from "./index";

const ME = "me@uni.edu";
const plain: MailStructure = { listed: false, recipients: [ME] };
const base = { person: ME, servesMilestone: false };

test("the model's attend decides (2026-11-20): must is required and not asked, likely is asked only when it serves a milestone", () => {
  expect(mailObligation({ ...base, attend: "must", structure: plain })).toEqual({ obligation: "required", basis: "model", ask: false });
  expect(mailObligation({ ...base, attend: "likely", structure: plain })).toEqual({ obligation: "likely", basis: "model", ask: false });
  expect(mailObligation({ ...base, attend: "likely", servesMilestone: true, structure: plain })).toEqual({ obligation: "likely", basis: "model", ask: true });
  expect(mailObligation({ ...base, attend: "optional", servesMilestone: true, structure: plain })).toEqual({ obligation: "optional", basis: "model", ask: false });
  // A list's notice is no longer capped by code: the structure is the model's evidence.
  expect(mailObligation({ ...base, attend: "must", structure: { listed: true, recipients: [] } })).toMatchObject({ obligation: "required" });
  // An answer recorded without attend is optional.
  expect(mailObligation({ ...base, attend: undefined, structure: plain })).toMatchObject({ obligation: "optional" });
});

test("what stays code's is the person's own: two 不去 for a sender, and their 拒绝 of the invitation", () => {
  expect(mailObligation({ ...base, attend: "must", rule: "optional", structure: plain })).toEqual({ obligation: "optional", basis: "rule", ask: false });
  const declined: MailStructure = { ...plain, invite: { method: "REQUEST", organizer: "lin@uni.edu", attendees: [{ address: ME, role: "REQ-PARTICIPANT", partstat: "DECLINED" }] } };
  expect(mailObligation({ ...base, attend: "must", structure: declined })).toEqual({ obligation: "optional", basis: "declined", ask: false });
});

test("the structure is said to the model as evidence", () => {
  const invite = (attendee: { role: string; partstat: string }, organizer = "lin@uni.edu") => ({ method: "REQUEST", organizer, attendees: [{ address: ME, ...attendee }] });
  expect(structureEvidence({ ...plain, invite: invite({ role: "", partstat: "" }, ME) }, ME)).toEqual({ listed: false, recipients: 1, toPersonAlone: true, invite: "organizer" });
  expect(structureEvidence({ listed: true, recipients: [ME, "x@uni.edu"], invite: invite({ role: "REQ-PARTICIPANT", partstat: "NEEDS-ACTION" }) }, ME))
    .toEqual({ listed: true, recipients: 2, toPersonAlone: false, invite: "required" });
  expect(structureEvidence(plain, ME).invite).toBe("");
});

const meet = (over: Partial<MailMeetReading> = {}): MailMeetReading => ({ date: "2026-11-17", start: "14:00", end: "", location: "", lineId: "", relevance: 40, personal: true,
  quote: "Can we meet on Tuesday, Nov 17 at 2pm", ...over });
const input = (over: Partial<Parameters<typeof mailEventFrom>[1]> = {}) => ({ id: "m1", title: "与 Lin 老师见面", from: "Prof Lin <lin@uni.edu>", fromAddress: "lin@uni.edu",
  subject: "Meeting", text: "Can we meet on Tuesday, Nov 17 at 2pm in my office?", today: "2026-11-10", lineIds: [], at: "2026-11-10T09:00:00Z", ...over });

test("an event carries timing and obligation: must goes on the schedule, likely serving a milestone is asked, the rest is listed", () => {
  expect(mailEventFrom(meet({ attend: "must" }), input())).toMatchObject({ timing: "fixed", obligation: "required", basis: "model", state: "fixed", source: "lin@uni.edu" });
  expect(mailEventFrom(meet({ attend: "likely" }), input({ servesMilestone: true }))).toMatchObject({ obligation: "likely", state: "asked" });
  expect(mailEventFrom(meet({ attend: "likely" }), input())).toMatchObject({ obligation: "likely", state: "digest" });
  expect(mailEventFrom(meet({ attend: "optional" }), input({ servesMilestone: true }))).toMatchObject({ obligation: "optional", state: "digest" });
  expect(mailEventFrom(meet({ attend: "must" }), input({ rules: [{ source: "lin@uni.edu", cap: "optional", why: "skipped_twice", at: "", example: "" }] })))
    .toMatchObject({ obligation: "optional", state: "digest" });
});

test("a day the quote's weekday contradicts, or one before the mail was sent, is not taken (relative days count from the mail)", () => {
  // Nov 17 2026 is a Tuesday: 「Wednesday, Nov 17」 is a misread.
  expect(mailEventFrom(meet({ quote: "Can we meet on Wednesday, Nov 17 at 2pm" }), input({ text: "Can we meet on Wednesday, Nov 17 at 2pm?" }))).toBeUndefined();
  expect(mailEventFrom(meet({ quote: "下周二（11 月 17 日）下午两点见" }), input({ text: "下周二（11 月 17 日）下午两点见" }))).toBeDefined();
  expect(mailEventFrom(meet({ quote: "下周三（11 月 17 日）下午两点见" }), input({ text: "下周三（11 月 17 日）下午两点见" }))).toBeUndefined();
  expect(mailEventFrom(meet(), input({ sentAt: "2026-11-18T08:00:00Z" }))).toBeUndefined();
});

test("required events are on the schedule without being asked, and a clash with another fixed one is found", () => {
  const event = (id: string, state: MailEvent["state"], start: string, end: string): MailEvent => ({ id, title: id, date: "2026-11-24", start, end, location: "", lineId: "",
    relevance: 0, personal: false, from: "", subject: "", state, at: "" });
  const list = [event("a", "fixed", "12:45", "13:15"), event("b", "asked", "09:00", "10:00"), event("c", "go", "16:00", "17:00")];
  expect(mailEventsOnSchedule(list).map((item) => [item.id, item.source])).toEqual([["mail-a", "mail"]]);
  const lecture = { id: "lec", title: "Lecture", lineId: "", repeat: { weekdays: [2], from: "2026-09-01", until: "2026-12-10", exceptions: [] }, date: "", start: "13:00", end: "14:15", location: "", source: "input" as const };
  expect(mailEventClash(event("x", "asked", "12:45", "13:15"), [lecture])?.id).toBe("lec");
  expect(mailEventClash(event("x", "asked", "11:00", "12:00"), [lecture])).toBeUndefined();
  // A required one kept on the schedule is kept when the same mail is read again.
  expect(withMailEvent(list, { ...event("a", "asked", "12:45", "13:15") }, "2026-11-10").find((item) => item.id === "a")!.state).toBe("fixed");
});

test("answers become per-source rules: two 不去 in a row cap the source, 去 to a required one lets it be required directly", () => {
  const event = (id: string, over: Partial<MailEvent> = {}): MailEvent => ({ id, title: id, date: "2026-11-20", start: "10:00", end: "11:00", location: "", lineId: "",
    relevance: 80, personal: false, from: "Club <club@uni.edu>", subject: id, state: "asked", at: "", source: "club@uni.edu", obligation: "likely", basis: "relevance", ...over });
  let list = [event("a"), event("b"), event("c", { source: "lab@uni.edu", obligation: "required", basis: "model" })];
  list = decideMailEvent(list, "a", "skip", "2026-11-10T10:00:00Z");
  let rules = mailEventRulesAfter(list, [], "a", "skip", "2026-11-10T10:00:00Z");
  expect(rules).toEqual([]);
  list = decideMailEvent(list, "b", "skip", "2026-11-11T10:00:00Z");
  rules = mailEventRulesAfter(list, rules, "b", "skip", "2026-11-11T10:00:00Z");
  expect(rules).toEqual([{ source: "club@uni.edu", cap: "optional", why: "skipped_twice", at: "2026-11-11T10:00:00Z", example: "b" }]);
  list = decideMailEvent(list, "c", "go", "2026-11-11T11:00:00Z");
  rules = mailEventRulesAfter(list, rules, "c", "go", "2026-11-11T11:00:00Z");
  expect(rules.map((rule) => [rule.source, rule.cap])).toEqual([["club@uni.edu", "optional"], ["lab@uni.edu", "required"]]);
  expect(readMailEventRules(JSON.stringify(rules))).toEqual(rules);
  expect(readMailEventRules("not json")).toEqual([]);
});

test("a syllabus's exam, quiz or class of a known course is required and fixed; with only a day it needs its time", () => {
  expect(dateItemAttributes({ kind: "exam", startTime: "" }, true)).toEqual({ timing: "fixed", obligation: "required", needsTime: true });
  expect(dateItemAttributes({ kind: "quiz", startTime: "10:00" }, true)).toEqual({ timing: "fixed", obligation: "required", needsTime: false });
  expect(dateItemAttributes({ kind: "exam", startTime: "" }, false)).toEqual({ timing: "fixed", obligation: "likely", needsTime: false });
  expect(dateItemAttributes({ kind: "homework_due", startTime: "" }, true)).toEqual({ timing: "due", obligation: "required", needsTime: false });
  expect(dateItemAttributes({ kind: "other", startTime: "" }, true)).toEqual({ timing: "none", obligation: "optional", needsTime: false });
});

test("「几点到几点」 is read from the person's words", () => {
  expect(parseTimeRange("12:45-13:15")).toEqual({ start: "12:45", end: "13:15" });
  expect(parseTimeRange("9:00 到 10:30")).toEqual({ start: "09:00", end: "10:30" });
  expect(parseTimeRange("14点到15点30")).toEqual({ start: "14:00", end: "15:30" });
  expect(parseTimeRange("2:00 to 3:15")).toEqual({ start: "02:00", end: "03:15" });
  expect(parseTimeRange("13:15-12:45")).toBeUndefined();
  expect(parseTimeRange("下午")).toBeUndefined();
});

test("going to something is the titler's reading, not a verb at the front (2026-11-22)", () => {
  // The verb list missed these; the titler read them as events.
  expect(attendedText({ intent: "于 11 月 5 日 11:00 通过 Zoom 参加 ECE 研究系列讲座", payload: { title: "参加 ECE 研究系列讲座", attends: true } })).toBe("参加 ECE 研究系列讲座");
  expect(attendedText({ intent: "Levy Hall 校友座谈会", payload: { attends: true } })).toBe("Levy Hall 校友座谈会");
  // Preparing for it is work, and a task the titler has not read yet is ordinary work.
  expect(attendedText({ intent: "复习第 3 章，并参加小测", payload: { title: "复习第 3 章", attends: false } })).toBeUndefined();
  expect(attendedText({ intent: "参加组会", payload: { title: "参加组会" } })).toBeUndefined();
});
