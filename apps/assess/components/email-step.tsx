"use client";

import type { FormEvent, ReactNode } from "react";
import { NICKNAME_MAX, RESULT_RETENTION_DAYS, TESTS_PER_EMAIL } from "../lib/contract";
import { useT } from "./locale-context";

export type EmailFields = { email: string; nickname: string; sendEmail: boolean; website: string };

/**
 * The gate before the result: email (required), an optional signature for invitations, and 「把结果链接发到我的邮箱」 ticked by
 * default. `website` is a honeypot: off screen, out of the tab order and away from autofill, so only a script fills it.
 */
export function EmailStep({ fields, problems, error, busy, invited, onChange, onSubmit, onBack, onSubmitWithoutInvite, latestLink }: {
  fields: EmailFields;
  problems: { email: string | null; nickname: string | null };
  error: string | null;
  busy: boolean;
  invited: boolean;
  onChange: (patch: Partial<EmailFields>) => void;
  onSubmit: () => void;
  onBack: () => void;
  onSubmitWithoutInvite?: (() => void) | undefined;
  /** With the address's tests used up: this browser's latest result, when it has one. */
  latestLink?: ReactNode;
}) {
  const t = useT();
  const submit = (event: FormEvent) => { event.preventDefault(); if (!busy) onSubmit(); };
  return <form className="as-sheet" onSubmit={submit} noValidate>
    <p className="as-kicker">{t("最后三步 · {{step}} / 3", { step: 2 })}</p>
    <h2>{invited ? t("填邮箱，看你们的双人卡") : t("填邮箱，看你的结果")}</h2>
    <label className="as-field">
      <span>{t("邮箱")}</span>
      <input type="email" name="email" inputMode="email" autoComplete="email" required value={fields.email} placeholder="name@example.com"
        aria-invalid={problems.email ? true : undefined} aria-describedby={problems.email ? "as-email-problem" : undefined}
        onChange={(event) => onChange({ email: event.target.value })} />
      {problems.email && <small id="as-email-problem" className="as-error">{problems.email}</small>}
    </label>
    <label className="as-field">
      <span>{t("你的昵称（可选）")}</span>
      <input type="text" name="nickname" autoComplete="nickname" value={fields.nickname} maxLength={NICKNAME_MAX * 2} placeholder={t("不填显示「你的朋友」")}
        aria-invalid={problems.nickname ? true : undefined} onChange={(event) => onChange({ nickname: event.target.value })} />
      <small className="as-note">{t("印在你的海报、邀请和双人卡上。")}</small>
      {problems.nickname && <small className="as-error">{problems.nickname}</small>}
    </label>
    <label className="as-check">
      <input type="checkbox" name="sendEmail" checked={fields.sendEmail} onChange={(event) => onChange({ sendEmail: event.target.checked })} />
      <span>{t("把结果链接发到我的邮箱")}</span>
    </label>
    <div className="as-note as-why">
      <p>{t("邮箱只用来：找回你的结果，以及朋友做完双人卡时通知你。不发营销邮件，不给任何人看。")}</p>
      <p>{t("加入 Crossline 内测后，用同一个邮箱登录，这次结果会自动带进 App。")}</p>
      <p>{t("一个邮箱最多测 {{tests}} 次，只保留最新一次。结果保存 {{days}} 天后自动删除；想早点删，结果页和每封邮件里都有「删除我的结果」。", { tests: TESTS_PER_EMAIL, days: RESULT_RETENTION_DAYS })}</p>
    </div>
    <div className="as-trap" aria-hidden="true">
      <label>{t("网站")}<input type="text" name="website" tabIndex={-1} autoComplete="off" value={fields.website}
        onChange={(event) => onChange({ website: event.target.value })} /></label>
    </div>
    {error && <div className="as-error" role="alert">
      <p>{error}</p>
      {onSubmitWithoutInvite && <button type="button" onClick={onSubmitWithoutInvite}>{t("不带邀请提交")}</button>}
      {latestLink}
    </div>}
    <div className="as-nav">
      <button type="button" onClick={onBack} disabled={busy}>{t("上一步")}</button>
      <button type="submit" className="as-primary" disabled={busy}>{busy ? t("正在提交…") : t("下一步")}</button>
    </div>
  </form>;
}
