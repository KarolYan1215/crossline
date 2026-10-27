import { randomUUID } from "node:crypto";
import {
  MAIL_ACCOUNTS_SETTING, MAIL_CHECK_MINUTES, MAIL_INBOX_PER_PASS, MAIL_LOG_KEEP, MAIL_LOG_SETTING, MAIL_TRIAGE_SCHEMA, readMailAccounts, readMailLog,
  amountsInText, isMailReminderTitle, MAIL_CHECK_NUDGE_KIND, moneyDirection, validateMailTriage, type MailAccount, type MailLogEntry, type MailTriage
} from "@crossline/core";
import {
  createImapMail, hostAllowed, presetFor, unsupportedProvider, type ImapFactory, type ImapMail, type MailHeader, type SecretStore
} from "@crossline/connectors";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import { mailRepliesView, recordAndJudge, type CrosslineStore } from "@crossline/db";
import type { MailLookup } from "./agent-tools";
import { draftReplies, followUpReplies, type ReplyCandidate } from "./mail-replies";
import { identityLines } from "./lines";
import { ownerOf } from "./owner";
import { tOfWorkspace } from "./locale";
import { sayToPerson } from "./workflow-smith";

/**
 * The person's mailbox in the worker (docs/personal-agent.md, 2026-10-19). Accounts are added after one successful sign-in, the
 * password goes to the secret store (`mail-<id>`), and every `MAIL_CHECK_MINUTES` the new mail is read (read-only) and, when the
 * person left sorting on, sorted by `crossline-mail-triage`: to-dos and dates go into the inbox as captures (the analysis then plans
 * them like anything typed), a reply from someone a wait is on brings that wait forward on 待决事项, and the rest is left. The new
 * headers are also handed to the automations (`onNewMail`), which is how a mail-triggered workflow starts.
 */
export const MAIL_TRIAGE_SKILL = "crossline:crossline-mail-triage";
const secretName = (id: string) => `mail-${id}`;

export type MailDeps = { store: CrosslineStore; secrets: SecretStore; factory?: ImapFactory; now?: () => Date;
  /** The host's checked public address (tests stand in for DNS). */
  resolve?: (host: string) => Promise<string | undefined> };

const accounts = (store: CrosslineStore, workspaceId: string) => readMailAccounts(store.getSetting(workspaceId, MAIL_ACCOUNTS_SETTING));
const saveAccounts = (store: CrosslineStore, workspaceId: string, list: MailAccount[]) => store.setSetting(workspaceId, MAIL_ACCOUNTS_SETTING, JSON.stringify(list));

/** What the settings card shows: the accounts (no password) with how much new mail waits to be sorted, what sorting did lately, and the reply drafts (switch and latest). */
export function mailView(store: CrosslineStore, workspaceId: string) {
  const waiting = new Map<string, number>();
  for (const message of unsortedOf(store, workspaceId)) waiting.set(message.accountId, (waiting.get(message.accountId) ?? 0) + 1);
  return { accounts: accounts(store, workspaceId).map((account) => ({ ...account, unsorted: waiting.get(account.id) ?? 0 })), log:readMailLog(store.getSetting(workspaceId, MAIL_LOG_SETTING)).slice(-30).reverse(),
    replies: mailRepliesView(store, workspaceId) };
}

/** Signs in once with what the person typed; kept only when it works. */
export async function addMailAccount(deps: MailDeps, workspaceId: string, input: { address: string; password: string; host?: string; port?: number; label?: string }):
  Promise<{ ok: true; account: MailAccount } | { ok: false; code: string; message: string }> {
  const t = tOfWorkspace(deps.store, workspaceId);
  const address = input.address.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return { ok: false, code: "MAIL_ADDRESS_INVALID", message: t("邮箱地址格式不对。") };
  const unsupported = unsupportedProvider(address);
  if (unsupported) return { ok: false, code: "MAIL_PROVIDER_UNSUPPORTED", message: t(unsupported) };
  const preset = presetFor(address);
  const host = (input.host?.trim() || preset?.host || "").toLowerCase();
  if (!host) return { ok: false, code: "MAIL_HOST_REQUIRED", message: t("认不出这个邮箱的服务器，请填写 IMAP 服务器地址（如 imap.example.com）。") };
  if (!hostAllowed(host)) return { ok: false, code: "MAIL_HOST_INVALID", message: t("服务器地址须是邮件服务器的域名。") };
  const port = input.port === 143 ? 143 : 993;
  if (!input.password.trim() || input.password.length > 200) return { ok: false, code: "MAIL_PASSWORD_REQUIRED", message: t("请填写应用专用密码或授权码。") };
  if (accounts(deps.store, workspaceId).some((account) => account.address === address)) return { ok: false, code: "MAIL_ALREADY_ADDED", message: t("这个邮箱已经接入。") };
  const mail = createImapMail({ host, port, secure: port === 993 }, address, input.password, deps.factory, deps.resolve);
  const checked = await mail.check();
  // The connector words its refusals in Chinese (keys of the catalogue): said in the account's language here.
  if (!checked.ok) return { ...checked, message: t(checked.message) };
  const id = randomUUID().slice(0, 8);
  await deps.secrets.write(workspaceId, secretName(id), input.password);
  const account: MailAccount = { id, address, label: input.label?.trim().slice(0, 40) || preset?.label || address, host, port, triage: true,
    addedAt: (deps.now?.() ?? new Date()).toISOString() };
  saveAccounts(deps.store, workspaceId, [...accounts(deps.store, workspaceId), account]);
  deps.store.appendEvent({ ownerId: ownerOf(deps.store, workspaceId), workspaceId, idempotencyKey: `mail.connected:${id}`, type: "mail.connected", entityId: id,
    payload: { host, label: account.label } });
  return { ok: true, account };
}

export function removeMailAccount(deps: MailDeps, workspaceId: string, id: string): boolean {
  const list = accounts(deps.store, workspaceId);
  if (!list.some((account) => account.id === id)) return false;
  saveAccounts(deps.store, workspaceId, list.filter((account) => account.id !== id));
  deps.secrets.remove(workspaceId, secretName(id));
  deps.store.setSetting(workspaceId, MAIL_LOG_SETTING, JSON.stringify(readMailLog(deps.store.getSetting(workspaceId, MAIL_LOG_SETTING)).filter((entry) => entry.accountId !== id)));
  deps.store.appendEvent({ ownerId: ownerOf(deps.store, workspaceId), workspaceId, idempotencyKey: `mail.removed:${id}`, type: "mail.removed", entityId: id, payload: {} });
  return true;
}

export function setMailTriage(store: CrosslineStore, workspaceId: string, id: string, on: boolean): boolean {
  const list = accounts(store, workspaceId);
  if (!list.some((account) => account.id === id)) return false;
  saveAccounts(store, workspaceId, list.map((account) => account.id === id ? { ...account, triage: on } : account));
  return true;
}

/** Whether a bank or shop mail on this account becomes a wealth record (docs/domain-lines.md); on by default, and only while sorting is on. */
export function setMailBookkeeping(store: CrosslineStore, workspaceId: string, id: string, on: boolean): boolean {
  const list = accounts(store, workspaceId);
  if (!list.some((account) => account.id === id)) return false;
  saveAccounts(store, workspaceId, list.map((account) => account.id === id ? { ...account, bookkeeping: on } : account));
  return true;
}

async function clientOf(deps: MailDeps, workspaceId: string, account: MailAccount): Promise<ImapMail | undefined> {
  const password = await deps.secrets.read(workspaceId, secretName(account.id)).catch(() => undefined);
  return password ? createImapMail({ host: account.host, port: account.port, secure: account.port === 993 }, account.address, password, deps.factory, deps.resolve) : undefined;
}

/** The mailbox for the assistant's `mail_search` / `mail_read`: every account, ids as `<account>:<uid>`. Undefined with none. */
export function mailLookupFor(deps: MailDeps, workspaceId: string): MailLookup | undefined {
  const list = accounts(deps.store, workspaceId);
  if (!list.length) return undefined;
  return {
    async search(query) {
      const found: Array<{ id: string; from: string; subject: string; date: string; snippet: string }> = [];
      for (const account of list) {
        const mail = await clientOf(deps, workspaceId, account);
        const hits = mail ? await mail.search(query).catch(() => [] as MailHeader[]) : [];
        found.push(...hits.map((hit) => ({ id: `${account.id}:${hit.uid}`, from: hit.from, subject: hit.subject, date: hit.date, snippet: hit.snippet })));
      }
      return found.sort((a, b) => b.date.localeCompare(a.date)).slice(0, query.limit ?? 15);
    },
    async read(id) {
      const [accountId, uid] = id.split(":");
      const account = list.find((item) => item.id === accountId);
      const mail = account ? await clientOf(deps, workspaceId, account) : undefined;
      const message = mail && Number(uid) > 0 ? await mail.read(Number(uid)).catch(() => undefined) : undefined;
      return message ? { id, from: message.from, to: message.to, subject: message.subject, date: message.date, text: message.text } : undefined;
    }
  };
}

export type NewMail = MailHeader & { accountId: string; uidValidity?: string };
/** New mail not sorted yet (quota, pause, a failed run): sorted with the next pass's, for three days. */
const UNSORTED_SETTING = "mail.unsorted";
const unsortedOf = (store: CrosslineStore, workspaceId: string): NewMail[] => { try { return JSON.parse(store.getSetting(workspaceId, UNSORTED_SETTING) ?? "[]") as NewMail[]; } catch { return []; } };
/** A message's key across UIDVALIDITY resets: a reused number is not taken for a message already handled. */
const mailKey = (message: NewMail) => `${message.accountId}:${message.uidValidity ?? ""}:${message.uid}`;

/**
 * Reads what arrived on every account whose check is due, records the new numbering, and hands the new headers back (for sorting and
 * for the automations). A failing account keeps its place and says why on the settings card.
 */
export async function readNewMail(deps: MailDeps, workspaceId: string, force = false): Promise<NewMail[]> {
  const now = deps.now?.() ?? new Date();
  const fresh: NewMail[] = [];
  for (const account of accounts(deps.store, workspaceId)) {
    if (!force && account.lastCheckedAt && now.getTime() - Date.parse(account.lastCheckedAt) < MAIL_CHECK_MINUTES * 60_000 - 30_000) continue;
    const mail = await clientOf(deps, workspaceId, account);
    let update: Partial<MailAccount>;
    try {
      if (!mail) throw Object.assign(new Error(tOfWorkspace(deps.store, workspaceId)("没有找到这个邮箱的密码，请移除后重新接入。")), { code: "MAIL_SECRET_MISSING" });
      const result = await mail.newSince({ ...(account.uidValidity ? { uidValidity: account.uidValidity } : {}), ...(account.lastUid ? { lastUid: account.lastUid } : {}) });
      fresh.push(...result.messages.map((message) => ({ ...message, accountId: account.id, uidValidity: result.uidValidity })));
      update = { uidValidity: result.uidValidity, lastUid: result.lastUid, lastCheckedAt: now.toISOString() };
    } catch (error) {
      update = { lastCheckedAt: now.toISOString(), lastError: { code: (error as { code?: string }).code ?? "MAIL_READ_FAILED",
        message: error instanceof Error ? tOfWorkspace(deps.store, workspaceId)(error.message).slice(0, 200) : tOfWorkspace(deps.store, workspaceId)("读取邮件失败"), at: now.toISOString() } };
    }
    // Written back over the list as it is now: the person may have removed or changed an account while the server answered.
    saveAccounts(deps.store, workspaceId, accounts(deps.store, workspaceId).map((item) => {
      if (item.id !== account.id) return item;
      const { lastError: _previous, ...rest } = item;
      return { ...rest, ...update };
    }));
  }
  return fresh;
}

/**
 * Sorts new mail on accounts where sorting is on. Returns what it did. Only the headers and opening lines go to the model; the inbox
 * lines carry the sender and subject so the analysis knows where a task came from.
 */
export async function triageMail(deps: MailDeps & { client: CodexRpcBoundary | undefined; cwd: string }, workspaceId: string, messages: NewMail[]):
  Promise<{ state: "done"; captured: number; replies: number; sorted: number; needsReply: ReplyCandidate[]; recorded: number } | { state: "skipped"; reason: string }> {
  const sorting = new Set(accounts(deps.store, workspaceId).filter((account) => account.triage).map((account) => account.id));
  const batch = messages.filter((message) => sorting.has(message.accountId)).slice(-40);
  if (!batch.length) return { state: "skipped", reason: "nothing" };
  if (!deps.client) return { state: "skipped", reason: "no_client" };
  const t = tOfWorkspace(deps.store, workspaceId);
  const waiting = deps.store.listWaitingItems(workspaceId, { state: "open" });
  const keyed = batch.map((message, index) => ({ ...message, key: index + 1 }));
  const input = {
    today: (deps.now?.() ?? new Date()).toISOString().slice(0, 10),
    lines: identityLines(deps.store, workspaceId).map((line) => ({ id: line.id, label: line.label })),
    openTasks: deps.store.listWorkOrders(workspaceId).filter((order) => !["accepted", "archived"].includes(order.state)).slice(0, 60)
      .map((order) => (order.payload as { title?: string }).title ?? order.intent.slice(0, 80)),
    waiting: waiting.map((item) => ({ id: item.id, who: item.who, title: item.title, expectedAt: item.expectedAt })),
    messages: keyed.map((message) => ({ uid: message.key, from: message.from, subject: message.subject, date: message.date, opening: message.snippet }))
  };
  const result = await runCodexSkill<MailTriage>(deps.client, input, {
    skillName: MAIL_TRIAGE_SKILL, cwd: deps.cwd, outputSchema: MAIL_TRIAGE_SCHEMA as unknown as Record<string, unknown>,
    developerInstructions: "Sort each new message once, from its sender, subject and opening. todo when it asks the person to do something or "
      + "doing nothing costs them (a deadline, a question only they can answer, an account or money alert to check); its title is the inbox line, "
      + "verb first, with the day. date for a dated event the mail asks nothing about; reply with the wait's id when the sender is who an open wait "
      + "is on, or with an empty waitingId when a real person or office waits for the person's answer by mail (a draft is written, never sent); info "
      + "for news about the person's own things that needs nothing, and for notices a service sends to all customers or about its own systems (security "
      + "advisories, incidents, CI or deploy results, terms changes) unless they name the person's own resource and a day to act; ignore for promotions, digests, cold pitches, spam and phishing. "
      + "transaction for a payment, purchase, refund, transfer or salary the mail itself states with an amount: direction, amount, currency "
      + "(ISO, e.g. CNY) and merchant exactly as the mail shows them; an unusual or unrecognised charge is todo, not transaction. Other kinds "
      + "leave direction and currency empty and amount 0.",
    // The prompt cache (docs/token-economy.md §2.5): the lines, open tasks and waits every pass shares, before this pass's mail and date.
    stableKeys: ["lines", "openTasks", "waiting"],
    prepareInput: () => input, validateOutput: (output) => validateMailTriage(output, keyed.map((message) => message.key), waiting.map((item) => item.id)),
    onAudit: () => {}, timeoutMs: 20 * 60_000
  });
  if (!result.ok) return { state: "skipped", reason: result.blocker.code };
  const at = (deps.now?.() ?? new Date()).toISOString();
  const ownerId = ownerOf(deps.store, workspaceId);
  const log: MailLogEntry[] = [];
  let captured = 0, replies = 0, recorded = 0;
  const needsReply: ReplyCandidate[] = [];
  const bookkeeping = new Set(accounts(deps.store, workspaceId).filter((account) => account.triage && account.bookkeeping !== false).map((account) => account.id));
  const wealthLine = identityLines(deps.store, workspaceId).find((line) => line.domain === "wealth")?.id;
  for (const item of result.output.items) {
    const message = keyed.find((entry) => entry.key === item.uid);
    if (!message) continue;
    let kind: MailLogEntry["kind"] = item.kind;
    if (kind === "reply" && !item.waitingId) {
      const { key: _key, ...mail } = message;
      needsReply.push({ ...mail, why: item.why });
      log.push({ accountId: message.accountId, uid: message.uid, from: message.from, subject: message.subject, date: message.date, kind: "needs_reply", title: item.why.slice(0, 140), at });
      continue;
    }
    // A mail to-do that only asks to look at something (a charge, a payment, a notice) is said once as a reminder, not planned as a task.
    if (kind === "todo" && isMailReminderTitle(item.title)) {
      const title = item.title.trim().slice(0, 120);
      // The amount the mail states is written to the bookkeeping by itself (the owner, 2026-10-27: 「上传交易记录太麻烦了，删掉，自动记录」);
      // nobody is asked to upload a statement, and it never becomes a task.
      const stated = amountsInText(`${message.subject} ${message.snippet}`)[0];
      let noted = "";
      if (stated && bookkeeping.has(message.accountId)) {
        const written = recordAndJudge(deps.store, workspaceId, ownerId, { domain: "wealth", kind: moneyDirection(`${message.subject} ${message.snippet}`),
          at: (message.date || at).slice(0, 10), value: stated.value, unit: "元", currency: stated.currency, category: item.merchant.trim().slice(0, 40),
          note: t("邮件：{{subject}}", { subject: message.subject }).slice(0, 200), source: "mail", sourceRef: mailKey(message), dedupeKey: `mail:${mailKey(message)}` },
        { lineId: wealthLine, now: deps.now?.() ?? new Date() });
        if (written.ok) { noted = t("已自动记账 {{value}} {{currency}}。", { value: stated.value, currency: stated.currency }); if (written.inserted) recorded += 1; }
      }
      sayToPerson(deps.store, workspaceId, t("邮件提醒：{{title}}。{{noted}}来自 {{from}}「{{subject}}」。不是本人操作的话在对应 App 或官网里处理，不要点邮件里的链接。", { title, noted, from: message.from, subject: message.subject.slice(0, 80) }),
        MAIL_CHECK_NUDGE_KIND, `mail-check:${mailKey(message)}`, [{ label: t("少问这类"), kind: "mute" }], deps.now?.() ?? new Date());
      log.push({ accountId: message.accountId, uid: message.uid, from: message.from, subject: message.subject, date: message.date, kind, title: title.slice(0, 140), at });
      continue;
    }
    if ((kind === "todo" || kind === "date") && captured < MAIL_INBOX_PER_PASS) {
      deps.store.capture({ id: `cap-mail-${randomUUID().slice(0, 12)}`, ownerId, workspaceId, title: item.title.trim().slice(0, 240),
        context: message.snippet
          ? tOfWorkspace(deps.store, workspaceId)("来自邮件：{{from}}「{{subject}}」（{{date}}）\n开头：{{snippet}}", { from: message.from, subject: message.subject, date: message.date.slice(0, 10), snippet: message.snippet.slice(0, 200) })
          : tOfWorkspace(deps.store, workspaceId)("来自邮件：{{from}}「{{subject}}」（{{date}}）", { from: message.from, subject: message.subject, date: message.date.slice(0, 10) }) },
      `mail:capture:${mailKey(message)}`);
      captured += 1;
    } else if (kind === "todo" || kind === "date") kind = "info";
    // A payment mail is a record only when its own subject or opening states the same amount: the model sorts, it never supplies a number.
    if (kind === "transaction") {
      const stated = amountsInText(`${message.subject} ${message.snippet}`);
      const currency = item.currency.trim().toUpperCase() === "RMB" ? "CNY" : item.currency.trim().toUpperCase();
      const confirmed = bookkeeping.has(message.accountId) && stated.some((entry) => entry.value === item.amount && (!currency || entry.currency === currency));
      if (confirmed && item.direction) {
        const written = recordAndJudge(deps.store, workspaceId, ownerId, { domain: "wealth", kind: item.direction, at: (message.date || at).slice(0, 10), value: item.amount,
          unit: "元", currency: currency || stated.find((entry) => entry.value === item.amount)!.currency, category: item.merchant.trim().slice(0, 40),
          note: tOfWorkspace(deps.store, workspaceId)("邮件：{{subject}}", { subject: message.subject }).slice(0, 200), source: "mail", sourceRef: mailKey(message), dedupeKey: `mail:${mailKey(message)}` },
        { lineId: wealthLine, now: deps.now?.() ?? new Date() });
        if (written.ok && written.inserted) recorded += 1;
      } else kind = "info";
    }
    if (kind === "reply") {
      deps.store.appendEvent({ ownerId, workspaceId, idempotencyKey: `waiting.mail_seen:${item.waitingId}:${mailKey(message)}`, type: "waiting.mail_seen",
        entityId: item.waitingId, payload: { from: message.from, subject: message.subject, date: message.date, at } });
      replies += 1;
    }
    log.push({ accountId: message.accountId, uid: message.uid, from: message.from, subject: message.subject, date: message.date, kind, title: item.title.slice(0, 140), at });
  }
  const kept = [...readMailLog(deps.store.getSetting(workspaceId, MAIL_LOG_SETTING)), ...log].slice(-MAIL_LOG_KEEP);
  deps.store.setSetting(workspaceId, MAIL_LOG_SETTING, JSON.stringify(kept));
  deps.store.appendEvent({ ownerId, workspaceId, idempotencyKey: `mail.triaged:${at}:${randomUUID().slice(0, 6)}`, type: "mail.triaged", entityId: workspaceId,
    payload: { messages: keyed.length, captured, replies, recorded } });
  return { state: "done", captured, replies, sorted: log.length, needsReply, recorded };
}

/** Messages that need a reply whose draft failed for a passing reason (the model, the quota): drafted with a later pass, for three days. */
const REPLY_QUEUE_SETTING = "mail.replyQueue";
const replyQueueOf = (store: CrosslineStore, workspaceId: string): ReplyCandidate[] => { try { return JSON.parse(store.getSetting(workspaceId, REPLY_QUEUE_SETTING) ?? "[]") as ReplyCandidate[]; } catch { return []; } };
/** Reasons a draft is not written that will not pass by themselves: such messages are not queued again. */
const FINAL_SKIPS = new Set(["already", "daily_limit", "off", "muted"]);

/**
 * The tick's pass and the supervisor's `/v1/mail*` routes. `sortAllowed` is the quota and pause check for sorting (it is intake work);
 * reading is never gated, because the automations listen to new mail whatever the quota.
 */
export function createMailService(deps: MailDeps & { cwd: string; client: (workspaceId: string) => CodexRpcBoundary | undefined;
  sortAllowed: (workspaceId: string) => Promise<boolean>; onNewMail?: (workspaceId: string, messages: NewMail[]) => void;
  /** Sorting put to-dos or dates in the inbox: the capture analysis may start now rather than at the next tick. */
  onCaptured?: (workspaceId: string) => void;
  /** Where reply drafts are written (`<dataDir>/mail-drafts/<workspace>`); without it no draft is written. */
  dataDir?: string;
  log?: (event: Record<string, unknown>) => void }) {
  const running = new Set<string>();
  const rerun = new Set<string>();
  /** When each workspace's sent folders were last looked at: no more often than new mail is read. */
  const sentCheckedAt = new Map<string, number>();
  const replyDeps = (workspaceId: string) => ({ store: deps.store, dataDir: deps.dataDir ?? "", cwd: deps.cwd, client: deps.client(workspaceId), ...(deps.now ? { now: deps.now } : {}),
    open: async (accountId: string) => {
      const account = accounts(deps.store, workspaceId).find((item) => item.id === accountId);
      const mail = account ? await clientOf(deps, workspaceId, account) : undefined;
      return account && mail ? { mail, address: account.address } : undefined;
    } });
  async function pass(workspaceId: string, force = false): Promise<{ read: number; sorted?: Awaited<ReturnType<typeof triageMail>>;
    drafts?: Awaited<ReturnType<typeof draftReplies>>; followUp?: Awaited<ReturnType<typeof followUpReplies>> }> {
    if (!accounts(deps.store, workspaceId).length) return { read: 0 };
    // A forced pass (an account connected, sorting switched on) during a running one goes right after it instead of being dropped.
    if (running.has(workspaceId)) { if (force) rerun.add(workspaceId); return { read: 0 }; }
    running.add(workspaceId);
    try {
      const fresh = await readNewMail(deps, workspaceId, force);
      if (fresh.length) { try { deps.onNewMail?.(workspaceId, fresh); } catch { /* the automations decide for themselves */ } }
      const now = (deps.now?.() ?? new Date()).getTime();
      const seen = new Set(fresh.map(mailKey));
      const list = accounts(deps.store, workspaceId);
      const known = new Set(list.map((account) => account.id));
      const sortingOn = new Set(list.filter((account) => account.triage).map((account) => account.id));
      const stored = unsortedOf(deps.store, workspaceId);
      const waiting = stored.filter((message) => known.has(message.accountId) && !seen.has(mailKey(message))
        && now - Date.parse(message.date || "1970-01-01") < 3 * 86_400_000);
      const batch = [...waiting, ...fresh].slice(-40);
      // Mail on an account with sorting off is kept unsorted too (three days, like the rest): switching sorting on sorts it at once.
      const toSort = batch.filter((message) => sortingOn.has(message.accountId));
      const sortingOff = batch.filter((message) => !sortingOn.has(message.accountId));
      const allowed = toSort.length || replyQueueOf(deps.store, workspaceId).length ? await deps.sortAllowed(workspaceId) : false;
      let sorted: Awaited<ReturnType<typeof triageMail>> | undefined;
      if (toSort.length) {
        sorted = allowed ? await triageMail({ ...deps, client: deps.client(workspaceId) }, workspaceId, toSort) : { state: "skipped" as const, reason: "quota" };
        if (sorted.state === "done" && sorted.captured) { try { deps.onCaptured?.(workspaceId); } catch { /* the analysis runs at the next intake anyway */ } }
      }
      // Kept for the next pass unless sorted.
      if (batch.length || stored.length) {
        deps.store.setSetting(workspaceId, UNSORTED_SETTING, JSON.stringify(sorted?.state === "skipped" ? batch : sortingOff));
      }
      // Drafts for what needs the person's answer: this pass's, and those a passing failure held back (three days at most).
      let drafts: Awaited<ReturnType<typeof draftReplies>> | undefined;
      const queued = replyQueueOf(deps.store, workspaceId).filter((message) => now - Date.parse(message.date || "1970-01-01") < 3 * 86_400_000);
      const candidates = [...queued, ...(sorted?.state === "done" ? sorted.needsReply : [])];
      if (deps.dataDir && candidates.length) {
        drafts = allowed ? await draftReplies(replyDeps(workspaceId), workspaceId, candidates)
          : { drafted: 0, notNeeded: 0, skipped: candidates.map((item) => ({ uid: item.uid, reason: "quota" })) };
        const retry = new Set(drafts.skipped.filter((item) => !FINAL_SKIPS.has(item.reason)).map((item) => item.uid));
        deps.store.setSetting(workspaceId, REPLY_QUEUE_SETTING, JSON.stringify(candidates.filter((item) => retry.has(item.uid)).slice(-20)));
      }
      // The follow-up needs no model: answers found in the sent folders close drafts, quiet moments let held messages out.
      let followUp: Awaited<ReturnType<typeof followUpReplies>> | undefined;
      if (deps.dataDir) {
        const checkSent = force || now - (sentCheckedAt.get(workspaceId) ?? 0) >= MAIL_CHECK_MINUTES * 60_000 - 30_000;
        if (checkSent) sentCheckedAt.set(workspaceId, now);
        followUp = await followUpReplies(replyDeps(workspaceId), workspaceId, { checkSent });
      }
      if (fresh.length || sorted || drafts || followUp?.closed || followUp?.told || followUp?.reminded) {
        deps.log?.({ type: "mail.pass", workspaceId, read: fresh.length, ...(sorted ?? {}), ...(sorted?.state === "done" ? { needsReply: sorted.needsReply.length } : {}),
          ...(drafts ? { drafts: { drafted: drafts.drafted, notNeeded: drafts.notNeeded, skipped: drafts.skipped.length } } : {}), ...(followUp ? { followUp } : {}) });
      }
      return { read: fresh.length, ...(sorted ? { sorted } : {}), ...(drafts ? { drafts } : {}), ...(followUp ? { followUp } : {}) };
    } finally {
      running.delete(workspaceId);
      if (rerun.delete(workspaceId)) void pass(workspaceId, true).catch(() => undefined);
    }
  }
  async function handle(method: string, pathname: string, workspaceId: string, body: Record<string, unknown> | undefined): Promise<{ status: number; body: unknown } | undefined> {
    if (method === "GET" && pathname === "/v1/mail") return { status: 200, body: mailView(deps.store, workspaceId) };
    if (method === "POST" && pathname === "/v1/mail/accounts") {
      const text = (key: string) => typeof body?.[key] === "string" ? (body[key] as string) : "";
      const added = await addMailAccount(deps, workspaceId, { address: text("address"), password: text("password"), host: text("host"),
        ...(typeof body?.port === "number" ? { port: body.port } : {}), label: text("label") });
      if (added.ok) void pass(workspaceId, true).catch(() => undefined);
      return { status: added.ok ? 200 : 400, body: added.ok ? { ok: true, account: added.account } : { ok: false, blocker: { code: added.code, message: added.message } } };
    }
    if (method === "POST" && pathname === "/v1/mail/check") return { status: 200, body: { ok: true, ...(await pass(workspaceId, true)) } };
    const one = /^\/v1\/mail\/accounts\/([a-z0-9-]{1,40})(\/triage|\/bookkeeping)?$/.exec(pathname);
    if (one && method === "DELETE" && !one[2]) return { status: 200, body: { ok: removeMailAccount(deps, workspaceId, one[1]!) } };
    if (one && method === "POST" && one[2] === "/triage") {
      const ok = setMailTriage(deps.store, workspaceId, one[1]!, body?.on === true);
      // Switched on: the last three days' mail is sorted now, not in up to fifteen minutes (as on connecting).
      if (ok && body?.on === true) void pass(workspaceId, true).catch(() => undefined);
      return { status: 200, body: { ok } };
    }
    if (one && method === "POST" && one[2] === "/bookkeeping") return { status: 200, body: { ok: setMailBookkeeping(deps.store, workspaceId, one[1]!, body?.on === true) } };
    return undefined;
  }
  return { pass, handle, lookup: (workspaceId: string) => mailLookupFor(deps, workspaceId) };
}
