import { MAIL_REPLIES_SETTING, MAIL_REPLY_DRAFTS_SETTING, readMailReplies, replyDraftsOn, type MailReplyClosure, type MailReplyDraft } from "@crossline/core";
import type { CrosslineStore } from "./index";

/**
 * Reply drafts in the ledger (docs/personal-agent.md §3.1), shared by the worker that writes them and the web that shows and closes them.
 * A draft's record is metadata only (`mail.replies`, written by the worker); whether it is still open is read from append-only
 * `mail.reply.closed` events, so the person closing one on a page never races the worker rewriting the list.
 */
export const MAIL_REPLY_CLOSED_EVENT = "mail.reply.closed";

export function mailReplyClosures(store: CrosslineStore, workspaceId: string): Map<string, MailReplyClosure> {
  const closed = new Map<string, MailReplyClosure>();
  for (const event of store.listEvents(workspaceId, { type: MAIL_REPLY_CLOSED_EVENT })) {
    const payload = event.payload as Partial<MailReplyClosure> | undefined;
    if (event.entityId && payload?.how && !closed.has(event.entityId)) closed.set(event.entityId, { how: payload.how, by: payload.by ?? "person", at: payload.at ?? "" });
  }
  return closed;
}

export const readReplyDrafts = (store: CrosslineStore, workspaceId: string): MailReplyDraft[] => readMailReplies(store.getSetting(workspaceId, MAIL_REPLIES_SETTING));
export const replyDraftsEnabled = (store: CrosslineStore, workspaceId: string) => replyDraftsOn(store.getSetting(workspaceId, MAIL_REPLY_DRAFTS_SETTING));

/** Drafts not answered and not dismissed. */
export function openReplyDrafts(store: CrosslineStore, workspaceId: string): MailReplyDraft[] {
  const closed = mailReplyClosures(store, workspaceId);
  return readReplyDrafts(store, workspaceId).filter((draft) => !closed.has(draft.id));
}

/**
 * Closes a draft: the person answered it (「已回复」, or their answer was found in the sent folder) or said it needs none (「不用回」). Once,
 * logged as an event; the messages that told them about it show the choice and are no longer sent to the phone. False when the draft is
 * unknown or already closed.
 */
export function closeMailReply(store: CrosslineStore, workspaceId: string, id: string, how: MailReplyClosure["how"], by: MailReplyClosure["by"], now = new Date()): boolean {
  const draft = readReplyDrafts(store, workspaceId).find((item) => item.id === id);
  if (!draft || mailReplyClosures(store, workspaceId).has(id)) return false;
  const ownerId = store.getWorkspaceOwnerId(workspaceId) ?? "system";
  store.appendEvent({ ownerId, workspaceId, idempotencyKey: `${MAIL_REPLY_CLOSED_EVENT}:${id}`, type: MAIL_REPLY_CLOSED_EVENT, entityId: id,
    payload: { how, by, at: now.toISOString(), accountId: draft.accountId } });
  for (const messageId of draft.messageIds ?? []) {
    const message = store.getConversationMessage(workspaceId, messageId);
    const card = message?.payload.card as { clarify?: { options?: Array<{ close?: string }>; chosen?: number } } | undefined;
    if (!message || !card?.clarify) continue;
    const index = card.clarify.options?.findIndex((option) => option.close === how) ?? -1;
    const nudge = message.payload.nudge as { delivery?: string } | undefined;
    store.updateConversationPayload(workspaceId, messageId, { ...message.payload,
      ...(nudge?.delivery === "pending" ? { nudge: { ...nudge, delivery: "closed" } } : {}),
      card: { ...card, clarify: { ...card.clarify, ...(card.clarify.chosen === undefined && index >= 0 ? { chosen: index } : {}) } } });
  }
  return true;
}

export type MailReplyView = Pick<MailReplyDraft, "id" | "accountId" | "from" | "subject" | "date" | "why" | "points" | "replyBy" | "createdAt"> & {
  state: "open" | MailReplyClosure["how"]; closedBy?: MailReplyClosure["by"] };
/** What the settings card lists: the latest drafts, newest first, with whether each is still open. */
export function mailRepliesView(store: CrosslineStore, workspaceId: string, limit = 10): { on: boolean; recent: MailReplyView[] } {
  const closed = mailReplyClosures(store, workspaceId);
  const recent = readReplyDrafts(store, workspaceId).slice(-limit).reverse().map((draft) => {
    const closure = closed.get(draft.id);
    return { id: draft.id, accountId: draft.accountId, from: draft.from, subject: draft.subject, date: draft.date, why: draft.why, points: draft.points,
      replyBy: draft.replyBy, createdAt: draft.createdAt, state: closure?.how ?? "open" as const, ...(closure ? { closedBy: closure.by } : {}) };
  });
  return { on: replyDraftsEnabled(store, workspaceId), recent };
}
