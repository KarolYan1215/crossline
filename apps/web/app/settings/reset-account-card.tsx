"use client";

import { useState, type FormEvent } from "react";
import { useT } from "../locale-context";

/**
 * 清空数据重新开始 (2026-10-18): typing the account's email is the confirmation. What the account built goes and cannot be brought back;
 * the login and the model connection stay, and the page then opens the interview from its opening card.
 */
export function ResetAccountCard({ email }: { email: string }) {
  const t = useT();
  const [typed, setTyped] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const matches = typed.trim().toLowerCase() === email.trim().toLowerCase();

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!matches || busy) return;
    setBusy(true); setStatus(t("正在清空…"));
    const answer = await fetch("/api/account/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: typed }) })
      .then((response) => response.json() as Promise<{ ok?: boolean; message?: string }>).catch(() => ({ ok: false, message: undefined }));
    if (answer.ok) { window.location.assign("/onboarding"); return; }
    setBusy(false); setStatus(answer.message ?? t("没有清空成功，请稍后再试。"));
  };

  return <section className="st-card" aria-label={t("清空数据重新开始")} id="reset-account">
    <header><h3>{t("清空数据重新开始")}</h3><small>{t("删除访谈、画像、主线、里程碑、任务、上传的文件和对话，无法恢复；账号、登录方式和模型连接保留")}</small></header>
    <div className="auth-form"><form method="post" onSubmit={submit}>
      <label><span>{t("输入账号邮箱确认（{{email}}）", { email })}</span>
        <input name="email" type="email" autoComplete="off" value={typed} onChange={(event) => setTyped(event.target.value)} /></label>
      <button className="secondary-button" type="submit" disabled={!matches || busy}>{busy ? t("清空中…") : t("清空并重新访谈")}</button>
    </form>
      {status && <small role={status === t("正在清空…") ? "status" : "alert"}>{status}</small>}
      <small>{t("清空后从访谈的开场重新开始；日历订阅和授权的文件夹需要重新添加。")}</small></div>
  </section>;
}
