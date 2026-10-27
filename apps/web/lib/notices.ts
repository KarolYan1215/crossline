import "server-only";
import { randomUUID } from "node:crypto";
import { tidySentenceEnds, type AccessContext } from "@crossline/core";
import { getStore, planToday } from "./crossline";
import { PRESENCE_FRESH_MS, PRESENCE_SETTING } from "./nudges";
import { isReminderKind, type NoticesBody, type NoticeView } from "../app/notice-kinds";

/** Until when the person has seen the bell's reminders (an ISO moment): anything said after it is unread. */
export const NOTICES_READ_SETTING = "notices.readAt";
const SHOWN_DAYS = 7;
const SHOWN_MAX = 40;
/** Kinds about a moment — a block about to start, the latest start, a timer running over: stale the same day, so they leave the bell after 12 hours. */
const MOMENT_KINDS = new Set(["block_start", "latest_start", "timer_overrun"]);
const MOMENT_MS = 12 * 3_600_000;

type Clarify = { question?: string; options?: Array<{ label: string; kind?: string; href?: string }> };
const plain = (text: string) => tidySentenceEnds(text).replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`~#>]+/g, "").replace(/\s+/g, " ").trim();

/** The bell's list: the system's own messages of the last week that ask nothing (`isReminderKind`), newest first, with the unread count. */
export function listNotices(ctx: AccessContext, now = new Date()): NoticesBody {
  const store = getStore();
  const readAt = store.getSetting(ctx.workspaceId, NOTICES_READ_SETTING) ?? "";
  const since = new Date(now.getTime() - SHOWN_DAYS * 86_400_000).toISOString();
  const items: NoticeView[] = store.listRecentNudges(ctx.workspaceId, since).flatMap((message) => {
    const payload = message.payload as { nudge?: { kind?: string }; card?: { nudgeKind?: string; clarify?: Clarify } } | undefined;
    const kind = payload?.nudge?.kind ?? payload?.card?.nudgeKind ?? "";
    const text = plain(payload?.card?.clarify?.question ?? message.text ?? "");
    if (!isReminderKind(kind) || !text) return [];
    if (MOMENT_KINDS.has(kind) && now.getTime() - Date.parse(message.createdAt) > MOMENT_MS) return [];
    const options = payload?.card?.clarify?.options ?? [];
    return [{ id: message.id, kind, text, at: message.createdAt,
      links: options.filter((option) => option.kind === "href" && option.href?.startsWith("/")).map((option) => ({ label: option.label, href: option.href! })),
      actionable: options.some((option) => option.kind === "action") }];
  }).reverse().slice(0, SHOWN_MAX);
  return { items, unread: items.filter((item) => item.at > readAt).length, readAt };
}

/** The bell was opened: everything said up to `at` is read. Never moves backwards. */
export function markNoticesRead(ctx: AccessContext, at: string): void {
  const store = getStore();
  const current = store.getSetting(ctx.workspaceId, NOTICES_READ_SETTING) ?? "";
  if (Number.isFinite(Date.parse(at)) && at > current) store.setSetting(ctx.workspaceId, NOTICES_READ_SETTING, at);
}

/**
 * Says a reminder to the person: it goes into the bell (and pops up there), and to the desktop and phone when no page is open. For
 * anything that asks nothing of them — an errand's departure reminder, an automation's result, a mail they only need to know about.
 * `links` are pages to open; a reminder never carries a button that changes something.
 */
export function addNotice(ctx: AccessContext, text: string, kind: string, links: Array<{ label: string; href: string }> = [], now = new Date()): string {
  const store = getStore();
  const conversation = store.conversationFor(ctx.workspaceId, planToday(ctx, now));
  const visibleAt = store.getSetting(ctx.workspaceId, PRESENCE_SETTING);
  const delivery = visibleAt && now.getTime() - Date.parse(visibleAt) < PRESENCE_FRESH_MS ? "page" : "pending";
  const id = randomUUID();
  store.appendConversationMessage({ id, workspaceId: ctx.workspaceId, conversationId: conversation.id, role: "nudge", text: "", createdAt: now.toISOString(),
    payload: { nudge: { kind, fingerprint: `${kind}:${id}`, counted: false, urgent: false, delivery },
      card: { actions: [], items: [], confidence: "high", nudgeKind: kind,
        clarify: { question: tidySentenceEnds(text), options: [...links.map((link) => ({ label: link.label, actions: [], kind: "href", href: link.href })), { label: "知道了", actions: [], kind: "ack" }] } } } });
  return id;
}
