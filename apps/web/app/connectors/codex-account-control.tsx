"use client";

import { useEffect, useState } from "react";

type AccountState = {
  account?: { type?: string; email?: string | null; planType?: string } | null;
  requiresOpenaiAuth?: boolean;
  blocker?: { code: string; message: string };
  supervisor?: {
    blocker?: { code: string; message: string };
    login?: {
      state?: "pending" | "completed" | "failed" | "canceled";
      blocker?: { code: string; message: string };
    } | null;
  };
};

export function shouldPollCodexLogin(loginUrl: string | undefined, state: AccountState | undefined): boolean {
  return Boolean(loginUrl) || state?.supervisor?.login?.state === "pending";
}

export function reconcileCodexLoginUrl(loginUrl: string | undefined, state: AccountState | undefined): string | undefined {
  const loginState = state?.supervisor?.login?.state;
  return loginState === "completed" || loginState === "failed" || loginState === "canceled" ? undefined : loginUrl;
}

export function visibleCodexBlocker(state: AccountState | undefined): { code: string; message: string } | undefined {
  return state?.blocker ?? state?.supervisor?.blocker ?? state?.supervisor?.login?.blocker;
}

export function CodexAccountControl() {
  const [state, setState] = useState<AccountState>();
  const [loginUrl, setLoginUrl] = useState<string>();
  const [busy, setBusy] = useState(false);
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
  }, [loginUrl, state?.supervisor?.login?.state]);
  const beginLogin = async () => {
    setBusy(true);
    const response = await fetch("/api/codex/account", { method: "POST" });
    const body = await response.json() as { authUrl?: string; blocker?: { code: string; message: string } };
    setLoginUrl(body.authUrl);
    if (body.blocker) setState({ account: null, requiresOpenaiAuth: true, blocker: body.blocker });
    else if (body.authUrl) await refresh();
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
  const blocker = visibleCodexBlocker(state);
  return <article className="status-card codex-account-card">
    <span className="status-badge">{account ? "已登录" : state ? "需授权" : "检查中"}</span>
    <h2>Codex sidecar</h2>
    <p>{account ? `${account.email ?? "ChatGPT account"} · ${account.planType ?? account.type ?? "authenticated"}` : "独立 Crossline CODEX_HOME；不读取 Desktop 私有认证状态。"}</p>
    {blocker && <code>{blocker.code}: {blocker.message}</code>}
    <div>
      {!account && !loginUrl && <button type="button" disabled={busy} onClick={beginLogin}>{busy ? "启动中…" : "请求 ChatGPT 授权"}</button>}
      {loginUrl && <a href={loginUrl} target="_blank" rel="noreferrer">打开官方登录页 →</a>}
      {loginUrl && <button type="button" className="text-button" disabled={busy} onClick={cancelLogin}>取消授权</button>}
      <button type="button" className="text-button" onClick={refresh}>刷新状态</button>
    </div>
  </article>;
}
