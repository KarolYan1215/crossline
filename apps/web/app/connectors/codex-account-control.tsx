"use client";

import { useEffect, useState } from "react";
import { Tag } from "../ui/tag";

type Login = {
  state?: "pending" | "completed" | "failed" | "canceled";
  blocker?: { code: string; message: string };
  type?: "chatgpt" | "chatgptDeviceCode" | "apiKey";
  authUrl?: string; verificationUrl?: string; userCode?: string;
};
type AccountState = {
  account?: { type?: string; email?: string | null; planType?: string } | null;
  requiresOpenaiAuth?: boolean;
  blocker?: { code: string; message: string };
  /** This account runs on its own Codex (not the machine owner's): its login is its own, and it can sign out of it here. */
  guest?: boolean;
  /** A guest's login in progress (the owner's is under `supervisor`). */
  login?: Login | null;
  supervisor?: {
    blocker?: { code: string; message: string };
    login?: Login | null;
  };
};

const loginOf = (state: AccountState | undefined) => state?.login ?? state?.supervisor?.login ?? undefined;

export function shouldPollCodexLogin(loginUrl: string | undefined, state: AccountState | undefined): boolean {
  return Boolean(loginUrl) || loginOf(state)?.state === "pending";
}

export function reconcileCodexLoginUrl(loginUrl: string | undefined, state: AccountState | undefined): string | undefined {
  const loginState = loginOf(state)?.state;
  return loginState === "completed" || loginState === "failed" || loginState === "canceled" ? undefined : loginUrl;
}

export function visibleCodexBlocker(state: AccountState | undefined): { code: string; message: string } | undefined {
  return state?.blocker ?? state?.supervisor?.blocker ?? loginOf(state)?.blocker;
}

/**
 * The model connection (decided 2026-10-10). The machine owner's account runs on this machine's own Codex. Every other account connects
 * its own: in the browser (only when the page is open on this machine — Codex's sign-in calls back to this computer's localhost), with a
 * device code (from anywhere, a phone included), or with an API key, which goes straight to that account's own runtime and is never
 * kept or shown by the app.
 */
export function CodexAccountControl() {
  const [state, setState] = useState<AccountState>();
  const [loginUrl, setLoginUrl] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [local, setLocal] = useState(false);
  useEffect(() => { setLocal(["127.0.0.1", "localhost"].includes(location.hostname)); }, []);
  const refresh = async () => {
    const response = await fetch("/api/codex/account", { cache: "no-store" });
    const nextState = await response.json() as AccountState;
    setState(nextState);
    setLoginUrl((current) => reconcileCodexLoginUrl(current, nextState));
  };
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    if (!shouldPollCodexLogin(loginUrl, state)) return;
    void refresh();
    const interval = setInterval(() => { void refresh(); }, 1_000);
    return () => clearInterval(interval);
  }, [loginUrl, loginOf(state)?.state]);
  const post = async (body: Record<string, string>) => {
    setBusy(true);
    const response = await fetch("/api/codex/account", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const answer = await response.json() as Login & { blocker?: { code: string; message: string } };
    if (answer.blocker) setState({ ...state, blocker: answer.blocker });
    else { setLoginUrl(answer.authUrl ?? answer.verificationUrl); await refresh(); }
    setApiKey("");
    setBusy(false);
  };
  const cancelLogin = async () => {
    setBusy(true);
    await fetch("/api/codex/account", { method: "DELETE" });
    setLoginUrl(undefined);
    await refresh();
    setBusy(false);
  };
  const account = state?.account;
  const login = loginOf(state);
  const blocker = visibleCodexBlocker(state);
  const guest = state?.guest === true;
  return <section className="st-card codex-account-card" aria-label="模型连接">
    <header><h3>模型连接</h3><Tag tone={account ? "ok" : "warn"}>{account ? "已连接" : state ? "未连接" : "检查中"}</Tag></header>
    <div className="st-row"><span className="st-row-label">{account
      ? account.type === "apiKey" ? "API key（按用量计费，每月上限见「模型额度」）" : account.email ?? "ChatGPT 账号"
      : guest ? "这个账号用自己的 Codex：分析、拆分与规划都在它上面运行，不使用电脑主人的额度与记忆。" : "分析、拆分与助手功能需要登录 ChatGPT 账号"}
      {blocker && <small role="status">{blocker.message}</small>}</span>
      <span className="st-row-actions">
        {!account && !loginUrl && (!guest || local) && <button type="button" className="primary-button" disabled={busy}
          onClick={() => void post({ type: "chatgpt" })}>{busy ? "启动中…" : "用 ChatGPT 登录"}</button>}
        {!account && !loginUrl && guest && <button type="button" disabled={busy} onClick={() => void post({ type: "chatgptDeviceCode" })}>用设备码登录</button>}
        {loginUrl && <a href={loginUrl} target="_blank" rel="noreferrer">打开登录页 →</a>}
        {loginUrl && <button type="button" disabled={busy} onClick={cancelLogin}>取消</button>}
        {account && guest && <button type="button" disabled={busy} onClick={() => void post({ action: "logout" })}>退出登录</button>}
        <button type="button" onClick={refresh} aria-label="刷新登录状态" title="刷新">↻</button>
      </span></div>
    {login?.state === "pending" && login.userCode && <div className="st-row"><span className="st-row-label">在登录页输入这个验证码
      <small>{login.verificationUrl}</small></span><b className="mono">{login.userCode}</b></div>}
    {!account && guest && <form className="st-row" onSubmit={(event) => { event.preventDefault(); if (apiKey.trim()) void post({ type: "apiKey", apiKey }); }}>
      <label className="st-row-label">或填写 OpenAI API key<small>只交给这个账号自己的运行时保存，本应用不留存、不显示。</small>
        <input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-…" /></label>
      <span className="st-row-actions"><button type="submit" disabled={busy || !apiKey.trim()}>保存</button></span>
    </form>}
  </section>;
}
