import { expect, test } from "vitest";
import { attributedBlockSpans, attributeSegment, draftTimeEntries, validateTimeAttribution, type DraftBlock, type TimeDraft, type TitledSegment } from "./time-drafts";

/** 拟计时 (docs/plans/2026-11-11-walkthrough-decisions.md §1): the screen record turned into time entries the person confirms. */
const at = (clock: string) => `2026-11-10T${clock}:00.000Z`;
const seg = (from: string, to: string, app: string, title: string, category: string, idle = false): TitledSegment =>
  ({ start: at(from), end: at(to), app, title, category, idle });
const block = (from: string, to: string, role?: string): DraftBlock => ({ orderId: "paper", stepId: "s1", ...(role ? { role } : {}), start: at(from), end: at(to) });
const now = at("23:00");

test("the person's rule comes first: an app or title keyword names the task, inside a block of another task or outside any", () => {
  const rules = [{ match: "ECE 555", category: "writing" as const, workOrderId: "hw", stepId: "h2" }, { match: "leetcode", category: "coding" as const, identityId: "career" }];
  expect(attributeSegment({ app: "winword.exe", title: "ECE 555 report.docx", category: "writing", idle: false }, rules, block("09:00", "10:00", "draft")))
    .toEqual({ work: true, target: { workOrderId: "hw", stepId: "h2" }, basis: "rule" });
  // A rule makes its window work even when its category is not a work one; a line-only rule names the line.
  expect(attributeSegment({ app: "chrome.exe", title: "LeetCode 42", category: "browsing", idle: false }, rules))
    .toEqual({ work: true, target: { identityId: "career" }, basis: "rule" });
  expect(attributeSegment({ app: "chrome.exe", title: "news", category: "browsing", idle: false }, rules)).toEqual({ work: false });
  expect(attributeSegment({ app: "winword.exe", title: "x", category: "writing", idle: true }, rules)).toEqual({ work: false });
});

test("inside a work block, screen time goes to the block's step only when its category fits the step's kind", () => {
  expect(attributeSegment({ app: "winword.exe", title: "draft", category: "writing", idle: false }, [], block("09:00", "10:00", "draft")))
    .toEqual({ work: true, target: { workOrderId: "paper", stepId: "s1" }, basis: "block" });
  // Coding in a writing step's block is work, but not that step's.
  expect(attributeSegment({ app: "code.exe", title: "x.ts", category: "coding", idle: false }, [], block("09:00", "10:00", "draft"))).toEqual({ work: true });
  // A simulation step takes the research tools; a block with no known step takes any work category.
  expect(attributeSegment({ app: "matlab.exe", title: "sim.m", category: "research_tool", idle: false }, [], block("09:00", "10:00", "test")).basis).toBe("block");
  expect(attributeSegment({ app: "code.exe", title: "x.ts", category: "coding", idle: false }, [], block("09:00", "10:00")).basis).toBe("block");
});

test("contiguous work merges across gaps of up to five minutes; short, timed, still-running or already-drafted time is not drafted", () => {
  const segments = [
    seg("08:00", "08:10", "winword.exe", "thesis.docx", "writing"),
    seg("08:10", "08:13", "chrome.exe", "news", "browsing"),
    seg("08:13", "08:30", "winword.exe", "thesis.docx", "writing"),
    // Seven idle minutes break the stretch.
    seg("08:30", "08:37", "winword.exe", "", "other", true),
    seg("08:37", "08:47", "code.exe", "a.ts", "coding"),
    // Inside a writing block: the writing goes to its step, the coding beside it does not.
    seg("09:00", "09:40", "winword.exe", "paper.docx", "writing"),
    seg("09:40", "10:00", "code.exe", "b.ts", "coding"),
    // Under a running timer: never drafted.
    seg("11:00", "12:00", "code.exe", "c.ts", "coding"),
    // Still going at `now`.
    seg("22:40", "22:58", "code.exe", "d.ts", "coding")
  ];
  const drafts = draftTimeEntries({ segments, rules: [], blocks: [block("09:00", "10:00", "draft")], excluded: [{ start: at("11:00"), end: at("12:00") }], now });
  expect(drafts.map(({ draft }) => [draft.start.slice(11, 16), draft.end.slice(11, 16), draft.minutes, draft.basis, draft.workOrderId ?? "", draft.app])).toEqual([
    ["08:00", "08:30", 27, "none", "", "winword.exe"],
    ["09:00", "09:40", 40, "block", "paper", "winword.exe"],
    ["09:40", "10:00", 20, "none", "", "code.exe"]]);
  // The titles go with an unattributed stretch for the model, most time first; the draft itself keeps none.
  expect(drafts[0]!.titles).toEqual(["thesis.docx"]);
  expect(JSON.stringify(drafts.map(({ draft }) => draft))).not.toContain("thesis");
  // A stretch already drafted (pending or decided) is not drafted again.
  const again = draftTimeEntries({ segments, rules: [], blocks: [block("09:00", "10:00", "draft")], now,
    excluded: [{ start: at("11:00"), end: at("12:00") }, ...drafts.map(({ draft }) => ({ start: draft.start, end: draft.end }))] });
  expect(again).toEqual([]);
});

test("the model's answer is kept only for stretches it was asked about and tasks and steps that exist and are open", () => {
  const tasks = [{ id: "hw", steps: ["h1", "h2"] }, { id: "paper", steps: [] }];
  const answer = { items: [
    { id: "d1", workOrderId: "hw", stepId: "h2", why: "标题含作业编号" },
    { id: "d2", workOrderId: "gone", stepId: "", why: "" },
    { id: "d3", workOrderId: "paper", stepId: "h1", why: "论文" },
    { id: "zz", workOrderId: "hw", stepId: "", why: "" }] };
  expect(validateTimeAttribution(answer, ["d1", "d2", "d3"], tasks)).toEqual([
    { id: "d1", workOrderId: "hw", stepId: "h2", why: "标题含作业编号" },
    { id: "d2", workOrderId: "", stepId: "", why: "" },
    { id: "d3", workOrderId: "paper", stepId: "", why: "论文" }]);
  expect(() => validateTimeAttribution({ nope: 1 }, ["d1"], tasks)).toThrow("TIME_ATTRIBUTION_INVALID");
});

test("a block's screen minutes are only those attributed to its own task (the wrap-up's inference)", () => {
  const draft = (from: string, to: string, workOrderId: string, basis: TimeDraft["basis"]): TimeDraft =>
    ({ id: `draft:${from}`, start: at(from), end: at(to), minutes: 10, app: "winword.exe", category: "writing", workOrderId, basis, createdAt: now });
  const segments = [
    seg("09:00", "09:20", "winword.exe", "", "writing"),
    // Coding does not fit a writing step.
    seg("09:20", "09:30", "code.exe", "", "coding"),
    // The model put this writing on another paper.
    seg("09:30", "09:40", "winword.exe", "", "writing"),
    // A rule sends this app to another task, whatever the block.
    seg("09:40", "09:50", "typora.exe", "", "writing"),
    // Outside the block: not its minutes.
    seg("10:00", "10:30", "winword.exe", "", "writing")];
  const rules = [{ match: "typora", category: "writing" as const, workOrderId: "blog" }];
  const spans = attributedBlockSpans({ segments, rules, block: block("09:00", "10:00", "draft"), drafts: [draft("09:30", "09:40", "other-paper", "model")] });
  expect(spans.reduce((sum, span) => sum + (span.end - span.start) / 60_000, 0)).toBe(20);
  // A draft the model put on this task counts even where the category does not fit.
  const mine = attributedBlockSpans({ segments, rules, block: block("09:00", "10:00", "draft"), drafts: [draft("09:20", "09:30", "paper", "model")] });
  expect(mine.reduce((sum, span) => sum + (span.end - span.start) / 60_000, 0)).toBe(40);
});
