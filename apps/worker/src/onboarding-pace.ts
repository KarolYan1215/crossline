// i18n-exempt: the short ledger handed to the interview model each round (model-facing)
import {
  AVAILABILITY_PROPOSED_SETTING, AVAILABILITY_SETTING, ONBOARDING_INSIGHTS, fixedScheduleLines, interviewAbstract, lineAttributes, progressLines, readInsightRatings, readTurnProgress,
  resolveAvailability, type InterviewFlow, type OnboardingDepth, type StoredLineProfile, type TurnProgress, cardCandidates, hypothesisLogLines, pointLines, GOAL_CANDIDATES_MIN
} from "@crossline/core";
import { datedItems, type CrosslineStore } from "@crossline/db";
import { readProfileModel } from "./onboarding-persist";

/**
 * The person's ratings of the observations told back to the dialogue: the last four used to drop the earlier corrections out of sight in a
 * long interview, and replay 8 showed one theme four times, three rated 部分对 with the same correction (2026-11-14).
 */
const OBSERVATIONS_SHOWN = 12;
const SOURCE_LABEL: Record<string, string> = { saved: "本人设定", interview: "访谈提议", stated_hours: "按说过的小时数推算", default: "默认值" };

/**
 * The short ledger each round starts from (2026-10-19, the owner's decision: 「账本不应该太多」): the interview's own progress record from
 * the last round, an abstract of what the extraction has recorded, and how the person rated the latest observations. It replaces the full
 * completion list, the whole question ledger and forty lines of recorded facts.
 */
export function paceContext(store: CrosslineStore, workspaceId: string, sessionId: string, input: {
  today: string; lines: Array<{ id: string; label: string; goals: string[] }>; recent: string[]; progress: TurnProgress | undefined;
  /** The interview's flow: the order of the parts the progress lines name. */
  flow?: InterviewFlow;
  /** The tier the person chose: the thorough one has a sixth part. */
  depth?: OnboardingDepth;
  /** The points rules: the hypothesis log and the points ledger go with every round. */
  rules?: boolean;
}): { progress?: string[]; abstract: string[]; observations?: string[]; goalPicker?: string[]; fixedSchedule?: string[]; hypothesisLog?: string[]; cardFrom?: string[]; points?: string[] } {
  const profiles = (() => { try { return JSON.parse(store.getSetting(workspaceId, "lines.profiles") ?? "{}") as Record<string, StoredLineProfile>; } catch { return {}; } })();
  const facts = store.listProfileFacts(workspaceId);
  const deadlineOf = (projectId: string) => {
    const own = facts.filter((fact) => fact.projectId === projectId);
    if (own.some((fact) => fact.slot === "no_deadline")) return "没有截止";
    const deadline = own.find((fact) => fact.slot === "deadline");
    if (deadline) return `${deadline.value.slice(0, 30)}${deadline.status === "confirmed" ? "" : "，推断"}`;
    const dated = own.filter((fact) => fact.slot.startsWith("date_")).map((fact) => fact.value).sort()[0];
    return dated ? dated.slice(0, 30) : "";
  };
  const resolved = resolveAvailability({ saved: store.getSetting(workspaceId, AVAILABILITY_SETTING), proposed: store.getSetting(workspaceId, AVAILABILITY_PROPOSED_SETTING),
    facts: facts.map(({ slot, status, value }) => ({ slot, status, value })) });
  const hours = resolved.windows.reduce((sum, window) => {
    const [sh, sm] = window.start.split(":").map(Number), [eh, em] = window.end.split(":").map(Number);
    return sum + window.days.length * Math.max(0, (eh! * 60 + em!) - (sh! * 60 + sm!));
  }, 0) / 60;
  const profile = readProfileModel(store, workspaceId);
  const weekly = datedItems(store, workspaceId, input.today).filter((item) => item.recurring);
  const abstract = interviewAbstract({
    lines: input.lines.map((line) => ({ id: line.id, label: line.label, description: profiles[line.id]?.description ?? "", goal: line.goals[0] ?? "" })),
    projects: store.listProjects(workspaceId).filter((project) => !/-default$/.test(project.id))
      .map((project) => ({ id: project.id, identityId: project.identityId, name: project.name, deadline: deadlineOf(project.id) })),
    weeklyHours: resolved.source === "default" ? null : { hours, source: SOURCE_LABEL[resolved.source] ?? resolved.source },
    fixedCount: weekly.length,
    profile: { problem: profile.problem, workView: profile.workView, trueNorth: profile.trueNorth, flow: profile.flow, anchor: profile.anchor },
    filesRead: store.listSourceDocuments(workspaceId).filter((doc) => doc.extractionStatus === "done").length,
    recent: input.recent.slice(-5)
  });
  const ratings = Object.entries(readInsightRatings(store.getSetting(workspaceId, ONBOARDING_INSIGHTS)))
    .filter(([key]) => key.startsWith(`${sessionId}#`)).sort((a, b) => a[1].at.localeCompare(b[1].at)).slice(-OBSERVATIONS_SHOWN)
    .map(([, rating]) => `观察「${(rating.text ?? "").slice(0, 60)}」：本人说${rating.verdict === "fits" ? "准" : rating.verdict === "partial" ? `部分对，更正为「${(rating.correction ?? "").slice(0, 60)}」` : "不准"}`);
  const progress = progressLines(input.progress, input.flow, input.depth);
  // Lines with no long-term goal yet, and whether the picker beside the conversation already offers candidates for one: the dialogue asks
  // what the person wants to become on a line only while it offers none (W-8: asking beside the picker asked the same thing twice).
  const goalPicker = input.lines.filter((line) => !line.goals.length).map((line) => {
    const count = lineAttributes(profiles[line.id], line.label).length;
    // Worded so that echoing it to the person does no harm: 「定语」 was repeated to people word for word (2026-10-31).
    return count >= GOAL_CANDIDATES_MIN ? `${line.label}：已给出 ${count} 个长期目标的候选词，由本人点选`
      : count ? `${line.label}：长期目标的候选词还不够（${count} 个），本人还选不了` : `${line.label}：还没有长期目标的候选词`;
  });
  // Each weekly arrangement with its own weekday and time, every round: the abstract has only their number (W-183).
  const fixedSchedule = fixedScheduleLines(weekly);
  // Under the points rules (2026-11-12): what cards may ask about, and what is settled.
  const log = input.rules ? hypothesisLogLines(profile.hypotheses ?? []) : [];
  const points = input.rules ? pointLines(profile.points ?? []).slice(-30) : [];
  const cardFrom = input.rules ? cardCandidates(profile.hypotheses ?? []) : [];
  return { abstract, ...(progress.length ? { progress } : {}), ...(ratings.length ? { observations: ratings } : {}),
    ...(log.length ? { hypothesisLog: log } : {}), ...(cardFrom.length ? { cardFrom } : {}), ...(points.length ? { points } : {}),
    ...(goalPicker.length ? { goalPicker } : {}), ...(fixedSchedule.length ? { fixedSchedule } : {}) };
}

/** The progress record the last round left in the session. */
export const storedProgress = (coverage: unknown) => readTurnProgress((coverage as { progress?: unknown } | undefined)?.progress);
