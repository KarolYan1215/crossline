"use client";
import { useCallback, useEffect, useState } from "react";
import { IMPORT_KIND_LABEL, type ImportBatch, type ImportServiceKind, type ImportSource } from "@crossline/core";
import { useT } from "../locale-context";
import { SegmentedControl } from "../ui/controls";
import { SetupGuide } from "../ui/setup-guide";
import { IMPORT_GUIDE } from "../../lib/setup-guides";
import { ImportReview } from "./import-review";

type View = { sources: ImportSource[]; batches: ImportBatch[]; lines: Array<{ id: string; label: string }> };
type Answer = { ok?: boolean; batchId?: string; items?: number; databases?: Array<{ id: string; title: string }>; blocker?: { message?: string } };

/**
 * 「从其他工具导入」 (docs/personal-agent.md §9, 2026-10-28): Todoist, TickTick and Notion by a token the person makes, anything else as a
 * paste, a CSV or a screenshot; the tutorial for each sits beside the buttons. What is read waits in a batch until the person confirms it
 * on one screen (`ImportReview`). `compact`: folded under one line, for the interview's 「材料与日历」.
 */
export function ImportCard({ compact, onChanged }: { compact?: boolean; onChanged?: () => void }) {
  const t = useT();
  const [view, setView] = useState<View>();
  const [kind, setKind] = useState<ImportServiceKind>("todoist");
  const [token, setToken] = useState("");
  const [databases, setDatabases] = useState<Array<{ id: string; title: string }>>();
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [reviewing, setReviewing] = useState<string>();

  const load = useCallback(async () => {
    const response = await fetch("/api/import", { cache: "no-store" }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as View | undefined;
    if (body?.sources) setView(body);
    return body;
  }, []);
  useEffect(() => { void load(); }, [load]);
  // A batch the model is still sorting is looked at again until it is ready.
  const sorting = view?.batches.some((batch) => batch.state === "sorting") ?? false;
  useEffect(() => {
    if (!sorting) return;
    const timer = setInterval(() => { void load(); }, 4000);
    return () => clearInterval(timer);
  }, [sorting, load]);

  const after = async (body: Answer | undefined, fallback: string) => {
    if (body?.ok && body.batchId) { setMessage(t("读到 {{count}} 条，正在整理，可以开始核对。", { count: body.items ?? 0 })); setReviewing(body.batchId); }
    else if (body?.ok) setMessage(t("没有新的条目：读到的都已导入过或已设为不要。"));
    else setMessage(body?.blocker?.message ?? fallback);
    await load();
    onChanged?.();
  };
  const connect = async (databaseId?: string) => {
    setBusy(true); setMessage("");
    const response = await fetch("/api/import/sources", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, token, ...(databaseId ? { databaseId } : {}) }) }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as Answer | undefined;
    if (body?.ok && body.databases) { setDatabases(body.databases); setMessage(t("选要导入的数据库：")); setBusy(false); return; }
    if (body?.ok) { setToken(""); setDatabases(undefined); }
    await after(body, t("没能接入，稍后再试。"));
    setBusy(false);
  };
  const upload = async (form: FormData) => {
    setBusy(true); setMessage(t("读取中…"));
    const response = await fetch("/api/import/upload", { method: "POST", body: form }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as Answer | undefined;
    if (body?.ok) setPasted("");
    await after(body, t("没有读到上传的内容，请重新上传。"));
    setBusy(false);
  };
  const sourceAction = async (id: string, payload: Record<string, unknown>, method = "POST") => {
    setBusy(true);
    const response = await fetch(`/api/import/sources/${encodeURIComponent(id)}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as Answer | undefined;
    if (payload.action === "read") await after(body, t("没能读取，稍后再试。"));
    else { if (method === "DELETE") setMessage(body?.ok ? t("已断开，令牌已删除。导入过的任务保留。") : t("没能断开，稍后再试。")); await load(); }
    setBusy(false);
  };

  const body = <>
    {view?.sources.map((source) => <div className="st-row import-source" key={source.id}>
      <span className="st-row-label">{source.label}
        <small>{t(IMPORT_KIND_LABEL[source.kind])}{source.lastError ? ` · ${source.lastError}` : source.lastItems !== undefined ? ` · ${t("上次读到 {{count}} 条", { count: source.lastItems })}` : ""}</small>
      </span>
      <label className="import-option"><input type="checkbox" checked={source.daily} disabled={busy} onChange={(event) => void sourceAction(source.id, { daily: event.target.checked })} />{t("每天读新增")}</label>
      {source.kind === "todoist" && <label className="import-option"><input type="checkbox" checked={source.writeBack} disabled={busy}
        onChange={(event) => void sourceAction(source.id, { writeBack: event.target.checked })} />{t("完成后在 Todoist 里关闭")}</label>}
      <button type="button" className="secondary-button" disabled={busy} onClick={() => void sourceAction(source.id, { action: "read" })}>{t("现在读取")}</button>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => void sourceAction(source.id, {}, "DELETE")}>{t("断开")}</button>
    </div>)}
    {view?.batches.map((batch) => <div className="st-row import-batch" key={batch.id}>
      <span className="st-row-label">{t("待核对：{{label}}", { label: batch.label })}
        <small>{batch.state === "sorting" ? t("{{count}} 条，整理中", { count: batch.items.length }) : t("{{count}} 条，已整理", { count: batch.items.length })}</small></span>
      <button type="button" className="primary-button" onClick={() => setReviewing(batch.id)}>{t("核对")}</button>
    </div>)}
    <SegmentedControl label={t("从哪个工具导入")} value={kind} disabled={busy} onChange={(next) => { setKind(next); setDatabases(undefined); }}
      options={[{ value: "todoist", label: "Todoist" }, { value: "ticktick", label: "TickTick" }, { value: "notion", label: "Notion" }]} />
    <form className="import-connect" onSubmit={(event) => { event.preventDefault(); if (token.trim()) void connect(); }}>
      <input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} disabled={busy}
        placeholder={kind === "notion" ? t("Notion 集成的 Internal Integration Secret") : t("{{tool}} 的 API 令牌", { tool: IMPORT_KIND_LABEL[kind] })} aria-label={t("令牌")} />
      <button type="submit" className="primary-button" disabled={busy || !token.trim()}>{busy ? t("读取中…") : t("接入")}</button>
    </form>
    {databases && <div className="import-databases" role="group" aria-label={t("选要导入的数据库")}>
      {databases.map((database) => <button key={database.id} type="button" className="secondary-button" disabled={busy} onClick={() => void connect(database.id)}>{database.title}</button>)}
    </div>}
    <SetupGuide guide={IMPORT_GUIDE} selected={kind} />
    <div className="import-paste">
      <textarea value={pasted} onChange={(event) => setPasted(event.target.value)} rows={4} disabled={busy} aria-label={t("粘贴清单")}
        placeholder={t("把原来的清单粘贴到这里，一行一条；带 [x] 的视为已做完")} />
      <div className="import-paste-actions">
        <button type="button" className="secondary-button" disabled={busy || !pasted.trim()} onClick={() => { const form = new FormData(); form.set("text", pasted); void upload(form); }}>{t("导入粘贴的清单")}</button>
        <label className="secondary-button import-file">
          <input type="file" hidden accept=".csv,.txt,.md,image/png,image/jpeg,image/webp" disabled={busy}
            onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (!file) return; const form = new FormData(); form.set("file", file); void upload(form); }} />
          {t("上传 CSV 或截图")}</label>
      </div>
    </div>
    {message && <p role="status" className="muted">{message}</p>}
    <small className="muted">{t("令牌只保存在加密存储里，不进账本和备份；断开即删除。")}</small>
    {reviewing && view && <ImportReview batchId={reviewing} view={view} reload={load} onClose={(done) => { setReviewing(undefined); if (done) { setMessage(done); onChanged?.(); } }} />}
  </>;

  if (compact) return <details className="import-card-compact" open={Boolean(view?.batches.length)}>
    <summary>{t("从其他工具导入")}{view?.batches.length ? ` · ${t("{{count}} 批待核对", { count: view.batches.length })}` : ""}</summary>
    {body}
  </details>;
  return <section className="st-card import-card" aria-label={t("从其他工具导入")}>
    <header><h3>{t("从其他工具导入")}</h3><small>{t("把 Todoist、TickTick、Notion 或任何清单里的待办带进来，先核对再收进收集箱。")}</small></header>
    {body}
  </section>;
}
