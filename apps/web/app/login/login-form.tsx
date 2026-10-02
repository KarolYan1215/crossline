"use client";

import { useState, type FormEvent } from "react";
import { authClient } from "../auth-client";
import { authErrorMessage } from "../auth-errors";

export function LoginForm({ googleEnabled, verified = false }: { googleEnabled: boolean; verified?: boolean }) {
  const [status, setStatus] = useState(verified ? "邮箱已验证，请登录。" : "");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  const submitPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email") ?? "");
    const password = String(data.get("password") ?? "");
    setBusy(true);
    setStatus("正在登录…");
    setError(false);
    const { error: signInError } = await authClient.signIn.email({ email, password });
    if (signInError) { setStatus(authErrorMessage(signInError, "登录失败，请检查邮箱和密码")); setError(true); setBusy(false); return; }
    location.href = "/";
  };

  const signInWithGoogle = async () => {
    setBusy(true);
    await authClient.signIn.social({ provider: "google", callbackURL: "/" });
  };

  return <div className="auth-form">
    <form onSubmit={submitPassword}>
      <label><span>邮箱</span><input name="email" type="email" required autoComplete="email" autoFocus /></label>
      <label><span>密码</span><input name="password" type="password" required autoComplete="current-password" /></label>
      <button className="secondary-button" type="submit" disabled={busy}>{busy ? "处理中…" : "登录"}</button>
    </form>
    {/* Hidden rather than shown-but-broken when no Google client id/secret is configured — a button
        that always fails with no useful reason is worse than one that is not there at all. */}
    {googleEnabled && <button className="secondary-button" type="button" disabled={busy} onClick={() => void signInWithGoogle()}>用 Google 账号登录</button>}
    {status && <small role={error ? "alert" : "status"}>{status}</small>}
    <p><a href="/signup">还没有账号？注册</a> · <a href="/reset-password">忘记密码</a></p>
  </div>;
}
