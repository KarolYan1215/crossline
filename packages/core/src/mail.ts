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
  /** A bank or shop mail's amount becomes a wealth record (docs/domain-lines.md). On unless set to false; needs `triage`. */
  bookkeeping?: boolean;
  addedAt: string; uidValidity?: string; lastUid?: number; lastCheckedAt?: string;
  lastError?: { code: string; message: string; at: string };
};
/** `needs_reply`: sorted as `reply` with no wait behind it — the sender expects an answer from the person (a draft may follow). */
export type MailLogEntry = { accountId: string; uid: number; from: string; subject: string; date: string; kind: MailTriageKind | "needs_reply"; title: string; at: string };

export function readMailAccounts(raw: string | null | undefined): MailAccount[] {
  try { const parsed = JSON.parse(raw ?? "[]") as MailAccount[]; return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.id === "string") : []; }
  catch { return []; }
}
export function readMailLog(raw: string | null | undefined): MailLogEntry[] {
  try { const parsed = JSON.parse(raw ?? "[]") as MailLogEntry[]; return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

/**
 * Where the person makes the password a mailbox needs, for providers that have one page for it (2026-10-19, the owner's request: send a
 * Gmail user straight there). `authuser` picks the typed account when the browser is signed in to several; Google shows its own account
 * chooser otherwise. The app-password page exists only once two-step verification is on, hence the second address.
 */
export type AppPasswordPage = { provider: string; url: string; setupUrl: string; setupLabel: string; hint: string };
export function appPasswordPage(address: string): AppPasswordPage | undefined {
  const trimmed = address.trim().toLowerCase();
  const domain = trimmed.split("@")[1] ?? "";
  if (domain !== "gmail.com" && domain !== "googlemail.com") return undefined;
  const account = /^[^\s@]+@[^\s@]+$/.test(trimmed) ? `?authuser=${encodeURIComponent(trimmed)}` : "";
  return { provider: "Gmail", url: `https://myaccount.google.com/apppasswords${account}`,
    setupUrl: `https://myaccount.google.com/signinoptions/twosv${account}`, setupLabel: "还没开两步验证？先开启",
    hint: "Gmail 不收 Google 登录密码。在打开的页面里起个名字（如 Crossline）并创建，把显示的 16 位密码粘贴到上面，空格可以带着。" };
}

export type MailTriageKind = "todo" | "date" | "reply" | "transaction" | "info" | "ignore";
export const MAIL_TRIAGE_KIND_LABEL: Record<MailTriageKind | "needs_reply", string> = { todo: "待办", date: "日期", reply: "回复了等待项", transaction: "记账",
  info: "知悉", ignore: "略过", needs_reply: "需要回复" };
/** `transaction` (a payment, a refund, a salary, a receipt): `direction`, `amount`, `currency` and `merchant` as the mail states them; empty otherwise. */
export type MailTriage = { items: Array<{ uid: number; kind: MailTriageKind; title: string; waitingId: string; why: string;
  direction: "" | "income" | "expense"; amount: number; currency: string; merchant: string }> };

export const MAIL_TRIAGE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["items"], properties: {
    items: { type: "array", maxItems: 40, items: { type: "object", additionalProperties: false,
      required: ["uid", "kind", "title", "waitingId", "why", "direction", "amount", "currency", "merchant"], properties: {
      uid: { type: "integer", minimum: 1 },
      kind: { type: "string", enum: ["todo", "date", "reply", "transaction", "info", "ignore"] },
      title: { type: "string", maxLength: 140 },
      waitingId: { type: "string", maxLength: 128 },
      why: { type: "string", maxLength: 200 },
      direction: { type: "string", enum: ["", "income", "expense"] },
      amount: { type: "number", minimum: 0 },
      currency: { type: "string", maxLength: 8 },
      merchant: { type: "string", maxLength: 60 } } } } }
} as const;

/**
 * Keeps only answers that can be acted on: a known message, a title for what goes in the inbox, an open wait for a reply. A `reply` with
 * an empty `waitingId` is a message whose sender expects the person's answer and is waiting on nobody's wait (it may get a draft).
 */
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
    if (item.kind === "reply" && item.waitingId && !waitingIds.includes(item.waitingId)) {
      problems.push(`uid ${item.uid} 的 waitingId「${item.waitingId}」不是正在等的事项（需要本人回复、不是在等的回信时 waitingId 留空）`);
    }
    if (item.kind === "transaction" && !(item.amount > 0 && item.direction)) problems.push(`uid ${item.uid} 是记账却没有 amount 或 direction`);
  }
  if (problems.length) throw Object.assign(new Error("MAIL_TRIAGE_INVALID"), { detail: problems.slice(0, 6).join("；") });
  return answer;
}

/**
 * Mail that needs the person's reply (docs/personal-agent.md §3.1, 2026-10-19): a cheap run drafts an answer, the draft is kept as a file in
 * the account's own folder under the data directory — the only place the text of either message is kept — and the person is told who wrote,
 * about what, why it wants an answer and what the draft says, with buttons to open or copy it, mark it answered or not needing one. Nothing
 * is ever sent: there is no sending path anywhere in Crossline, and the draft says so in its first line. The ledger keeps only metadata
 * (`MAIL_REPLIES_SETTING` and `mail.reply.*` events).
 */
export const MAIL_REPLY_DRAFTS_SETTING = "mail.replyDrafts";
/** The drafts written, newest last (metadata only; the text is in the file named by `file`). */
export const MAIL_REPLIES_SETTING = "mail.replies";
export const MAIL_REPLIES_KEEP = 60;
/** At most this many drafts a day for each mailbox: a flood of mail must not become a flood of drafts and messages. */
export const MAIL_DRAFTS_PER_ACCOUNT_DAY = 5;
/** A draft still unanswered this long after the person was told, whose mail names a day to answer by, is mentioned once more. */
export const MAIL_REPLY_REMIND_HOURS = 48;
/** The nudge kind of these messages: 「少问这类」 mutes it for a week, like any other kind. */
export const MAIL_REPLY_NUDGE_KIND = "mail_reply";
/** The line every draft starts with (and the reason a copy of the body leaves it out). */
export const MAIL_DRAFT_NOTE = "由助手起草，需本人确认后自行发送。Crossline 不会发送这封邮件。";

export const replyDraftsOn = (raw: string | null | undefined) => raw !== "off";

export type MailReplyDraft = {
  id: string; accountId: string; uid: number; uidValidity: string; messageId: string;
  from: string; fromAddress: string; subject: string; date: string;
  /** Why it wants an answer (the drafter's words, short). */
  why: string;
  /** What the draft says, two to four short lines (shown in the message; the draft itself is only in the file). */
  points: string[];
  /** The day the sender asked for an answer by, YYYY-MM-DD, or "". */
  replyBy: string;
  /** The draft file's name inside the account's drafts folder. */
  file: string;
  createdAt: string;
  /** When the person was told (absent while quiet hours or a busy moment held it back). */
  notifiedAt?: string;
  remindedAt?: string;
  /** The conversation messages that told the person, so closing the draft closes their buttons too. */
  messageIds?: string[];
};
export type MailReplyClosure = { how: "replied" | "dismissed"; by: "person" | "sent_found"; at: string };

export function readMailReplies(raw: string | null | undefined): MailReplyDraft[] {
  try { const parsed = JSON.parse(raw ?? "[]") as MailReplyDraft[]; return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.id === "string") : []; }
  catch { return []; }
}

export type MailReplyDraftAnswer = { needsReply: boolean; why: string; subject: string; body: string; points: string[]; replyBy: string };
export const MAIL_REPLY_DRAFT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["needsReply", "why", "subject", "body", "points", "replyBy"], properties: {
    needsReply: { type: "boolean" },
    why: { type: "string", maxLength: 200 },
    subject: { type: "string", maxLength: 200 },
    body: { type: "string", maxLength: 4000 },
    points: { type: "array", maxItems: 4, items: { type: "string", maxLength: 80 } },
    replyBy: { type: "string", maxLength: 10 } }
} as const;

/** Words a draft may not use about itself: it is never sent by anyone but the person, so it never says it was. */
const CLAIMS_SENT = /已(为你|替你|代你)?(发送|发出|回复了)|I have sent|has been sent/i;
export function validateMailReplyDraft(value: unknown): MailReplyDraftAnswer {
  const answer = value as MailReplyDraftAnswer | undefined;
  if (!answer || typeof answer.needsReply !== "boolean") throw Object.assign(new Error("MAIL_REPLY_DRAFT_INVALID"), { detail: "needsReply 必须是布尔值" });
  const problems: string[] = [];
  if (!answer.why.trim()) problems.push("why 不能为空");
  if (answer.replyBy && !/^\d{4}-\d{2}-\d{2}$/.test(answer.replyBy)) problems.push(`replyBy「${answer.replyBy}」须是 YYYY-MM-DD 或空`);
  if (answer.needsReply) {
    if (!answer.body.trim()) problems.push("需要回复时 body 不能为空");
    if (!answer.points.some((point) => point.trim())) problems.push("需要回复时 points 至少一条");
    if (CLAIMS_SENT.test(answer.body) || answer.points.some((point) => CLAIMS_SENT.test(point))) problems.push("草稿不能说已经发送：它只由本人确认后自己发");
  }
  if (problems.length) throw Object.assign(new Error("MAIL_REPLY_DRAFT_INVALID"), { detail: problems.join("；") });
  return { ...answer, points: answer.points.map((point) => point.trim()).filter(Boolean).slice(0, 4) };
}

const BODY_MARK = "正文：";
/** The draft file: the note first, then whom it answers and the subject, then the body to copy. */
export function draftFileText(draft: Pick<MailReplyDraft, "from" | "subject" | "date">, answer: Pick<MailReplyDraftAnswer, "subject" | "body">): string {
  const subject = answer.subject.trim() || (/^(re|回复)[:：]/i.test(draft.subject) ? draft.subject : `Re: ${draft.subject}`);
  return [`> ${MAIL_DRAFT_NOTE}`, "", `回复：${draft.from}（${draft.date.slice(0, 10)} 来信「${draft.subject || "无主题"}」）`, `主题：${subject}`, "",
    BODY_MARK, "", answer.body.trim(), ""].join("\n");
}
/** What 「复制草稿」 puts on the clipboard: the body alone, without the note and the heading lines. */
export function draftBodyOf(fileText: string): string {
  const at = fileText.indexOf(`\n${BODY_MARK}\n`);
  return (at < 0 ? fileText : fileText.slice(at + BODY_MARK.length + 2)).trim();
}

/**
 * Why a message about a draft is held back now, or undefined when it may be said: the nudges' own rules (docs/one-input.md §5) — never
 * at night (before 08:00 or from 23:00 on the person's clock), never while they are busy (the timer runs, a calendar event is under way,
 * they answered something in the last twenty minutes), nothing at the 「关闭」 level, nothing while 「少问这类」 holds.
 */
export function mailReplyQuiet(input: { clock: string; timerRunning: boolean; inMeeting: boolean; answeredRecently: boolean; level: string; muted: boolean }): string | undefined {
  if (input.level === "off") return "notify_off";
  if (input.muted) return "muted";
  if (input.clock < "08:00" || input.clock >= "23:00") return "night";
  if (input.timerRunning || input.inMeeting || input.answeredRecently) return "busy";
  return undefined;
}

/** The one reminder: told at least 48 hours ago, not reminded yet, and the sender named a day to answer by. */
export function replyReminderDue(draft: MailReplyDraft, now: Date): boolean {
  return Boolean(draft.notifiedAt && !draft.remindedAt && draft.replyBy
    && now.getTime() - Date.parse(draft.notifiedAt) >= MAIL_REPLY_REMIND_HOURS * 3_600_000);
}
