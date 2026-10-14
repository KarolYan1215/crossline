"use client";

import { useState } from "react";
import { SegmentedControl } from "../ui/controls";

type Preview = { id: string; summary: { tables: Array<{ name: string; rows: number }>; bytes: number; gzipBytes: number }; json: string };

const kb = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * An installed copy's two ways of telling the owner how it went (docs/local-installer.md, 回传): usage metadata sent by itself —
 * on unless turned off here — and a diagnostic snapshot sent only from this card, after the person has seen exactly what it holds.
 */
export function TelemetryCard({ on }: { on: boolean }) {
  const [value, setValue] = useState(on);
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");

  const change = async (next: boolean) => {
    setValue(next);
    const response = await fetch("/api/settings/telemetry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on: next }) }).catch(() => undefined);
    if (!response?.ok) { setValue(!next); setNote("未保存，请重试"); } else setNote(next ? "已开启" : "已关闭：关闭期间的记录不会补发");
  };
  const build = async () => {
    setBusy(true); setResult("");
    const response = await fetch("/api/diagnostic-snapshot").catch(() => undefined);
    const answer = await response?.json().catch(() => undefined) as { id?: string; summary?: Preview["summary"]; snapshot?: unknown } | undefined;
    setBusy(false);
    if (!response?.ok || !answer?.id || !answer.summary) { setResult("快照没有生成，请稍后重试"); return; }
    setPreview({ id: answer.id, summary: answer.summary, json: JSON.stringify(answer.snapshot, null, 1) });
  };
  const upload = async () => {
    if (!preview) return;
    setBusy(true);
    const response = await fetch("/api/diagnostic-snapshot", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: preview.id, feedback }) }).catch(() => undefined);
    const answer = await response?.json().catch(() => undefined) as { ok?: boolean; code?: string } | undefined;
    setBusy(false);
    if (answer?.ok) { setPreview(null); setFeedback(""); setResult("已上传，谢谢"); return; }
    if (answer?.code === "SNAPSHOT_PREVIEW_EXPIRED") { setPreview(null); setResult("预览已过期，请重新生成后再上传"); return; }
    setResult("上传没有完成，请检查网络后重试");
  };

  return <section className="st-card" aria-label="使用记录回传">
    <header><h3>使用记录回传</h3><small>内测期间发给开发者，用于改进；不含任何文字内容</small></header>
    <div className="st-row"><span className="st-row-label">自动回传<small>每 15 分钟：哪些页面被打开、任务和访谈走到哪一步、模型运行的耗时与报错码。不含标题、对话、文件、日历与窗口内容</small></span>
      <SegmentedControl label="自动回传" value={value ? "on" : "off"} onChange={(next) => void change(next === "on")}
        options={[{ value: "off", label: "关闭" }, { value: "on", label: "开启" }]} /></div>
    {note && <p role="status" className="st-note">{note}</p>}
    <div className="st-row"><span className="st-row-label">诊断快照<small>遇到问题时手动上传：保留各表的结构、状态、时间与数量，每段文字都换成长度和一个只在这台电脑上能算出的哈希</small></span>
      {!preview && <button type="button" className="secondary-button" disabled={busy} onClick={() => void build()}>{busy ? "正在生成…" : "生成快照并预览"}</button>}</div>
    {preview && <div className="st-details">
      <p className="st-note">共 {preview.summary.tables.reduce((sum, table) => sum + table.rows, 0)} 行，{preview.summary.tables.length} 张表，上传约 {kb(preview.summary.gzipBytes)}（压缩前 {kb(preview.summary.bytes)}）。</p>
      <details><summary>查看将要上传的全部内容</summary>
        <pre className="st-snapshot-json">{preview.json}</pre>
      </details>
      <label className="st-row-label st-snapshot-note">附一段说明（可选，会原样上传）
        <textarea value={feedback} maxLength={4000} rows={3} onChange={(event) => setFeedback(event.target.value)} placeholder="例如：在哪个页面、做了什么之后出现了问题" /></label>
      <div className="st-row">
        <button type="button" className="primary-button" disabled={busy} onClick={() => void upload()}>{busy ? "正在上传…" : "确认上传"}</button>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => setPreview(null)}>取消</button>
      </div>
    </div>}
    {result && <p role="status" className="st-note">{result}</p>}
  </section>;
}
