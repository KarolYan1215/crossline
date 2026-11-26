import "server-only";
import { randomUUID } from "node:crypto";
import { validateAvailability, type AccessContext, type AvailabilityWindow } from "@crossline/core";
import { normalizeParams, paramsFor, type ScheduleParams } from "@crossline/planner";
import { AVAILABILITY_PROPOSED_SETTING, AVAILABILITY_SETTING, resolveAvailability, hoursFromText, type AvailabilitySource, type PortraitReport } from "@crossline/core";
import { statedShares } from "../plan-stats";
import { linePacks } from "../lines";
import { previewScope } from "./preview";
import { getStore } from "./store";
import { ensureSeeded } from "./seed";
import { goalKey, readGoalSettings } from "./goals";

/** Zones already found valid; a stored zone is checked once per process instead of on every read of the preferences. */
const knownZones = new Set<string>();
const PREFERENCES_SETTING = "schedule.preferences";
export type SchedulePreferences = { timeZone: string; mode: "buffered" | "asap";
  importance: Record<string, "important" | "ordinary">;
  /** The four packing numbers set on the plan page; absent, `mode` stands for its preset. */
  params?: ScheduleParams };

/** The packing numbers in effect: a previewed set, else the saved ones, else what the saved mode stands for. */
export function effectiveParams(ctx: AccessContext): ScheduleParams {
  return previewScope.getStore()?.params ?? paramsFor(effectiveSchedulePreferences(ctx).preferences);
}

/**
 * The zone the person's own device reports (2026-10-21): the hosted beta runs in Hong Kong with `CROSSLINE_TIME_ZONE=Asia/Shanghai`, so
 * without it every account that had not picked a zone was planned, reminded and shown on the server's clock — and saving any schedule
 * number copied that default into the saved preferences, where it stayed. The page reports `Intl`'s zone; when it differs from the one on
 * record it becomes `schedule.preferences.timeZone`, which every reader (the web's and the worker's) takes before the server's. The
 * device's zone, not one guessed from the IP address: a VPN, a proxy or the phone's mobile network moves an IP's apparent place, and the
 * device's own setting is what its clock shows.
 */
export function syncDeviceTimeZone(ctx: AccessContext, timeZone: unknown): { ok: true; changed: boolean } | { ok: false; code: string } {
  const zone = typeof timeZone === "string" ? timeZone.trim() : "";
  if (!zone || zone.length > 64) return { ok: false, code: "SCHEDULE_TIME_ZONE_INVALID" };
  try { new Intl.DateTimeFormat("en", { timeZone: zone }); } catch { return { ok: false, code: "SCHEDULE_TIME_ZONE_INVALID" }; }
  const current = effectiveSchedulePreferences(ctx).preferences;
  if (current.timeZone === zone && readSchedulePreferences(ctx)) return { ok: true, changed: false };
  const store = getStore();
  store.setSetting(ctx.workspaceId, PREFERENCES_SETTING, JSON.stringify({ ...current, timeZone: zone } satisfies SchedulePreferences));
  store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `schedule:time_zone:${randomUUID()}`,
    type: "schedule.time_zone_detected", entityId: ctx.workspaceId, payload: { previous: current.timeZone, next: zone } });
  return { ok: true, changed: current.timeZone !== zone };
}

export function saveScheduleParams(ctx: AccessContext, value: unknown): { ok: true } {
  const params = normalizeParams(value);
  const current = effectiveSchedulePreferences(ctx).preferences;
  const mode = params.gapMinutes === 0 && params.maxDailyShare >= 1 ? "asap" as const : "buffered" as const;
  const store = getStore();
  store.setSetting(ctx.workspaceId, PREFERENCES_SETTING, JSON.stringify({ ...current, mode, params } satisfies SchedulePreferences));
  store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `schedule:params:${randomUUID()}`,
    type: "schedule.params_saved", entityId: ctx.workspaceId, payload: { previous: paramsFor(current), next: params } });
  return { ok: true };
}

export function readSchedulePreferences(ctx: AccessContext): SchedulePreferences | null {
  const raw = getStore().getSetting(ctx.workspaceId, PREFERENCES_SETTING);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as SchedulePreferences;
    if (!knownZones.has(value.timeZone)) { new Intl.DateTimeFormat("en", { timeZone: value.timeZone }); knownZones.add(value.timeZone); }
    return value.mode === "buffered" || value.mode === "asap" ? value : null;
  } catch { return null; }
}

/**
 * The plan page used to show nothing at all — no availability editor, no AI lane, no forecast — until
 * this form was filled in, which stacked a mandatory setup screen onto a brand-new person's first
 * visit. The schedule the planner actually needs (a time zone, a mode, per-milestone importance) has a
 * sane default for every field; there is no reason a real preview has to wait on the person supplying
 * one by hand. `isDefault` says which case this is, so the page can offer the real setup form as an
 * unobtrusive invitation instead of a locked gate.
 */
export function effectiveSchedulePreferences(ctx: AccessContext): { preferences: SchedulePreferences; isDefault: boolean } {
  const saved = readSchedulePreferences(ctx);
  if (saved) return { preferences: saved, isDefault: false };
  return { preferences: { timeZone: process.env.CROSSLINE_TIME_ZONE?.trim() || "America/Chicago",
    mode: "buffered", importance: {} }, isDefault: true };
}

export function saveSchedulePreferences(ctx: AccessContext, input: {
  timeZone: unknown; mode: unknown; windows: unknown; importance: unknown
}): { ok: true } | { ok: false; code: string } {
  ensureSeeded(ctx);
  const timeZone = typeof input.timeZone === "string" ? input.timeZone.trim() : "";
  try { new Intl.DateTimeFormat("en", { timeZone }); }
  catch { return { ok: false, code: "SCHEDULE_TIME_ZONE_INVALID" }; }
  if (input.mode !== "buffered" && input.mode !== "asap")
    return { ok: false, code: "SCHEDULE_MODE_INVALID" };
  let windows: AvailabilityWindow[];
  try { windows = validateAvailability(input.windows); }
  catch (error) { return { ok: false, code: error instanceof Error ? error.message : "AVAILABILITY_INVALID" }; }
  if (!windows.length || windows.some((window) => !window.days.length))
    return { ok: false, code: "AVAILABILITY_INVALID" };
  const importance = input.importance;
  if (!importance || typeof importance !== "object" || Array.isArray(importance))
    return { ok: false, code: "SCHEDULE_IMPORTANCE_REQUIRED" };
  const approved = getStore().listMilestones(ctx.workspaceId).filter((milestone) => milestone.status === "approved");
  if (approved.some((milestone) => !["important", "ordinary"].includes(
    (importance as Record<string, string>)[milestone.id] ?? "")))
    return { ok: false, code: "SCHEDULE_IMPORTANCE_REQUIRED" };
  const selected = Object.fromEntries(approved.map((milestone) => [milestone.id,
    (importance as Record<string, "important" | "ordinary">)[milestone.id]!]));
  const store = getStore();
  store.setSetting(ctx.workspaceId, AVAILABILITY_SETTING, JSON.stringify(windows));
  const params = readSchedulePreferences(ctx)?.params;
  store.setSetting(ctx.workspaceId, PREFERENCES_SETTING, JSON.stringify({ timeZone, mode: input.mode,
    importance: selected, ...(params ? { params } : {}) } satisfies SchedulePreferences));
  for (const [id, importance] of Object.entries(selected)) {
    const goal = readGoalSettings(ctx, id);
    if (!goal || goal.importance === importance) continue;
    const next = { ...goal, importance };
    store.setSetting(ctx.workspaceId, goalKey(id), JSON.stringify(next));
    store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId,
      idempotencyKey: `goal:importance:${id}:${randomUUID()}`, type: "goal.settings_confirmed",
      entityId: id, payload: { previous: goal, next, source: "schedule_preferences" } });
  }
  store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId,
    idempotencyKey: `schedule:preferences:${randomUUID()}`, type: "schedule.preferences_saved",
    entityId: ctx.workspaceId, payload: { timeZone, mode: input.mode, milestoneCount: approved.length } });
  return { ok: true };
}

/**
 * When the person said they are free, as the scheduler needs it.
 *
 * In the ledger rather than an environment variable, because a backup that does not carry it restores
 * a plan that cannot be rebuilt. A stored value that no longer parses falls back to the default rather
 * than emptying the plan silently — an unreadable setting is a bug to fix, not a reason to show a
 * blank week as though the person had no time.
 */
export function readAvailability(ctx: AccessContext): AvailabilityWindow[] {
  const preview = previewScope.getStore()?.availability;
  if (preview) return preview;
  return resolvedAvailability(ctx).windows;
}

/** Setting for each line's share (percent) of the week, set on the plan page; when absent the interview's stated shares are used. */
export const LINE_SHARES_SETTING = "schedule.lineShares";

/** Each line's share of the week (percent): what the person set on the plan page, else what they said (`statedShares`), else none. */
export function readLineShares(ctx: AccessContext): Record<string, number> | null {
  const preview = previewScope.getStore()?.lineShares;
  if (preview) return preview;
  const store = getStore();
  try {
    const set = JSON.parse(store.getSetting(ctx.workspaceId, LINE_SHARES_SETTING) ?? "null") as Record<string, number> | null;
    if (set && Object.values(set).some((value) => value > 0)) return set;
  } catch { /* unreadable: fall back to what was said */ }
  let portrait: PortraitReport | undefined;
  try { portrait = (JSON.parse(store.getSetting(ctx.workspaceId, "portrait.report") ?? "{}") as { report?: PortraitReport }).report; } catch { /* none yet */ }
  // The portrait's suggested share (`targetShare`) over the one the person described (`share`): the owner chose on 2026-10-20 to plan
  // on the suggestion, which keeps the hard line as the calendar's base and gives each other line what it feeds back to it.
  const items = portrait?.lines?.items?.map((item) => ({ lineId: item.lineId, share: item.targetShare ?? item.share })) ?? null;
  return statedShares(items, store.listProfileFacts(ctx.workspaceId), hoursFromText);
}

/** Each line's share as the person set it: whole percents for known lines, together at most 100; `{}` goes back to what they said. */
export function saveLineShares(ctx: AccessContext, value: Record<string, number>): { ok: true } | { ok: false; code: string } {
  const lines = new Set(linePacks(ctx).filter((pack) => pack.kind === "identity").map((pack) => pack.id));
  const entries = Object.entries(value).filter(([line]) => lines.has(line)).map(([line, share]) => [line, Math.max(0, Math.min(100, Math.round(share)))] as const);
  if (entries.reduce((sum, [, share]) => sum + share, 0) > 100) return { ok: false, code: "LINE_SHARES_OVER_100" };
  getStore().setSetting(ctx.workspaceId, LINE_SHARES_SETTING, entries.length ? JSON.stringify(Object.fromEntries(entries)) : "");
  return { ok: true };
}

/** The pattern and where it came from (painted / the interview's proposal / the stated weekly hours / the default); see `resolveAvailability`. */
export function resolvedAvailability(ctx: AccessContext): { windows: AvailabilityWindow[]; source: AvailabilitySource } {
  const store = getStore();
  return resolveAvailability({ saved: store.getSetting(ctx.workspaceId, AVAILABILITY_SETTING),
    proposed: store.getSetting(ctx.workspaceId, AVAILABILITY_PROPOSED_SETTING), facts: store.listProfileFacts(ctx.workspaceId) });
}

export function saveAvailability(ctx: AccessContext, windows: unknown): { ok: true } | { ok: false; code: string } {
  try {
    const validated = validateAvailability(windows);
    getStore().setSetting(ctx.workspaceId, AVAILABILITY_SETTING, JSON.stringify(validated));
    return { ok: true };
  } catch (error) {
    return { ok: false, code: error instanceof Error ? error.message : "AVAILABILITY_INVALID" };
  }
}
