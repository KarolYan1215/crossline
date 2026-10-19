import {
  AVAILABILITY_PROPOSED_SETTING, AVAILABILITY_SETTING, ONBOARDING_INSIGHTS, interviewAbstract, lineAttributes, progressLines, readInsightRatings, readTurnProgress,
  resolveAvailability, type StoredLineProfile, type TurnProgress
} from "@crossline/core";
import { datedItems, type CrosslineStore } from "@crossline/db";
import { readProfileModel } from "./onboarding-persist";

const SOURCE_LABEL: Record<string, string> = { saved: "本人设定", interview: "访谈提议", stated_hours: "按说过的小时数推算", default: "默认值" };

/**
 * The short ledger each round starts from (2026-10-19, the owner's decision: 「账本不应该太多」): the interview's own progress record from
 * the last round, an abstract of what the extraction has recorded, and how the person rated the latest observations. It replaces the full
 * completion list, the whole question ledger and forty lines of recorded facts.
 */
export function paceContext(store: CrosslineStore, workspaceId: string, sessionId: string, input: {
  today: string; lines: Array<{ id: string; label: string; goals: string[] }>; recent: string[]; progress: TurnProgress | undefined;
}): { progress?: string[]; abstract: string[]; observations?: string[]; goalPicker?: string[] } {
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
  const abstract = interviewAbstract({
    lines: input.lines.map((line) => ({ id: line.id, label: line.label, description: profiles[line.id]?.description ?? "", goal: line.goals[0] ?? "" })),
    projects: store.listProjects(workspaceId).filter((project) => !/-default$/.test(project.id))
      .map((project) => ({ id: project.id, identityId: project.identityId, name: project.name, deadline: deadlineOf(project.id) })),
    weeklyHours: resolved.source === "default" ? null : { hours, source: SOURCE_LABEL[resolved.source] ?? resolved.source },
    fixedCount: datedItems(store, workspaceId, input.today).filter((item) => item.recurring).length,
    profile: { problem: profile.problem, workView: profile.workView, trueNorth: profile.trueNorth, flow: profile.flow, anchor: profile.anchor },
    filesRead: store.listSourceDocuments(workspaceId).filter((doc) => doc.extractionStatus === "done").length,
    recent: input.recent.slice(-5)
  });
  const ratings = Object.entries(readInsightRatings(store.getSetting(workspaceId, ONBOARDING_INSIGHTS)))
    .filter(([key]) => key.startsWith(`${sessionId}#`)).sort((a, b) => a[1].at.localeCompare(b[1].at)).slice(-4)
    .map(([, rating]) => `观察「${(rating.text ?? "").slice(0, 60)}」：本人说${rating.verdict === "fits" ? "准" : "不准"}`);
  const progress = progressLines(input.progress);
  // Lines with no long-term goal yet, and whether the picker beside the conversation already offers candidates for one: the dialogue asks
  // what the person wants to become on a line only while it offers none (W-8: asking beside the picker asked the same thing twice).
  const goalPicker = input.lines.filter((line) => !line.goals.length).map((line) => {
    const count = lineAttributes(profiles[line.id], line.label).length;
    return count ? `${line.label}：左栏已有 ${count} 个候选定语，由本人选定` : `${line.label}：还没有候选定语`;
  });
  return { abstract, ...(progress.length ? { progress } : {}), ...(ratings.length ? { observations: ratings } : {}),
    ...(goalPicker.length ? { goalPicker } : {}) };
}

/** The progress record the last round left in the session. */
export const storedProgress = (coverage: unknown) => readTurnProgress((coverage as { progress?: unknown } | undefined)?.progress);
