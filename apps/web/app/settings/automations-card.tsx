"use client";
import { useEffect, useState } from "react";

type AutomationView = { id: string; name: string; summary: string; status: "active" | "off"; triggerLabel: string; runs: number; lastFiredAt?: string;
  steps: Array<{ title: string; by: "assistant" | "person" }>; action: { kind: "run" | "remind" } };
type RunView = { automationId: string; taskId: string; firedAt: string; reason: string; state: string; detail?: string };
type View = { automations: AutomationView[]; runs: RunView[]; pending: Array<{ id: string; text: string }> };

const post = (url: string, body: unknown, method = "POST") => fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then(async (response) => ({ ok: response.ok, body: await response.json().catch(() => ({})) as Record<string, unknown> })).catch(() => ({ ok: false, body: {} as Record<string, unknown> }));
const RUN_STATE: Record<string, string> = { started: "已开始", reminded: "已提醒", queued: "等助手空出来", skipped: "今天次数已满" };
const day = (iso: string) => iso ? `${iso.slice(5, 10).replace("-", "/")} ${iso.slice(11, 16)}` : "";

/**
 * 自动化 (docs/personal-agent.md, 2026-10-19): what runs by itself, in the person's words — a trigger Crossline watches (a time, every few
 * hours, new mail, a page changing, a new file, a task finishing or coming due) and what the assistant does each time. Made from one
 * sentence here or in the input box; each can be run now, paused or deleted, and the recent runs say what happened.
 */
export function AutomationsCard({ lines }: { lines: Array<{ id: string; label: string }> }) {
  const [view, setView] = useState<View | undefined>();
  const [text, setText] = useState("");
  const [lineId, setLineId] = useState(lines[0]?.id ?? "");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const load = async () => {
    const response = await fetch("/api/automations", { cache: "no-store" }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as View | undefined;
    setView(body?.automations ? body : { automations: [], runs: [], pending: [] });
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!view?.pending.length) return;
    const timer = setTimeout(() => void load(), 8000);
    return () => clearTimeout(timer);
  }, [view]);
  const create = async () => {
    setBusy("create"); setMessage("");
    const result = await post("/api/automations", { text, lineId });
    setMessage(result.ok ? "已交给助手设计，建好后会在页面和手机上通知，并说明按什么条件运行。" : String((result.body.blocker as { message?: string } | undefined)?.message ?? "没有提交成功，稍后再试。"));
    if (result.ok) setText("");
    await load(); setBusy("");
  };
  const act = async (id: string, action: "run" | "pause" | "resume" | "delete") => {
    setBusy(id);
    const result = action === "delete" ? await post(`/api/automations/${id}`, {}, "DELETE") : await post(`/api/automations/${id}`, { action });
    const run = result.body.run as RunView | undefined;
    setMessage(!result.ok ? "没有完成，稍后再试。" : action === "run" ? `已运行：${RUN_STATE[run?.state ?? ""] ?? "已提交"}${run?.detail ? `（${run.detail}）` : ""}`
      : action === "delete" ? "已删除。" : action === "pause" ? "已暂停。" : "已恢复。");
    await load(); setBusy("");
  };
  const nameOf = (id: string) => view?.automations.find((item) => item.id === id)?.name ?? "已删除的自动化";

  return <section className="st-card" aria-label="自动化">
    <header><h3>自动化</h3><small>说一句想让它做什么、什么时候做，助手照着按时或按条件去做；发送、回复、发布始终由本人完成</small></header>
    <form className="st-automation-new" onSubmit={(event) => { event.preventDefault(); if (text.trim()) void create(); }}>
      <textarea value={text} onChange={(event) => setText(event.target.value)} rows={2} maxLength={1000} aria-label="新的自动化"
        placeholder="例如：每天早上 8 点把邮箱里和课程有关的邮件整理成待办；课程网页一更新就告诉我改了什么；每周五把这周新上传的材料归档" />
      <div className="st-row">
        <label className="st-row-label">服务哪条主线
          <select value={lineId} onChange={(event) => setLineId(event.target.value)}>{lines.map((line) => <option key={line.id} value={line.id}>{line.label}</option>)}</select>
        </label>
        <button type="submit" className="primary-button" disabled={!text.trim() || busy === "create"}>{busy === "create" ? "提交中…" : "建成自动化"}</button>
      </div>
    </form>
    {message && <p role="status" className="muted">{message}</p>}
    {view?.pending.map((item) => <p key={item.id} className="muted">正在设计：「{item.text.slice(0, 60)}」</p>)}
    {view && !view.automations.length && !view.pending.length && <p className="muted">还没有自动化。</p>}
    <ul className="st-rows">{view?.automations.map((item) => <li key={item.id} className="st-row st-automation">
      <span className="st-row-label"><b>{item.name}</b>{item.status === "off" ? "（已暂停）" : ""}
        <small>{item.triggerLabel} · {item.summary}</small>
        <small>{item.steps.map((step) => `${step.by === "person" ? "本人" : "助手"}：${step.title}`).join("；")}</small>
        <small>已运行 {item.runs} 次{item.lastFiredAt ? `，上次 ${day(item.lastFiredAt)}` : ""}</small></span>
      <span className="st-automation-actions">
        <button type="button" className="secondary-button" disabled={busy === item.id} onClick={() => void act(item.id, "run")}>立即运行</button>
        <button type="button" className="secondary-button" disabled={busy === item.id} onClick={() => void act(item.id, item.status === "off" ? "resume" : "pause")}>{item.status === "off" ? "恢复" : "暂停"}</button>
        <button type="button" className="secondary-button" disabled={busy === item.id} onClick={() => { if (window.confirm(`删除自动化「${item.name}」？`)) void act(item.id, "delete"); }}>删除</button>
      </span>
    </li>)}</ul>
    {Boolean(view?.runs.length) && <details className="st-fold"><summary>最近运行</summary>
      <ul className="st-list">{view!.runs.map((run) => <li key={`${run.automationId}:${run.firedAt}`}>
        <span>{day(run.firedAt)} · {nameOf(run.automationId)} · {RUN_STATE[run.state] ?? run.state}{run.detail ? `（${run.detail}）` : ""}</span>
        <small>{run.reason}</small>
      </li>)}</ul>
    </details>}
  </section>;
}
