"use client";

import { useState } from "react";
import { Check, Flag, MessageSquare, Plus, RefreshCw, Sparkles, TriangleAlert } from "lucide-react";
import { Sheet } from "../ui/overlay";
import { ICON, IconButton } from "../ui/icon-button";
import type { LineHealth } from "./line-health";
import { AttributePicker, type AttributeOption } from "../ui/attribute-picker";
import { composeGoal } from "@crossline/core";
import { DOMAIN_PACKS, LINE_DOMAINS, type LineDomain } from "@crossline/identity-packs";
import { LineCardInterview, type LineInterviewView } from "./line-card-interview";
import { useLocale, useT } from "../locale-context";
import { DomainRecords, type DomainRecordsCard } from "./domain-records";

/**
 * One line as its card shows it. `attributes`: the interview's candidates for the long-term goal (§4.1); `goalParts`: the ones the goal
 * was composed from, in order; the rest is the line's own interview inside the card (§4.2).
 */
export type LineCard = { id: string; label: string; color: string; goals: string[]; hard: boolean; rank: number | null; milestones: number;
  /** The life domain the line covers (健康 / 财富), which brings its interview checklist, templates and records; null for none. */
  domain?: LineDomain | null;
  /** A domain line's numbers from its records (this month's money, this week's exercise). */
  records?: DomainRecordsCard | null;
  attributes: AttributeOption[]; goalParts: string[]; description: string; pendingEdit: { parts: string[] } | null; redraftDue: boolean;
  interview: LineInterviewView;
  /** Of `milestones`, how many are drafts waiting for approval. */
  drafts?: number;
  /** The line's standing from the schedule and the risk reviews (`lineHealth`), an estimate; null with no approved milestone. */
  health?: LineHealth | null;
  /** The line's share of the week the scheduler keeps (percent); absent when none is set. */
  share?: number };

/** Asks the page's 「新建里程碑」 form to open with this line chosen (`MilestoneActions` listens). */
export const NEW_MILESTONE_EVENT = "crossline:new-milestone";

const HEALTH_LABEL = { ok: "按计划 · 估计", watch: "需关注 · 估计", risk: "有风险 · 估计" } as const;

const post = async (body: unknown) => {
  const response = await fetch("/api/lines", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  return { ok: Boolean(response?.ok), body: await response?.json().catch(() => null) as { id?: string; code?: string; message?: string; lineId?: string } | null };
};
/** Kept in Chinese (they are the keys); translated where shown. */
const FAILURE: Record<string, string> = { LINE_LABEL_REQUIRED: "需要主线名称（身份名词，如「研究者」）", LINE_LABEL_TAKEN: "已有同名主线",
  LINE_HARD_LIMIT: "硬约束最多两条" };

/**
 * One line, or a new one: its name (an identity noun — 研究者, 创作者), its long-term goal built from attributes (an existing line), any
 * further long-term goals, whether it is a hard constraint, and its colour.
 */
function LineEditor({ line, palette, onDone, onOrder, names = {} }: { line?: LineCard; palette: Record<string, string>; onDone: () => void;
  /** Line id → name, so a domain another line already covers can be named. */
  names?: Record<string, string>;
  /** Moves this line into the ranked order or out of it (to parallel); absent for a new line. */
  onOrder?: (() => void) | undefined }) {
  const t = useT();
  const [label, setLabel] = useState(line?.label ?? "");
  // For an existing line the first goal is built from attributes; the rows below are any further goals. A new line writes them freely.
  const [goals, setGoals] = useState<string[]>(line ? line.goals.slice(1) : [""]);
  const [hard, setHard] = useState(line?.hard ?? false);
  const [color, setColor] = useState(line?.color ?? "");
  const [domain, setDomain] = useState<LineDomain | "">(line?.domain ?? "");
  const [status, setStatus] = useState("");
  const save = async (extra: Record<string, unknown> = {}) => {
    setStatus(t("保存中…"));
    const kept = goals.filter((goal) => goal.trim());
    const domainChange = line ? (domain !== (line.domain ?? "") ? { domain: domain || null } : {}) : domain ? { domain } : {};
    const result = await post({ ...(line ? { id: line.id } : {}), label, goals: line ? [...line.goals.slice(0, 1), ...kept] : kept, hard, ...(color ? { color } : {}), ...domainChange, ...extra });
    if (!result.ok && result.body?.code === "LINE_DOMAIN_TAKEN" && domain) {
      // One line per domain: name the line that has it, which can be changed instead of adding a second.
      setStatus(t("「{{line}}」已经是{{domain}}主线，可在那条主线里修改", { line: names[result.body.lineId ?? ""] ?? t("另一条主线"), domain: t(DOMAIN_PACKS[domain].label) })); return;
    }
    if (!result.ok) { const known = FAILURE[result.body?.code ?? ""]; setStatus(known ? t(known) : result.body?.message ?? t("未保存，请重试")); return; }
    // A new line is set up by its own interview: what the person does on it, where they stand, what they want from it.
    if (!line && result.body?.id) { location.href = `/onboarding?line=${encodeURIComponent(result.body.id)}`; return; }
    onDone(); location.reload();
  };
  const adopt = async (parts: string[]) => {
    const result = await post({ id: line!.id, goalParts: parts });
    if (!result.ok) return result.body?.message ?? t("未保存，请重试");
    location.reload();
    return "";
  };
  const noun = label.trim() || t("身份");
  return <div className="line-editor">
    <label>{t("主线（身份名词）")} <input value={label} maxLength={20} placeholder={t("例如：研究者、创作者、工程师")} onChange={(event) => setLabel(event.target.value)} /></label>
    {line && <fieldset className="line-attr-section" data-line={line.id}><legend>{t("长期目标：选定语组成，可多选、拖动排序、点击改字")}</legend>
      {line.goals[0] && <small className="muted">{t("当前：")}<span className="gen">{line.goals[0]}</span></small>}
      <AttributePicker noun={line.label} candidates={line.attributes} initial={line.goalParts} onAdopt={adopt} />
    </fieldset>}
    <fieldset className="line-goals"><legend>{line ? t("其他长期目标（可选）") : t("长期目标（可多个）")}</legend>
      {goals.map((goal, index) => <div key={index} className="line-goal-row">
        <input value={goal} maxLength={120} placeholder={t("成为 ___ 的{{noun}}", { noun })} aria-label={t("长期目标 {{n}}", { n: index + (line ? 2 : 1) })}
          onChange={(event) => setGoals((list) => list.map((item, i) => i === index ? event.target.value : item))} />
        {(line || goals.length > 1) && <button type="button" aria-label={t("删除该目标")} onClick={() => setGoals((list) => list.filter((_, i) => i !== index))}>×</button>}
      </div>)}
      <button type="button" className="text-button" onClick={() => setGoals((list) => [...list, ""])}>{t("＋ 添加长期目标")}</button>
    </fieldset>
    <fieldset className="line-domain"><legend>{t("领域（带固定的访谈清单、里程碑模板与记录）")}</legend>
      {(["", ...LINE_DOMAINS] as const).map((id) => <label key={id || "none"}><input type="radio" name={`domain-${line?.id ?? "new"}`} checked={domain === id}
        onChange={() => { setDomain(id); if (!line && id && !label.trim()) setLabel(t(DOMAIN_PACKS[id].noun)); }} />{id ? t(DOMAIN_PACKS[id].label) : t("无")}</label>)}
    </fieldset>
    <label className="line-hard"><input type="checkbox" checked={hard} onChange={(event) => setHard(event.target.checked)} />
      {t("硬约束：其固定日程是不可移动的骨架、截止日优先，可用时段由它推出（最多两条）")}</label>
    <fieldset className="line-swatches"><legend>{t("颜色")}</legend>
      {Object.entries(palette).map(([key, hex]) => <button key={key} type="button" aria-label={t("颜色 {{name}}", { name: key })} aria-pressed={color === key || (!color && line?.color === key)}
        style={{ background: hex }} onClick={() => setColor(key)} />)}
    </fieldset>
    {!line && <small className="muted">{t("保存后进入该主线的访谈：了解现状与目标，再生成里程碑草稿。")}</small>}
    <div className="line-editor-actions">
      <button type="button" className="primary-button" disabled={!label.trim()} onClick={() => void save()}>{line ? t("保存") : t("新增并开始访谈")}</button>
      {line && <a className="secondary-button" href={`/onboarding?line=${encodeURIComponent(line.id)}`}>{t("重新访谈该主线")}</a>}
      {line && onOrder && <button type="button" onClick={onOrder}>{line.rank ? t("改为平行") : t("加入主次")}</button>}
      {line && <button type="button" onClick={() => void save({ archived: true })}>{t("归档主线")}</button>}
      {status && <small role="status">{status}</small>}
    </div>
  </div>;
}

/**
 * The goal as the person reads it: 「成为」, each attribute in its own rounded box (a deeper tint of the line's colour for each in turn, ink
 * text, so every box stays above 7:1), 「的」 between them, the identity noun last. A goal never split into attributes is shown whole.
 */
export function GoalChips({ line }: { line: Pick<LineCard, "label" | "goals" | "goalParts"> }) {
  const t = useT();
  const english = useLocale() === "en";
  if (!line.goalParts.length) return line.goals[0] ? <p className="lb-goal gen">{line.goals[0]}</p> : <p className="lb-goal muted">{t("未设长期目标")}</p>;
  // English reads 「Become A, B researcher」: no 「的」 after each attribute.
  return <p className="lb-goal" aria-label={english ? t("成为 {{goal}}", { goal: `${line.goalParts.join(", ")} ${line.label}` }) : composeGoal(line.goalParts, line.label)}>
    <span className="lb-goal-word">{t("成为")}</span>
    {/* The 「、」 ends the attribute before it, so a wrapped line never starts with one (W-24). */}
    {line.goalParts.map((part, index) => <span key={`${index}-${part}`} className="lb-attr-wrap">
      <span className="lb-attr gen" data-i={index % 3}>{part}</span>
      {english ? (index < line.goalParts.length - 1 ? <span className="lb-goal-word">,</span> : null)
        : <span className="lb-goal-word">{index < line.goalParts.length - 1 ? "的、" : "的" /* i18n-ignore: Chinese grammar, not drawn in English */}</span>}</span>)}
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
  const t = useT();
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
  const goalLink = (line: LineCard) => line.goalParts.length ? t("调整定语")
    : line.attributes.length ? t("{{count}} 个定语候选待选", { count: line.attributes.length }) : line.goals.length ? t("调整长期目标") : t("设定长期目标");
  const reorder = (line: LineCard) => () => void order(line.rank ? ranked.filter((item) => item.id !== line.id).map((item) => item.id)
    : [...ranked.map((item) => item.id), line.id]);
  // 重算草稿 straight from the card's icon (2026-10-28): the line's untouched drafts are redesigned, approved milestones never move.
  const [redraft, setRedraft] = useState<Record<string, string>>({});
  const redoDrafts = async (line: LineCard) => {
    setRedraft((current) => ({ ...current, [line.id]: "running" }));
    const response = await fetch("/api/milestones/propose", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: "", only: [line.id] }) }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as { state?: string; drafts?: unknown[]; message?: string; blocker?: { message?: string } } | undefined;
    if (!response?.ok || body?.state === "blocked") {
      setRedraft((current) => ({ ...current, [line.id]: t("{{reason}}，可以稍后重试", { reason: body?.message ?? body?.blocker?.message ?? t("未完成") }) }));
      return;
    }
    location.reload();
  };
  const card = (line: LineCard, index?: number) => {
    const waiting = line.pendingEdit ? t("目标修改待定") : line.interview.questions.length && !line.interview.waiting
      ? t("{{count}} 个问题", { count: line.interview.questions.length }) : line.interview.waiting ? t("整理中") : "";
    const open = talking === line.id;
    const health = line.health;
    const progress = health && health.total ? Math.round(health.reached / health.total * 100) : 0;
    const running = redraft[line.id] === "running";
    return <article key={line.id} className="lines-bar-card" data-line={line.id} data-open={open || undefined}
      onDragOver={(event) => event.preventDefault()} onDrop={() => dropOn(line.rank ? line.id : null)}>
      <header draggable={Boolean(line.rank)} onDragStart={() => setDragging(line.id)}>
        <button type="button" className="lines-bar-name" onClick={() => setEditing(line)}>{line.label}</button>
        <span className="tag lb-rank">{index !== undefined ? (index === 0 ? t("底座") : t("第 {{n}}", { n: index + 1 })) : t("平行")}</span>
        {line.hard && <span className="tag">{t("硬约束")}</span>}
        {line.domain && <span className="tag">{t(DOMAIN_PACKS[line.domain].label)}</span>}
        {health && <span className="lb-health" data-level={health.level}
          title={t("估计（按排程与风险审查，未经本人确认）：{{open}} 个进行中的里程碑，{{risky}} 个有风险，{{watch}} 个需关注", { open: health.open, risky: health.risky, watch: health.watch })}>
          {health.level === "ok" ? <Check {...ICON} /> : <TriangleAlert {...ICON} />}{t(HEALTH_LABEL[health.level])}</span>}
      </header>
      <GoalChips line={line} />
      {line.goals.length > 1 && <small className="muted lb-more" title={line.goals.slice(1).join(t("；"))}>{t("另有 {{count}} 个长期目标", { count: line.goals.length - 1 })}</small>}
      <p className="lb-progress"><Flag {...ICON} />
        <span className="mono">{t("{{done}}/{{count}} 里程碑", { done: health?.reached ?? 0, count: line.milestones })}{line.drafts ? ` · ${t("{{n}} 待批准", { n: line.drafts })}` : ""}</span>
        <span className="lb-progress-bar" aria-hidden="true"><i style={{ width: `${progress}%` }} /></span></p>
      {line.records && <DomainRecords card={line.records} />}
      <footer>
        <span className="lb-talk-wrap">
          <IconButton label={waiting ? t("访谈：{{state}}", { state: waiting }) : t("访谈")} icon={<MessageSquare {...ICON} />} className="lb-talk" aria-expanded={open}
            onClick={() => setTalking(open ? null : line.id)} />
          {waiting ? <span className="lb-talk-flag">{waiting}</span> : null}</span>
        <IconButton label={running ? t("正在重算该主线未动过的草稿…") : line.redraftDue ? t("目标已变，重算未动过的草稿") : t("重算这条线未动过的草稿")}
          icon={<RefreshCw {...ICON} />} className="lb-redraft" data-due={line.redraftDue || undefined} disabled={running} onClick={() => void redoDrafts(line)} />
        <IconButton label={t("给这条线新建里程碑")} icon={<Plus {...ICON} />}
          onClick={() => window.dispatchEvent(new CustomEvent(NEW_MILESTONE_EVENT, { detail: { lineId: line.id } }))} />
        <IconButton label={goalLink(line)} icon={<Sparkles {...ICON} />} className="lines-bar-goal-button" onClick={() => setEditing(line)} />
        {line.share ? <small className="mono lb-share" title={t("每周至少得到的可用时间份额，在计划页调整")}>{t("{{n}}% 时间", { n: line.share })}</small> : null}
      </footer>
      {redraft[line.id] && <small role="status" className="lb-redraft-status">{running ? t("正在重算该主线未动过的草稿…（通常 2–5 分钟，已批准的里程碑不变）") : redraft[line.id]}</small>}
      <div className="lb-interview" hidden={!open}>
        <LineCardInterview lineId={line.id} label={line.label} description={line.description} interview={line.interview}
          pendingEdit={line.pendingEdit} redraftDue={line.redraftDue} />
      </div>
    </article>;
  };
  return <section className="lines-bar" aria-label={t("主线、主次与长期目标")}>
    <div className="lines-bar-row" style={{ ["--lines" as string]: String(lines.length) }} onDragOver={(event) => event.preventDefault()}>
      {ranked.map((line, index) => card(line, index))}
      {parallel.map((line) => card(line))}
      <button type="button" className="lines-bar-add" aria-label={t("新增主线")} title={t("新增主线")} onClick={() => setEditing("new")}>＋</button>
    </div>
    <Sheet title={editing === "new" ? t("新增主线") : editing ? t("主线：{{label}}", { label: editing.label }) : ""} open={editing !== null} onOpenChange={(open) => { if (!open) setEditing(null); }}>
      {editing && <LineEditor {...(editing === "new" ? {} : { line: editing, onOrder: reorder(editing) })} palette={palette} names={Object.fromEntries(lines.map((item) => [item.id, item.label]))} onDone={() => setEditing(null)} />}
    </Sheet>
  </section>;
}
