"use client";

import { useState, type FormEvent } from "react";
import { authClient } from "../auth-client";
import { authErrorMessage } from "../auth-errors";

function RequestResetForm() {
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get("email") ?? "");
    setBusy(true);
    setStatus("正在发送…");
    await authClient.requestPasswordReset({ email, redirectTo: "/reset-password" });
    // Always the same message regardless of whether the email exists — a different one for "not
    // found" would let this form be used to check who has an account.
    setStatus("如果这个邮箱已注册，重置链接已经发出，请查收邮件。");
    setBusy(false);
  };
  return <form method="post" onSubmit={submit}>
    <label><span>邮箱</span><input name="email" type="email" required autoComplete="email" autoFocus /></label>
    <button className="secondary-button" type="submit" disabled={busy}>{busy ? "发送中…" : "发送重置链接"}</button>
    {status && <small role="status">{status}</small>}
  </form>;
}

function SetNewPasswordForm({ token }: { token: string }) {
  const [status, setStatus] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const newPassword = String(new FormData(event.currentTarget).get("password") ?? "");
    setBusy(true);
    setStatus("正在重置…");
    setError(false);
    const { error: resetError } = await authClient.resetPassword({ newPassword, token });
    if (resetError) { setStatus(authErrorMessage(resetError, "重置失败，链接可能已过期。")); setError(true); setBusy(false); return; }
    location.href = "/login?reset=1";
  };
  return <form method="post" onSubmit={submit}>
    <label><span>新密码</span><input name="password" type="password" required minLength={8} autoComplete="new-password" autoFocus /></label>
    <button className="secondary-button" type="submit" disabled={busy}>{busy ? "处理中…" : "设置新密码"}</button>
    {status && <small role={error ? "alert" : "status"}>{status}</small>}
  </form>;
}

export function ResetPasswordForm({ token }: { token: string | null }) {
  return <div className="auth-form">
    {token ? <SetNewPasswordForm token={token} /> : <RequestResetForm />}
    <p><a href="/login">返回登录</a></p>
  </div>;
}
