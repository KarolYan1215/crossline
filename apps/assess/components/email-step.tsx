"use client";

import type { FormEvent } from "react";
import { NICKNAME_MAX, RESULT_RETENTION_DAYS } from "../lib/contract";

export type EmailFields = { email: string; nickname: string; sendEmail: boolean; website: string };

/**
 * The gate before the result: email (required), an optional signature for invitations, and 「把海报和结果发到我的邮箱」 ticked by
 * default. `website` is a honeypot: off screen, out of the tab order and away from autofill, so only a script fills it.
 */
export function EmailStep({ fields, problems, error, busy, invited, onChange, onSubmit, onBack, onSubmitWithoutInvite }: {
  fields: EmailFields;
  problems: { email: string | null; nickname: string | null };
  error: string | null;
  busy: boolean;
  invited: boolean;
  onChange: (patch: Partial<EmailFields>) => void;
  onSubmit: () => void;
  onBack: () => void;
  onSubmitWithoutInvite?: (() => void) | undefined;
}) {
  const submit = (event: FormEvent) => { event.preventDefault(); if (!busy) onSubmit(); };
  return <form className="as-sheet" onSubmit={submit} noValidate>
    <p className="as-kicker">最后两步 · 2 / 2</p>
    <h2>{invited ? "填邮箱，看你们的双人卡" : "填邮箱，看你的结果"}</h2>
    <label className="as-field">
      <span>邮箱</span>
      <input type="email" name="email" inputMode="email" autoComplete="email" required value={fields.email}
        aria-invalid={problems.email ? true : undefined} aria-describedby={problems.email ? "as-email-problem" : undefined}
        onChange={(event) => onChange({ email: event.target.value })} />
      {problems.email && <small id="as-email-problem" className="as-error">{problems.email}</small>}
    </label>
    <label className="as-field">
      <span>邀请卡署名（可选）</span>
      <input type="text" name="nickname" autoComplete="nickname" value={fields.nickname} maxLength={NICKNAME_MAX * 2} placeholder="不填显示「你的朋友」"
        aria-invalid={problems.nickname ? true : undefined} onChange={(event) => onChange({ nickname: event.target.value })} />
      {problems.nickname && <small className="as-error">{problems.nickname}</small>}
    </label>
    <label className="as-check">
      <input type="checkbox" name="sendEmail" checked={fields.sendEmail} onChange={(event) => onChange({ sendEmail: event.target.checked })} />
      <span>把海报和结果发到我的邮箱</span>
    </label>
    <p className="as-note">保存 {RESULT_RETENTION_DAYS} 天，注册后可带入访谈，可随时删除。不发营销邮件。</p>
    <div className="as-trap" aria-hidden="true">
      <label>网站<input type="text" name="website" tabIndex={-1} autoComplete="off" value={fields.website}
        onChange={(event) => onChange({ website: event.target.value })} /></label>
    </div>
    {error && <div className="as-error" role="alert">
      <p>{error}</p>
      {onSubmitWithoutInvite && <button type="button" onClick={onSubmitWithoutInvite}>不带邀请提交</button>}
    </div>}
    <div className="as-nav">
      <button type="button" onClick={onBack} disabled={busy}>上一步</button>
      <button type="submit" className="as-primary" disabled={busy}>{busy ? "正在生成…" : "看结果"}</button>
    </div>
  </form>;
}
