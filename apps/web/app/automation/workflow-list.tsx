"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "../locale-context";
import { LineTag, Tag } from "../ui/tag";
import { VoiceField } from "../ui/voice/voice-input";
import type { WorkflowDraft, WorkflowListItem } from "../../lib/workflows";

export const WORKFLOW_TAG = { automation: "自动化", grown: "生长的工作流", remind: "提醒" } as const;
export const WORKFLOW_STATUS = { active: "运行中", off: "已暂停", needs_consent: "待本人确认风险" } as const;
const day = (iso: string) => iso ? `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}` : "—";

/**
 * 工作流 (the 自动化 page, 2026-11-10): automations and grown workflows in one list, the kind as a tag. A new one starts as a conversation:
 * the first sentence goes to the designer and the page opens that conversation, where the person goes on until it is right.
 */
export function WorkflowList({ items, drafts, lines }: { items: WorkflowListItem[]; drafts: WorkflowDraft[]; lines: Array<{ id: string; label: string }> }) {
  const t = useT();
  const router = useRouter();
  const [text, setText] = useState("");
  const [lineId, setLineId] = useState(lines[0]?.id ?? "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true); setNote("");
    const response = await fetch("/api/workflows", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, lineId }) }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as { ok?: boolean; threadId?: string; message?: string } | undefined;
    setBusy(false);
    if (body?.ok && body.threadId) { router.push(`/automation/${encodeURIComponent(body.threadId)}`); return; }
    setNote(body?.message ?? t("没有提交成功，稍后再试。"));
  };
  return <section className="st-card st-card-wide wf-list" aria-label={t("工作流")}>
    <header><h3>{t("工作流 · {{n}}", { n: items.length })}</h3>
      <small>{t("自动化与生长的工作流都在这里；点开一个，在它自己的对话里继续修改，每次修改都是一个版本，可对比、试运行和回到任一版")}</small></header>
    <form className="wf-new" onSubmit={(event) => { event.preventDefault(); if (text.trim() && !busy) void start(); }}>
      <VoiceField kind="note"><textarea value={text} rows={2} maxLength={2000} onChange={(event) => setText(event.target.value)} aria-label={t("新的工作流")}
        placeholder={t("例如：每天早上 8 点把邮箱里和课程有关的邮件整理成待办；课程网页一更新就告诉我改了什么；每周五把这周新上传的材料归档")} /></VoiceField>
      <div className="st-row">
        <label className="st-row-label">{t("服务哪条主线")}
          <select value={lineId} onChange={(event) => setLineId(event.target.value)}>{lines.map((line) => <option key={line.id} value={line.id}>{line.label}</option>)}</select>
        </label>
        <button type="submit" className="primary-button" disabled={!text.trim() || busy}>{busy ? t("提交中…") : t("开始对话")}</button>
      </div>
    </form>
    {note && <p role="status" className="muted">{note}</p>}
    {drafts.length > 0 && <ul className="wf-drafts">{drafts.map((draft) => <li key={draft.threadId}>
      <a href={`/automation/${encodeURIComponent(draft.threadId)}`}>{draft.title || t("新的工作流")}</a>
      <small>{draft.running ? t("正在设计") : draft.failed ? t("没有建成") : t("等本人回答")} · {day(draft.at)}</small></li>)}</ul>}
    {items.length === 0 ? <p className="muted">{t("还没有工作流。")}</p>
      : <ul className="wf-items">{items.map((item) => <li key={`${item.kind}:${item.id}`}>
        <a className="wf-item" href={`/automation/${encodeURIComponent(item.id)}`}>
          <span className="wf-item-head"><b>{item.name}</b>
            <Tag tone={item.tag === "grown" ? "info" : "neutral"}>{t(WORKFLOW_TAG[item.tag])}</Tag>
            <Tag tone={item.status === "active" ? "ok" : item.status === "off" ? "neutral" : "warn"}>{t(WORKFLOW_STATUS[item.status])}</Tag>
            {item.lineLabel && <LineTag line={item.lineId}>{item.lineLabel}</LineTag>}</span>
          <small>{item.when}{item.summary ? ` · ${item.summary}` : ""}</small>
          <small>{t("第 {{version}} 版 · 共 {{count}} 版", { version: item.version, count: item.versions })} · {day(item.lastAt)}</small>
        </a></li>)}</ul>}
  </section>;
}
