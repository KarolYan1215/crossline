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
export type MailHeader = { uid: number; from: string; fromAddress: string; to: string; subject: string; date: string; snippet: string };
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

/** The parts of `ImapFlow` used here, so tests can stand in for a server. */
export type ImapLike = Pick<ImapFlow, "connect" | "logout" | "mailboxOpen" | "search" | "fetchAll" | "fetchOne"> & { close?: () => void };
export type ImapFactory = (options: ImapFlowOptions) => ImapLike;
const realFactory: ImapFactory = (options) => new ImapFlow(options);

async function textOf(source: Buffer | undefined): Promise<string> {
  if (!source?.length) return "";
  try {
    const parsed = await simpleParser(source, { skipImageLinks: true, skipTextToHtml: true });
    return plain(parsed.text || (typeof parsed.html === "string" ? parsed.html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ") : ""));
  } catch { return ""; }
}

export function createImapMail(server: MailServer, user: string, password: string, factory: ImapFactory = realFactory) {
  const options = (): ImapFlowOptions => ({ host: server.host, port: server.port, secure: server.secure, auth: { user, pass: password }, logger: false,
    disableAutoIdle: true, tls: { servername: server.host }, clientInfo: { name: "Crossline", version: "1" } });
  /** One connection per call, INBOX opened read-only, always logged out. */
  async function withInbox<T>(work: (client: ImapLike, box: { uidValidity: string; uidNext: number }) => Promise<T>): Promise<T> {
    const client = factory(options());
    await client.connect();
    try {
      const box = await client.mailboxOpen("INBOX", { readOnly: true });
      return await work(client, { uidValidity: String(box.uidValidity ?? ""), uidNext: Number(box.uidNext ?? 1) });
    } finally {
      await client.logout().catch(() => client.close?.());
    }
  }
  const header = async (message: Pick<FetchMessageObject, "uid" | "envelope" | "internalDate" | "source">): Promise<MailHeader> => {
    const text = await textOf(message.source);
    return { uid: message.uid, from: addressText(message.envelope?.from), fromAddress: (message.envelope?.from?.[0]?.address ?? "").toLowerCase(),
      to: addressText(message.envelope?.to), subject: (message.envelope?.subject ?? "").slice(0, 300), date: iso(message.envelope?.date ?? message.internalDate),
      snippet: text.slice(0, SNIPPET) };
  };
  const QUERY = { uid: true, envelope: true, internalDate: true, source: { start: 0, maxLength: PARTIAL_BYTES } } as const;

  return {
    /** Signs in and opens the inbox once; says why when it cannot. */
    async check(): Promise<MailCheck> {
      try { await withInbox(async () => undefined); return { ok: true }; }
      catch (error) {
        const text = error instanceof Error ? `${error.message} ${(error as { responseText?: string }).responseText ?? ""}` : String(error);
        if (/auth|login|credential|password|invalid|denied|LOGIN|AUTHENTICATIONFAILED/i.test(text) && !/ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(text)) {
          return { ok: false, code: "MAIL_AUTH_FAILED", message: "邮箱拒绝了登录：多半是没开 IMAP，或填的是登录密码而不是应用专用密码 / 授权码。" };
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
