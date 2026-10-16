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
  const blocker = state?.blocker ?? state?.supervisor?.blocker ?? loginOf(state)?.blocker;
  // The worker being down or not configured reaches here as the supervisor's own English; the page says it in words (copy-style).
  return blocker && /SUPERVISOR|CAPABILITY/.test(blocker.code) ? { code: blocker.code, message: "后台服务没有连上，稍后点 ↻ 刷新。" } : blocker;
}

/**
 * The model connection (decided 2026-10-10). The machine owner's account runs on this machine's own Codex. Every other account connects
 * its own: in the browser (only when the page is open on this machine — Codex's sign-in calls back to this computer's localhost), with a
 * device code (from anywhere, a phone included), or with an API key, which goes straight to that account's own runtime and is never
 * kept or shown by the app. On a hosted server (2026-10-16) the owner too is away from the machine Codex runs on, so whoever opens the
 * page anywhere but this computer gets the device code: the browser sign-in would call back to their own localhost:1455 and fail.
 */
export function CodexAccountControl({ onConnected }: {
  /** Told after every read whether this account now has a model connection (the interview waits on it). */
  onConnected?: (connected: boolean) => void } = {}) {
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
    onConnected?.(Boolean(nextState.account));
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
  // Away from this computer only the device code works, for the owner as for a guest; on it, the browser sign-in is the main button.
  const codeFirst = !local;
  const deviceCode = guest || !local;
  // One click copies the code and opens OpenAI's page, so the code is ready to paste where it is asked for.
  const copyAndOpen = (code: string | undefined, url: string) => {
    if (code) void navigator.clipboard?.writeText(code).catch(() => undefined);
    window.open(url, "_blank", "noopener");
  };
  return <section className="st-card codex-account-card" aria-label="模型连接" id="model">
    <header><h3>模型连接</h3><Tag tone={account ? "ok" : "warn"}>{account ? "已连接" : state ? "未连接" : "检查中"}</Tag></header>
    <div className="st-row"><span className="st-row-label">{account
      ? account.type === "apiKey" ? "API key（按用量计费，每月上限见「模型额度」）" : account.email ?? "ChatGPT 账号"
      : !state ? "正在读取登录状态…" : guest ? "这个账号用自己的 Codex：分析、拆分与规划都在它上面运行，不使用电脑主人的额度与记忆。" : "分析、拆分与助手功能需要登录 ChatGPT 账号"}
      {blocker && <small role="status">{blocker.message}</small>}</span>
      <span className="st-row-actions">
        {state && !account && !loginUrl && local && <button type="button" className="primary-button" disabled={busy}
          onClick={() => void post({ type: "chatgpt" })}>{busy ? "启动中…" : "用 ChatGPT 登录"}</button>}
        {state && !account && !loginUrl && deviceCode && <button type="button" className={codeFirst ? "primary-button" : "secondary-button"} disabled={busy}
          onClick={() => void post({ type: "chatgptDeviceCode" })}>{busy && codeFirst ? "正在取代码…" : "用一次性代码连接"}</button>}
        {loginUrl && !login?.userCode && <a href={loginUrl} target="_blank" rel="noreferrer">打开登录页 →</a>}
        {loginUrl && <button type="button" disabled={busy} onClick={cancelLogin}>取消</button>}
        {account && guest && <button type="button" disabled={busy} onClick={() => void post({ action: "logout" })}>退出登录</button>}
        <button type="button" onClick={refresh} aria-label="刷新登录状态" title="刷新">↻</button>
      </span></div>
    {state && !account && deviceCode && <ol className="codex-steps">
      {/* OpenAI refuses every code until this switch is on, and a code entered before it is spent (owner's run, 2026-10-15). */}
      <li>先在 ChatGPT 网页版打开 设置 → 安全，开启「为 Codex、Excel、PowerPoint 和 Word 启用设备代码登录」（只需一次）</li>
      <li>点「用一次性代码连接」，再点「复制代码并打开 OpenAI 页面」：代码已复制，在打开的页面用本人的 ChatGPT 账号登录后粘贴</li>
      <li>回到这里，几秒内自动显示「已连接」</li>
    </ol>}
    {login?.state === "pending" && login.userCode && <div className="st-row"><span className="st-row-label">在 OpenAI 的页面输入这串代码
      <small>代码只给本人用，不要发给别人。页面提示要先启用设备代码登录时，按上面第 1 步开启后点「获取新代码」。</small></span>
      <b className="mono codex-user-code">{login.userCode}</b>
      <span className="st-row-actions">
        {loginUrl && <button type="button" className="primary-button" onClick={() => copyAndOpen(login.userCode, loginUrl)}>复制代码并打开 OpenAI 页面</button>}
        <button type="button" disabled={busy} onClick={() => void (async () => { await cancelLogin(); await post({ type: "chatgptDeviceCode" }); })()}>获取新代码</button></span></div>}
    {login?.state === "failed" && deviceCode && !account && <p className="muted" role="status">这串代码没有通过。确认已按第 1 步开启设备代码登录，再点「用一次性代码连接」取一串新代码。</p>}
    {!account && guest && <form className="st-row" onSubmit={(event) => { event.preventDefault(); if (apiKey.trim()) void post({ type: "apiKey", apiKey }); }}>
      <label className="st-row-label">或填写 OpenAI API key<small>只交给这个账号自己的运行时保存，本应用不留存、不显示。</small>
        <input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-…" /></label>
      <span className="st-row-actions"><button type="submit" disabled={busy || !apiKey.trim()}>保存</button></span>
    </form>}
  </section>;
}
