import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { OnboardingProgress } from "@crossline/core";
import { LocaleProvider } from "../locale-context";
import { OpeningCard, openingReply } from "./opening-card";
import { WeekView } from "./stage-view";
import { progressHeadline } from "./turn-progress";
import { DateBatchCard } from "./date-batch-card";

/** The interview in English (docs/i18n.md): the screen's own words, the reply the person "says", the wait and the week. */
const en = (node: React.ReactNode) => renderToStaticMarkup(<LocaleProvider locale="en">{node}</LocaleProvider>);

test("the opening card speaks English and offers the common roles as English words", () => {
  const html = en(<OpeningCard linesKnown={false} knownLines={[]} initialTone="neutral" busy={false} hasMaterials={false} onStart={() => {}} />);
  expect(html).toContain("A note from the developer");
  expect(html).toContain("How would you like me to talk to you?");
  expect(html).toContain("Which roles are you investing in right now?");
  expect(html).toContain("Researcher");
  expect(html).toContain("Start the interview");
  expect(html).not.toMatch(/[一-鿿]{2,}.*你希望/);
  expect(html).not.toContain("开始访谈");
});

test("the first reply is said in English on an English screen, and stays Chinese otherwise", () => {
  const reply = openingReply({ tone: "direct", lines: ["Researcher", "Entrepreneur"], base: "", fixed: [] }, true, "en");
  expect(reply).toContain("[My tracks] Researcher, Entrepreneur");
  expect(reply).toContain("[Foundation for the next 12–24 months] All equally");
  expect(reply).toContain("[Tracks with a fixed schedule] None");
  expect(reply.endsWith("I've added my materials. Please read what you can from them first, then ask about what's missing.")).toBe(true);
  expect(openingReply({ tone: "direct", lines: ["研究者"], base: "", fixed: [] }, false)).toContain("【我的主线】研究者");
});

test("the wait says what the turn is doing in English", () => {
  const at = (over: Partial<OnboardingProgress>): OnboardingProgress => ({ sessionId: "s", startedAt: "", updatedAt: "", phase: "thinking", files: [],
    facts: 0, dates: 0, questions: 0, reply: "", repairs: 0, stalls: 0, ...over });
  expect(progressHeadline(null, "en")).toBe("Preparing this round…");
  expect(progressHeadline(at({ phase: "queued", ahead: 2 }), "en")).toBe("In the queue: 2 ahead");
  expect(progressHeadline(at({ files: ["syllabus.pdf", "cv.docx", "timetable.png"] }), "en")).toBe("Reading 3 files: syllabus.pdf, cv.docx and more");
  expect(progressHeadline(at({ files: ["syllabus.pdf"] }), "en")).toBe("Reading 1 file: syllabus.pdf");
});

test("the week's days and tooltips are English", () => {
  const html = en(<WeekView week={{ source: "interview", windows: [{ days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00", energy: "high" }],
    fixed: [{ id: "c1", title: "ECE 548", project: "ece548", weekdays: [2, 4], start: "11:00", end: "12:15", status: "pending" }], calendar: [] }} />);
  expect(html).toContain("ECE 548 · Tue 11:00–12:15 (to confirm)");
  expect(html).toContain("Mon 09:00–17:00 available (energy high)");
  expect(html).toContain("About 40 h available a week (proposed by the interview; change it on the Plan page).");
  expect(html).toContain(">Sun<");
});

test("the date batch counts in English, with plurals", () => {
  const item = { id: "d1", kind: "date" as const, title: "Midterm", project: "ece548", confidence: "high" as const, when: "Oct 27", quote: "10/27 Midterm",
    sourceRef: "src-1", note: "", checked: true, blocks: 0 };
  const html = en(<DateBatchCard batch={{ id: "b", documentCount: 1, items: [item], questions: [], dropped: 2 }} busy={false} onDecide={() => {}} onRedo={() => {}} />);
  expect(html).toContain("1 item found in 1 file(s)");
  expect(html).toContain("Add to calendar (1 item)");
  expect(html).toContain("2 more items couldn&#x27;t be verified against the source and were dropped, not saved.");
  expect(html).toContain("High confidence");
});
