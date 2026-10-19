/**
 * The person's mailbox as Crossline sees it (docs/personal-agent.md, 2026-10-19): accounts read over IMAP, read-only, the password in
 * the worker's secret store and never in the ledger. New mail is sorted once by a cheap model run (`crossline-mail-triage`): something
 * the person has to do or a date becomes a line in their inbox — planned like anything they type — a reply from someone they were
 * waiting on brings that wait forward, and the rest is left alone. What is kept is the sender, subject, date and opening lines of the
 * newest messages, and what was done with each; never the full text, which is read from the server when a run needs it.
 */
export const MAIL_ACCOUNTS_SETTING = "mail.accounts";
/** What the sorting did with each recent message, newest last (at most `MAIL_LOG_KEEP`). */
export const MAIL_LOG_SETTING = "mail.log";
export const MAIL_LOG_KEEP = 120;
/** New mail is looked at this often. */
export const MAIL_CHECK_MINUTES = 15;
/** Lines one pass may put in the inbox: a flood of mail must not become a flood of tasks. */
export const MAIL_INBOX_PER_PASS = 5;

export type MailAccount = {
  id: string; address: string; label: string; host: string; port: number;
  /** New mail is sorted (inbox lines, waits brought forward). Off: only read when the assistant or an automation asks. */
  triage: boolean;
  addedAt: string; uidValidity?: string; lastUid?: number; lastCheckedAt?: string;
  lastError?: { code: string; message: string; at: string };
};
export type MailLogEntry = { accountId: string; uid: number; from: string; subject: string; date: string; kind: MailTriageKind; title: string; at: string };

export function readMailAccounts(raw: string | null | undefined): MailAccount[] {
  try { const parsed = JSON.parse(raw ?? "[]") as MailAccount[]; return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.id === "string") : []; }
  catch { return []; }
}
export function readMailLog(raw: string | null | undefined): MailLogEntry[] {
  try { const parsed = JSON.parse(raw ?? "[]") as MailLogEntry[]; return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

export type MailTriageKind = "todo" | "date" | "reply" | "info" | "ignore";
export const MAIL_TRIAGE_KIND_LABEL: Record<MailTriageKind, string> = { todo: "待办", date: "日期", reply: "回复了等待项", info: "知悉", ignore: "略过" };
export type MailTriage = { items: Array<{ uid: number; kind: MailTriageKind; title: string; waitingId: string; why: string }> };

export const MAIL_TRIAGE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["items"], properties: {
    items: { type: "array", maxItems: 40, items: { type: "object", additionalProperties: false, required: ["uid", "kind", "title", "waitingId", "why"], properties: {
      uid: { type: "integer", minimum: 1 },
      kind: { type: "string", enum: ["todo", "date", "reply", "info", "ignore"] },
      title: { type: "string", maxLength: 140 },
      waitingId: { type: "string", maxLength: 128 },
      why: { type: "string", maxLength: 200 } } } } }
} as const;

/** Keeps only answers that can be acted on: a known message, a title for what goes in the inbox, an open wait for a reply. */
export function validateMailTriage(value: unknown, uids: number[], waitingIds: string[]): MailTriage {
  const answer = value as MailTriage | undefined;
  if (!answer || !Array.isArray(answer.items)) throw Object.assign(new Error("MAIL_TRIAGE_INVALID"), { detail: "items 必须是数组" });
  const problems: string[] = [];
  const seen = new Set<number>();
  for (const item of answer.items) {
    if (!uids.includes(item.uid)) problems.push(`uid ${item.uid} 不是这次给出的邮件`);
    else if (seen.has(item.uid)) problems.push(`uid ${item.uid} 重复`);
    seen.add(item.uid);
    if ((item.kind === "todo" || item.kind === "date") && !item.title.trim()) problems.push(`uid ${item.uid} 是${item.kind === "todo" ? "待办" : "日期"}却没有 title`);
    if (item.kind === "reply" && !waitingIds.includes(item.waitingId)) problems.push(`uid ${item.uid} 的 waitingId「${item.waitingId}」不是正在等的事项`);
  }
  if (problems.length) throw Object.assign(new Error("MAIL_TRIAGE_INVALID"), { detail: problems.slice(0, 6).join("；") });
  return answer;
}
