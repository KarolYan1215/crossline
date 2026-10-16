"use client";

import { useRef, useState } from "react";
import { STEP_ROLES, localStamp, plainEstimateWords } from "@crossline/core";
import type { TaskDetail } from "../../lib/task-detail";
import { Sheet } from "../ui/overlay";
import { ProgressRing, formatMinutes, dayLabel } from "../ui/controls";
import { ArtifactTag, SupportsTag, Tag } from "../ui/tag";
import { Clamp } from "../ui/clamp";
import { riskLabel, riskTone, stateLabelFor } from "../../lib/labels";
import { Conversation } from "../chat/conversation";
import { ExecutionActions } from "../execution-actions";
import { currentStep } from "./card-model";
import { CompletionChoice } from "./completion-choice";
import { PostponePanel } from "./postpone";
import { StepDuration, TaskQuickEdit } from "./quick-edit";
import { StepStrip } from "./step-strip";
import { TaskActions } from "./task-actions";
import { StepMaterials, TaskMaterials } from "./task-materials";
import { stepAnchor, tutorialAnchor } from "../materials/tutorial-model";

const post = (path: string, body: unknown) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then((response) => response.ok).catch(() => false);
const stepsApi = (id: string) => `/api/work-orders/${encodeURIComponent(id)}/steps`;
type Step = NonNullable<TaskDetail["stepPlan"]>["steps"][number];

/**
 * The steps, read top to bottom: done ones folded to a line, the current one open with its first move, what counts as done and why it is
 * there, the others a line each that opens on a click. Editing (reorder, rename, add, remove, a one-line replan) is a mode of its own, so
 * the list reads as a plan rather than a form.
 */
function StepsPanel({ detail }: { detail: TaskDetail }) {
  const plan = detail.stepPlan;
  const current = currentStep(detail);
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(current ? [current.id] : []));
  const [status, setStatus] = useState("");
  const division = (detail.humanCore.length > 0 || detail.automationParts.length > 0) && <dl className="steps-division">
    {detail.humanCore.length > 0 && <div><dt>本人负责</dt>{detail.humanCore.map((part) => <dd key={part.id} className="gen">{part.intent}</dd>)}</div>}
    {detail.automationParts.length > 0 && <div><dt>系统准备</dt>{detail.automationParts.map((part) => <dd key={part.id} className="gen">{part.intent}</dd>)}</div>}
  </dl>;
  if (!plan) return <div className="steps-panel"><p className="muted">步骤规划中，完成后显示在此处。</p>{division}</div>;
  if (editing) return <div className="steps-panel"><StepsEditor detail={detail} onDone={() => setEditing(false)} />{division}</div>;
  const toggle = (id: string) => setExpanded((set) => { const next = new Set(set); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  return <div className="steps-panel">
    <p className="steps-meta"><small>{plan.archetypeLabel} · {plan.quantity.amount > 0 ? `${plan.quantity.amount} ${plan.quantity.unit}` : plan.quantity.basis}</small>
      <button type="button" className="text-button" onClick={() => setEditing(true)}>调整步骤</button></p>
    {plan.rationale && <p className="gen steps-rationale"><Clamp text={plainEstimateWords(plan.rationale)} /></p>}
    {plan.units.length > 0 && <p className="steps-units"><small>依据材料的内容</small>{plan.units.map((unit) => <span key={unit.id} className="tag" title={unit.quote}>{unit.title}</span>)}</p>}
    {plan.questions.length > 0 && <p className="steps-questions"><small>需要本人回答后才能定下的</small>{plan.questions.map((question) => <a key={question.id} href="/approvals">{question.text}</a>)}</p>}
    <ol className="steps-list">{plan.steps.map((step, index) => {
      const open = expanded.has(step.id);
      const kind = step.status !== "planned" ? "done" : step.executor === "agent" ? "agent" : step === current ? "current" : "open";
      return <li key={step.id} id={stepAnchor(step.id)} className="step-row" data-kind={kind} data-open={open || undefined}>
        <span className="step-index mono" aria-hidden="true">{index + 1}</span>
        <StepRing detail={detail} step={step} />
        <div className="step-body">
          <button type="button" className="step-head" aria-expanded={open} onClick={() => toggle(step.id)}>
            <span className="step-title">{step.title}</span>
            <span className="step-facts">
              {kind === "current" && <Tag tone="info">当前</Tag>}
              {kind === "agent" && <Tag>助手准备 · {agentState(detail, step)}</Tag>}
              {kind === "done" && <Tag tone="ok">{step.status === "done" ? "已完成" : "已跳过"}</Tag>}
              {step.schedulable && kind !== "done" && <small className="mono">约 {formatMinutes(step.estimate.p50Minutes)}</small>}
              {(step.notBefore || step.dueBy) && kind !== "done" && <small className="mono">{step.notBefore ? dayLabel(step.notBefore) : "…"} → {step.dueBy ? dayLabel(step.dueBy) : "…"}</small>}
            </span>
          </button>
          {kind === "current" && step.firstAction && <p className="step-first"><small>先做</small><span className="gen">{step.firstAction}</span></p>}
          {open && <StepDetail detail={detail} step={step} kind={kind} onStatus={setStatus} />}
        </div>
      </li>;
    })}</ol>
    {status && <small role="status">{status}</small>}
    {division}
  </div>;
}

const agentState = (detail: TaskDetail, step: Step) => {
  const run = [...detail.agentOutputs].reverse().find((task) => task.stepId === step.id);
  return !run ? "待开始" : run.status === "running" ? "准备中" : run.status === "blocked" || run.status === "stale" ? "未做成" : run.status === "rejected" ? "未采用" : "已备好";
};

/** A step's ring: clicking an open step of the person's marks it done. */
function StepRing({ detail, step }: { detail: TaskDetail; step: Step }) {
  if (step.status !== "planned") return <ProgressRing quarters={4} label={step.title} />;
  if (step.executor === "agent") return <span className="ui-ring step-ring-agent" aria-hidden="true" />;
  return <ProgressRing quarters={step.progressQuarter} label={step.title}
    onConfirm={() => void post(stepsApi(detail.id), { action: "progress", stepId: step.id, status: "done" }).then((ok) => ok && location.reload())} />;
}

/** What a step is for and what it has: its done criterion, why it is there, what it covers, the AI tool it assumes, and its own files. */
function StepDetail({ detail, step, kind, onStatus }: { detail: TaskDetail; step: Step; kind: string; onStatus: (text: string) => void }) {
  const covered = (detail.stepPlan?.units ?? []).filter((unit) => (step.covers ?? []).includes(unit.id)).map((unit) => unit.title);
  return <div className="step-detail">
    {kind !== "current" && step.firstAction && kind !== "done" && <p className="step-first"><small>先做</small><span className="gen">{step.firstAction}</span></p>}
    {step.doneCriterion && <p className="step-line"><small>完成标准</small><span className="gen">{step.doneCriterion}</span></p>}
    {step.deliverable && kind === "agent" && <p className="step-line"><small>产出</small><span className="gen">{step.deliverable}</span></p>}
    {covered.length > 0 && <p className="step-line"><small>内容</small><span className="step-covers">{covered.map((title) => <span key={title} className="tag">{title}</span>)}</span></p>}
    {step.why && <p className="step-line"><small>为什么</small><span className="gen">{step.why}</span></p>}
    {step.aiAssist?.tool && <p className="step-line" title="计划按用这个工具估算时间"><small>工具</small><span><Tag tone="info">{step.aiAssist.tool}</Tag> <span className="gen">{step.aiAssist.how}</span>
      {step.aiAssist.minutesSaved > 0 && <span className="muted">（约省 {step.aiAssist.minutesSaved} 分钟）</span>}</span></p>}
    {step.tickOutcome && <p className="step-line step-tick" title="里程碑刻度"><small>刻度</small><span>◆ {step.tickOutcome}</span></p>}
    <StepMaterials detail={detail} stepId={step.id} />
    {/* Only the person's own steps have a tutorial section; the assistant's and shared steps do not. */}
    {step.executor === "human" && kind !== "done" && detail.preparedMaterials.some((item) => /manual\.md$/.test(item.uri)) && <p className="step-line"><small>教程</small>
      <a href={`#${tutorialAnchor(step.id)}`}>本步的教程与材料</a></p>}
    {kind !== "done" && kind !== "agent" && step.schedulable && <div className="step-line"><small>时长</small><StepDuration workOrderId={detail.id} stepId={step.id} estimate={step.estimate} /></div>}
    {kind !== "done" && step.executor !== "human" && <p className="step-line"><span />
      <button type="button" className="secondary-button step-agent" onClick={() => void post("/api/agent/dispatch", { workOrderId: detail.id, stepId: step.id })
        .then((ok) => onStatus(ok ? `已交给 Agent：${step.title}` : "未能交给 Agent"))}>由 Agent 完成该步骤</button></p>}
  </div>;
}

/** The step list as a form: drag or arrow to reorder, rename in place, add, remove, save; or ask for a replan in one line. */
function StepsEditor({ detail, onDone }: { detail: TaskDetail; onDone: () => void }) {
  const plan = detail.stepPlan!;
  const [draft, setDraft] = useState(() => plan.steps.filter((step) => step.status === "planned").map((step) => ({ id: step.id as string | undefined, title: step.title })));
  const [dirty, setDirty] = useState(false);
  const [dragging, setDragging] = useState<number | null>(null);
  const [fix, setFix] = useState("");
  const [status, setStatus] = useState("");
  const move = (from: number, to: number) => { setDraft((list) => { const next = [...list]; const [item] = next.splice(from, 1); next.splice(to, 0, item!); return next; }); setDirty(true); };
  return <>
    <ol className="steps-list steps-editing">{draft.map((item, index) => <li key={item.id ?? `new-${index}`} draggable onDragStart={() => setDragging(index)} onDragOver={(event) => event.preventDefault()}
      onDrop={() => { if (dragging !== null && dragging !== index) move(dragging, index); setDragging(null); }}>
      <span className="step-grip" aria-hidden="true">⋮⋮</span>
      <input value={item.title} aria-label="步骤名称" onChange={(event) => { const title = event.target.value; setDraft((list) => list.map((row, i) => i === index ? { ...row, title } : row)); setDirty(true); }} />
      <span className="step-tools">
        {index > 0 && <button type="button" aria-label="上移" onClick={() => move(index, index - 1)}>↑</button>}
        {index < draft.length - 1 && <button type="button" aria-label="下移" onClick={() => move(index, index + 1)}>↓</button>}
        <button type="button" aria-label="删除步骤" onClick={() => { setDraft((list) => list.filter((_, i) => i !== index)); setDirty(true); }}>×</button>
      </span>
    </li>)}</ol>
    <div className="steps-actions">
      <button type="button" onClick={() => { setDraft((list) => [...list, { id: undefined, title: "" }]); setDirty(true); }}>＋ 添加步骤</button>
      {dirty && <button type="button" className="primary-button" onClick={() => void post(stepsApi(detail.id), { action: "edit", steps: draft }).then((ok) => ok ? location.reload() : setStatus("未保存，请重试"))}>保存步骤</button>}
      <button type="button" onClick={onDone}>{dirty ? "放弃修改" : "完成"}</button>
    </div>
    <form className="steps-fix" onSubmit={(event) => { event.preventDefault(); if (!fix.trim()) return;
      void post(stepsApi(detail.id), { action: "replan", feedback: fix }).then((ok) => { setStatus(ok ? "已提交，正在重新规划" : "未提交，请重试"); if (ok) setFix(""); }); }}>
      <input value={fix} maxLength={1000} placeholder="用一句话调整步骤，例如：先做第 3 题，检查合并到最后" aria-label="用自然语言调整步骤" onChange={(event) => setFix(event.target.value)} />
      <button type="submit">重新规划</button>
    </form>
    {status && <small role="status">{status}</small>}
  </>;
}

/**
 * Handing in: what the task is judged against (rings a click confirms, the deliverables it promised), a progress report in words for the
 * judge, then completion with its evidence and the time it took — the existing completion path (`ExecutionActions`).
 */
function FinishPanel({ detail }: { detail: TaskDetail }) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState("");
  const by: Record<string, string> = { person: "本人确认", assessment: "进度判定", gate: "闸门判定", none: "未判定" };
  // Before work starts there is nothing to complete: the primary action above starts it, and this section says what will be asked.
  const notStarted = ["awaiting_plan_approval", "approved", "ready_for_human", "blocked"].includes(detail.state);
  return <div className="finish-panel">
    <CompletionChoice detail={detail} />
    {detail.evidenceContract.length > 0 && <div><h4 className="task-subhead">要交付的</h4>
      <ul className="standards-contract">{detail.evidenceContract.map((item, index) => <li key={index}>
        <Tag tone={item.required ? "info" : "neutral"}>{item.required ? "必交" : "可选"}</Tag><span>{item.description}</span></li>)}</ul></div>}
    <div><h4 className="task-subhead">达成标准</h4>
      {detail.criteria.length ? <ul className="standards-list">{detail.criteria.map((criterion) => <li key={criterion.id}>
        <ProgressRing quarters={criterion.quarters} label={criterion.statement}
          {...(criterion.quarters < 4 ? { onConfirm: () => void post(stepsApi(detail.id), { action: "confirm_criterion", criterionId: criterion.id }).then((ok) => ok && location.reload()) } : {})} />
        <span>{criterion.statement}{criterion.note && <small className="gen">{criterion.note}</small>}</span>
        <Tag>{by[criterion.by]}</Tag>
      </li>)}</ul> : <p className="muted">所属里程碑未设置达成标准。</p>}</div>
    {!notStarted && <form className="progress-report" onSubmit={(event) => { event.preventDefault(); if (!text.trim()) return;
      void post(stepsApi(detail.id), { action: "report", text }).then((ok) => { setStatus(ok ? "已提交，正在判定进度" : "未提交，请重试"); if (ok) setText(""); }); }}>
      <textarea value={text} maxLength={2000} rows={2} placeholder="描述当前进度，例如：第 1–3 题已完成，第 4 题卡在边界条件" aria-label="进度描述" onChange={(event) => setText(event.target.value)} />
      <button type="submit">判定进度</button>
    </form>}
    {status && <small role="status">{status}</small>}
    {notStarted ? <p className="muted" id="complete">开始计时后，在此记录完成情况、提交成果。</p>
      : <ExecutionActions workOrderId={detail.id} intent={detail.intent} state={detail.state} paused={detail.paused} ownerId={detail.ownerId}
        workspaceId={detail.workspaceId} evidenceChecklist={detail.evidenceChecklist} estimateP50={detail.estimate.p50Minutes}
        {...(detail.suggestedMinutes ? { suggestedMinutes: detail.suggestedMinutes } : {})} />}
  </div>;
}

/** The task's record: time spent and the person's own notes and postponements (recording in words is the task's input box). */
function RecordPanel({ detail }: { detail: TaskDetail }) {
  return <div className="record-panel">
    <p className="record-figures"><span className="ui-stat"><b>{formatMinutes(detail.workedMinutes)}</b><span>已投入</span></span>
      <span className="ui-stat"><b>{detail.executions.length}</b><span>次计时</span></span>
      <span className="ui-stat"><b>{detail.executions.reduce((sum, item) => sum + item.interruptions.length, 0)}</b><span>次中断</span></span></p>
    {detail.notes.length > 0 ? <ol className="record-notes">{detail.notes.map((note, index) => <li key={index} data-kind={note.kind}>
      <small className="mono">{localStamp(note.at, detail.timeZone)}</small><span>{note.text}</span></li>)}</ol> : <p className="muted">尚无记录。</p>}
  </div>;
}

/**
 * The task opened from any card, in place: the same content as its own page, and a link to that page (which has the back button and
 * keeps the address).
 */
export function TaskDialog({ detail, open, onOpenChange }: { detail: TaskDetail; open: boolean; onOpenChange: (open: boolean) => void }) {
  return <Sheet title={detail.title} open={open} onOpenChange={onOpenChange}
    footer={<a className="secondary" href={`/workbench/${encodeURIComponent(detail.id)}`}>完整页面</a>}>
    <TaskPanels detail={detail} />
  </Sheet>;
}

const SECTIONS = [["steps", "步骤"], ["materials", "材料与教程"], ["finish", "提交与完成"]] as const;

/**
 * Everything about one task, in the order the work goes (redesigned 2026-10-15): the head (line, state, progress, the due date and the
 * time left, edited in place), the primary action and the task's own input box, then 1 步骤 → 2 材料与教程 → 3 提交与完成, and the
 * record folded at the end. The dialog's content and the whole of the task's page (`/workbench/[id]`, where `anchors` gives the sections
 * ids that links such as 「#tutorial」 and 「#complete」 land on).
 */
export function TaskPanels({ detail, anchors = false }: { detail: TaskDetail; anchors?: boolean }) {
  const [postponing, setPostponing] = useState(false);
  const refs = useRef<Record<string, HTMLElement | null>>({});
  const live = !["accepted", "archived", "evidence_review"].includes(detail.state);
  // With steps, the figure at the top is what is left (the open steps added up), edited step by step below; without, the task's own.
  const open = detail.stepPlan?.steps.filter((step) => step.status === "planned" && step.schedulable) ?? [];
  const remaining = open.length
    ? { estimate: open.reduce((sum, step) => ({ p25Minutes: sum.p25Minutes + step.estimate.p25Minutes, p50Minutes: sum.p50Minutes + step.estimate.p50Minutes,
        p85Minutes: sum.p85Minutes + step.estimate.p85Minutes }), { p25Minutes: 0, p50Minutes: 0, p85Minutes: 0 }), durationEditable: false, durationLabel: "剩余合计" }
    : { estimate: detail.estimate, durationLabel: "时长" };
  const steps = detail.stepPlan?.steps ?? [];
  const done = steps.filter((step) => step.status !== "planned").length;
  const crossLine = detail.supports.length > 0 || (detail.artifactLinks?.length ?? 0) > 0;
  return <div className="task-dialog" data-line={detail.identityId}>
    <header className="task-detail-head">
      <p className="task-card-line"><i className="task-card-dot" aria-hidden="true" />{detail.identityLabel}
        {detail.projectName && <span className="task-card-project">{detail.projectName}</span>}
        <Tag>{stateLabelFor(detail.state, detail.paused)}</Tag>
        {detail.riskTier !== "routine" && <Tag tone={riskTone[detail.riskTier] ?? "neutral"}>{riskLabel[detail.riskTier]}</Tag>}</p>
      {detail.intent !== detail.title && <p className="task-dialog-description gen">{detail.intent}</p>}
      {detail.milestone && <p className="task-dialog-milestone">→ <a href={`/milestones/${encodeURIComponent(detail.milestone.id)}`}>{detail.milestone.title}</a></p>}
      {steps.length > 0 && <div className="task-detail-progress"><StepStrip detail={detail} size="page" /><small className="mono">{done}/{steps.length} 步</small></div>}
      <TaskQuickEdit workOrderId={detail.id} dueBy={detail.window.dueBy} samples={detail.estimate.observationCount} line={detail.identityId}
        editable={!["accepted", "archived"].includes(detail.state)} {...remaining} />
      {crossLine && <p className="task-detail-cross">
        {detail.supports.map((item) => <SupportsTag key={`${item.line}:${item.target}`} line={item.line} lineLabel={item.lineLabel} target={item.target} {...(item.artifact ? { artifact: item.artifact } : {})} />)}
        {detail.artifactLinks?.map((item) => <ArtifactTag key={`${item.direction}:${item.line}:${item.title}`} {...item} />)}</p>}
    </header>
    <TaskActions workOrderId={detail.id} state={detail.state} paused={detail.paused} agentReady={detail.agentSteps.length > 0} agentStepId={detail.agentSteps[0]?.id}
      offline={{ ownerId: detail.viewerId, workspaceId: detail.workspaceId, intent: detail.intent }}>
      {live && !postponing && <button type="button" onClick={() => setPostponing(true)}>推迟</button>}
    </TaskActions>
    {postponing && <PostponePanel workOrderId={detail.id} onClose={() => setPostponing(false)} />}
    {/* One way in for everything about this task: ask about it, change it, record what happened. Changes come back as a card to apply. */}
    <div className="task-entry">
      <Conversation variant="task" page={{ kind: "task", entityId: detail.id }}
        placeholder="对该任务的指令、记录或问题：改截止、这一步做完了、用了多久、卡在哪、在等谁、讲解某一步…" />
    </div>
    <nav className="task-sections" aria-label="任务内容">{SECTIONS.map(([id, label], index) =>
      <button key={id} type="button" onClick={() => refs.current[id]?.scrollIntoView({ behavior: "smooth", block: "start" })}><span className="mono">{index + 1}</span> {label}</button>)}</nav>
    {SECTIONS.map(([id, label], index) => <section key={id} className="task-section" aria-labelledby={`${detail.id}-${id}`} ref={(element) => { refs.current[id] = element; }}
      {...(anchors ? { id } : {})}>
      <h3 id={`${detail.id}-${id}`} className="task-section-title"><span className="mono">{index + 1}</span> {label}</h3>
      {id === "steps" && <StepsPanel detail={detail} />}
      {id === "materials" && <TaskMaterials detail={detail} live={live} anchors={anchors} />}
      {id === "finish" && <FinishPanel detail={detail} />}
    </section>)}
    <details className="advanced task-record" {...(anchors ? { id: "record" } : {})}>
      <summary>记录 · 已投入 {formatMinutes(detail.workedMinutes)} · {detail.executions.length} 次计时</summary>
      <RecordPanel detail={detail} />
    </details>
  </div>;
}
