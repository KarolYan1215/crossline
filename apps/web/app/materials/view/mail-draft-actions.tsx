"use client";
import { useState } from "react";
import { useT } from "../../locale-context";

/** Copies a reply draft's body; false when the draft or the clipboard is not reachable. */
export async function copyDraft(id: string): Promise<boolean> {
  const text = await fetch(`/api/mail/drafts/${encodeURIComponent(id)}/file?part=body`, { cache: "no-store" })
    .then((response) => response.ok ? response.text() : "").catch(() => "");
  return text ? Boolean(await navigator.clipboard?.writeText(text).then(() => true, () => false)) : false;
}
/** Closes a reply draft as answered or as needing no answer. */
export async function closeDraft(id: string, how: "replied" | "dismissed"): Promise<boolean> {
  const response = await fetch(`/api/mail/replies/${encodeURIComponent(id)}`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ how }) }).catch(() => undefined);
  return Boolean(response?.ok);
}

const STATE_WORD = { replied: "已回复", dismissed: "不用回" } as const;

/**
 * Beside a reply draft on the material page (docs/personal-agent.md §3.1): who wrote and why an answer is wanted, then 复制草稿 (the body
 * only), 已回复 and 不用回. Crossline never sends it; the person sends it from their own mailbox.
 */
export function MailDraftActions({ id, from, why, replyBy, state }: { id: string; from: string; why: string; replyBy: string; state: "open" | "replied" | "dismissed" }) {
  const [current, setCurrent] = useState(state);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const t = useT();
  return <div className="mt-digest">
    <h2>{t("这份草稿")}</h2>
    <p><span className="tag">{t("助手起草")}</span> <small>{t("回复 {{from}}", { from })}</small></p>
    <p><small>{why}{replyBy ? t("；对方希望 {{day}} 前答复", { day: replyBy }) : ""}</small></p>
    <p><small>{t("Crossline 不会发送这封邮件：确认、修改后由本人从自己的邮箱发出。")}</small></p>
    <div className="conversation-options">
      <button type="button" className="secondary-button" disabled={busy} onClick={async () => {
        const ok = await copyDraft(id); setNote(t(ok ? "正文已复制" : "没能复制，请在左边选中正文复制"));
      }}>{t("复制草稿")}</button>
      {current === "open" ? <>
        <button type="button" className="secondary-button" disabled={busy} onClick={async () => {
          setBusy(true); if (await closeDraft(id, "replied")) setCurrent("replied"); else setNote(t("没能记下，稍后再试")); setBusy(false);
        }}>{t("已回复")}</button>
        <button type="button" className="text-button" disabled={busy} onClick={async () => {
          setBusy(true); if (await closeDraft(id, "dismissed")) setCurrent("dismissed"); else setNote(t("没能记下，稍后再试")); setBusy(false);
        }}>{t("不用回")}</button>
      </> : <small className="muted">{t("已记为：{{state}}，不再提醒", { state: t(STATE_WORD[current]) })}</small>}
    </div>
    {note && <p role="status"><small>{note}</small></p>}
  </div>;
}
