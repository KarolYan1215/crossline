"use client";

import { useEffect, useState, type FormEvent } from "react";

/**
 * Sets the account's first password (POST /api/auth/password). Also used inside Settings (`embedded`), where it stays put after saving
 * instead of moving on.
 */
export function SetPasswordForm({ next, embedded = false, onSaved }: { next?: string; embedded?: boolean; onSaved?: () => void }) {
  const [status, setStatus] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  // An account that already has a password has nothing to do here: on its own page it moves straight on.
  useEffect(() => {
    if (embedded || !next) return;
    void fetch("/api/auth/password", { cache: "no-store" }).then((response) => response.json())
      .then((answer: { hasPassword?: boolean }) => { if (answer.hasPassword) location.replace(next); }).catch(() => undefined);
  }, [embedded, next]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const password = String(data.get("password") ?? ""), again = String(data.get("again") ?? "");
    if (password !== again) { setStatus("两次输入的密码不一样。"); setError(true); return; }
    setBusy(true); setError(false); setStatus("正在保存…");
    const response = await fetch("/api/auth/password", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ newPassword: password }) }).catch(() => undefined);
    const answer = await response?.json().catch(() => undefined) as { ok?: boolean; message?: string } | undefined;
    setBusy(false);
    if (!answer?.ok) { setStatus(answer?.message ?? "密码没有设置成功，请稍后再试。"); setError(true); return; }
    setStatus("密码已设置：之后用邮箱和密码，或邮箱验证码，都能登录。");
    onSaved?.();
    if (!embedded && next) location.replace(next);
  };

  return <div className="auth-form">
    {!embedded && <p>账号已经建好。设一个密码，之后用邮箱和密码就能登录，不用每次等验证码。</p>}
    <form method="post" onSubmit={submit}>
      <label><span>新密码</span><input name="password" type="password" required minLength={8} maxLength={128} autoComplete="new-password" autoFocus={!embedded} /></label>
      <label><span>再输一次</span><input name="again" type="password" required minLength={8} maxLength={128} autoComplete="new-password" /></label>
      <button className={embedded ? "secondary-button" : "primary-button"} type="submit" disabled={busy}>{busy ? "保存中…" : embedded ? "设置密码" : "保存并继续"}</button>
      <small>至少 8 个字符。</small>
    </form>
    {status && <small role={error ? "alert" : "status"}>{status}</small>}
    {!embedded && next && <p><a href={next}>以后再说</a></p>}
  </div>;
}
