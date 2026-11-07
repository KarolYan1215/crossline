"use client";

import { useState } from "react";
import { useT } from "../locale-context";

/**
 * 「申请内测」 for a visitor with no account (POST /api/invites/request): the developer is mailed the application and decides it from the
 * mail; an approval mails a code to this address, typed in after signing in. Shown only where invites are offered.
 */
export function GuestInvite() {
  const t = useT();
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");
  const [website, setWebsite] = useState("");
  const [status, setStatus] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true); setStatus(t("提交中…"));
    const response = await fetch("/api/invites/request", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, reason, website }) }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as { ok?: boolean; message?: string } | undefined;
    setBusy(false);
    if (!body?.ok) { setStatus(body?.message ?? t("申请没有成功，请重试。")); return; }
    setSent(true);
    setStatus("");
  };
  return <details className="login-invite">
    <summary>{t("没有 ChatGPT 也没有模型 API key？申请内测，用开发者提供的模型")}</summary>
    {sent ? <p role="status">{t("申请已提交。开发者通过后，邀请码会发到 {{email}}；用这个邮箱登录后，在「输入邀请码」里填入。", { email })}</p>
      : <form onSubmit={(event) => { event.preventDefault(); if (email.trim()) void submit(); }}>
        <label>{t("邮箱")}
          <input type="email" required autoComplete="email" maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} />
        </label>
        <label>{t("想用 Crossline 做什么（可不填）")}
          <textarea rows={2} maxLength={300} value={reason} onChange={(event) => setReason(event.target.value)} />
        </label>
        {/* Filled only by scripts: people never see it. */}
        <input className="login-invite-trap" type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true"
          value={website} onChange={(event) => setWebsite(event.target.value)} />
        <button type="submit" className="secondary-button" disabled={busy || !email.trim()}>{t("提交申请")}</button>
      </form>}
    {status && <p role="status">{status}</p>}
  </details>;
}
