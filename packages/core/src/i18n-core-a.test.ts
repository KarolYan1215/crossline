import "@crossline/i18n/catalog/worker";
import { describe, expect, test } from "vitest";
import { realityChanges, toRealityBlock } from "./reality";
import { backgroundSpend, allowDiscretionarySpend } from "./cost";
import { nightlyTrigger } from "./flywheel";
import { inferWorkState } from "./activity-state";
import { dayCapacity, predictEnergy } from "./energy-model";
import { ruleMilestoneRisks } from "./milestone-risk";
import { nudgeCandidates, type NudgeInput } from "./nudges";
import { agentAskProgress, classifyAgentFailure, resultNeedsPerson } from "./agent-failure";
import { actionLabel, keepUsable } from "./concierge";
import { capabilityGap, unavailableOnThirdParty } from "./provider-conformance";
import { folderPathProblem } from "./source-folders";
import { timeOrderProblem } from "./artifact-plan";
import { energyAdviceRule } from "./energy-advice";

/** Text core builds for the person comes out in English when asked, and exactly as before when not (docs/i18n.md). */
describe("core text in English", () => {
  test("calendar changes", () => {
    const block = { id: "graph_calendar:1", title: "Sync up", day: "2026-10-16", start: "11:30", end: "12:00", source: "Calendar" };
    expect(realityChanges([], [block], "2026-10-16")[0]!.explanation).toBe("日历新增「Sync up」11:30–12:00");
    expect(realityChanges([], [block], "2026-10-16", "en")[0]!.explanation).toBe("Calendar added “Sync up” 11:30–12:00");
    expect(realityChanges([block], [], "2026-10-15", "en")[0]!.explanation).toBe("“Sync up” 10/16 11:30–12:00 is no longer on the calendar");
    expect(toRealityBlock({ provider: "graph_calendar", externalId: "x", title: "A", start: "2026-10-16T10:00:00Z", end: "2026-10-16T11:00:00Z" }, "UTC", undefined, "en")?.source).toBe("Calendar");
  });

  test("quota and nightly reasons", () => {
    expect(backgroundSpend({ available: true, limitReached: true }).blocker?.message).toBe("模型额度已用尽，后台自动工作暂停到额度恢复。");
    expect(backgroundSpend({ available: true, limitReached: true }, "en").blocker?.message).toBe("Model quota used up. Background work is paused until it resets.");
    const decision = allowDiscretionarySpend({ available: true, limitReached: false, short: { usedPercent: 40, windowDurationMins: 300, resetsAt: null } },
      { windowSharePercent: 30, longWindowCeilingPercent: 80 }, "en");
    expect(decision.allowed ? "" : decision.message).toBe("40% of the current window is used, reaching the 30% limit for automatic work.");
    const night = nightlyTrigger({ now: "2026-10-16T03:00:00Z", resetsAt: [], night: { startHour: 1, endHour: 6 }, cost: { available: true, limitReached: false },
      spend: { windowSharePercent: 30, longWindowCeilingPercent: 80 }, idleRequiredMs: 0, lastRunDay: "2026-10-16", timeZoneOffsetMinutes: 0, locale: "en" });
    expect(night.run ? "" : night.message).toBe("Tonight's expansion has already run.");
  });

  test("screen activity and energy", () => {
    const segments = [{ start: "2026-10-16T10:00:00Z", end: "2026-10-16T10:12:00Z", app: "code", category: "coding" as const, idle: false }];
    const state = inferWorkState({ segments, now: "2026-10-16T10:15:00Z", calendar: [], locale: "en" });
    expect(state.reasons[0]).toBe("12 min on Coding work, longest stretch 12 min, 0 switches.");
    expect(inferWorkState({ segments, now: "2026-10-16T10:15:00Z", calendar: [] }).reasons[0]).toBe("12 分钟在编程类工作上，连续最长 12 分钟，切换 0 次。");
    const night = [{ sleepAt: "2026-10-15T23:00:00Z", wakeAt: "2026-10-16T07:00:00Z", source: "screen" as const }];
    const prediction = predictEnergy("2026-10-16T10:00:00Z", night, { low: 0, high: 20, reports: 1, agreement: 1 }, (iso) => new Date(iso).getUTCHours(), 0, "en");
    expect(prediction.basis).toEqual(["Slept about 8.0 h (inferred from computer idle time)", "Awake for 3.0 h", "Calibrated on 1 of your own report"]);
    expect(predictEnergy("2026-10-16T10:00:00Z", [], { low: 0, high: 20, reports: 0, agreement: 0 }, () => 10, 0, "en").basis).toEqual(["Last sleep unknown"]);
    const physiology = [{ day: "2026-10-16", wristTempDeltaC: 0.6 }];
    expect(dayCapacity("2026-10-16T10:00:00Z", "2026-10-16", [], physiology, "en").basis).toEqual(["Wrist temperature 0.6°C above usual"]);
  });

  test("milestone risks, plurals included, and the Chinese unchanged", () => {
    const base = { today: "2026-10-16", criteria: [], dependsOn: [], otherDeadlines: ["2026-10-20", "2026-10-21", "2026-10-22"] };
    const en = ruleMilestoneRisks({ ...base, deadline: "2026-10-21", locale: "en" }).map((risk) => risk.note);
    expect(en).toEqual(["5 days to the deadline", "No acceptance standard, so there is no telling whether it is reached", "3 other milestones are due within 2 days of it"]);
    expect(ruleMilestoneRisks({ ...base, deadline: "2026-10-17", otherDeadlines: [], locale: "en" })[0]!.note).toBe("Only 1 day to the deadline");
    const zh = ruleMilestoneRisks({ ...base, deadline: "2026-10-21" }).map((risk) => risk.note);
    expect(zh).toEqual(["距截止 5 天", "没有验收标准，达成与否无从判断", "前后 2 天内另有 3 个里程碑截止"]);
  });

  test("nudges", () => {
    const input: NudgeInput = { now: "2026-10-16T09:50:00Z", today: "2026-10-16", clock: "09:50", tomorrow: "2026-10-17", level: "normal",
      quiet: { timerRunning: false, inMeeting: false, answeredRecently: false }, muted: new Set(), sent: new Set(), countedToday: 0,
      blocks: [{ id: "b1", orderId: "o1", stepId: "s1", title: "Homework 3", step: "Problem 1", start: "10:00", end: "10:45", dueDay: "2026-10-18",
        firstAction: "Open the problem set", prepared: ["notes.md", "outline.md"] }], ending: [], slack: [], finished: [], locale: "en" };
    const [start] = nudgeCandidates(input);
    expect(start!.text).toBe("“Homework 3 · Problem 1” at 10:00 (45 min), toward the deadline on 10/18. First step: Open the problem set. Ready: notes.md, outline.md.");
    expect(start!.buttons.map((button) => button.label)).toEqual(["Start timer", "Postpone to tomorrow", "Ask less about this"]);
    const { locale: _locale, ...zhInput } = input;
    const zh = nudgeCandidates(zhInput)[0]!;
    expect(zh.text).toBe("10:00 做「Homework 3 · Problem 1」（45 分），关系到 10/18 的截止。第一步：Open the problem set。已备好：notes.md、outline.md。");
  });

  test("the assistant's stops and results", () => {
    const lost = classifyAgentFailure({ status: "blocked", blockerCode: "AGENT_RUN_LOST", blockerMessage: "" }, "en");
    expect(lost.stuckAt).toBe("The background process restarted and this run was cut off");
    const sent = classifyAgentFailure({ status: "blocked", blockerCode: "X", blockerMessage: "", deniedRules: ["send.mail"] }, "en");
    expect(sent.stuckAt).toBe("The guard stopped an outside action (sending)");
    expect(classifyAgentFailure({ status: "blocked", blockerCode: "X", blockerMessage: "", deniedRules: ["send.mail"] }).stuckAt).toBe("护栏拦下了一个对外的动作（发送）");
    // English messages are read by the same rules: a login wall is external, never retried.
    expect(classifyAgentFailure({ status: "blocked", blockerCode: "X", blockerMessage: "The page says login required" }).kind).toBe("external");
    expect(classifyAgentFailure({ status: "blocked", blockerCode: "X", blockerMessage: "Missing the course syllabus" }).kind).toBe("needs_input");
    expect(resultNeedsPerson({ needsHuman: [{ what: "Pick a title" }], checksPassed: false, inputsModified: [], decisions: [], locale: "en" }))
      .toEqual(["Left 1 thing for you: Pick a title", "Not every self-check passed"]);
    expect(resultNeedsPerson({ needsHuman: [{ what: "Decide whether to keep this workflow" }], checksPassed: true, inputsModified: [], decisions: [], growing: true })).toEqual([]);
    const progress = agentAskProgress({ title: "Collect sources", failure: lost, record: { commands: [{ command: "ls", exitCode: 0 }] }, retries: 0, exhausted: false, locale: "en" });
    expect(progress.summary).toBe("The assistant was working on “Collect sources” and stopped after this: Ran 1 command.");
    expect(progress.needs).toEqual(["Decide whether the assistant should try once more, or take it over yourself"]);
  });

  test("the input box's cards and the model connection's limits", () => {
    expect(actionLabel({ action: "note.add", summary: "", args: { text: "x" } }, "en")).toBe("Add a note");
    expect(actionLabel({ action: "note.add", summary: "", args: { text: "x" } })).toBe("记一笔");
    const refs = { tasks: new Map(), asks: new Map(), ops: new Set<string>(), lines: new Set<string>(), milestones: new Set<string>(), draftMilestones: new Set<string>(),
      proposals: new Set<string>(), agentResults: new Set<string>() };
    const kept = keepUsable({ reply: "Done.", confidence: "high", actions: [{ action: "undo", summary: "", args: { opId: "missing" } }], clarify: { question: "", options: [] } }, refs, "en");
    expect(kept?.reply).toBe("Done. 1 item could not be matched to anything and is not listed.");
    expect(capabilityGap("crossline-due-diligence", undefined, "en")).toBe("Web fact-checking needs web search, which this model connection lacks. It needs a ChatGPT sign-in or an OpenAI API key.");
    expect(unavailableOnThirdParty({ webSearch: false, image: false }, "en")).toMatch(/^On this server, Web fact-checking and Portrait figure work only/);
    expect(unavailableOnThirdParty({ webSearch: false, image: false })).toMatch(/^联网查证和画像插图在这台服务器上/);
  });

  test("folders, artifact timing and the weekly energy advice", () => {
    expect(folderPathProblem("C:\\", { locale: "en" })).toBe("A whole drive cannot be authorized. Choose a specific folder.");
    expect(folderPathProblem("courses")).toBe("需要完整路径，例如 D:\\课程资料");
    expect(timeOrderProblem("2026-11-10", "2026-11-05", 2, false, "en")).toBe("Upstream is due 2026-11-10, later than the downstream deadline 2026-11-05 less 2 days to hand it over (latest 2026-11-03)");
    const advice = energyAdviceRule({ now: "2026-10-16T12:00:00Z", zone: "UTC", episodes: [], reports: [], worked: [], locale: "en" });
    expect("insufficient" in advice ? advice.insufficient : "").toBe("Needs at least 3 nights of sleep on record or 2 energy reports of your own");
  });
});
