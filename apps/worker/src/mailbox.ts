import { randomUUID } from "node:crypto";
import {
  MAIL_ACCOUNTS_SETTING, MAIL_CHECK_MINUTES, MAIL_INBOX_PER_PASS, MAIL_LOG_KEEP, MAIL_LOG_SETTING, MAIL_TRIAGE_SCHEMA, readMailAccounts, readMailLog,
  validateMailTriage, type MailAccount, type MailLogEntry, type MailTriage
} from "@crossline/core";
import {
  createImapMail, hostAllowed, presetFor, unsupportedProvider, type ImapFactory, type ImapMail, type MailHeader, type SecretStore
} from "@crossline/connectors";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";
import type { MailLookup } from "./agent-tools";
import { identityLines } from "./lines";
import { ownerOf } from "./owner";

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

/** What the settings card shows: the accounts (no password), and what sorting did lately. */
export function mailView(store: CrosslineStore, workspaceId: string) {
  return { accounts: accounts(store, workspaceId), log: readMailLog(store.getSetting(workspaceId, MAIL_LOG_SETTING)).slice(-30).reverse() };
}

/** Signs in once with what the person typed; kept only when it works. */
export async function addMailAccount(deps: MailDeps, workspaceId: string, input: { address: string; password: string; host?: string; port?: number; label?: string }):
  Promise<{ ok: true; account: MailAccount } | { ok: false; code: string; message: string }> {
  const address = input.address.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return { ok: false, code: "MAIL_ADDRESS_INVALID", message: "邮箱地址格式不对。" };
  const unsupported = unsupportedProvider(address);
  if (unsupported) return { ok: false, code: "MAIL_PROVIDER_UNSUPPORTED", message: unsupported };
  const preset = presetFor(address);
  const host = (input.host?.trim() || preset?.host || "").toLowerCase();
  if (!host) return { ok: false, code: "MAIL_HOST_REQUIRED", message: "认不出这个邮箱的服务器，请填写 IMAP 服务器地址（如 imap.example.com）。" };
  if (!hostAllowed(host)) return { ok: false, code: "MAIL_HOST_INVALID", message: "服务器地址须是邮件服务器的域名。" };
  const port = input.port === 143 ? 143 : 993;
  if (!input.password.trim() || input.password.length > 200) return { ok: false, code: "MAIL_PASSWORD_REQUIRED", message: "请填写应用专用密码或授权码。" };
  if (accounts(deps.store, workspaceId).some((account) => account.address === address)) return { ok: false, code: "MAIL_ALREADY_ADDED", message: "这个邮箱已经接入。" };
  const mail = createImapMail({ host, port, secure: port === 993 }, address, input.password, deps.factory, deps.resolve);
  const checked = await mail.check();
  if (!checked.ok) return checked;
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
      if (!mail) throw Object.assign(new Error("没有找到这个邮箱的密码，请移除后重新接入。"), { code: "MAIL_SECRET_MISSING" });
      const result = await mail.newSince({ ...(account.uidValidity ? { uidValidity: account.uidValidity } : {}), ...(account.lastUid ? { lastUid: account.lastUid } : {}) });
      fresh.push(...result.messages.map((message) => ({ ...message, accountId: account.id, uidValidity: result.uidValidity })));
      update = { uidValidity: result.uidValidity, lastUid: result.lastUid, lastCheckedAt: now.toISOString() };
    } catch (error) {
      update = { lastCheckedAt: now.toISOString(), lastError: { code: (error as { code?: string }).code ?? "MAIL_READ_FAILED",
        message: error instanceof Error ? error.message.slice(0, 200) : "读取邮件失败", at: now.toISOString() } };
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
  Promise<{ state: "done"; captured: number; replies: number; sorted: number } | { state: "skipped"; reason: string }> {
  const sorting = new Set(accounts(deps.store, workspaceId).filter((account) => account.triage).map((account) => account.id));
  const batch = messages.filter((message) => sorting.has(message.accountId)).slice(-40);
  if (!batch.length) return { state: "skipped", reason: "nothing" };
  if (!deps.client) return { state: "skipped", reason: "no_client" };
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
    developerInstructions: "Sort each new message once. Use todo only for something the person must do themselves, date only for a dated event or deadline they should keep, reply only when the sender is the one an open wait is on. Everything else is info or ignore.",
    prepareInput: () => input, validateOutput: (output) => validateMailTriage(output, keyed.map((message) => message.key), waiting.map((item) => item.id)),
    onAudit: () => {}, timeoutMs: 20 * 60_000
  });
  if (!result.ok) return { state: "skipped", reason: result.blocker.code };
  const at = (deps.now?.() ?? new Date()).toISOString();
  const ownerId = ownerOf(deps.store, workspaceId);
  const log: MailLogEntry[] = [];
  let captured = 0, replies = 0;
  for (const item of result.output.items) {
    const message = keyed.find((entry) => entry.key === item.uid);
    if (!message) continue;
    let kind = item.kind;
    if ((kind === "todo" || kind === "date") && captured < MAIL_INBOX_PER_PASS) {
      deps.store.capture({ id: `cap-mail-${randomUUID().slice(0, 12)}`, ownerId, workspaceId, title: item.title.trim().slice(0, 240),
        context: `来自邮件：${message.from}「${message.subject}」（${message.date.slice(0, 10)}）${message.snippet ? `\n开头：${message.snippet.slice(0, 200)}` : ""}` },
      `mail:capture:${mailKey(message)}`);
      captured += 1;
    } else if (kind === "todo" || kind === "date") kind = "info";
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
    payload: { messages: keyed.length, captured, replies } });
  return { state: "done", captured, replies, sorted: log.length };
}

/**
 * The tick's pass and the supervisor's `/v1/mail*` routes. `sortAllowed` is the quota and pause check for sorting (it is intake work);
 * reading is never gated, because the automations listen to new mail whatever the quota.
 */
export function createMailService(deps: MailDeps & { cwd: string; client: (workspaceId: string) => CodexRpcBoundary | undefined;
  sortAllowed: (workspaceId: string) => Promise<boolean>; onNewMail?: (workspaceId: string, messages: NewMail[]) => void;
  log?: (event: Record<string, unknown>) => void }) {
  const running = new Set<string>();
  async function pass(workspaceId: string, force = false): Promise<{ read: number; sorted?: Awaited<ReturnType<typeof triageMail>> }> {
    if (running.has(workspaceId) || !accounts(deps.store, workspaceId).length) return { read: 0 };
    running.add(workspaceId);
    try {
      const fresh = await readNewMail(deps, workspaceId, force);
      if (fresh.length) { try { deps.onNewMail?.(workspaceId, fresh); } catch { /* the automations decide for themselves */ } }
      const now = (deps.now?.() ?? new Date()).getTime();
      const seen = new Set(fresh.map(mailKey));
      const waiting = unsortedOf(deps.store, workspaceId).filter((message) => !seen.has(mailKey(message)) && now - Date.parse(message.date || "1970-01-01") < 3 * 86_400_000);
      const batch = [...waiting, ...fresh].slice(-40);
      if (!batch.length) return { read: 0 };
      const sorted = await deps.sortAllowed(workspaceId) ? await triageMail({ ...deps, client: deps.client(workspaceId) }, workspaceId, batch) : { state: "skipped" as const, reason: "quota" };
      // Kept for the next pass unless sorted (or there was nothing to sort on these accounts).
      deps.store.setSetting(workspaceId, UNSORTED_SETTING, JSON.stringify(sorted.state === "done" || sorted.reason === "nothing" ? [] : batch));
      deps.log?.({ type: "mail.pass", workspaceId, read: fresh.length, ...sorted });
      return { read: fresh.length, sorted };
    } finally { running.delete(workspaceId); }
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
    const one = /^\/v1\/mail\/accounts\/([a-z0-9-]{1,40})(\/triage)?$/.exec(pathname);
    if (one && method === "DELETE" && !one[2]) return { status: 200, body: { ok: removeMailAccount(deps, workspaceId, one[1]!) } };
    if (one && method === "POST" && one[2]) return { status: 200, body: { ok: setMailTriage(deps.store, workspaceId, one[1]!, body?.on === true) } };
    return undefined;
  }
  return { pass, handle, lookup: (workspaceId: string) => mailLookupFor(deps, workspaceId) };
}
