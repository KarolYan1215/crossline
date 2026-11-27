import type { ImapMail, MailHeader } from "@crossline/connectors";
import type { CrosslineStore } from "@crossline/db";
import { ownerOf } from "../owner";

/**
 * What the person sent, as evidence for J1 (docs/plans/execution-gates-1124.md, round 2): per message the time, the recipients' domains
 * and the subject are kept as one `mail.changed` `sent_seen` event; the opening 500 characters of the text go only into a judgement's input and are
 * read again from the mailbox when needed, never stored.
 */
export const SENT_EXCERPT_CHARS = 500;
const stateKey = (accountId: string) => `mail.sentState.${accountId}`;

export type SentSeen = { accountId: string; uid: number; at: string; toDomains: string[]; subject: string };
export type SentMessage = SentSeen & { excerpt: string };

const domainsOf = (recipients: readonly string[]) => [...new Set(recipients.map((address) => address.split("@")[1] ?? "").filter(Boolean))].slice(0, 10);

export const sentOf = (accountId: string, message: MailHeader): SentMessage => ({ accountId, uid: message.uid, at: message.date,
  toDomains: domainsOf(message.recipients ?? []), subject: message.subject.slice(0, 200), excerpt: (message.body || message.snippet).slice(0, SENT_EXCERPT_CHARS) });

/** Reads each account's sent folder since last time and records what went out. Returns this pass's messages with their excerpts. */
export async function readSentMail(store: CrosslineStore, workspaceId: string, accounts: ReadonlyArray<{ id: string }>,
  open: (accountId: string) => Promise<{ mail: ImapMail } | undefined>): Promise<SentMessage[]> {
  const out: SentMessage[] = [];
  const owner = ownerOf(store, workspaceId);
  for (const account of accounts) {
    const box = await open(account.id).catch(() => undefined);
    if (!box) continue;
    let state: { uidValidity?: string; lastUid?: number } = {};
    try { state = JSON.parse(store.getSetting(workspaceId, stateKey(account.id)) ?? "{}") as typeof state; } catch { state = {}; }
    const read = await box.mail.sentSince(state).catch(() => undefined);
    if (!read?.sentFolder) continue;
    for (const message of read.messages) {
      const sent = sentOf(account.id, message);
      const { excerpt: _excerpt, ...kept } = sent;
      store.appendEvent({ ownerId: owner, workspaceId, type: "mail.changed", entityId: `${account.id}:${message.uid}`,
        idempotencyKey: `mail.sent_seen:${account.id}:${read.uidValidity}:${message.uid}`, payload: { ...kept, change: "sent_seen" } });
      out.push(sent);
    }
    store.setSetting(workspaceId, stateKey(account.id), JSON.stringify({ uidValidity: read.uidValidity, lastUid: read.lastUid }));
  }
  return out;
}

/** The recorded sent messages since `sinceIso`, newest last. */
export function sentSeenSince(store: CrosslineStore, workspaceId: string, sinceIso: string): Array<SentSeen & { eventId: string }> {
  return store.listEvents(workspaceId, { type: "mail.changed", change: "sent_seen" }).filter((event) => event.createdAt >= sinceIso || String((event.payload as SentSeen).at) >= sinceIso)
    .map((event) => ({ ...(event.payload as SentSeen), eventId: event.eventId }));
}

/** Excerpts for recorded messages, read again from each mailbox; a message that cannot be read keeps an empty excerpt. */
export async function sentExcerpts(items: ReadonlyArray<SentSeen>, open: (accountId: string) => Promise<{ mail: ImapMail } | undefined>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const byAccount = new Map<string, number[]>();
  for (const item of items) byAccount.set(item.accountId, [...(byAccount.get(item.accountId) ?? []), item.uid]);
  for (const [accountId, uids] of byAccount) {
    const box = await open(accountId).catch(() => undefined);
    const read = box ? await box.mail.readSent(uids).catch(() => []) : [];
    for (const message of read) out.set(`${accountId}:${message.uid}`, (message.body || message.snippet).slice(0, SENT_EXCERPT_CHARS));
  }
  return out;
}
