"use client";

import { useState } from "react";
import { Sheet } from "../ui/overlay";

export type LineCard = { id: string; label: string; color: string; goals: string[]; hard: boolean; rank: number | null; milestones: number };

const post = async (body: unknown) => {
  const response = await fetch("/api/lines", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  return { ok: Boolean(response?.ok), body: await response?.json().catch(() => null) as { id?: string; code?: string } | null };
};
const FAILURE: Record<string, string> = { LINE_LABEL_REQUIRED: "需要主线名称（身份名词，如「研究者」）", LINE_LABEL_TAKEN: "已有同名主线",
  LINE_HARD_LIMIT: "硬约束最多两条" };

/**
 * One line, or a new one: its name (an identity noun — 研究者, 创作者), its long-term goals (each 「成为 ___ 的 <身份>」; several are
 * normal), whether it is a hard constraint, and its colour.
 */
function LineEditor({ line, palette, onDone }: { line?: LineCard; palette: Record<string, string>; onDone: () => void }) {
  const [label, setLabel] = useState(line?.label ?? "");
  const [goals, setGoals] = useState<string[]>(line?.goals.length ? line.goals : [""]);
  const [hard, setHard] = useState(line?.hard ?? false);
  const [color, setColor] = useState(line?.color ?? "");
  const [status, setStatus] = useState("");
  const save = async (extra: Record<string, unknown> = {}) => {
    setStatus("保存中…");
    const result = await post({ ...(line ? { id: line.id } : {}), label, goals: goals.filter((goal) => goal.trim()), hard, ...(color ? { color } : {}), ...extra });
    if (!result.ok) { setStatus(FAILURE[result.body?.code ?? ""] ?? "未保存，请重试"); return; }
    // A new line is set up by its own interview: what the person does on it, where they stand, what they want from it.
    if (!line && result.body?.id) { location.href = `/onboarding?line=${encodeURIComponent(result.body.id)}`; return; }
    onDone(); location.reload();
  };
  const noun = label.trim() || "身份";
  return <div className="line-editor">
    <label>主线（身份名词） <input value={label} maxLength={20} placeholder="例如：研究者、创作者、工程师" onChange={(event) => setLabel(event.target.value)} /></label>
    <fieldset className="line-goals"><legend>长期目标（可多个）</legend>
      {goals.map((goal, index) => <div key={index} className="line-goal-row">
        <input value={goal} maxLength={120} placeholder={`成为 ___ 的${noun}`} aria-label={`长期目标 ${index + 1}`}
          onChange={(event) => setGoals((list) => list.map((item, i) => i === index ? event.target.value : item))} />
        {goals.length > 1 && <button type="button" aria-label="删除该目标" onClick={() => setGoals((list) => list.filter((_, i) => i !== index))}>×</button>}
      </div>)}
      <button type="button" className="text-button" onClick={() => setGoals((list) => [...list, ""])}>＋ 添加长期目标</button>
    </fieldset>
    <label className="line-hard"><input type="checkbox" checked={hard} onChange={(event) => setHard(event.target.checked)} />
      硬约束：其固定日程是不可移动的骨架、截止日优先，可用时段由它推出（最多两条）</label>
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
 * The lines above the timeline, in the person's 12–24 month order: ranked lines first (dragged into order; the first is the base), the
 * others in parallel. Each shows its long-term goals, whether it is a hard constraint, and its milestones. A click edits it.
 */
export function LinesBar({ lines, palette }: { lines: LineCard[]; palette: Record<string, string> }) {
  const [editing, setEditing] = useState<LineCard | "new" | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const ranked = lines.filter((line) => line.rank).sort((a, b) => a.rank! - b.rank!);
  const parallel = lines.filter((line) => !line.rank);
  const order = async (ids: string[]) => { if ((await post({ order: ids })).ok) location.reload(); };
  const dropOn = (target: string | null) => {
    if (!dragging) return;
    const rest = ranked.map((line) => line.id).filter((id) => id !== dragging);
    const at = target ? rest.indexOf(target) : rest.length;
    void order([...rest.slice(0, at < 0 ? rest.length : at), dragging, ...rest.slice(at < 0 ? rest.length : at)]);
    setDragging(null);
  };
  const card = (line: LineCard, index?: number) => <article key={line.id} className="lines-bar-card" data-line={line.id} draggable
    onDragStart={() => setDragging(line.id)} onDragOver={(event) => event.preventDefault()} onDrop={() => dropOn(line.rank ? line.id : null)}>
    <header>
      <button type="button" className="lines-bar-name" onClick={() => setEditing(line)}>{line.label}</button>
      {line.hard && <span className="tag">硬约束</span>}
      <small className="mono">{index !== undefined ? (index === 0 ? "底座" : `第 ${index + 1}`) : "平行"}</small>
    </header>
    {line.goals.length ? <ul>{line.goals.map((goal) => <li key={goal}>{goal}</li>)}</ul> : <span className="muted">未设长期目标</span>}
    <footer><small className="mono">{line.milestones} 个里程碑</small>
      {line.rank ? <button type="button" className="text-button" onClick={() => void order(ranked.filter((item) => item.id !== line.id).map((item) => item.id))}>改为平行</button>
        : <button type="button" className="text-button" onClick={() => void order([...ranked.map((item) => item.id), line.id])}>加入主次</button>}</footer>
  </article>;
  return <section className="lines-bar" aria-label="主线、主次与长期目标">
    {ranked.length > 0 && <div className="lines-bar-group" onDragOver={(event) => event.preventDefault()} onDrop={() => dropOn(null)}>
      <h3>未来 12–24 个月主次 <small className="muted">拖动排序</small></h3>
      <div className="lines-bar-row">{ranked.map((line, index) => card(line, index))}</div>
    </div>}
    <div className="lines-bar-group">
      {ranked.length > 0 && parallel.length > 0 && <h3>平行</h3>}
      <div className="lines-bar-row">{parallel.map((line) => card(line))}
        <button type="button" className="lines-bar-card lines-bar-add" onClick={() => setEditing("new")}>＋ 新增主线</button></div>
    </div>
    <Sheet title={editing === "new" ? "新增主线" : editing ? `主线：${editing.label}` : ""} open={editing !== null} onOpenChange={(open) => { if (!open) setEditing(null); }}>
      {editing && <LineEditor {...(editing === "new" ? {} : { line: editing })} palette={palette} onDone={() => setEditing(null)} />}
    </Sheet>
  </section>;
}
