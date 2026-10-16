import "@crossline/i18n/catalog/worker";
import { describe, expect, test } from "vitest";
import { planAssistantTask, categoryFromWording } from "./agent-dispatch";
import { decideCommand, decideFileChange, decideMcpTool } from "./agent-guard";
import { plainProject, type KnownProject } from "./belonging";
import { deriveCapacity } from "./capacity";
import { acceptanceStandardLines, completionRule, outcomeCriteriaVerdict } from "./completion";
import { mentionsExternalAction } from "./external-action";
import { describeEvent, fixedEventBlocks, type FixedEvent } from "./fixed-events";
import { presetImportance } from "./importance";
import { advanceWorkOrder, validateCommandEnvelope, validateSuccessCriteria } from "./index";
import { ASSUMPTION_PREFIX, interviewChecklist } from "./interview-checklist";
import { openAccessVerdict } from "./manualbook-schema";
import { questionKind } from "./onboarding-turn-schema";
import { portraitLabels, typeFromScores } from "./portrait-type";
import { answerLine, answeredGapFacts, gapCoveredBy, profileGaps, readAnswerLine, readableFromMaterial, screenQuestions, undatedKey } from "./profile-gaps";
import { licenseVerdict } from "./public-skills";
import { plainEstimateWords } from "./text-hygiene";
import { scheduleLabel, stepLeavesMachine } from "./workflows";

/**
 * The English side of packages/core's person-facing text (docs/i18n.md): each builder gets `locale`, says the same thing in English, and
 * says exactly what it said before without one; each heuristic that reads Chinese reads English too.
 */

const weekly: FixedEvent = { id: "e", title: "ECE 548", lineId: "research", repeat: { weekdays: [1, 5], from: "2026-09-04", until: "2026-12-07", exceptions: [] },
  date: "2026-09-04", start: "14:30", end: "15:45", location: "", source: "file" };
const once: FixedEvent = { ...weekly, repeat: null, date: "2026-10-27" };

describe("text built in English, unchanged in Chinese", () => {
  test("a fixed event and a workflow schedule", () => {
    expect(describeEvent(weekly)).toBe("每周一、五 14:30–15:45（9/4–12/7）");
    expect(describeEvent(once)).toBe("10/27 周二 14:30–15:45");
    expect(describeEvent(weekly, "en")).toBe("Every Mon, Fri 14:30–15:45 (Sep 4–Dec 7)");
    expect(describeEvent(once, "en")).toBe("Tue Oct 27 14:30–15:45");
    expect(fixedEventBlocks([weekly], ["2026-09-04"], "en")[0]?.source).toBe("Event · weekly");
    expect(scheduleLabel({ type: "weekly", days: ["MO", "FR"], time: "09:00" })).toBe("每周一、五 09:00");
    expect(scheduleLabel({ type: "weekly", days: ["MO", "FR"], time: "09:00" }, "en")).toBe("Every Mon, Fri 09:00");
    expect(scheduleLabel(null, "en")).toBe("On request");
  });

  test("completion: the why, the follow-up question and the reported score", () => {
    expect(completionRule({ intent: "", payload: { title: "Write the project report" } }, "en"))
      .toMatchObject({ mode: "needs_assessment", reason: "quality", why: "The quality of the output is hard to judge directly", question: "How did \"Write the project report\" go?" });
    expect(completionRule({ intent: "", payload: { title: "ECE 555 期中考试" } }).question).toBe("「ECE 555 期中考试」的成绩或结果出来了吗？");
    expect(acceptanceStandardLines([{ description: "Report", required: false }], "en")).toEqual(["Report (optional)"]);
    expect(acceptanceStandardLines([{ description: "报告", required: false }])).toEqual(["报告（可选）"]);
    const criteria = [{ id: "c", statement: "s", evidenceOf: "outcome" as const, measure: { kind: "threshold" as const, comparator: "gte" as const, value: 85, unit: "分" } }];
    expect(outcomeCriteriaVerdict(criteria as never, "92", "en")[0]?.observed).toBe("You reported: 92");
  });

  test("capacity, importance, criteria, transitions and offline commands", () => {
    const reading = deriveCapacity({ now: "2026-10-16T12:00:00Z", selfReports: [], dailyActivity: [], interruptionDensity: [], localActivityConsent: "denied", locale: "en" });
    expect(reading.blockers[0]?.message).toMatch(/^Activity tracking on this computer is off/);
    const preset = presetImportance({ standing: { rank: 2, hard: false }, line: "research", relations: 1, maxRelations: 3, graded: true, daysToDeadline: 10, pastAdjustments: [], locale: "en" });
    expect(preset.basis.map((item) => item.detail)).toEqual(["Ranked 2 for the next 12–24 months", "1 cross-track link", "Counts toward a course grade, 10 days to the deadline", "No adjustments yet"]);
    expect(presetImportance({ standing: { rank: 2, hard: false }, line: "research", relations: 1, maxRelations: 3, graded: true, daysToDeadline: 10, pastAdjustments: [] }).basis[2]?.detail)
      .toBe("计入课程成绩，距截止 10 天");
    expect(validateSuccessCriteria([], "en")).toMatchObject({ ok: false, blocker: { message: "A milestone needs at least one success criterion" } });
    expect(advanceWorkOrder({ state: "captured" }, { type: "human.completed" } as never, "en"))
      .toMatchObject({ ok: false, blocker: { message: "Cannot move from captured by human.completed" } });
    expect(validateCommandEnvelope(null, "en")).toMatchObject({ ok: false, blocker: { message: "The offline command is missing a required field" } });
  });

  test("the assistant's guard and dispatch", () => {
    const context = { taskDir: "C:\\work\\task", homeDir: "C:\\Users\\me", locale: "en" as const };
    expect(decideCommand("git push origin main", context).reason).toBe("Pushes to a remote");
    expect(decideCommand("git push origin main", { ...context, locale: undefined }).reason).toBe("把东西推到远端");
    expect(decideFileChange(["C:\\elsewhere\\a.txt"], context).reason).toMatch(/^Only the task's own folder may be written; "C:\\elsewhere\\a.txt" is outside it/);
    expect(decideMcpTool("gmail", "send_message", "en").reason).toBe("send_message on \"gmail\" sends something out; only you can do that");
    const order = { id: "o", intent: "Choose the venue for the retreat", state: "approved", projectId: "p", payload: { family: "preparation" } };
    expect(planAssistantTask(order, { projectIsCourse: false, locale: "en" })).toEqual({ fit: false, reason: "This step needs your own choice or decision, so it is not handed to the assistant whole." });
    const split = { ...order, intent: "Prepare notes", payload: { automationParts: [{ intent: "Summarize the three papers into notes" }] } };
    expect(planAssistantTask(split, { projectIsCourse: false, locale: "en" })).toMatchObject({ category: "read_research_organize", why: "The AI part reads as \"Reading, research and organizing\"." });
  });

  test("interview questions and checklist", () => {
    const gaps = profileGaps({ identities: [{ id: "research", label: "Research" }], projects: [{ id: "thesis", identityId: "research", name: "Thesis" }],
      facts: [{ identityId: "research", projectId: "thesis", slot: "goal", value: "x", status: "confirmed" }], locale: "en" });
    const deadline = gaps.find((gap) => gap.code === "PROJECT_DEADLINE")!;
    expect(deadline.question.text).toBe("Does \"Thesis\" have a deadline?");
    expect(deadline.question.options.map((option) => option.label)).toEqual(["I'll write the date", "No deadline"]);
    const items = interviewChecklist({ lines: [{ id: "research", label: "Research", hard: false, goals: [] }], descriptions: {}, profile: {}, facts: [], projects: [],
      dates: [], availability: false, unfiledFiles: 2, portraitConfirmed: false, locale: "en" });
    expect(items.find((item) => item.id === "line_goal:research")?.label).toBe("\"Research\" has at least one long-term goal chosen");
    expect(items.find((item) => item.id === "files_filed")?.detail).toBe("2 files still need a project (see Decisions)");
    expect(items.find((item) => item.id === "portrait_fields")?.detail).toMatch(/^Missing: One-line portrait, Core tension, /);
  });

  test("the thinking-style type and the poster labels", () => {
    const type = typeFromScores({ scope: 80, basis: 20, output: 30, rhythm: 70 }, {}, "en");
    expect(type).toMatchObject({ code: "GEMA", name: "Modder", group: { name: "Structure group" } });
    expect(type.axes.map((axis) => axis.label)).toEqual(["Generalist", "Evidence", "Making", "Adapting"]);
    expect(typeFromScores({ scope: 80, basis: 20, output: 30, rhythm: 70 }).name).toBe("改装师");
    const report = { cover: { coreWord: "Bridge" }, compass: { values: [] }, lines: { items: [{ lineId: "research", targetShare: 60 }] } } as never;
    expect(portraitLabels(report, { lineLabel: () => "Research", locale: "en" }).cells).toEqual([
      { title: "Core word", value: "Bridge" }, { title: "Suggested base", value: "Research", detail: "About 60% suggested" }]);
  });

  test("small labels", () => {
    expect(plainEstimateWords("p50 合计 180 分钟")).toBe("通常合计 180 分钟");
    expect(plainEstimateWords("p50 total 180 min, p85 240", "en")).toBe("usual total 180 min, cautious 240");
    expect(openAccessVerdict({ url: "https://example.com/a", openAccess: "yes" }, "en").why).toBe("The source is not on a known open-access site: only its link and a summary are kept");
    expect(licenseVerdict("Proprietary", "en")).toEqual({ ok: false, reason: "License Proprietary does not allow reuse, or cannot be confirmed" });
  });
});

describe("heuristics read English as well as Chinese", () => {
  test("questionKind: several answers wanted", () => {
    const ask = (text: string) => questionKind({ kind: "single", text });
    expect(ask("本学期哪些课程最重要？")).toBe("multi");
    expect(ask("ECE 555 的目标分数？")).toBe("single");
    expect(ask("Which of these courses matter most this term?")).toBe("multi");
    expect(ask("Select all that apply: where do you lose time?")).toBe("multi");
    expect(ask("What are your goals for this term?")).toBe("multi");
    expect(ask("What target grade do you want in ECE 555?")).toBe("single");
    expect(ask("What is your goal score for ECE 555?")).toBe("single");
    expect(ask("Which day does the class meet?")).toBe("single");
  });

  test("answeredGapFacts reads Chinese and English replies, across the switch", () => {
    const zh = profileGaps({ identities: [{ id: "media", label: "自媒体" }], projects: [{ id: "channel", identityId: "media", name: "频道" }],
      facts: [{ identityId: "media", projectId: "channel", slot: "goal", value: "x", status: "confirmed" }] });
    const en = profileGaps({ identities: [{ id: "media", label: "Media" }], projects: [{ id: "channel", identityId: "media", name: "Channel" }],
      facts: [{ identityId: "media", projectId: "channel", slot: "goal", value: "x", status: "confirmed" }], locale: "en" });
    const zhGap = zh.find((gap) => gap.code === "PROJECT_DEADLINE")!;
    const enGap = en.find((gap) => gap.code === "PROJECT_DEADLINE")!;
    expect(answerLine(zhGap.question.text, ["没有截止"], "")).toBe("【「频道」有截止日期吗？】选择：没有截止");
    expect(answerLine(enGap.question.text, ["No deadline"], "", "en")).toBe("[Does \"Channel\" have a deadline?] Chose: No deadline");
    expect(answeredGapFacts(answerLine(zhGap.question.text, ["没有截止"], ""), [zhGap]))
      .toEqual([{ identityId: "media", projectId: "channel", slot: "no_deadline", value: "没有截止", quote: "没有截止" }]);
    expect(answeredGapFacts(answerLine(enGap.question.text, ["No deadline"], "", "en"), [enGap]))
      .toEqual([{ identityId: "media", projectId: "channel", slot: "no_deadline", value: "No deadline", quote: "No deadline" }]);
    // A round written in Chinese, answered after the screen was switched to English (the question text is stored, the option label is not).
    expect(answeredGapFacts(`[${zhGap.question.text}] Chose: No deadline`, [zhGap])[0]).toMatchObject({ slot: "no_deadline", value: "No deadline" });
    expect(answeredGapFacts(answerLine(enGap.question.text, [], "2026-12-15", "en"), [enGap])[0]).toMatchObject({ slot: "deadline", value: "2026-12-15" });
    expect(readAnswerLine("Chose: A; B. Added: on Fridays")).toEqual({ picked: ["A", "B"], other: "on Fridays" });
    expect(readAnswerLine("选择：甲；乙。补充：周五")).toEqual({ picked: ["甲", "乙"], other: "周五" });
  });

  test("a model question that already asks what a gap asks, and questions screened out", () => {
    const gaps = profileGaps({ identities: [{ id: "research", label: "Research" }], projects: [{ id: "ece548", identityId: "research", name: "ECE 548" }],
      facts: [{ identityId: "research", projectId: "ece548", slot: "grading", value: "x", status: "confirmed" }], dated: ["ece548"], locale: "en" });
    const meetings = gaps.find((gap) => gap.code === "COURSE_MEETINGS")!;
    expect(gapCoveredBy(meetings, [{ identityId: "research", projectId: "ece548", text: "When does the ECE 548 lecture meet each week?" }])).toBe(true);
    expect(gapCoveredBy(meetings, [{ identityId: "research", projectId: "ece548", text: "ECE 548 每周几点上课？" }])).toBe(true);
    const screen = (text: string) => screenQuestions([{ id: "q", text, projectId: "" }], { projects: [], meetings: [] }).screened[0]?.reason;
    expect(screen("Which room is the ECE 548 lecture in?")).toBe("location");
    expect(screen("ECE 548 在哪个教室？")).toBe("location");
    expect(screen("Are these calendar events ongoing or one-off?")).toBe("calendar_inferable");
    expect(readableFromMaterial("How do I submit homework 3?")).toBe(true);
    expect(readableFromMaterial("作业提交方式？")).toBe(true);
    expect(readableFromMaterial("Which topic matters most to you?")).toBe(false);
    expect(undatedKey("Submit the ECE 555 final project report")).toBe(undatedKey("ECE 555 final project report due"));
  });

  test("completion rules for old tasks", () => {
    const rule = (title: string) => completionRule({ intent: "", payload: { title } });
    expect(rule("Hand in homework 3")).toMatchObject({ mode: "self_evident" });
    expect(rule("提交作业 3")).toMatchObject({ mode: "self_evident" });
    expect(rule("Midterm exam")).toMatchObject({ mode: "needs_assessment", reason: "result_pending" });
    expect(rule("Prepare for the midterm exam")).toMatchObject({ mode: "self_evident" });
    expect(rule("Explore pricing models")).toMatchObject({ mode: "needs_assessment", reason: "exploration" });
    expect(rule("Draft the grant proposal")).toMatchObject({ mode: "needs_assessment", reason: "quality" });
  });

  test("dispatch, external actions and workflow steps", () => {
    expect(categoryFromWording("Edit the vlog footage and add subtitles")).toBe("media_edit");
    expect(categoryFromWording("剪辑视频")).toBe("media_edit");
    expect(categoryFromWording("Debug the simulation script")).toBe("data_code_sim");
    expect(categoryFromWording("Draft the email to the advisor")).toBe("draft_text");
    expect(mentionsExternalAction("Send the invoice to the client")).toBe(true);
    expect(mentionsExternalAction("发送发票")).toBe(true);
    expect(mentionsExternalAction("Summarize the notes")).toBe(false);
    expect(stepLeavesMachine("Upload to YouTube")).toBe(true);
    expect(stepLeavesMachine("Prepare the publishing checklist")).toBe(false);
    expect(stepLeavesMachine("Stop before publishing and leave the package for review")).toBe(false);
    expect(stepLeavesMachine("Do not send anything; save the draft")).toBe(false);
    expect(stepLeavesMachine("发布前核对清单")).toBe(false);
    expect(stepLeavesMachine("上传到小红书")).toBe(true);
  });

  test("an uncertain project and an assumption", () => {
    const projects: KnownProject[] = [{ id: "ece548", name: "ECE 548", identityId: "research" }];
    expect(plainProject("ECE 548", projects)?.id).toBe("ece548");
    expect(plainProject("possibly ECE 548", projects)).toBeUndefined();
    expect(plainProject("可能为 ECE 548", projects)).toBeUndefined();
    expect(ASSUMPTION_PREFIX.test("假设：按日历判断")).toBe(true);
    expect(ASSUMPTION_PREFIX.test("Assumption: read from the calendar")).toBe(true);
  });
});
