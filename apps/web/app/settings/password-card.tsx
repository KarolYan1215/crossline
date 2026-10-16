"use client";

import { useEffect, useState, type FormEvent } from "react";
import { authClient } from "../auth-client";
import { authErrorMessage } from "../auth-errors";
import { SetPasswordForm } from "../set-password/set-password-form";

/**
 * 登录密码: an account made by an email code sets its first password here (POST /api/auth/password, which needs a recent sign-in);
 * one that has a password changes it with the current one (Better Auth's `changePassword`).
 */
export function PasswordCard() {
  const [hasPassword, setHasPassword] = useState<boolean>();
  const [status, setStatus] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const read = () => fetch("/api/auth/password", { cache: "no-store" }).then((response) => response.json())
    .then((answer: { hasPassword?: boolean }) => setHasPassword(Boolean(answer.hasPassword))).catch(() => undefined);
  useEffect(() => { void read(); }, []);

  const change = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true); setError(false); setStatus("正在保存…");
    const { error: changeError } = await authClient.changePassword({ currentPassword: String(data.get("current") ?? ""),
      newPassword: String(data.get("next") ?? ""), revokeOtherSessions: false });
    setBusy(false);
    if (changeError) { setStatus(authErrorMessage(changeError, "密码没有修改成功，请检查当前密码。")); setError(true); return; }
    form.reset(); setStatus("密码已修改。");
  };

  return <section className="st-card" aria-label="登录密码" id="password">
    <header><h3>登录密码</h3><small>{hasPassword === undefined ? "读取中…" : hasPassword ? "已设置；邮箱验证码也能登录" : "还没有密码：现在只能用邮箱验证码登录"}</small></header>
    {hasPassword === false && <SetPasswordForm embedded onSaved={() => void read()} />}
    {hasPassword && <div className="auth-form"><form method="post" onSubmit={change}>
      <label><span>当前密码</span><input name="current" type="password" required autoComplete="current-password" /></label>
      <label><span>新密码</span><input name="next" type="password" required minLength={8} maxLength={128} autoComplete="new-password" /></label>
      <button className="secondary-button" type="submit" disabled={busy}>{busy ? "保存中…" : "修改密码"}</button>
    </form>
      {status && <small role={error ? "alert" : "status"}>{status}</small>}
      <small>忘了当前密码时，退出后在登录页用「忘记密码」重设。</small></div>}
  </section>;
}
