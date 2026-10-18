"use client";

import { useState } from "react";
import { Sheet } from "../ui/overlay";
import { AttributePicker, type AttributeOption } from "../ui/attribute-picker";
import { composeGoal } from "@crossline/core";
import { LineCardInterview, type LineInterviewView } from "./line-card-interview";

/**
 * One line as its card shows it. `attributes`: the interview's candidates for the long-term goal (§4.1); `goalParts`: the ones the goal
 * was composed from, in order; the rest is the line's own interview inside the card (§4.2).
 */
export type LineCard = { id: string; label: string; color: string; goals: string[]; hard: boolean; rank: number | null; milestones: number;
  attributes: AttributeOption[]; goalParts: string[]; description: string; pendingEdit: { parts: string[] } | null; redraftDue: boolean;
  interview: LineInterviewView;
  /** Of `milestones`, how many are drafts waiting for approval. */
  drafts?: number };

const post = async (body: unknown) => {
  const response = await fetch("/api/lines", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  return { ok: Boolean(response?.ok), body: await response?.json().catch(() => null) as { id?: string; code?: string; message?: string } | null };
};
const FAILURE: Record<string, string> = { LINE_LABEL_REQUIRED: "需要主线名称（身份名词，如「研究者」）", LINE_LABEL_TAKEN: "已有同名主线",
  LINE_HARD_LIMIT: "硬约束最多两条" };

/**
 * One line, or a new one: its name (an identity noun — 研究者, 创作者), its long-term goal built from attributes (an existing line), any
 * further long-term goals, whether it is a hard constraint, and its colour.
 */
function LineEditor({ line, palette, onDone, onOrder }: { line?: LineCard; palette: Record<string, string>; onDone: () => void;
  /** Moves this line into the ranked order or out of it (to parallel); absent for a new line. */
  onOrder?: (() => void) | undefined }) {
  const [label, setLabel] = useState(line?.label ?? "");
  // For an existing line the first goal is built from attributes; the rows below are any further goals. A new line writes them freely.
  const [goals, setGoals] = useState<string[]>(line ? line.goals.slice(1) : [""]);
  const [hard, setHard] = useState(line?.hard ?? false);
  const [color, setColor] = useState(line?.color ?? "");
  const [status, setStatus] = useState("");
  const save = async (extra: Record<string, unknown> = {}) => {
    setStatus("保存中…");
    const kept = goals.filter((goal) => goal.trim());
    const result = await post({ ...(line ? { id: line.id } : {}), label, goals: line ? [...line.goals.slice(0, 1), ...kept] : kept, hard, ...(color ? { color } : {}), ...extra });
    if (!result.ok) { setStatus(FAILURE[result.body?.code ?? ""] ?? result.body?.message ?? "未保存，请重试"); return; }
    // A new line is set up by its own interview: what the person does on it, where they stand, what they want from it.
    if (!line && result.body?.id) { location.href = `/onboarding?line=${encodeURIComponent(result.body.id)}`; return; }
    onDone(); location.reload();
  };
  const adopt = async (parts: string[]) => {
    const result = await post({ id: line!.id, goalParts: parts });
    if (!result.ok) return result.body?.message ?? "未保存，请重试";
    location.reload();
    return "";
  };
  const noun = label.trim() || "身份";
  return <div className="line-editor">
    <label>主线（身份名词） <input value={label} maxLength={20} placeholder="例如：研究者、创作者、工程师" onChange={(event) => setLabel(event.target.value)} /></label>
    {line && <fieldset className="line-attr-section" data-line={line.id}><legend>长期目标：选定语组成，可多选、拖动排序、点击改字</legend>
      {line.goals[0] && <small className="muted">当前：<span className="gen">{line.goals[0]}</span></small>}
      <AttributePicker noun={line.label} candidates={line.attributes} initial={line.goalParts} onAdopt={adopt} />
    </fieldset>}
    <fieldset className="line-goals"><legend>{line ? "其他长期目标（可选）" : "长期目标（可多个）"}</legend>
      {goals.map((goal, index) => <div key={index} className="line-goal-row">
        <input value={goal} maxLength={120} placeholder={`成为 ___ 的${noun}`} aria-label={`长期目标 ${index + (line ? 2 : 1)}`}
          onChange={(event) => setGoals((list) => list.map((item, i) => i === index ? event.target.value : item))} />
        {(line || goals.length > 1) && <button type="button" aria-label="删除该目标" onClick={() => setGoals((list) => list.filter((_, i) => i !== index))}>×</button>}
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
      {line && onOrder && <button type="button" onClick={onOrder}>{line.rank ? "改为平行" : "加入主次"}</button>}
      {line && <button type="button" onClick={() => void save({ archived: true })}>归档主线</button>}
      {status && <small role="status">{status}</small>}
    </div>
  </div>;
}

/**
 * The goal as the person reads it: 「成为」, each attribute in its own rounded box (a deeper tint of the line's colour for each in turn, ink
 * text, so every box stays above 7:1), 「的」 between them, the identity noun last. A goal never split into attributes is shown whole.
 */
export function GoalChips({ line }: { line: Pick<LineCard, "label" | "goals" | "goalParts"> }) {
  if (!line.goalParts.length) return line.goals[0] ? <p className="lb-goal gen">{line.goals[0]}</p> : <p className="lb-goal muted">未设长期目标</p>;
  return <p className="lb-goal" aria-label={composeGoal(line.goalParts, line.label)}>
    <span className="lb-goal-word">成为</span>
    {/* The 「、」 ends the attribute before it, so a wrapped line never starts with one (W-24). */}
    {line.goalParts.map((part, index) => <span key={`${index}-${part}`} className="lb-attr-wrap">
      <span className="lb-attr gen" data-i={index % 3}>{part}</span><span className="lb-goal-word">{index < line.goalParts.length - 1 ? "的、" : "的"}</span></span>)}
    <span className="lb-goal-noun">{line.label}</span>
  </p>;
}

/**
 * The lines above the timeline, side by side in one row, in the person's 12–24 month order (ranked lines first, dragged into order by
 * their header; the first is the base), then the parallel ones. A hard constraint is only a tag. Each card shows the long-term goal as
 * attribute boxes, its milestones and drafts waiting, and the line's own interview behind 「访谈」 (open by itself while a goal change or a
 * redraft waits, or questions are open). A click on the name edits the line.
 */
export function LinesBar({ lines, palette }: { lines: LineCard[]; palette: Record<string, string> }) {
  const [editing, setEditing] = useState<LineCard | "new" | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [talking, setTalking] = useState<string | null>(null);
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
  const goalLink = (line: LineCard) => line.goalParts.length ? "调整定语 →"
    : line.attributes.length ? `${line.attributes.length} 个定语候选待选 →` : line.goals.length ? "调整长期目标 →" : "设定长期目标 →";
  const reorder = (line: LineCard) => () => void order(line.rank ? ranked.filter((item) => item.id !== line.id).map((item) => item.id)
    : [...ranked.map((item) => item.id), line.id]);
  const card = (line: LineCard, index?: number) => {
    const waiting = line.pendingEdit ? "目标修改待定" : line.redraftDue ? "可重算草稿" : line.interview.questions.length && !line.interview.waiting
      ? `${line.interview.questions.length} 个问题` : line.interview.waiting ? "整理中" : "";
    const open = talking === line.id;
    return <article key={line.id} className="lines-bar-card" data-line={line.id} data-open={open || undefined}
      onDragOver={(event) => event.preventDefault()} onDrop={() => dropOn(line.rank ? line.id : null)}>
      <header draggable={Boolean(line.rank)} onDragStart={() => setDragging(line.id)}>
        <button type="button" className="lines-bar-name" onClick={() => setEditing(line)}>{line.label}</button>
        {line.hard && <span className="tag">硬约束</span>}
        <small className="mono">{index !== undefined ? (index === 0 ? "底座" : `第 ${index + 1}`) : "平行"}</small>
      </header>
      <GoalChips line={line} />
      {line.goals.length > 1 && <small className="muted lb-more" title={line.goals.slice(1).join("；")}>另有 {line.goals.length - 1} 个长期目标</small>}
      <footer>
        <small className="mono">{line.milestones} 个里程碑{line.drafts ? ` · ${line.drafts} 待批准` : ""}</small>
        <button type="button" className="text-button lines-bar-goal-button" onClick={() => setEditing(line)}>{goalLink(line)}</button>
        <button type="button" className="text-button lb-talk" aria-expanded={open} onClick={() => setTalking(open ? null : line.id)}>
          访谈{waiting ? <span className="lb-talk-flag">{waiting}</span> : null}</button>
      </footer>
      <div className="lb-interview" hidden={!open}>
        <LineCardInterview lineId={line.id} label={line.label} description={line.description} interview={line.interview}
          pendingEdit={line.pendingEdit} redraftDue={line.redraftDue} />
      </div>
    </article>;
  };
  return <section className="lines-bar" aria-label="主线、主次与长期目标">
    <div className="lines-bar-row" style={{ ["--lines" as string]: String(lines.length) }} onDragOver={(event) => event.preventDefault()}>
      {ranked.map((line, index) => card(line, index))}
      {parallel.map((line) => card(line))}
      <button type="button" className="lines-bar-add" aria-label="新增主线" title="新增主线" onClick={() => setEditing("new")}>＋</button>
    </div>
    <Sheet title={editing === "new" ? "新增主线" : editing ? `主线：${editing.label}` : ""} open={editing !== null} onOpenChange={(open) => { if (!open) setEditing(null); }}>
      {editing && <LineEditor {...(editing === "new" ? {} : { line: editing, onOrder: reorder(editing) })} palette={palette} onDone={() => setEditing(null)} />}
    </Sheet>
  </section>;
}
