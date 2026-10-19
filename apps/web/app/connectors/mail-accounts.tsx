"use client";
import { useEffect, useState } from "react";
import { MAIL_TRIAGE_KIND_LABEL, type MailAccount, type MailLogEntry } from "@crossline/core";

type View = { accounts: MailAccount[]; log: MailLogEntry[] };
const post = (url: string, body: unknown, method = "POST") => fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then(async (response) => ({ ok: response.ok, body: await response.json().catch(() => ({})) as Record<string, unknown> })).catch(() => ({ ok: false, body: {} as Record<string, unknown> }));
const ago = (at: string | undefined) => {
  if (!at) return "还没读过";
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 60_000));
  return minutes < 1 ? "刚刚读过" : minutes < 60 ? `${minutes} 分钟前读过` : minutes < 1440 ? `${Math.round(minutes / 60)} 小时前读过` : `${Math.round(minutes / 1440)} 天前读过`;
};

/**
 * 邮箱 (docs/personal-agent.md, 2026-10-19): a mailbox read over IMAP with an app password or authorisation code, read-only — nothing is
 * marked read, moved, deleted or sent. New mail is read every quarter hour; with sorting on, to-dos and dates go into the inbox and a reply
 * someone was waiting for brings that wait forward. The assistant and the automations can search and read it.
 */
export function MailAccounts() {
  const [view, setView] = useState<View | undefined>();
  const [address, setAddress] = useState("");
  const [password, setPassword] = useState("");
  const [host, setHost] = useState("");
  const [showHost, setShowHost] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const load = async () => {
    const response = await fetch("/api/mail", { cache: "no-store" }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as View | undefined;
    setView(body?.accounts ? body : { accounts: [], log: [] });
  };
  useEffect(() => { void load(); }, []);
  const add = async () => {
    setBusy(true); setMessage("");
    const result = await post("/api/mail/accounts", { address, password, host });
    const blocker = result.body.blocker as { code?: string; message?: string } | undefined;
    if (result.ok && result.body.ok) { setAddress(""); setPassword(""); setHost(""); setMessage("已接入，正在读最近三天的邮件；以后每 15 分钟看一次新邮件。"); }
    else { setMessage(blocker?.message ?? "没能接入，稍后再试。"); if (blocker?.code === "MAIL_HOST_REQUIRED") setShowHost(true); }
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
  const check = async () => {
    setBusy(true); setMessage("正在读新邮件…");
    const result = await post("/api/mail/check", {});
    const read = Number(result.body.read ?? 0);
    setMessage(!result.ok ? "没读成，稍后再试。" : read ? `读到 ${read} 封新邮件。` : "没有新邮件。");
    await load(); setBusy(false);
  };

  return <section className="st-card mail-accounts" aria-label="邮箱">
    <header><h3>邮箱（只读）</h3><small>用应用专用密码或授权码接入；只读不写：不标已读、不移动、不删除、不发信</small></header>
    {view?.accounts.map((account) => <div className="st-row" key={account.id}>
      <span className="st-row-label">{account.address}
        <small>{account.label} · {account.lastError ? `读取失败：${account.lastError.message}` : ago(account.lastCheckedAt)}</small></span>
      <label className="st-inline"><input type="checkbox" checked={account.triage} disabled={busy} onChange={(event) => void triage(account, event.target.checked)} /> 自动整理新邮件</label>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => void remove(account)}>移除</button>
    </div>)}
    {Boolean(view?.accounts.length) && <button type="button" className="secondary-button" disabled={busy} onClick={() => void check()}>现在读新邮件</button>}
    <form className="mail-accounts-form" onSubmit={(event) => { event.preventDefault(); if (address && password) void add(); }}>
      <input type="email" value={address} onChange={(event) => setAddress(event.target.value)} placeholder="邮箱地址，如 name@gmail.com" aria-label="邮箱地址" disabled={busy} autoComplete="off" />
      <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="应用专用密码 / 授权码（不是登录密码）" aria-label="应用专用密码或授权码" disabled={busy} autoComplete="new-password" />
      {showHost && <input type="text" value={host} onChange={(event) => setHost(event.target.value)} placeholder="IMAP 服务器，如 imap.example.com" aria-label="IMAP 服务器" disabled={busy} />}
      <button type="submit" className="primary-button" disabled={busy || !address || !password}>{busy ? "连接中…" : "接入"}</button>
    </form>
    <p className="st-note">Gmail：Google 账号 → 安全 → 两步验证 → 应用专用密码。QQ / 163 / 126：邮箱设置里开启 IMAP 并生成授权码。iCloud：appleid.apple.com → App 专用密码。Outlook / Hotmail 已不允许用密码读取，暂不支持。</p>
    {message && <p role="status" className="muted">{message}</p>}
    {Boolean(view?.log.length) && <details className="st-fold"><summary>最近整理的邮件</summary>
      <ul className="st-list">{view!.log.map((entry) => <li key={`${entry.accountId}:${entry.uid}`}>
        <span>{MAIL_TRIAGE_KIND_LABEL[entry.kind]} · {entry.subject || "（无主题）"}</span>
        <small>{entry.from}{entry.title ? ` → ${entry.title}` : ""}</small>
      </li>)}</ul>
    </details>}
  </section>;
}
