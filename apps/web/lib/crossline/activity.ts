import "server-only";
import { deriveCapacity, PRODUCTIVE, type ActivityCategory, type AccessContext } from "@crossline/core";
import type { DashboardData } from "../../app/dashboard-view";
import { localeFor } from "../locale";
import { tFor, type Locale } from "../i18n";
import { getStore } from "./store";
import { dayOf } from "./clock";

/**
 * What the screen record says the open session of this order took: minutes in work-like apps since it started.
 * Only with the detail consent, and only ever a suggestion the person confirms at completion — offline work
 * (paper, a lab, a meeting) is invisible to it.
 */
export function suggestedSessionMinutes(ctx: AccessContext, workOrderId: string, now = new Date()): number | undefined {
  const open = getStore().listExecutions(ctx.workspaceId, workOrderId).find((execution) => !execution.endedAt);
  return open ? activityMinutes(ctx, open.startedAt, now.toISOString()) : undefined;
}

/** Productive minutes the screen record holds between two instants, with the detail consent only; under five reads as nothing. */
export function activityMinutes(ctx: AccessContext, from: string, to: string): number | undefined {
  const store = getStore();
  if (store.getSetting(ctx.workspaceId, ACTIVITY_DETAIL_CONSENT) !== "granted") return undefined;
  const start = Date.parse(from), end = Date.parse(to);
  const minutes = store.listActivitySegments(ctx.workspaceId, from)
    .filter((segment) => !segment.idle && PRODUCTIVE.has(segment.category as ActivityCategory))
    .reduce((sum, segment) => sum + Math.max(0, Math.min(Date.parse(segment.end), end) - Math.max(Date.parse(segment.start), start)) / 60_000, 0);
  return minutes >= 5 ? Math.round(minutes) : undefined;
}

export const LOCAL_ACTIVITY_CONSENT = "localActivity.consent";
/** The second, separate consent: which app and window were in front. Mirrors the worker's names (it cannot be imported here). */
export const ACTIVITY_DETAIL_CONSENT = "localActivity.consentV2";
export const ACTIVITY_PAUSED_UNTIL = "localActivity.pausedUntil";
export const ACTIVITY_BLACKLIST = "activity.blacklist";

/**
 * What last night's expansion actually did. A night that did not run says so with its reason — the
 * alternative is showing an older expansion as if it were this morning's, which is the same class of
 * lie as a fabricated metric.
 */
export type LastNight = { state: "none" } | { state: "ran"; proposals: number } | { state: "skipped"; reason: string };
export function lastNight(workspaceId: string, now: Date, locale?: Locale): LastNight {
  const since = new Date(now.getTime() - 36 * 60 * 60_000).toISOString();
  const event = [...getStore().listEvents(workspaceId)]
    .reverse()
    .find((item) => item.type.startsWith("flywheel.nightly.") && item.createdAt >= since);
  if (!event) return { state: "none" };
  const payload = event.payload as { code?: string; message?: string; proposals?: number };
  if (event.type === "flywheel.nightly.ran") return { state: "ran", proposals: payload.proposals ?? 0 };
  // Shown on 周复盘: the stored message of a failed run or an unreadable quota is the runtime's own error text (a JSON-RPC body), so
  // those two are said in words by their code.
  const plain: Record<string, string> = { COST_SIGNAL_UNAVAILABLE: "读不到模型额度，今晚不运行。", FLYWHEEL_RUN_FAILED: "扩展运行出错，下一晚重试。" };
  const t = tFor(locale);
  return { state: "skipped", reason: (payload.code && plain[payload.code] ? t(plain[payload.code]!) : undefined) ?? payload.message ?? payload.code ?? t("未记录原因") };
}

/** Interruptions per active hour, per day, from real executions — never from a guess about the day. */
function interruptionDensity(workspaceId: string): Array<{ day: string; perActiveHour: number }> {
  const byDay = new Map<string, { interruptions: number; activeMinutes: number }>();
  for (const execution of getStore().listExecutions(workspaceId)) {
    if (!execution.endedAt || !execution.durationObserved) continue;
    const wall = (Date.parse(execution.endedAt) - Date.parse(execution.startedAt)) / 60_000;
    const activeMinutes = Math.max(0, wall - execution.pauseMinutes);
    const day = dayOf(execution.startedAt);
    const bucket = byDay.get(day) ?? { interruptions: 0, activeMinutes: 0 };
    bucket.interruptions += execution.interruptions.length;
    bucket.activeMinutes += activeMinutes;
    byDay.set(day, bucket);
  }
  return [...byDay.entries()]
    .filter(([, bucket]) => bucket.activeMinutes > 0)
    .map(([day, bucket]) => ({ day, perActiveHour: bucket.interruptions / (bucket.activeMinutes / 60) }));
}

export function latestCapacity(ctx: AccessContext, now: Date): DashboardData["capacity"] {
  const store = getStore();
  const observations = store.listEnergyObservations(ctx.workspaceId);
  const consent = store.getSetting(ctx.workspaceId, LOCAL_ACTIVITY_CONSENT);
  return deriveCapacity({
    now: now.toISOString(),
    selfReports: observations
      .filter((item) => item.source === "self_report" && item.level !== "uncalibrated")
      .map((item) => ({ level: item.level as "low" | "medium" | "high", confidence: item.confidence, observedAt: item.observedAt })),
    dailyActivity: observations
      .filter((item) => item.source === "local_activity")
      .map((item) => ({ day: dayOf(item.observedAt), activeMinutes: item.aggregate.activeMinutes ?? 0, windowSwitches: item.aggregate.windowSwitches ?? 0 })),
    interruptionDensity: interruptionDensity(ctx.workspaceId),
    localActivityConsent: consent === "granted" ? "granted" : consent === "denied" ? "denied" : "unasked",
    locale: localeFor(ctx)
  });
}
