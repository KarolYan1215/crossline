import { classifyWindow, isPrivateWindow, type ActivityReading, type ActivityRule } from "@crossline/core";
import type { CrosslineStore } from "@crossline/db";

/** Consent v1: idle time and window changes, as daily aggregates only. Never a window title, never an app name. */
export const LOCAL_ACTIVITY_CONSENT = "localActivity.consent";
/** Consent v2: which app and window were in front, so work can be told from drifting. Asked separately and in words. */
export const ACTIVITY_DETAIL_CONSENT = "localActivity.consentV2";
/** ISO instant until which nothing is recorded, for "pause for an hour". */
export const ACTIVITY_PAUSED_UNTIL = "localActivity.pausedUntil";
export const ACTIVITY_BLACKLIST = "activity.blacklist";
export const ACTIVITY_RULES = "activity.rules";

/** The last active minute, and the long idle stretches (start and end only) the energy model reads sleep from. */
export const ACTIVITY_LAST_ACTIVE = "activity.lastActiveAt";
export const ACTIVITY_LONG_GAPS = "activity.longGaps";
const LONG_GAP_MS = 4 * 3_600_000;
const isGap = (value: unknown): value is { from: string; to: string } =>
  typeof value === "object" && value !== null && typeof (value as { from?: unknown }).from === "string" && typeof (value as { to?: unknown }).to === "string";

/** Titles are kept this long; after it the minutes, app and category stay and the title is blanked. */
export const TITLE_RETENTION_DAYS = 14;
const ROW_RETENTION_DAYS = 90;
const IDLE_AFTER_MS = 120_000;

const parseList = <T>(raw: string | null | undefined, ok: (item: unknown) => item is T): T[] => {
  try { const value = raw ? JSON.parse(raw) as unknown : []; return Array.isArray(value) ? value.filter(ok) : []; } catch { return []; }
};
const isString = (item: unknown): item is string => typeof item === "string";
const isRule = (item: unknown): item is ActivityRule => typeof item === "object" && item !== null
  && typeof (item as ActivityRule).match === "string" && typeof (item as ActivityRule).category === "string";

type DayCounters = { day: string; active: number; idle: number; switches: number; samples: number; last?: string };

/**
 * Turns readings from a source into what is stored, for every workspace that has agreed to it.
 *
 * Two levels, decided per workspace and re-read on every reading so a change takes effect at once: the daily aggregate
 * (consent v1) and the segment record with app and title (consent v2). A window that matches the private rules is not
 * recorded as a segment at all — not its title, not its app, not that it was open — though the minute still counts as
 * active in the aggregate, which comes from input idle time alone. Nothing is recorded while paused. Raw readings never
 * leave this object.
 */
export function createActivityTracker(store: CrosslineStore, listWorkspaceIds: () => string[], intervalSeconds = 60) {
  const counters = new Map<string, DayCounters>();

  /**
   * The start and end of every stretch of four hours or more with no activity — the computer idle or off — and nothing else (no app,
   * no title, no count). It is what the energy model reads sleep from when no phone record exists (docs/one-input.md §5).
   */
  function noteLongGap(workspaceId: string, at: string): void {
    const previous = store.getSetting(workspaceId, ACTIVITY_LAST_ACTIVE);
    if (previous && Date.parse(at) - Date.parse(previous) >= LONG_GAP_MS) {
      const gaps = parseList(store.getSetting(workspaceId, ACTIVITY_LONG_GAPS), isGap);
      store.setSetting(workspaceId, ACTIVITY_LONG_GAPS, JSON.stringify([...gaps, { from: previous, to: at }].slice(-40)));
    }
    store.setSetting(workspaceId, ACTIVITY_LAST_ACTIVE, at);
  }

  function handleFor(workspaceId: string, reading: ActivityReading): "skipped" | "recorded" {
    const detail = store.getSetting(workspaceId, ACTIVITY_DETAIL_CONSENT) === "granted";
    const aggregate = store.getSetting(workspaceId, LOCAL_ACTIVITY_CONSENT) === "granted";
    if (!detail && !aggregate) { counters.delete(workspaceId); return "skipped"; }
    const pausedUntil = store.getSetting(workspaceId, ACTIVITY_PAUSED_UNTIL);
    if (pausedUntil && Date.parse(pausedUntil) > Date.parse(reading.at)) return "skipped";

    const idle = reading.idleMs >= IDLE_AFTER_MS;
    const blacklist = parseList(store.getSetting(workspaceId, ACTIVITY_BLACKLIST), isString);
    const hidden = isPrivateWindow(reading.app, reading.title, blacklist);
    // What the aggregate may remember of a window is only whether it changed: a private one is just "private".
    const signature = hidden ? "private" : reading.app;

    const day = reading.at.slice(0, 10);
    let current = counters.get(workspaceId);
    if (!current || current.day !== day) current = { day, active: 0, idle: 0, switches: 0, samples: 0 };
    const minutes = intervalSeconds / 60;
    if (idle) current.idle += minutes; else current.active += minutes;
    if (current.last !== undefined && current.last !== signature && !idle) current.switches += 1;
    if (!idle) current.last = signature;
    current.samples += 1;
    if (!idle) noteLongGap(workspaceId, reading.at);
    counters.set(workspaceId, current);
    // A workspace with no owner row is not a real account; there is nobody to attribute the reading to.
    const ownerId = store.getWorkspaceOwnerId(workspaceId);
    if (!ownerId) return "skipped";
    store.upsertDailyActivity({ ownerId, workspaceId, day,
      aggregate: { activeMinutes: current.active, idleMinutes: current.idle, windowSwitches: current.switches, sampleCount: current.samples }, observedAt: reading.at });

    if (!detail || hidden) return "recorded";
    const rules = parseList(store.getSetting(workspaceId, ACTIVITY_RULES), isRule);
    store.recordActivityReading({ workspaceId, at: reading.at, intervalSeconds, app: reading.app, title: idle ? "" : reading.title,
      category: idle ? "other" : classifyWindow(reading.app, reading.title, rules), idle });
    return "recorded";
  }

  return {
    /** One reading, offered to every workspace on this machine; each decides for itself. */
    handle(reading: ActivityReading): void {
      for (const workspaceId of listWorkspaceIds()) { try { handleFor(workspaceId, reading); } catch { /* one workspace's trouble never stops the others */ } }
    },
    /** Retention: old titles blanked, very old rows dropped. Cheap enough to run every tick. */
    prune(now: Date = new Date()): void {
      for (const workspaceId of listWorkspaceIds()) {
        store.pruneActivity(workspaceId, new Date(now.getTime() - TITLE_RETENTION_DAYS * 86_400_000).toISOString(), new Date(now.getTime() - ROW_RETENTION_DAYS * 86_400_000).toISOString());
      }
    }
  };
}
