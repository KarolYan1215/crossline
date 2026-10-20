import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ImapFlow, type FetchMessageObject, type ImapFlowOptions } from "imapflow";
import { simpleParser } from "mailparser";

/**
 * The person's mailbox, read-only (docs/personal-agent.md, 2026-10-19): IMAP with the address and an app password (Gmail with
 * two-step verification) or an authorisation code (QQ, 163, 126, Foxmail, iCloud), through the open-source `imapflow` and `mailparser`.
 * The mailbox is opened with EXAMINE (`readOnly`), so no flag ever changes — nothing is marked read, moved or deleted — and there is no
 * way to send: this module has no SMTP and no APPEND. Outlook.com and Microsoft 365 no longer take passwords over IMAP; they are named
 * as such rather than failing at login.
 */
export type MailServer = { host: string; port: number; secure: boolean };
export type MailHeader = { uid: number; from: string; fromAddress: string; to: string; subject: string; date: string; snippet: string;
  /** The message's own Message-ID and the one it answers (In-Reply-To), "" when absent: how a sent answer is matched to its message. */
  messageId?: string; inReplyTo?: string };
/** A message the person was asked to answer, as the sent-mail check looks for it. */
export type ReplyThread = { messageId: string; fromAddress: string; subject: string; date: string };
export type MailMessage = MailHeader & { text: string };
export type MailCheck = { ok: true } | { ok: false; code: "MAIL_AUTH_FAILED" | "MAIL_UNREACHABLE" | "MAIL_PROVIDER_UNSUPPORTED"; message: string };

/** Servers by the address's domain, and how to get the password each one takes. */
export const MAIL_PRESETS: Record<string, MailServer & { label: string; password: string }> = {
  "gmail.com": { host: "imap.gmail.com", port: 993, secure: true, label: "Gmail", password: "应用专用密码（Google 账号 → 安全 → 两步验证 → 应用专用密码）" },
  "googlemail.com": { host: "imap.gmail.com", port: 993, secure: true, label: "Gmail", password: "应用专用密码（Google 账号 → 安全 → 两步验证 → 应用专用密码）" },
  "qq.com": { host: "imap.qq.com", port: 993, secure: true, label: "QQ 邮箱", password: "授权码（QQ 邮箱 → 设置 → 账号 → 开启 IMAP/SMTP 服务 → 生成授权码）" },
  "foxmail.com": { host: "imap.qq.com", port: 993, secure: true, label: "Foxmail", password: "授权码（QQ 邮箱 → 设置 → 账号 → 生成授权码）" },
  "163.com": { host: "imap.163.com", port: 993, secure: true, label: "网易 163", password: "授权码（网易邮箱 → 设置 → POP3/SMTP/IMAP → 开启并生成授权码）" },
  "126.com": { host: "imap.126.com", port: 993, secure: true, label: "网易 126", password: "授权码（网易邮箱 → 设置 → POP3/SMTP/IMAP → 开启并生成授权码）" },
  "yeah.net": { host: "imap.yeah.net", port: 993, secure: true, label: "网易 yeah", password: "授权码（网易邮箱设置里生成）" },
  "icloud.com": { host: "imap.mail.me.com", port: 993, secure: true, label: "iCloud", password: "App 专用密码（appleid.apple.com → 登录与安全 → App 专用密码）" },
  "me.com": { host: "imap.mail.me.com", port: 993, secure: true, label: "iCloud", password: "App 专用密码（appleid.apple.com → App 专用密码）" },
  "yahoo.com": { host: "imap.mail.yahoo.com", port: 993, secure: true, label: "Yahoo", password: "应用密码（Yahoo 账号安全 → 生成应用密码）" },
  "sina.com": { host: "imap.sina.com", port: 993, secure: true, label: "新浪邮箱", password: "授权码（新浪邮箱设置里开启 IMAP 并生成）" },
  "aliyun.com": { host: "imap.aliyun.com", port: 993, secure: true, label: "阿里邮箱", password: "邮箱密码或授权码" }
};
/** Microsoft turned off password sign-in over IMAP for these: only OAuth works, which this connector does not do. */
const MICROSOFT = /(^|\.)(outlook\.com|hotmail\.com|live\.com|msn\.com|office365\.com)$/i;

export function mailDomain(address: string): string { return address.trim().toLowerCase().split("@")[1] ?? ""; }
export function presetFor(address: string) { return MAIL_PRESETS[mailDomain(address)]; }
export const unsupportedProvider = (address: string): string | undefined => MICROSOFT.test(mailDomain(address))
  ? "Outlook / Hotmail 已不支持用密码读取邮件（微软只允许 OAuth 登录），暂时接不了；Gmail、QQ、163、iCloud 等可以。" : undefined;

/** Only a mail server name: no IP literal, no local name, so a typed host cannot reach the server's own network. */
export function hostAllowed(host: string): boolean {
  const name = host.trim().toLowerCase();
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name) && !/^\d+(\.\d+){3}$/.test(name) && !/(^|\.)(localhost|local|internal|lan|home|corp)$/.test(name);
}

const addressText = (list: Array<{ name?: string | undefined; address?: string | undefined }> | undefined) =>
  (list ?? []).map((item) => item.name ? `${item.name} <${item.address ?? ""}>` : item.address ?? "").filter(Boolean).join(", ");
const iso = (value: Date | string | undefined) => { const date = value ? new Date(value) : undefined; return date && !Number.isNaN(date.getTime()) ? date.toISOString() : ""; };
const plain = (text: string) => text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ").trim();
const SNIPPET = 300;
const PARTIAL_BYTES = 48_000;
const FULL_BYTES = 2_000_000;

/** IMAP over TLS or STARTTLS only: a typed port cannot point the worker at another service on some host. */
export const MAIL_PORTS = [993, 143] as const;

/** A loopback, private, link-local or otherwise non-public address (IPv4 and IPv6, including IPv4-mapped). */
export function privateAddress(address: string): boolean {
  const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/i.exec(address);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v6 = address.toLowerCase();
  return v6 === "::" || v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80") || v6.startsWith("ff");
}
/** The host's first address when every address it resolves to is public; undefined otherwise (no reaching the server's own network). */
export async function publicAddressOf(host: string): Promise<string | undefined> {
  if (isIP(host)) return undefined;
  const found = await lookup(host, { all: true }).catch(() => []);
  return found.length && found.every((entry) => !privateAddress(entry.address)) ? found[0]!.address : undefined;
}

/** The parts of `ImapFlow` used here, so tests can stand in for a server. */
export type ImapLike = Pick<ImapFlow, "connect" | "logout" | "mailboxOpen" | "search" | "fetchAll" | "fetchOne"> & { close?: () => void;
  on?: (event: "error", listener: (error: unknown) => void) => unknown;
  /** The folder list, for finding the sent folder (optional: a stand-in without it has no sent folder). */
  list?: () => Promise<Array<{ path: string; specialUse?: string | undefined; flags?: Set<string> | undefined }>> };
export type ImapFactory = (options: ImapFlowOptions) => ImapLike;
const realFactory: ImapFactory = (options) => new ImapFlow(options);

async function textOf(source: Buffer | undefined): Promise<string> {
  if (!source?.length) return "";
  try {
    const parsed = await simpleParser(source, { skipImageLinks: true, skipTextToHtml: true });
    return plain(parsed.text || (typeof parsed.html === "string" ? parsed.html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ") : ""));
  } catch { return ""; }
}

/**
 * Why a sign-in was refused, in words the person can act on. Gmail says which of three things went wrong in its response text: its normal
 * password used where an app password is needed, a sign-in from a new place held until the person confirms it in a browser, or an app
 * password that does not match; the generic line stays for every other server.
 */
export function signInRefusal(text: string, host: string): string {
  const gmail = /(^|\.)gmail\.com$|googlemail\.com$/i.test(host);
  if (/application-specific password required/i.test(text)) return "Gmail 要求应用专用密码，填的是 Google 登录密码。先开两步验证，再到 myaccount.google.com/apppasswords 生成一个 16 位密码填进来。";
  if (/WEBALERT|log ?in via your web browser|web login required/i.test(text)) return "Gmail 拦下了这次登录（来自新的地点）。在浏览器里登录一次 Gmail，按提示确认是你本人，然后再接入。";
  if (gmail) return "Gmail 不认这个密码：要用 16 位的应用专用密码（myaccount.google.com/apppasswords 生成），不是 Google 登录密码；复制时空格可以带着。";
  return "邮箱拒绝了登录：多半是没开 IMAP，或填的是登录密码而不是应用专用密码 / 授权码。";
}

/** The sent folder: its special-use flag (RFC 6154), else one of the usual names. */
async function sentFolder(client: ImapLike): Promise<string | undefined> {
  const folders = await client.list?.().catch(() => []) ?? [];
  return folders.find((folder) => folder.specialUse === "\\Sent" || folder.flags?.has("\\Sent"))?.path
    ?? folders.find((folder) => /^(sent|sent items|sent messages|sent mail|\[gmail\]\/sent mail|已发送|已发送邮件)$/i.test(folder.path))?.path;
}

/** A subject without its reply and forward prefixes, for matching a sent answer to the message it answers. */
export function bareSubject(subject: string): string {
  let text = subject.trim();
  for (let i = 0; i < 5; i += 1) {
    const next = text.replace(/^(re|fw|fwd|aw|回复|答复|转发)\s*[:：]\s*/i, "");
    if (next === text) break;
    text = next;
  }
  return text.replace(/\s+/g, " ").toLowerCase();
}

export function createImapMail(server: MailServer, user: string, rawPassword: string, factory: ImapFactory = realFactory,
  resolve: (host: string) => Promise<string | undefined> = publicAddressOf) {
  // Google shows an app password as four groups of four letters; the spaces are not part of it.
  const password = /(^|\.)gmail\.com$|googlemail\.com$/i.test(server.host) ? rawPassword.replace(/\s+/g, "") : rawPassword;
  /**
   * One connection per call, INBOX opened read-only, always logged out. The host is resolved first and the connection made to that
   * checked public address (the certificate still checked against the name), so a name pointing inside cannot be used to probe it.
   */
  async function withInbox<T>(work: (client: ImapLike, box: { uidValidity: string; uidNext: number }) => Promise<T>): Promise<T> {
    return withBox(async () => "INBOX", work);
  }
  /**
   * One connection per call to the folder `choose` names (opened read-only, EXAMINE, like the inbox; nothing is ever written to it). A
   * `choose` answering undefined opens nothing and hands `work` no box.
   */
  async function withBox<T>(choose: (client: ImapLike) => Promise<string | undefined>,
    work: (client: ImapLike, box: { uidValidity: string; uidNext: number }) => Promise<T>, none?: () => T): Promise<T> {
    if (!(MAIL_PORTS as readonly number[]).includes(server.port)) throw Object.assign(new Error("只接受 993 或 143 端口"), { code: "MAIL_PORT_INVALID" });
    const address = await resolve(server.host);
    if (!address) throw Object.assign(new Error("服务器地址解析不到公开地址"), { code: "MAIL_HOST_INVALID" });
    const client = factory({ host: address, port: server.port, secure: server.secure, auth: { user, pass: password }, logger: false,
      disableAutoIdle: true, tls: { servername: server.host }, clientInfo: { name: "Crossline", version: "1" } });
    // ImapFlow emits 'error' after connecting (a socket error, a command timing out); with no listener that would end the worker.
    client.on?.("error", () => undefined);
    await client.connect();
    try {
      const folder = await choose(client);
      if (!folder) return none ? none() : Promise.reject(Object.assign(new Error("没有这个文件夹"), { code: "MAIL_FOLDER_MISSING" }));
      const box = await client.mailboxOpen(folder, { readOnly: true });
      return await work(client, { uidValidity: String(box.uidValidity ?? ""), uidNext: Number(box.uidNext ?? 1) });
    } finally {
      await client.logout().catch(() => client.close?.());
    }
  }
  const header = async (message: Pick<FetchMessageObject, "uid" | "envelope" | "internalDate" | "source">): Promise<MailHeader> => {
    const text = await textOf(message.source);
    return { uid: message.uid, from: addressText(message.envelope?.from), fromAddress: (message.envelope?.from?.[0]?.address ?? "").toLowerCase(),
      to: addressText(message.envelope?.to), subject: (message.envelope?.subject ?? "").slice(0, 300), date: iso(message.envelope?.date ?? message.internalDate),
      snippet: text.slice(0, SNIPPET), messageId: message.envelope?.messageId ?? "", inReplyTo: message.envelope?.inReplyTo ?? "" };
  };
  const QUERY = { uid: true, envelope: true, internalDate: true, source: { start: 0, maxLength: PARTIAL_BYTES } } as const;

  return {
    /** Signs in and opens the inbox once; says why when it cannot. */
    async check(): Promise<MailCheck> {
      try { await withInbox(async () => undefined); return { ok: true }; }
      catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "MAIL_HOST_INVALID" || code === "MAIL_PORT_INVALID") return { ok: false, code: "MAIL_UNREACHABLE", message: (error as Error).message };
        // imapflow puts the server's own words in `response` (a string after a refused LOGIN), its code in `serverResponseCode`.
        const detail = error as { responseText?: string; response?: unknown; serverResponseCode?: string; authenticationFailed?: boolean };
        const text = error instanceof Error ? [error.message, detail.responseText, typeof detail.response === "string" ? detail.response : "", detail.serverResponseCode]
          .filter(Boolean).join(" ") : String(error);
        if (detail.authenticationFailed || (/auth|login|credential|password|invalid|denied|LOGIN|AUTHENTICATIONFAILED/i.test(text) && !/ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(text))) {
          return { ok: false, code: "MAIL_AUTH_FAILED", message: signInRefusal(text, server.host) };
        }
        return { ok: false, code: "MAIL_UNREACHABLE", message: "连不上邮箱服务器，请检查服务器地址。" };
      }
    },

    /**
     * Messages that arrived after `lastUid` (at most `limit`, newest kept). A changed UIDVALIDITY means the numbering restarted: then only
     * the last `sinceDays` days count, as on first connection.
     */
    async newSince(state: { uidValidity?: string; lastUid?: number }, limit = 30, sinceDays = 3): Promise<{ uidValidity: string; lastUid: number; messages: MailHeader[] }> {
      return withInbox(async (client, box) => {
        const fresh = !state.lastUid || state.uidValidity !== box.uidValidity;
        const uids = fresh
          ? ((await client.search({ since: new Date(Date.now() - sinceDays * 86_400_000) }, { uid: true })) || [])
          : ((await client.search({ uid: `${state.lastUid! + 1}:*` }, { uid: true })) || []).filter((uid) => uid > state.lastUid!);
        const take = [...uids].sort((a, b) => a - b).slice(-limit);
        const lastUid = Math.max(state.lastUid && !fresh ? state.lastUid : 0, box.uidNext - 1, ...take);
        if (!take.length) return { uidValidity: box.uidValidity, lastUid, messages: [] };
        const fetched = await client.fetchAll(take, QUERY, { uid: true });
        const messages = await Promise.all(fetched.map(header));
        return { uidValidity: box.uidValidity, lastUid, messages: messages.sort((a, b) => a.uid - b.uid) };
      });
    },

    /** Newest first: words in the subject or text, part of the sender, within the last days. */
    async search(query: { text?: string; from?: string; sinceDays?: number; limit?: number }): Promise<MailHeader[]> {
      return withInbox(async (client) => {
        const where = { ...(query.text ? { or: [{ subject: query.text }, { text: query.text }] } : {}), ...(query.from ? { from: query.from } : {}),
          since: new Date(Date.now() - (query.sinceDays ?? 30) * 86_400_000) };
        const uids = ((await client.search(where, { uid: true })) || []).sort((a, b) => b - a).slice(0, Math.min(30, query.limit ?? 15));
        if (!uids.length) return [];
        const fetched = await client.fetchAll(uids, QUERY, { uid: true });
        return (await Promise.all(fetched.map(header))).sort((a, b) => b.uid - a.uid);
      });
    },

    /**
     * Which of `threads` the person has answered: the sent folder (its special-use flag, else a usual name) is opened read-only and its
     * messages since the oldest thread are matched by In-Reply-To, or by recipient and subject without its 「Re:」. Returns the matched
     * threads' Message-IDs (or `fromAddress|subject` when a thread has none). No sent folder: nothing matched.
     */
    async sentReplies(threads: ReplyThread[]): Promise<string[]> {
      if (!threads.length) return [];
      const since = new Date(Math.min(...threads.map((thread) => Date.parse(thread.date) || Date.now())) - 86_400_000);
      return withBox(sentFolder, async (client) => {
        const uids = ((await client.search({ since }, { uid: true })) || []).sort((a, b) => b - a).slice(0, 200);
        if (!uids.length) return [];
        const sent = await client.fetchAll(uids, { uid: true, envelope: true }, { uid: true });
        const matched: string[] = [];
        for (const thread of threads) {
          const key = thread.messageId || `${thread.fromAddress}|${thread.subject}`;
          const subject = bareSubject(thread.subject);
          if (sent.some((message) => (thread.messageId && message.envelope?.inReplyTo === thread.messageId)
            || ((message.envelope?.to ?? []).some((to) => (to.address ?? "").toLowerCase() === thread.fromAddress) && subject && bareSubject(message.envelope?.subject ?? "") === subject))) {
            matched.push(key);
          }
        }
        return matched;
      }, () => []);
    },

    /** One message's text (up to 2 MB of source read), without marking it read. */
    async read(uid: number): Promise<MailMessage | undefined> {
      return withInbox(async (client) => {
        const message = await client.fetchOne(String(uid), { uid: true, envelope: true, internalDate: true, source: { start: 0, maxLength: FULL_BYTES } }, { uid: true });
        if (!message) return undefined;
        const head = await header(message);
        return { ...head, text: await textOf(message.source) };
      });
    }
  };
}
export type ImapMail = ReturnType<typeof createImapMail>;
