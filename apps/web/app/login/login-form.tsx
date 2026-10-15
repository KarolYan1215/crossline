"use client";

import { useState, type FormEvent } from "react";
import { authClient, emailCode } from "../auth-client";
import { authErrorMessage } from "../auth-errors";

export function LoginForm({ googleEnabled, emailEnabled = true, chatgptEnabled = false, verified = false, errorCode }: { googleEnabled: boolean;
  emailEnabled?: boolean; chatgptEnabled?: boolean; verified?: boolean;
  /** A redirect back from a sign-in that failed elsewhere (ChatGPT, Google), as `/login?error=CODE`. */
  errorCode?: string }) {
  const [status, setStatus] = useState(errorCode ? authErrorMessage({ code: errorCode }, "登录没有完成，请重试。") : verified ? "邮箱已验证，请登录。" : "");
  const [error, setError] = useState(Boolean(errorCode));
  const [busy, setBusy] = useState(false);
  // 「邮箱验证码」 signs in (and on first use, signs up) without a password; offered only where mail can be sent.
  // The code is the default: one address, one code, and a first-time address is an account — no password, no separate verification mail.
  const [mode, setMode] = useState<"password" | "code">(emailEnabled ? "code" : "password");
  const [codeSentTo, setCodeSentTo] = useState("");
  // The address that was refused for being unverified: the person can have the link sent again right here.
  const [unverified, setUnverified] = useState("");

  const fail = (failure: { code?: string | undefined; message?: string | null | undefined }, fallback: string) => {
    setStatus(authErrorMessage(failure, fallback)); setError(true); setBusy(false);
  };

  const submitPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email") ?? "");
    const password = String(data.get("password") ?? "");
    setBusy(true);
    setStatus("正在登录…");
    setError(false);
    setUnverified("");
    const { error: signInError } = await authClient.signIn.email({ email, password });
    if (signInError) {
      if (signInError.code === "EMAIL_NOT_VERIFIED") setUnverified(email);
      fail(signInError, "登录失败，请检查邮箱和密码");
      return;
    }
    location.href = "/";
  };

  const resend = async () => {
    setBusy(true);
    const { error: sendError } = await authClient.sendVerificationEmail({ email: unverified, callbackURL: "/login?verified=1" });
    if (sendError) { fail(sendError, "验证邮件没有发出，请稍后再试。"); return; }
    setStatus(`已重新发送验证邮件到 ${unverified}，请查收（包括垃圾邮件夹）。`); setError(false); setBusy(false);
  };

  const submitCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email") ?? "");
    setBusy(true);
    setError(false);
    if (!codeSentTo) {
      setStatus("正在发送验证码…");
      const { error: sendError } = await emailCode.send(email);
      if (sendError) { fail(sendError, "验证码没有发出，请稍后再试。"); return; }
      setCodeSentTo(email); setStatus(`验证码已发到 ${email}，10 分钟内有效。`); setBusy(false);
      return;
    }
    const { error: signInError } = await emailCode.signIn(codeSentTo, String(data.get("otp") ?? "").trim());
    if (signInError) { fail(signInError, "登录失败，请重新获取验证码。"); return; }
    location.href = "/";
  };

  const signInWithGoogle = async () => {
    setBusy(true);
    await authClient.signIn.social({ provider: "google", callbackURL: "/" });
  };

  return <div className="auth-form">
    {emailEnabled && <p className="auth-modes">
      <button type="button" aria-pressed={mode === "code"} onClick={() => { setMode("code"); setStatus(""); setCodeSentTo(""); }}>邮箱验证码</button>
      <button type="button" aria-pressed={mode === "password"} onClick={() => { setMode("password"); setStatus(""); }}>密码登录</button>
    </p>}
    {mode === "password" ? <form method="post" onSubmit={submitPassword}>
      <label><span>邮箱</span><input name="email" type="email" required autoComplete="email" autoFocus /></label>
      <label><span>密码</span><input name="password" type="password" required autoComplete="current-password" /></label>
      <button className="secondary-button" type="submit" disabled={busy}>{busy ? "处理中…" : "登录"}</button>
    </form> : <form method="post" onSubmit={submitCode}>
      <label><span>邮箱</span><input name="email" type="email" required autoComplete="email" autoFocus readOnly={Boolean(codeSentTo)} defaultValue={codeSentTo} /></label>
      {codeSentTo && <label><span>验证码</span><input name="otp" inputMode="numeric" autoComplete="one-time-code" required pattern="[0-9]{6}" maxLength={6} /></label>}
      <button className="secondary-button" type="submit" disabled={busy}>{busy ? "处理中…" : codeSentTo ? "登录" : "发送验证码"}</button>
      <small>首次用这个邮箱登录即创建账号，不需要密码。</small>
    </form>}
    {/* Hidden rather than shown-but-broken when no Google client id/secret is configured — a button
        that always fails with no useful reason is worse than one that is not there at all. */}
    {googleEnabled && <button className="secondary-button" type="button" disabled={busy} onClick={() => void signInWithGoogle()}>用 Google 账号登录</button>}
    {chatgptEnabled && <a className="secondary-button" href="/api/auth/chatgpt/start">用 ChatGPT 账号登录</a>}
    {status && <small role={error ? "alert" : "status"}>{status}</small>}
    {unverified && emailEnabled && <button type="button" disabled={busy} onClick={() => void resend()}>重发验证邮件</button>}
    {/* A code signs up on first use, so the separate sign-up and reset pages belong to the password way in only. */}
    {emailEnabled && mode === "password" && <p><a href="/signup">还没有账号？注册</a> · <a href="/reset-password">忘记密码</a></p>}
  </div>;
}
