"use client";

import { useState, type FormEvent } from "react";
import { authClient } from "../auth-client";
import { authErrorMessage } from "../auth-errors";

export function SignupForm() {
  const [status, setStatus] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email") ?? "");
    const password = String(data.get("password") ?? "");
    const name = String(data.get("name") ?? "");
    setBusy(true);
    setStatus("正在创建账号…");
    setError(false);
    const { error: signUpError } = await authClient.signUp.email({ email, password, name, callbackURL: "/login?verified=1" });
    if (signUpError) { setStatus(authErrorMessage(signUpError, "注册失败，请重试。")); setError(true); setBusy(false); return; }
    setStatus("已发送验证邮件，请查收（包括垃圾邮件夹）并点击链接完成验证后再登录。");
    setBusy(false);
  };

  return <div className="auth-form">
    <form method="post" onSubmit={submit}>
      <label><span>名字</span><input name="name" required autoComplete="name" autoFocus /></label>
      <label><span>邮箱</span><input name="email" type="email" required autoComplete="email" /></label>
      <label><span>密码</span><input name="password" type="password" required minLength={8} autoComplete="new-password" /></label>
      <button className="secondary-button" type="submit" disabled={busy}>{busy ? "处理中…" : "注册"}</button>
    </form>
    {status && <small role={error ? "alert" : "status"}>{status}</small>}
    <p><a href="/login">已有账号？登录</a></p>
  </div>;
}
