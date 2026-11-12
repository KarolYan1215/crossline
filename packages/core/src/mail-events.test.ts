import { expect, test } from "vitest";
import {
  attendedName, dateItemAttributes, mailEventClash, mailEventFrom, mailEventRulesAfter, mailEventsOnSchedule, mailObligation, parseTimeRange, readMailEventRules,
  decideMailEvent, withMailEvent, type MailEvent, type MailMeetReading, type MailStructure
} from "./index";

const ME = "me@uni.edu";
const plain: MailStructure = { listed: false, recipients: [ME] };
const base = { person: ME, personal: false, relevance: 0, requiredQuote: false, senderRole: "other" as const };

test("required comes only from structure: organizer, a required participant, an accepted invitation to the person alone", () => {
  const invite = (attendee: { role: string; partstat: string }, organizer = "lin@uni.edu") => ({ method: "REQUEST", organizer, attendees: [{ address: ME, ...attendee }] });
  expect(mailObligation({ ...base, structure: { ...plain, invite: invite({ role: "", partstat: "" }, ME) } })).toEqual({ obligation: "required", basis: "organizer", ask: true });
  expect(mailObligation({ ...base, structure: { ...plain, invite: invite({ role: "REQ-PARTICIPANT", partstat: "NEEDS-ACTION" }) } }))
    .toMatchObject({ obligation: "required", basis: "required_participant" });
  expect(mailObligation({ ...base, structure: { ...plain, invite: invite({ role: "OPT-PARTICIPANT", partstat: "ACCEPTED" }) } }))
    .toMatchObject({ obligation: "required", basis: "accepted" });
  // Accepted, but the invitation went to many: not required by that alone; still an invitation of the person's.
  expect(mailObligation({ ...base, structure: { listed: false, recipients: [ME, "x@uni.edu"], invite: invite({ role: "OPT-PARTICIPANT", partstat: "ACCEPTED" }) } }))
    .toMatchObject({ obligation: "likely", basis: "invitation" });
  // A source the person said 去 to before is required without asking.
  expect(mailObligation({ ...base, rule: "required", structure: { ...plain, invite: invite({ role: "REQ-PARTICIPANT", partstat: "" }) } }))
    .toEqual({ obligation: "required", basis: "required_participant", ask: false });
});

test("a list or bulletin board is at most optional whatever the body or the invitation says", () => {
  const listed: MailStructure = { listed: true, recipients: [ME], invite: { method: "REQUEST", organizer: ME, attendees: [] } };
  expect(mailObligation({ ...base, structure: listed, personal: true, relevance: 95, requiredQuote: true, senderRole: "course_staff", rule: "required" }))
    .toEqual({ obligation: "optional", basis: "list", ask: false });
});

test("body keywords alone give likely, from course staff or an advisor only; a 去 rule makes the same source required", () => {
  expect(mailObligation({ ...base, structure: plain, requiredQuote: true, senderRole: "course_staff" })).toEqual({ obligation: "likely", basis: "keyword", ask: true });
  expect(mailObligation({ ...base, structure: plain, requiredQuote: true, senderRole: "advisor", rule: "required" })).toEqual({ obligation: "required", basis: "rule", ask: false });
  // Anyone else writing 「attendance required」 is not believed.
  expect(mailObligation({ ...base, structure: plain, requiredQuote: true, senderRole: "other" })).toEqual({ obligation: "optional", basis: "none", ask: false });
  expect(mailObligation({ ...base, structure: plain, personal: true })).toMatchObject({ obligation: "likely", basis: "invitation" });
  expect(mailObligation({ ...base, structure: plain, relevance: 70 })).toMatchObject({ obligation: "likely", basis: "relevance" });
  expect(mailObligation({ ...base, structure: plain, relevance: 69 })).toMatchObject({ obligation: "optional" });
  expect(mailObligation({ ...base, structure: plain, personal: true, rule: "optional" })).toEqual({ obligation: "optional", basis: "rule", ask: false });
});

const meet = (over: Partial<MailMeetReading> = {}): MailMeetReading => ({ date: "2026-11-17", start: "14:00", end: "", location: "", lineId: "", relevance: 40, personal: true,
  quote: "Can we meet on Tuesday, Nov 17 at 2pm", ...over });
const input = (over: Partial<Parameters<typeof mailEventFrom>[1]> = {}) => ({ id: "m1", title: "与 Lin 老师见面", from: "Prof Lin <lin@uni.edu>", fromAddress: "lin@uni.edu",
  subject: "Meeting", text: "Can we meet on Tuesday, Nov 17 at 2pm in my office?", today: "2026-11-10", lineIds: [], at: "2026-11-10T09:00:00Z", ...over });

test("an event carries timing and obligation; required and known goes on the schedule, required and new is asked, optional is listed", () => {
  const asked = mailEventFrom(meet(), input())!;
  expect(asked).toMatchObject({ timing: "fixed", obligation: "likely", state: "asked", source: "lin@uni.edu" });
  const organizer = { listed: false, recipients: [ME], invite: { method: "REQUEST", organizer: ME, attendees: [] } };
  expect(mailEventFrom(meet(), input({ structure: organizer, person: ME }))).toMatchObject({ obligation: "required", basis: "organizer", state: "asked" });
  expect(mailEventFrom(meet(), input({ structure: organizer, person: ME, rules: [{ source: "lin@uni.edu", cap: "required", why: "went", at: "", example: "" }] })))
    .toMatchObject({ obligation: "required", state: "fixed" });
  expect(mailEventFrom(meet({ personal: false, relevance: 60 }), input())).toMatchObject({ obligation: "optional", state: "digest" });
  expect(mailEventFrom(meet(), input({ structure: { listed: true, recipients: [] }, person: ME }))).toMatchObject({ obligation: "optional", state: "digest" });
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
  let list = [event("a"), event("b"), event("c", { source: "lab@uni.edu", obligation: "likely", basis: "keyword" })];
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

test("an event is named by what it is: no verb, no leading day, no 「在…举行的」", () => {
  expect(attendedName("参加 11 月 6 日在 Levy Hall 举行的 CoE Alumni Award 座谈会")).toBe("CoE Alumni Award 座谈会");
  expect(attendedName("参加 11 月 2 日晚间 BadgerShop 排练")).toBe("BadgerShop 排练");
  expect(attendedName("参加 11 月 5 日 ECE 研究系列讲座")).toBe("ECE 研究系列讲座");
  expect(attendedName("出席组会")).toBe("组会");
  // What follows the first clause is about the task (seen on the owner's card the day it shipped).
  expect(attendedName("参加 11 月 5 日 ECE 研究系列讲座，并保留参会记录。")).toBe("ECE 研究系列讲座");
  expect(attendedName("参加 11 月 2 日晚间 BadgerShop 排练。")).toBe("BadgerShop 排练");
  expect(attendedName("参加")).toBe("参加");
});
