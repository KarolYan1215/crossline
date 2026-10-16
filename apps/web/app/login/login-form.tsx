"use client";

import { useState, type FormEvent } from "react";
import { authClient, emailCode } from "../auth-client";
import { authErrorMessage } from "../auth-errors";
import { useT } from "../locale-context";

export function LoginForm({ googleEnabled, emailEnabled = true, chatgptEnabled = false, verified = false, errorCode }: { googleEnabled: boolean;
  emailEnabled?: boolean; chatgptEnabled?: boolean; verified?: boolean;
  /** A redirect back from a sign-in that failed elsewhere (ChatGPT, Google), as `/login?error=CODE`. */
  errorCode?: string }) {
  const t = useT();
  const [status, setStatus] = useState(errorCode ? authErrorMessage({ code: errorCode }, t("登录没有完成，请重试。"), t) : verified ? t("邮箱已验证，请登录。") : "");
  const [error, setError] = useState(Boolean(errorCode));
  const [busy, setBusy] = useState(false);
  // 「邮箱验证码」 signs in (and on first use, signs up) without a password; offered only where mail can be sent.
  // The code is the default: one address, one code, and a first-time address is an account — no password, no separate verification mail.
  const [mode, setMode] = useState<"password" | "code">(emailEnabled ? "code" : "password");
  const [codeSentTo, setCodeSentTo] = useState("");
  // The address that was refused for being unverified: the person can have the link sent again right here.
  const [unverified, setUnverified] = useState("");

  const fail = (failure: { code?: string | undefined; message?: string | null | undefined }, fallback: string) => {
    setStatus(authErrorMessage(failure, t(fallback), t)); setError(true); setBusy(false);
  };

  const submitPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email") ?? "");
    const password = String(data.get("password") ?? "");
    setBusy(true);
    setStatus(t("正在登录…"));
    setError(false);
    setUnverified("");
    const { error: signInError } = await authClient.signIn.email({ email, password });
    if (signInError) {
      if (signInError.code === "EMAIL_NOT_VERIFIED") setUnverified(email);
      fail(signInError, "登录失败，请检查邮箱和密码");
      return;
    }
    location.href = "/connect";
  };

  const resend = async () => {
    setBusy(true);
    const { error: sendError } = await authClient.sendVerificationEmail({ email: unverified, callbackURL: "/login?verified=1" });
    if (sendError) { fail(sendError, "验证邮件没有发出，请稍后再试。"); return; }
    setStatus(t("已重新发送验证邮件到 {{email}}，请查收（包括垃圾邮件夹）。", { email: unverified })); setError(false); setBusy(false);
  };

  const submitCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email") ?? "");
    setBusy(true);
    setError(false);
    if (!codeSentTo) {
      setStatus(t("正在发送验证码…"));
      const { error: sendError } = await emailCode.send(email);
      if (sendError) { fail(sendError, "验证码没有发出，请稍后再试。"); return; }
      setCodeSentTo(email); setStatus(t("验证码已发到 {{email}}，10 分钟内有效。", { email })); setBusy(false);
      return;
    }
    const { error: signInError } = await emailCode.signIn(codeSentTo, String(data.get("otp") ?? "").trim());
    if (signInError) { fail(signInError, "登录失败，请重新获取验证码。"); return; }
    // A code makes the account with no password; offer one now, while the sign-in is fresh enough to set it.
    const password = await fetch("/api/auth/password", { cache: "no-store" }).then((response) => response.json() as Promise<{ hasPassword?: boolean }>)
      .catch(() => ({ hasPassword: true }));
    location.href = password.hasPassword ? "/connect" : "/set-password?next=/connect";
  };

  const signInWithGoogle = async () => {
    setBusy(true);
    await authClient.signIn.social({ provider: "google", callbackURL: "/connect" });
  };

  return <div className="auth-form">
    {emailEnabled && <p className="auth-modes">
      <button type="button" aria-pressed={mode === "code"} onClick={() => { setMode("code"); setStatus(""); setCodeSentTo(""); }}>{t("邮箱验证码")}</button>
      <button type="button" aria-pressed={mode === "password"} onClick={() => { setMode("password"); setStatus(""); }}>{t("密码登录")}</button>
    </p>}
    {mode === "password" ? <form method="post" onSubmit={submitPassword}>
      <label><span>{t("邮箱")}</span><input name="email" type="email" required autoComplete="email" autoFocus /></label>
      <label><span>{t("密码")}</span><input name="password" type="password" required autoComplete="current-password" /></label>
      <button className="secondary-button" type="submit" disabled={busy}>{busy ? t("处理中…") : t("登录")}</button>
    </form> : <form method="post" onSubmit={submitCode}>
      <label><span>{t("邮箱")}</span><input name="email" type="email" required autoComplete="email" autoFocus readOnly={Boolean(codeSentTo)} defaultValue={codeSentTo} /></label>
      {codeSentTo && <label><span>{t("验证码")}</span><input name="otp" inputMode="numeric" autoComplete="one-time-code" required pattern="[0-9]{6}" maxLength={6} /></label>}
      <button className="secondary-button" type="submit" disabled={busy}>{busy ? t("处理中…") : codeSentTo ? t("登录") : t("发送验证码")}</button>
      <small>{t("首次用这个邮箱登录即创建账号；登录后可以设一个密码。")}</small>
    </form>}
    {/* Hidden rather than shown-but-broken when no Google client id/secret is configured — a button
        that always fails with no useful reason is worse than one that is not there at all. */}
    {googleEnabled && <button className="secondary-button" type="button" disabled={busy} onClick={() => void signInWithGoogle()}>{t("用 Google 账号登录")}</button>}
    {chatgptEnabled && <a className="secondary-button" href="/api/auth/chatgpt/start">{t("用 ChatGPT 账号登录")}</a>}
    {status && <small role={error ? "alert" : "status"}>{status}</small>}
    {unverified && emailEnabled && <button type="button" disabled={busy} onClick={() => void resend()}>{t("重发验证邮件")}</button>}
    {/* A code signs up on first use, so the separate sign-up and reset pages belong to the password way in only. */}
    {emailEnabled && mode === "password" && <p><a href="/signup">{t("还没有账号？注册")}</a> · <a href="/reset-password">{t("忘记密码")}</a></p>}
  </div>;
}
