import "server-only";
import { randomUUID } from "node:crypto";
import type { AccessContext } from "@crossline/core";
import { getStore, planToday } from "./crossline";

/** One row of 小帮手's thread list. `today`: the day's conversation, the thread every box (Today, the floating 小帮手) opens. */
export type ThreadView = { id: string; title: string; kind: "day" | "thread"; day: string; updatedAt: string; archived: boolean; today: boolean };

export function threadView(ctx: AccessContext, conversation: { id: string; title: string; kind: "day" | "thread"; day: string; updatedAt: string; archivedAt?: string },
  today = planToday(ctx)): ThreadView {
  return { id: conversation.id, title: conversation.title, kind: conversation.kind, day: conversation.day, updatedAt: conversation.updatedAt,
    archived: Boolean(conversation.archivedAt), today: conversation.kind === "day" && conversation.day === today };
}

/** The list: today's conversation first (made on first use), then the rest by last use. Archived threads only with `archived`. */
export function listThreads(ctx: AccessContext, options: { archived?: boolean } = {}): ThreadView[] {
  const store = getStore();
  const today = planToday(ctx);
  const rows = store.listConversationThreads(ctx.workspaceId, options.archived ? { archived: true } : {});
  if (options.archived) return rows.map((row) => threadView(ctx, row, today));
  const current = store.conversationFor(ctx.workspaceId, today);
  return [threadView(ctx, current, today), ...rows.filter((row) => row.id !== current.id).map((row) => threadView(ctx, row, today))];
}

export function createThread(ctx: AccessContext, title: string): ThreadView {
  const row = getStore().createConversationThread(ctx.workspaceId, { id: `thr-${randomUUID()}`, title: title.trim().slice(0, 60), day: planToday(ctx) });
  return threadView(ctx, row);
}

/** Rename or archive (and bring back) one thread. Today's conversation cannot be archived: it is where every box writes. */
export function updateThread(ctx: AccessContext, id: string, change: { title?: string; archived?: boolean }): { ok: true; thread: ThreadView } | { ok: false; code: string } {
  const store = getStore();
  const row = store.getConversation(ctx.workspaceId, id);
  if (!row) return { ok: false, code: "THREAD_NOT_FOUND" };
  if (change.archived === true && row.kind === "day" && row.day === planToday(ctx)) return { ok: false, code: "THREAD_TODAY_NOT_ARCHIVABLE" };
  if (change.title !== undefined) store.renameConversation(ctx.workspaceId, id, change.title.trim().slice(0, 60));
  if (change.archived !== undefined) store.archiveConversation(ctx.workspaceId, id, change.archived);
  return { ok: true, thread: threadView(ctx, store.getConversation(ctx.workspaceId, id)!) };
}
