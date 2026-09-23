"use client";

import { useState, type FormEvent } from "react";
import { authClient } from "../auth-client";

export function SignupForm() {
  const [status, setStatus] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email") ?? "");
    const password = String(data.get("password") ?? "");
    const name = String(data.get("name") ?? "");
    setStatus("正在创建账号…");
    const { error } = await authClient.signUp.email({ email, password, name });
    if (error) { setStatus(error.message ?? "注册失败"); return; }
    setStatus("已发送验证邮件，请点击邮件里的链接完成验证后再登录。");
  };

  return <div className="auth-form">
    <form onSubmit={submit}>
      <label><span>名字</span><input name="name" required autoComplete="name" /></label>
      <label><span>邮箱</span><input name="email" type="email" required autoComplete="email" /></label>
      <label><span>密码</span><input name="password" type="password" required minLength={8} autoComplete="new-password" /></label>
      <button className="secondary-button" type="submit">注册</button>
    </form>
    {status && <small className="muted" role="status">{status}</small>}
    <p><a href="/login">已有账号？登录</a></p>
  </div>;
}
