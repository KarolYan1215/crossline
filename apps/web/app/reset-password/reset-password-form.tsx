"use client";

import { useState, type FormEvent } from "react";
import { authClient } from "../auth-client";
import { authErrorMessage } from "../auth-errors";
import { useT } from "../locale-context";

function RequestResetForm() {
  const t = useT();
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get("email") ?? "");
    setBusy(true);
    setStatus(t("正在发送…"));
    await authClient.requestPasswordReset({ email, redirectTo: "/reset-password" });
    // Always the same message regardless of whether the email exists — a different one for "not
    // found" would let this form be used to check who has an account.
    setStatus(t("如果这个邮箱已注册，重置链接已经发出，请查收邮件。"));
    setBusy(false);
  };
  return <form method="post" onSubmit={submit}>
    <label><span>{t("邮箱")}</span><input name="email" type="email" required autoComplete="email" autoFocus /></label>
    <button className="secondary-button" type="submit" disabled={busy}>{busy ? t("发送中…") : t("发送重置链接")}</button>
    {status && <small role="status">{status}</small>}
  </form>;
}

function SetNewPasswordForm({ token }: { token: string }) {
  const t = useT();
  const [status, setStatus] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const newPassword = String(new FormData(event.currentTarget).get("password") ?? "");
    setBusy(true);
    setStatus(t("正在重置…"));
    setError(false);
    const { error: resetError } = await authClient.resetPassword({ newPassword, token });
    if (resetError) { setStatus(authErrorMessage(resetError, t("重置失败，链接可能已过期。"), t)); setError(true); setBusy(false); return; }
    location.href = "/login?reset=1";
  };
  return <form method="post" onSubmit={submit}>
    <label><span>{t("新密码")}</span><input name="password" type="password" required minLength={8} autoComplete="new-password" autoFocus /></label>
    <button className="secondary-button" type="submit" disabled={busy}>{busy ? t("处理中…") : t("设置新密码")}</button>
    {status && <small role={error ? "alert" : "status"}>{status}</small>}
  </form>;
}

export function ResetPasswordForm({ token }: { token: string | null }) {
  const t = useT();
  return <div className="auth-form">
    {token ? <SetNewPasswordForm token={token} /> : <RequestResetForm />}
    <p><a href="/login">{t("返回登录")}</a></p>
  </div>;
}
