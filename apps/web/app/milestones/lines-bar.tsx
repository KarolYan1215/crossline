"use client";

import { useState } from "react";
import { Sheet } from "../ui/overlay";

export type LineCard = { id: string; label: string; color: string; goal: string; milestones: number };

const post = async (body: unknown) => {
  const response = await fetch("/api/lines", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  return { ok: Boolean(response?.ok), body: await response?.json().catch(() => null) as { id?: string; code?: string } | null };
};
const FAILURE: Record<string, string> = { LINE_LABEL_REQUIRED: "需要主线名称", LINE_LABEL_TAKEN: "已有同名主线" };

/** The editor for one line, or for a new one: its name, its long-term goal (who the person is becoming on it) and its colour. */
function LineEditor({ line, palette, onDone }: { line?: LineCard; palette: Record<string, string>; onDone: () => void }) {
  const [label, setLabel] = useState(line?.label ?? "");
  const [goal, setGoal] = useState(line?.goal ?? "");
  const [color, setColor] = useState(line?.color ?? "");
  const [status, setStatus] = useState("");
  const save = async (extra: Record<string, unknown> = {}) => {
    setStatus("保存中…");
    const result = await post({ ...(line ? { id: line.id } : {}), label, goal, ...(color ? { color } : {}), ...extra });
    if (!result.ok) { setStatus(FAILURE[result.body?.code ?? ""] ?? "未保存，请重试"); return; }
    // A new line is set up by its own interview: what the person does on it, where they stand, what they want from it.
    if (!line && result.body?.id) { location.href = `/onboarding?line=${encodeURIComponent(result.body.id)}`; return; }
    onDone(); location.reload();
  };
  return <div className="line-editor">
    <label>名称 <input value={label} maxLength={20} placeholder="例如：音乐创作" onChange={(event) => setLabel(event.target.value)} /></label>
    <label>长期目标 <textarea value={goal} maxLength={300} rows={2} placeholder="这条主线上想成为什么样的人（抽象描述，不写具体日期）"
      onChange={(event) => setGoal(event.target.value)} /></label>
    <fieldset className="line-swatches"><legend>颜色</legend>
      {Object.entries(palette).map(([key, hex]) => <button key={key} type="button" aria-label={`颜色 ${key}`} aria-pressed={color === key || (!color && line?.color === key)}
        style={{ background: hex }} onClick={() => setColor(key)} />)}
    </fieldset>
    {!line && <small className="muted">保存后进入该主线的访谈：了解现状与目标，再生成里程碑草稿。</small>}
    <div className="line-editor-actions">
      <button type="button" className="primary-button" disabled={!label.trim()} onClick={() => void save()}>{line ? "保存" : "新增并开始访谈"}</button>
      {line && <a className="secondary-button" href={`/onboarding?line=${encodeURIComponent(line.id)}`}>重新访谈该主线</a>}
      {line && <button type="button" onClick={() => void save({ archived: true })}>归档主线</button>}
      {status && <small role="status">{status}</small>}
    </div>
  </div>;
}

/**
 * The lines, above the timeline: each with its colour, name, long-term goal and how many milestones it has; a click edits it, and
 * 新增主线 adds one (its interview follows). The long-term goal is the abstract layer above milestones.
 */
export function LinesBar({ lines, palette }: { lines: LineCard[]; palette: Record<string, string> }) {
  const [editing, setEditing] = useState<LineCard | "new" | null>(null);
  return <section className="lines-bar" aria-label="主线与长期目标">
    {lines.map((line) => <button key={line.id} type="button" className="lines-bar-card" data-line={line.id} onClick={() => setEditing(line)}>
      <b>{line.label}</b>
      <span>{line.goal || "未设长期目标"}</span>
      <small className="mono">{line.milestones} 个里程碑</small>
    </button>)}
    <button type="button" className="lines-bar-card lines-bar-add" onClick={() => setEditing("new")}>＋ 新增主线</button>
    <Sheet title={editing === "new" ? "新增主线" : editing ? `主线：${editing.label}` : ""} open={editing !== null} onOpenChange={(open) => { if (!open) setEditing(null); }}>
      {editing && <LineEditor {...(editing === "new" ? {} : { line: editing })} palette={palette} onDone={() => setEditing(null)} />}
    </Sheet>
  </section>;
}
