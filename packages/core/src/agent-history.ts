/**
 * The person's own coding-agent history (Codex and Claude Code on this machine), read as **time only**: when they worked, for how long,
 * in which folder. Decided 2026-10-08: this is evidence of habits and of how far each project has come, never a source of plans — the
 * schedule is built only from what lies ahead. No message, prompt, file name or output is read; a folder's last path segment is the only
 * name kept, and the whole summary lives in the ledger, never in a model's context except as the plain lines `agentHistoryLines` writes.
 */
export const AGENT_HISTORY_CONSENT = "history.agentLogs";
export const AGENT_HISTORY_SUMMARY = "history.agentLogs.summary";

/** One stretch of activity in one folder: events no more than `GAP_MS` apart join into one. */
export type ActivitySpan = { tool: "codex" | "claude"; folder: string; start: number; end: number };
export const GAP_MS = 10 * 60_000;

export type AgentHistorySummary = {
  updatedAt: string; days: number; timeZone: string;
  totalMinutes: number;
  /** Per folder, most minutes first. */
  folders: Array<{ folder: string; minutes: number; activeDays: number; lastActive: string; codex: number; claude: number }>;
  /** Minutes by local hour of day (24) and by weekday (7, Sunday first). */
  byHour: number[]; byWeekday: number[];
  /** Minutes per local day, oldest first. */
  daily: Array<{ day: string; minutes: number }>;
  /**
   * When the person worked, as merged stretches (no folder, no tool): one of measured work time's signals (docs/plans/closed-loop-1030.md
   * §1), joined in time with the timer and the screen. Absent on a summary written before 2026-10-30.
   */
  spans?: Array<{ start: string; end: string }>;
};

/** Joins timestamps (ms, any order) into spans: consecutive events at most `GAP_MS` apart are one stretch of work. */
export function spansOf(times: number[], tool: ActivitySpan["tool"], folder: string): ActivitySpan[] {
  const sorted = [...times].filter(Number.isFinite).sort((a, b) => a - b);
  const spans: ActivitySpan[] = [];
  for (const time of sorted) {
    const last = spans.at(-1);
    if (last && time - last.end <= GAP_MS) last.end = time;
    else spans.push({ tool, folder, start: time, end: time });
  }
  // A single event still stands for a minute of work.
  return spans.map((span) => ({ ...span, end: Math.max(span.end, span.start + 60_000) }));
}

const localParts = (ms: number, timeZone: string) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short" })
    .formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24, weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday ?? "") };
};

/**
 * The last `days` days of spans as minutes per folder, hour, weekday and day. Overlapping spans (two sessions at once) count once in the
 * totals: the person was working, not working twice. Minutes are walked one at a time, which is exact and cheap at this size.
 */
export function summarizeAgentHistory(spans: ActivitySpan[], now: Date, timeZone: string, days = 30): AgentHistorySummary {
  const since = now.getTime() - days * 86_400_000;
  const minute = 60_000;
  const all = new Set<number>();
  const byFolder = new Map<string, { minutes: Set<number>; codex: Set<number>; claude: Set<number> }>();
  for (const span of spans) {
    if (span.end < since) continue;
    const folder = byFolder.get(span.folder) ?? { minutes: new Set(), codex: new Set(), claude: new Set() };
    byFolder.set(span.folder, folder);
    for (let at = Math.floor(Math.max(span.start, since) / minute) * minute; at < span.end; at += minute) {
      all.add(at); folder.minutes.add(at); folder[span.tool].add(at);
    }
  }
  const byHour = Array<number>(24).fill(0), byWeekday = Array<number>(7).fill(0);
  const daily = new Map<string, number>();
  for (const at of all) {
    const local = localParts(at, timeZone);
    byHour[local.hour]! += 1; if (local.weekday >= 0) byWeekday[local.weekday]! += 1;
    daily.set(local.day, (daily.get(local.day) ?? 0) + 1);
  }
  const folders = [...byFolder].map(([folder, sets]) => {
    const stamps = [...sets.minutes];
    return { folder, minutes: sets.minutes.size, codex: sets.codex.size, claude: sets.claude.size,
      activeDays: new Set(stamps.map((at) => localParts(at, timeZone).day)).size,
      lastActive: stamps.length ? localParts(Math.max(...stamps), timeZone).day : "" };
  }).sort((a, b) => b.minutes - a.minutes);
  const merged: Array<{ start: number; end: number }> = [];
  for (const span of spans.filter((item) => item.end >= since).map((item) => ({ start: Math.max(item.start, since), end: item.end })).sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return { updatedAt: now.toISOString(), days, timeZone, totalMinutes: all.size, folders, byHour, byWeekday,
    daily: [...daily].sort((a, b) => a[0].localeCompare(b[0])).map(([day, minutes]) => ({ day, minutes })),
    spans: merged.map((span) => ({ start: new Date(span.start).toISOString(), end: new Date(span.end).toISOString() })) };
}

/* i18n-ignore-start: these lines are context for a model, not interface text */
const hours = (minutes: number) => `${(minutes / 60).toFixed(minutes >= 600 ? 0 : 1)} 小时`;

/**
 * The summary as the few plain lines a model may read: hours per folder and when in the day the person tends to work. Said to be a
 * record of the past, for habits and progress — not hours to plan with.
 */
export function agentHistoryLines(summary: AgentHistorySummary | null): string[] {
  if (!summary || !summary.totalMinutes) return [];
  const peak = summary.byHour.map((minutes, hour) => ({ hour, minutes })).sort((a, b) => b.minutes - a.minutes).slice(0, 4).map((entry) => entry.hour).sort((a, b) => a - b);
  const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const busiest = summary.byWeekday.map((minutes, day) => ({ day, minutes })).sort((a, b) => b.minutes - a.minutes).slice(0, 2).map((entry) => weekdays[entry.day]);
  return [
    `过去 ${summary.days} 天在 Codex 与 Claude Code 中的工作时长（仅时间记录，不含内容；用于了解习惯与进度，不用于排程）：共 ${hours(summary.totalMinutes)}。`,
    ...summary.folders.slice(0, 8).map((folder) => `- 文件夹「${folder.folder}」：${hours(folder.minutes)}，${folder.activeDays} 天有记录，最近 ${folder.lastActive}`),
    `最常工作的时段：${peak.map((hour) => `${hour}:00`).join("、")}；最忙的是${busiest.join("和")}。`
  ];
}
/* i18n-ignore-end */
