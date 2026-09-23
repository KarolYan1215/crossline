"use client";

import { useState, type FormEvent } from "react";
import { authClient } from "../auth-client";

export function LoginForm() {
  const [status, setStatus] = useState("");

  const submitPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email") ?? "");
    const password = String(data.get("password") ?? "");
    setStatus("正在登录…");
    const { error } = await authClient.signIn.email({ email, password });
    if (error) { setStatus(error.message ?? "登录失败，请检查邮箱和密码"); return; }
    location.href = "/";
  };

  const signInWithGoogle = async () => {
    await authClient.signIn.social({ provider: "google", callbackURL: "/" });
  };

  return <div className="auth-form">
    <form onSubmit={submitPassword}>
      <label><span>邮箱</span><input name="email" type="email" required autoComplete="email" /></label>
      <label><span>密码</span><input name="password" type="password" required autoComplete="current-password" /></label>
      <button className="secondary-button" type="submit">登录</button>
    </form>
    <button className="secondary-button" type="button" onClick={signInWithGoogle}>用 Google 账号登录</button>
    {status && <small className="muted" role="status">{status}</small>}
    <p><a href="/signup">还没有账号？注册</a> · <a href="/reset-password">忘记密码</a></p>
  </div>;
}
