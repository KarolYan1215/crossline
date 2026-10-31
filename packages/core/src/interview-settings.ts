import { isSettingKey, parseQuiet, settingProblem, type SettingKey, type SettingTargets } from "./setting-catalog";

/**
 * Settings the interview hears the person state (2026-10-30, the owner: 「系统功能设置应该在访谈中就根据用户偏好设置好」). Before this,
 * 「22:30 以后别提醒我」「专注 50 分钟一段」「别让助手回我的邮件」 were stored as fact text that no feature reads. The extraction now names
 * them as catalog keys with the sentence they rest on; they wait here and the person applies them in the start confirmation (the
 * input box's rule: a setting changes only after the person confirms the intent), or later from 待决事项.
 */
export const INTERVIEW_SETTINGS = "onboarding.settings";

/**
 * What the interview may propose: the schedule's packing numbers, notifications and the assistant's scope. Never a privacy consent
 * (those are turned on only on their own card, with its explanation), never one object's setting (a milestone, a task, a block).
 */
export const INTERVIEW_SETTING_KEYS = ["notify.level", "notify.quietHours", "notify.briefTime", "schedule.gapMinutes", "schedule.maxDailyShare",
  "schedule.focusCapMinutes", "schedule.deadlineBufferDays", "mail.replyDrafts", "agent.category", "agent.autoHandoff"] as const satisfies readonly SettingKey[];
export type InterviewSettingKey = (typeof INTERVIEW_SETTING_KEYS)[number];

export type InterviewSetting = {
  key: InterviewSettingKey; target: string; value: string;
  /** The person's own words it rests on, and the reply they are from. */
  quote: string; sourceRef: string; at: string;
  state: "pending" | "applied" | "declined";
};

const isInterviewKey = (key: unknown): key is InterviewSettingKey => isSettingKey(key) && (INTERVIEW_SETTING_KEYS as readonly string[]).includes(key);

export function readInterviewSettings(raw: string | null | undefined): InterviewSetting[] {
  try {
    const parsed = JSON.parse(raw ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is InterviewSetting => Boolean(item) && typeof item === "object" && isInterviewKey((item as InterviewSetting).key)) : [];
  } catch { return []; }
}

/**
 * New proposals checked against the catalog (an invalid one is dropped, never the run) and merged: a later statement replaces an earlier
 * one for the same key and target, and comes back as pending even after the earlier one was applied or declined.
 */
export function mergeInterviewSettings(previous: InterviewSetting[], proposals: Array<{ key: string; target: string; value: string; quote: string; sourceRef: string }>,
  at: string, refs: SettingTargets): InterviewSetting[] {
  const next = new Map(previous.map((item) => [`${item.key}|${item.target}`, item]));
  for (const proposal of proposals) {
    if (!isInterviewKey(proposal.key) || !proposal.sourceRef || settingProblem(proposal, refs)) continue;
    const id = `${proposal.key}|${proposal.target}`;
    const before = next.get(id);
    if (before && before.value === proposal.value.trim()) continue;
    next.set(id, { key: proposal.key, target: proposal.target.trim(), value: proposal.value.trim(), quote: proposal.quote.slice(0, 200), sourceRef: proposal.sourceRef, at, state: "pending" });
  }
  return [...next.values()];
}

/** Notifications stay quiet between these clock times (the person's zone; may run past midnight). */
export const QUIET_HOURS_SETTING = "notify.quietHours";
/** When the morning brief goes out (`HH:MM`); unset, it follows the first available hour of the day. */
export const BRIEF_TIME_SETTING = "notify.briefTime";
/** The quiet hours before the person set any: 23:00 to 08:00, as the nudges always were. */
export const DEFAULT_QUIET = { from: "23:00", to: "08:00" } as const;

export const quietHoursOf = (raw: string | null | undefined): { from: string; to: string } => parseQuiet(raw) ?? DEFAULT_QUIET;

/** Whether a `HH:MM` clock falls in the quiet hours. */
export function inQuiet(clock: string, quiet: { from: string; to: string }): boolean {
  if (quiet.from === quiet.to) return false;
  return quiet.from < quiet.to ? clock >= quiet.from && clock < quiet.to : clock >= quiet.from || clock < quiet.to;
}
