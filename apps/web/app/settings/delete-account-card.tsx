"use client";

import { useState, type FormEvent } from "react";

/**
 * 删除账号 (decided 2026-10-17): typing the account's email is the confirmation. Everything the account holds on the server goes and
 * cannot be brought back; the page then leaves for the sign-in page, which says the account is gone.
 */
export function DeleteAccountCard({ email }: { email: string }) {
  const [typed, setTyped] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const matches = typed.trim().toLowerCase() === email.trim().toLowerCase();

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!matches || busy) return;
    setBusy(true); setStatus("正在删除…");
    const answer = await fetch("/api/account/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: typed }) })
      .then((response) => response.json() as Promise<{ ok?: boolean; message?: string }>).catch(() => ({ ok: false, message: undefined }));
    if (answer.ok) { window.location.assign("/login?deleted=1"); return; }
    setBusy(false); setStatus(answer.message ?? "没有删除成功，请稍后再试。");
  };

  return <section className="st-card" aria-label="删除账号" id="delete-account">
    <header><h3>删除账号</h3><small>删除访谈、画像、主线、任务、上传的文件、模型连接和登录方式，无法恢复</small></header>
    <div className="auth-form"><form method="post" onSubmit={submit}>
      <label><span>输入账号邮箱确认（{email}）</span>
        <input name="email" type="email" autoComplete="off" value={typed} onChange={(event) => setTyped(event.target.value)} /></label>
      <button className="secondary-button" type="submit" disabled={!matches || busy}>{busy ? "删除中…" : "永久删除这个账号"}</button>
    </form>
      {status && <small role={status === "正在删除…" ? "status" : "alert"}>{status}</small>}
      <small>公开测评的结果不在这里，用结果邮件里的删除链接删除。</small></div>
  </section>;
}
