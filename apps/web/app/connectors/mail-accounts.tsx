"use client";
import { useEffect, useState } from "react";
import { appPasswordPage, MAIL_TRIAGE_KIND_LABEL, type AppPasswordPage, type MailAccount, type MailLogEntry } from "@crossline/core";
import { closeDraft, copyDraft } from "../materials/view/mail-draft-actions";
import { SetupGuide } from "../ui/setup-guide";
import { MAIL_GUIDE, mailGuideId } from "../../lib/setup-guides";

type ReplyView = { id: string; from: string; subject: string; why: string; points: string[]; replyBy: string; createdAt: string;
  state: "open" | "replied" | "dismissed"; closedBy?: "person" | "sent_found" };
/** `unsorted`: new messages read but not yet sorted (sorting off, or waiting for quota), when the worker reports them. */
export type MailAccountView = MailAccount & { unsorted?: number };
type View = { accounts: MailAccountView[]; log: MailLogEntry[]; replies?: { on: boolean; recent: ReplyView[] } };
const REPLY_STATE: Record<ReplyView["state"], string> = { open: "待回复", replied: "已回复", dismissed: "不用回" };
const draftHref = (id: string) => `/materials/view?src=${encodeURIComponent(`/api/mail/drafts/${id}/file`)}&name=${encodeURIComponent("回复草稿.md")}`;
const post = (url: string, body: unknown, method = "POST") => fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then(async (response) => ({ ok: response.ok, body: await response.json().catch(() => ({})) as Record<string, unknown> })).catch(() => ({ ok: false, body: {} as Record<string, unknown> }));
const ago = (at: string | undefined) => {
  if (!at) return "还没读过";
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 60_000));
  return minutes < 1 ? "刚刚读过" : minutes < 60 ? `${minutes} 分钟前读过` : minutes < 1440 ? `${Math.round(minutes / 60)} 小时前读过` : `${Math.round(minutes / 1440)} 天前读过`;
};

/**
 * What one mailbox's row says (2026-10-21: an owner had connected their Gmail under a test account and never noticed): when it was last
 * read, why the last read failed, and how many new messages wait while sorting is off. Pure, so it is tested without a page.
 */
export function mailAccountStatus(account: MailAccountView): { read: string; error?: string; waiting?: string } {
  const waiting = account.unsorted ?? 0;
  return { read: ago(account.lastCheckedAt),
    ...(account.lastError ? { error: `最近一次读取失败：${account.lastError.message}` } : {}),
    ...(waiting > 0 ? { waiting: account.triage ? `${waiting} 封新邮件等待整理` : `自动整理已关闭：${waiting} 封新邮件未整理，打开后补上` } : {}) };
}

/** The way to the provider's app-password page, opened in a new tab so the half-filled form stays where it is. */
export function AppPasswordLink({ page, label }: { page: AppPasswordPage; label: string }) {
  return <span className="mail-app-password">
    <a className="secondary-button" href={page.url} target="_blank" rel="noopener noreferrer">{label}</a>
    <a href={page.setupUrl} target="_blank" rel="noopener noreferrer">{page.setupLabel}</a>
  </span>;
}

/**
 * 邮箱 (docs/personal-agent.md, 2026-10-19): a mailbox read over IMAP with an app password or authorisation code, read-only — nothing is
 * marked read, moved, deleted or sent. New mail is read every quarter hour; with sorting on, to-dos and dates go into the inbox and a reply
 * someone was waiting for brings that wait forward. The assistant and the automations can search and read it.
 */
export function MailAccounts({ accountEmail }: {
  /** The Crossline account the mailboxes are connected under, said on the card so a mailbox is not connected under the wrong one. */
  accountEmail?: string | undefined } = {}) {
  const [view, setView] = useState<View | undefined>();
  const [address, setAddress] = useState("");
  const [password, setPassword] = useState("");
  const [host, setHost] = useState("");
  const [showHost, setShowHost] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  // Set when the last attempt was refused for its password, so the way to make one stays beside the message.
  const [refused, setRefused] = useState(false);
  const typedPage = appPasswordPage(address);
  const provider = mailGuideId(address);
  const load = async () => {
    const response = await fetch("/api/mail", { cache: "no-store" }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as View | undefined;
    setView(body?.accounts ? body : { accounts: [], log: [] });
  };
  useEffect(() => { void load(); }, []);
  const add = async () => {
    setBusy(true); setMessage(""); setRefused(false);
    const result = await post("/api/mail/accounts", { address, password, host });
    const blocker = result.body.blocker as { code?: string; message?: string } | undefined;
    if (result.ok && result.body.ok) { setAddress(""); setPassword(""); setHost(""); setMessage("已接入，正在读最近三天的邮件；以后每 15 分钟看一次新邮件。"); }
    else {
      setMessage(blocker?.message ?? "没能接入，稍后再试。");
      if (blocker?.code === "MAIL_HOST_REQUIRED") setShowHost(true);
      if (blocker?.code === "MAIL_AUTH_FAILED") setRefused(true);
    }
    await load(); setBusy(false);
  };
  const remove = async (account: MailAccount) => {
    if (!window.confirm(`移除 ${account.address}？Crossline 不再读取这个邮箱，保存的授权码一并删除。`)) return;
    setBusy(true);
    const result = await post(`/api/mail/accounts/${account.id}`, {}, "DELETE");
    setMessage(result.ok ? "已移除，授权码已删除。" : "没能移除，稍后再试。");
    await load(); setBusy(false);
  };
  const triage = async (account: MailAccount, on: boolean) => {
    setBusy(true);
    await post(`/api/mail/accounts/${account.id}`, { triage: on });
    await load(); setBusy(false);
  };
  const bookkeeping = async (account: MailAccount, on: boolean) => {
    setBusy(true);
    await post(`/api/mail/accounts/${account.id}`, { bookkeeping: on });
    await load(); setBusy(false);
  };
  const drafting = async (on: boolean) => {
    setBusy(true);
    const result = await post("/api/mail/replies", { on });
    if (!result.ok) setMessage("没能保存，稍后再试。");
    await load(); setBusy(false);
  };
  const closeReply = async (reply: ReplyView, how: "replied" | "dismissed") => {
    setBusy(true);
    const ok = await closeDraft(reply.id, how);
    if (!ok) setMessage("没能记下，稍后再试。");
    await load(); setBusy(false);
  };
  const copyReply = async (reply: ReplyView) => setMessage(await copyDraft(reply.id) ? `已复制回复「${reply.subject || "无主题"}」的草稿正文。` : "没能复制，请打开草稿后手动复制。");
  const check = async () => {
    setBusy(true); setMessage("正在读新邮件…");
    const result = await post("/api/mail/check", {});
    const read = Number(result.body.read ?? 0);
    setMessage(!result.ok ? "没读成，稍后再试。" : read ? `读到 ${read} 封新邮件。` : "没有新邮件。");
    await load(); setBusy(false);
  };

  return <section className="st-card mail-accounts" aria-label="邮箱">
    <header><h3>邮箱（只读）</h3><small>用应用专用密码或授权码接入；只读不写：不标已读、不移动、不删除、不发信</small></header>
    {accountEmail && <p className="mail-owner" data-user-text>{view?.accounts.length
      ? `以下 ${view.accounts.length} 个邮箱接在当前登录账号 ${accountEmail} 下；用别的账号登录时看不到它们。`
      : `接入的邮箱归当前登录账号 ${accountEmail} 所有；用别的账号登录时看不到。`}</p>}
    {view?.accounts.map((account) => <div className="st-row" key={account.id}>
      <span className="st-row-label">{account.address}
        <small>{account.label} · {mailAccountStatus(account).read}{account.triage ? " · 自动整理开启" : " · 自动整理关闭"}</small>
        {mailAccountStatus(account).error && <small className="st-fail">{mailAccountStatus(account).error}</small>}
        {mailAccountStatus(account).waiting && <small>{mailAccountStatus(account).waiting}</small>}
        {account.lastError?.code === "MAIL_AUTH_FAILED" && appPasswordPage(account.address)
          && <small>应用专用密码失效时：生成一个新的，移除这个邮箱后用新密码重新接入。<AppPasswordLink page={appPasswordPage(account.address)!} label="生成新的应用专用密码" /></small>}</span>
      <label className="st-inline"><input type="checkbox" checked={account.triage} disabled={busy} onChange={(event) => void triage(account, event.target.checked)} /> 自动整理新邮件</label>
      <label className="st-inline" title="银行与商家的提醒邮件记为财富主线的收支记录；只记邮件原文写明金额的">
        <input type="checkbox" checked={account.triage && account.bookkeeping !== false} disabled={busy || !account.triage} onChange={(event) => void bookkeeping(account, event.target.checked)} /> 自动记账</label>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => void remove(account)}>移除</button>
    </div>)}
    {Boolean(view?.accounts.length) && <button type="button" className="secondary-button" disabled={busy} onClick={() => void check()}>现在读新邮件</button>}
    {Boolean(view?.accounts.length) && <div className="st-row">
      <span className="st-row-label">需要回复的邮件，先起草再提醒我
        <small>助手起草一封回复存为文件，再告诉本人谁来信、为什么要回、草稿要点；不会发送，由本人确认后自己发。每个邮箱每天最多 5 封，夜里和忙时不提醒。</small></span>
      <label className="st-inline"><input type="checkbox" checked={view?.replies?.on ?? true} disabled={busy} onChange={(event) => void drafting(event.target.checked)} /> 开启</label>
    </div>}
    {Boolean(view?.replies?.recent.length) && <details className="st-fold" open={view!.replies!.recent.some((reply) => reply.state === "open")}>
      <summary>最近起草的回复</summary>
      <ul className="st-list">{view!.replies!.recent.map((reply) => <li key={reply.id}>
        <span>{REPLY_STATE[reply.state]}{reply.closedBy === "sent_found" ? "（在已发送里找到）" : ""} · {reply.subject || "（无主题）"}</span>
        <small>{reply.from} · {reply.why}{reply.replyBy ? ` · 希望 ${reply.replyBy} 前答复` : ""}</small>
        <span className="mail-reply-actions">
          <a className="secondary-button" href={draftHref(reply.id)}>看草稿</a>
          <button type="button" className="secondary-button" disabled={busy} onClick={() => void copyReply(reply)}>复制草稿</button>
          {reply.state === "open" && <>
            <button type="button" className="secondary-button" disabled={busy} onClick={() => void closeReply(reply, "replied")}>已回复</button>
            <button type="button" className="text-button" disabled={busy} onClick={() => void closeReply(reply, "dismissed")}>不用回</button>
          </>}
        </span>
      </li>)}</ul>
    </details>}
    {/* Each field says what goes in it above the box, in full: a hint kept only in the placeholder was cut off at the box's width. */}
    <form className="mail-accounts-form" onSubmit={(event) => { event.preventDefault(); if (address && password) void add(); }}>
      <label className="mail-field"><span>邮箱地址</span>
        <input type="email" value={address} onChange={(event) => setAddress(event.target.value)} placeholder="name@qq.com" disabled={busy} autoComplete="off" />
        <small>完整地址，如 name@gmail.com、12345@qq.com</small></label>
      <label className="mail-field"><span>应用专用密码或授权码</span>
        <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} autoComplete="new-password" />
        <small>{provider === "gmail" ? "Google 生成的 16 位应用专用密码，不是 Google 登录密码"
          : provider === "icloud" ? "Apple 账户里生成的 App 专用密码，不是 Apple 账户密码"
            : provider === "other" ? "企业邮箱的客户端专用密码；没有这项要求的填邮箱密码"
              : "在邮箱设置里开启 IMAP 后生成的授权码，不是登录密码"}</small></label>
      {showHost && <label className="mail-field"><span>IMAP 服务器</span>
        <input type="text" value={host} onChange={(event) => setHost(event.target.value)} placeholder="imap.example.com" disabled={busy} />
        <small>向管理员或邮箱帮助页确认的服务器地址，只填域名</small></label>}
      <button type="submit" className="primary-button" disabled={busy || !address || !password || provider === "outlook"}>{busy ? "连接中…" : "接入"}</button>
    </form>
    {provider === "outlook" && <p role="status" className="st-note">Outlook、Hotmail 与 Microsoft 365 邮箱已不允许用密码读取，暂时接不了；可以用转发接入，步骤见下方教程的「Outlook / Hotmail / 组织邮箱」一栏。</p>}
    {typedPage && <div className="mail-app-password-help">
      <AppPasswordLink page={typedPage} label={`去 Google 生成${refused ? "新的" : ""}应用专用密码`} />
      <small>{typedPage.hint}</small>
    </div>}
    <SetupGuide guide={MAIL_GUIDE} selected={provider} {...(view ? { open: view.accounts.length === 0 || refused } : {})} />
    {message && <p role="status" className="muted">{message}</p>}
    {Boolean(view?.log.length) && <details className="st-fold"><summary>最近整理的邮件</summary>
      <ul className="st-list">{view!.log.map((entry) => <li key={`${entry.accountId}:${entry.uid}`}>
        <span>{MAIL_TRIAGE_KIND_LABEL[entry.kind]} · {entry.subject || "（无主题）"}</span>
        <small>{entry.from}{entry.title ? ` → ${entry.title}` : ""}</small>
      </li>)}</ul>
    </details>}
  </section>;
}
