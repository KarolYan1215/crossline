"use client";

import { useEffect, useState } from "react";
import { Archive, Plus, Sparkles } from "lucide-react";
import type { SuccessCriterion } from "@crossline/core";
import { Sheet } from "../ui/overlay";
import { ICON } from "../ui/icon-button";
import { useT } from "../locale-context";
import { NEW_MILESTONE_EVENT } from "./lines-bar";

const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .catch(() => undefined);

export type ArchivedMilestone = { id: string; identityId: string; projectId: string; title: string; successCriteria: SuccessCriterion[]; templateId?: string };

/** Kept in Chinese (they are the keys); translated where shown. */
const errorText: Record<string, string> = {
  MILESTONE_TITLE_REQUIRED: "标题不能为空。", MILESTONE_IDENTITY_UNKNOWN: "主线不存在。", MILESTONE_DATE_INVALID: "日期格式不对。"
};

/**
 * The 主线 page's own actions: 新建里程碑 opens a short form whose result is a draft on its line (approved like any other), 让 AI 提议
 * redesigns the drafts, and the milestones the person archived can be put back as drafts.
 */
export function MilestoneActions({ lines, archived }: { lines: Array<{ id: string; label: string }>; archived: ArchivedMilestone[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ lineId: lines[0]?.id ?? "", title: "", date: "", target: "" });
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const labels = new Map(lines.map((line) => [line.id, line.label]));
  // A line card's 「+」 opens the same form with its line chosen.
  useEffect(() => {
    const openFor = (event: Event) => {
      const lineId = (event as CustomEvent<{ lineId?: string }>).detail?.lineId;
      setForm((current) => ({ ...current, lineId: lineId && labels.has(lineId) ? lineId : current.lineId }));
      setOpen(true);
    };
    window.addEventListener(NEW_MILESTONE_EVENT, openFor);
    return () => window.removeEventListener(NEW_MILESTONE_EVENT, openFor);
  }, [lines]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    setBusy(true); setStatus("");
    const response = await post("/api/milestones/draft", form);
    const body = await response?.json().catch(() => null) as { ok?: boolean; code?: string } | null;
    if (response?.ok && body?.ok) { location.reload(); return; }
    setBusy(false); setStatus(t(errorText[body?.code ?? ""] ?? "未保存，请重试。"));
  };
  const propose = async () => {
    setBusy(true); setStatus(t("正在重新设计里程碑草稿，可能需要几分钟…"));
    const response = await post("/api/milestones/propose", { request: "" });
    const body = await response?.json().catch(() => null) as { state?: string; message?: string; blocker?: { message?: string } } | null;
    if (response?.ok && body?.state !== "blocked") { location.reload(); return; }
    setBusy(false); setStatus(body?.blocker?.message ?? body?.message ?? t("未完成，请稍后重试。"));
  };
  const restore = async (milestone: ArchivedMilestone) => {
    setBusy(true);
    const response = await post("/api/milestones", { ...milestone, status: "draft" });
    if (response?.ok) { location.reload(); return; }
    setBusy(false); setStatus(t("未恢复，请刷新后重试。"));
  };

  return <div className="ms-actions">
    <Sheet title={t("新建里程碑")} open={open} onOpenChange={setOpen}
      trigger={<button type="button" className="ms-tool" disabled={!lines.length}><Plus {...ICON} />{t("新建里程碑")}</button>}
      footer={<div className="md-actions">
        <button type="button" className="primary-button" disabled={busy || !form.title.trim() || !form.lineId} onClick={() => void create()}>{t("保存为草稿")}</button>
        <button type="button" disabled={busy} onClick={() => setOpen(false)}>{t("取消")}</button>
      </div>}>
      <form className="ms-form" onSubmit={(event) => { event.preventDefault(); void create(); }}>
        <label><span>{t("主线", { context: "field" })}</span>
          <select value={form.lineId} onChange={(event) => setForm({ ...form, lineId: event.target.value })}>
            {lines.map((line) => <option key={line.id} value={line.id}>{line.label}</option>)}
          </select></label>
        <label><span>{t("里程碑")}</span>
          <input value={form.title} maxLength={200} required placeholder={t("达成的状态，例如：投出第一篇期刊论文")} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label>
        <label><span>{t("截止日（可选）")}</span>
          <input type="date" value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} /></label>
        <label><span>{t("目标说明（可选）")}</span>
          <textarea value={form.target} maxLength={500} rows={3} placeholder={t("做到什么程度，如何判断达成")} onChange={(event) => setForm({ ...form, target: event.target.value })} /></label>
        <p className="muted">{t("保存后为草稿，在本页批准；也可在任意页面的输入框中直接写「研究者里程碑：…」。")}</p>
        {status && <p role="status">{status}</p>}
      </form>
    </Sheet>
    <button type="button" className="ms-tool" disabled={busy} onClick={() => void propose()}><Sparkles {...ICON} />{t("让 AI 重新提议草稿")}</button>
    {!open && status && <small role="status">{status}</small>}
    {archived.length > 0 && <Sheet title={t("已归档的里程碑（{{n}}）", { n: archived.length })} side="right"
      trigger={<button type="button" className="ms-tool ms-tool-icon" aria-label={t("已归档 {{n}}", { n: archived.length })} title={t("已归档 {{n}}", { n: archived.length })}>
        <Archive {...ICON} /><small className="mono">{archived.length}</small></button>}>
      <ul className="ms-archived">{archived.map((milestone) => <li key={milestone.id} data-line={milestone.identityId}>
        <span>{labels.get(milestone.identityId) ?? milestone.identityId} · {milestone.title}</span>
        <button type="button" className="text-button" disabled={busy} onClick={() => void restore(milestone)}>{t("恢复为草稿")}</button>
      </li>)}</ul>
      {status && <p role="status">{status}</p>}
    </Sheet>}
  </div>;
}
