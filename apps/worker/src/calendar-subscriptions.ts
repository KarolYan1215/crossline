import { randomUUID } from "node:crypto";
import {
  CALENDAR_SUBSCRIPTIONS_SETTING, readSubscriptions, subscriptionSecretName, subscriptionSourceKey, type CalendarSubscription
} from "@crossline/core";
import { icalAddress, readIcal, type SecretStore } from "@crossline/connectors";
import type { CrosslineStore } from "@crossline/db";
import type { CalendarSource } from "./graph-sync";
import { safeGet, type SafeGetDeps } from "./safe-fetch";

/**
 * Calendars read from a subscription link (docs/onboarding-v3.md 「日历接入」; the shared shape is in `packages/core/src/calendar-subscriptions.ts`).
 * Each one is a `CalendarSource` for the existing sync, so per-source authority, the change summary and the classifier all apply as for
 * a Graph calendar. A subscription has no delta: every read is the whole calendar, so it never stores a cursor and every read is
 * authoritative for its own blocks — an event removed from the calendar leaves the plan on the next read.
 */
const MAX_BYTES = 5_000_000;
const TYPES = ["text/calendar", "application/ics", "text/x-vcalendar", "text/plain", "application/octet-stream"];
/** The plan carries 56 days; a little more is read so an event moved just past the edge is known when the window rolls onto it. */
const READ_DAYS = 63;

export type SubscriptionDeps = { secrets: SecretStore; fetch: SafeGetDeps; now?: () => Date };

const list = (store: CrosslineStore, workspaceId: string) => readSubscriptions(store.getSetting(workspaceId, CALENDAR_SUBSCRIPTIONS_SETTING));
const save = (store: CrosslineStore, workspaceId: string, items: CalendarSubscription[]) =>
  store.setSetting(workspaceId, CALENDAR_SUBSCRIPTIONS_SETTING, JSON.stringify(items));

export const hasSubscriptions = (store: CrosslineStore, workspaceId: string) => list(store, workspaceId).length > 0;

/** Reads one link: the calendar's events inside the window, or a reason in the person's words. */
async function readLink(link: string, sourceId: string, deps: SubscriptionDeps, timeZone: string) {
  const fetched = await safeGet(link, deps.fetch, { maxBytes: MAX_BYTES, types: TYPES });
  if (!fetched.ok) return { ok: false as const, reason: `读不到这个链接：${fetched.reason}` };
  const text = new TextDecoder().decode(fetched.bytes);
  if (!/BEGIN:VCALENDAR/i.test(text)) return { ok: false as const, reason: "这个链接打开的不是日历文件（应以 BEGIN:VCALENDAR 开头）" };
  const now = deps.now?.() ?? new Date();
  try {
    const read = readIcal(text, { sourceId, from: new Date(now.getTime() - 86_400_000), to: new Date(now.getTime() + READ_DAYS * 86_400_000), timeZone });
    return { ok: true as const, read };
  } catch { return { ok: false as const, reason: "日历文件格式有误，读不出来" }; }
}

/** The person's subscriptions as sync sources, resolved per tick (a link removed in Settings stops being read at once). */
export function subscriptionSources(store: CrosslineStore, workspaceId: string, deps: SubscriptionDeps, timeZone: () => string | undefined): CalendarSource[] {
  return list(store, workspaceId).map((subscription) => ({
    key: subscriptionSourceKey(subscription.id), label: subscription.label,
    reader: {
      pullCalendar: async () => {
        const note = (patch: Partial<CalendarSubscription>) => save(store, workspaceId,
          list(store, workspaceId).map((item) => item.id === subscription.id ? { ...item, ...patch, lastReadAt: new Date().toISOString() } : item));
        const link = await deps.secrets.read(workspaceId, subscriptionSecretName(subscription.id)).catch(() => undefined);
        if (!link) { note({ lastError: "这台电脑上没有这个链接（换过电脑或恢复过备份）；删掉后重新粘贴" }); throw new Error("ICAL_LINK_MISSING"); }
        const outcome = await readLink(link, subscription.id, deps, timeZone() ?? "UTC");
        if (!outcome.ok) { note({ lastError: outcome.reason }); throw new Error("ICAL_READ_FAILED"); }
        save(store, workspaceId, list(store, workspaceId).map((item) => {
          if (item.id !== subscription.id) return item;
          const { lastError: _cleared, ...rest } = item;
          return { ...rest, lastReadAt: new Date().toISOString(), lastEvents: outcome.read.items.length };
        }));
        // No cursor: the next read starts from nothing again, which is what makes every read authoritative for this source.
        return { items: outcome.read.items };
      }
    }
  }));
}

export type SubscriptionAdded =
  | { state: "added"; subscription: CalendarSubscription; events: number }
  | { state: "blocked"; code: string; message: string };

/**
 * Adds a link after reading it once — a link that does not open, or opens something that is not a calendar, is refused here rather
 * than stored to fail every tick. The link goes to the secret store; only the label and host go to the ledger.
 */
export async function addSubscription(store: CrosslineStore, workspaceId: string, deps: SubscriptionDeps,
  input: { link: string; label: string; timeZone: string }): Promise<SubscriptionAdded> {
  const url = icalAddress(input.link);
  if (!url) return { state: "blocked", code: "ICAL_LINK_INVALID", message: "需要一个 https:// 或 webcal:// 开头的日历链接。" };
  const id = randomUUID().slice(0, 8);
  const outcome = await readLink(url.toString(), id, deps, input.timeZone);
  if (!outcome.ok) return { state: "blocked", code: "ICAL_READ_FAILED", message: outcome.reason };
  try { await deps.secrets.write(workspaceId, subscriptionSecretName(id), url.toString()); }
  catch { return { state: "blocked", code: "ICAL_SECRET_UNAVAILABLE", message: "这台电脑上没法安全保存链接（需要 Windows 的数据保护）。" }; }
  const label = input.label.trim().slice(0, 40) || outcome.read.calendarName.slice(0, 40) || url.hostname;
  const subscription: CalendarSubscription = { id, label, host: url.hostname, addedAt: new Date().toISOString(),
    lastReadAt: new Date().toISOString(), lastEvents: outcome.read.items.length };
  save(store, workspaceId, [...list(store, workspaceId), subscription]);
  return { state: "added", subscription, events: outcome.read.items.length };
}

/**
 * Stops reading a link and forgets it, and takes its events out of the plan now: a workspace with no other calendar has no sync left to
 * do that (a sync with no sources does not run).
 */
export function removeSubscription(store: CrosslineStore, workspaceId: string, secrets: SecretStore, id: string): boolean {
  const before = list(store, workspaceId);
  if (!before.some((item) => item.id === id)) return false;
  secrets.remove(workspaceId, subscriptionSecretName(id));
  save(store, workspaceId, before.filter((item) => item.id !== id));
  const plan = store.listPlanVersions(workspaceId)[0];
  const blocks = (plan?.payload as { blocks?: Array<{ sourceKey?: unknown }> } | undefined)?.blocks;
  const key = subscriptionSourceKey(id);
  if (plan && Array.isArray(blocks) && blocks.some((block) => block.sourceKey === key)) {
    store.savePlanVersion({ ...plan, payload: { ...(plan.payload as object), blocks: blocks.filter((block) => block.sourceKey !== key) } });
  }
  return true;
}
