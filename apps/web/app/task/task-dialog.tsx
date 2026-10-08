"use client";

import { useState } from "react";
import { STEP_ROLES } from "@crossline/core";
import type { TaskDetail } from "../../lib/task-detail";
import { Sheet } from "../ui/overlay";
import { ProgressRing, formatMinutes } from "../ui/controls";
import { LineTag, SupportsTag, Tag } from "../ui/tag";
import { riskLabel, riskTone, stateLabelFor } from "../../lib/labels";
import { AssistantChat } from "../chat/assistant-chat";
import { ManualbookView } from "../manualbook-view";
import { ExecutionActions } from "../execution-actions";
import { WaitingForm } from "../waiting-form";
import { StepDuration, TaskQuickEdit } from "./quick-edit";

const post = (path: string, body: unknown) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then((response) => response.ok).catch(() => false);
const stepsApi = (id: string) => `/api/work-orders/${encodeURIComponent(id)}/steps`;

/** The step graph: rings for progress (click marks a step done), drag to reorder, add and remove, and a one-line request to replan. */
function StepsPanel({ detail }: { detail: TaskDetail }) {
  const plan = detail.stepPlan;
  const [draft, setDraft] = useState(() => (plan?.steps ?? []).filter((step) => step.status === "planned").map((step) => ({ id: step.id as string | undefined, title: step.title })));
  const [dirty, setDirty] = useState(false);
  const [dragging, setDragging] = useState<number | null>(null);
  const [fix, setFix] = useState("");
  const [status, setStatus] = useState("");
  const division = (detail.humanCore.length > 0 || detail.automationParts.length > 0) && <dl className="steps-division">
    {detail.humanCore.length > 0 && <div><dt>本人负责</dt>{detail.humanCore.map((part) => <dd key={part.id} className="gen">{part.intent}</dd>)}</div>}
    {detail.automationParts.length > 0 && <div><dt>系统准备</dt>{detail.automationParts.map((part) => <dd key={part.id} className="gen">{part.intent}</dd>)}</div>}
  </dl>;
  if (!plan) return <div className="steps-panel"><p className="muted">步骤规划中，完成后显示在此处。</p>{division}</div>;
  const move = (from: number, to: number) => { setDraft((list) => { const next = [...list]; const [item] = next.splice(from, 1); next.splice(to, 0, item!); return next; }); setDirty(true); };
  const done = plan.steps.filter((step) => step.status !== "planned");
  const byId = new Map(plan.steps.map((step) => [step.id, step]));
  return <div className="steps-panel">
    <div className="steps-head">
      <ProgressRing quarters={Math.round(plan.progress * 4)} label="任务进度" size={30} />
      <span><b className="mono">{Math.round(plan.progress * 100)}%</b> <small>{plan.archetypeLabel} · {plan.quantity.amount > 0 ? `${plan.quantity.amount} ${plan.quantity.unit}` : plan.quantity.basis}</small></span>
    </div>
    {plan.rationale && <p className="gen steps-rationale">{plan.rationale}</p>}
    <ol className="steps-list">
      {done.map((step) => <li key={step.id} data-status={step.status}>
        <ProgressRing quarters={4} label={step.title} /><span className="step-title">{step.title}</span><Tag tone="ok">{step.status === "done" ? "已完成" : "已跳过"}</Tag>
      </li>)}
      {draft.map((item, index) => {
        const step = item.id ? byId.get(item.id) : undefined;
        return <li key={item.id ?? `new-${index}`} draggable onDragStart={() => setDragging(index)} onDragOver={(event) => event.preventDefault()}
          onDrop={() => { if (dragging !== null && dragging !== index) move(dragging, index); setDragging(null); }}>
          <span className="step-grip" aria-hidden="true">⋮⋮</span>
          {step ? <ProgressRing quarters={step.progressQuarter} label={step.title}
            onConfirm={() => void post(stepsApi(detail.id), { action: "progress", stepId: step.id, status: "done" }).then((ok) => ok && location.reload())} />
            : <span className="ui-ring" />}
          <span className="step-body">
            <input value={item.title} aria-label="步骤名称" onChange={(event) => { const title = event.target.value; setDraft((list) => list.map((row, i) => i === index ? { ...row, title } : row)); setDirty(true); }} />
            {step && <small><Tag>{STEP_ROLES[step.role as keyof typeof STEP_ROLES] ?? step.role}</Tag>
              {step.notBefore || step.dueBy ? <span className="mono"> {step.notBefore || "…"} → {step.dueBy || "…"}</span> : null}
              {step.tickOutcome && <span className="step-tick" title="里程碑刻度"> ◆ {step.tickOutcome}</span>}</small>}
            {step && step.schedulable && <StepDuration workOrderId={detail.id} stepId={step.id} estimate={step.estimate} />}
            {step?.doneCriterion && <small className="gen step-criterion">{step.doneCriterion}</small>}
          </span>
          <span className="step-tools">
            {step && step.executor !== "human" && <button type="button" className="step-agent" title="由 Agent 完成该步骤"
              onClick={() => void post("/api/agent/dispatch", { workOrderId: detail.id, stepId: step.id }).then((ok) => setStatus(ok ? `已交给 Agent：${step.title}` : "未能交给 Agent"))}>Agent</button>}
            {index > 0 && <button type="button" aria-label="上移" onClick={() => move(index, index - 1)}>↑</button>}
            {index < draft.length - 1 && <button type="button" aria-label="下移" onClick={() => move(index, index + 1)}>↓</button>}
            <button type="button" aria-label="删除步骤" onClick={() => { setDraft((list) => list.filter((_, i) => i !== index)); setDirty(true); }}>×</button>
          </span>
        </li>;
      })}
    </ol>
    <div className="steps-actions">
      <button type="button" onClick={() => { setDraft((list) => [...list, { id: undefined, title: "" }]); setDirty(true); }}>＋ 添加步骤</button>
      {dirty && <button type="button" className="primary-button" onClick={() => void post(stepsApi(detail.id), { action: "edit", steps: draft }).then((ok) => ok ? location.reload() : setStatus("未保存，请重试"))}>保存步骤</button>}
    </div>
    <form className="steps-fix" onSubmit={(event) => { event.preventDefault(); if (!fix.trim()) return;
      void post(stepsApi(detail.id), { action: "replan", feedback: fix }).then((ok) => { setStatus(ok ? "已提交，正在重新规划" : "未提交，请重试"); if (ok) setFix(""); }); }}>
      <input value={fix} maxLength={1000} placeholder="用一句话调整步骤，例如：先做第 3 题，检查合并到最后" aria-label="用自然语言调整步骤" onChange={(event) => setFix(event.target.value)} />
      <button type="submit">重新规划</button>
    </form>
    {status && <small role="status">{status}</small>}
    {division}
  </div>;
}

/** The standards this task is judged against, as rings, with a box to describe progress in words for the judge to read. */
function StandardsPanel({ detail }: { detail: TaskDetail }) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState("");
  const by: Record<string, string> = { person: "本人确认", assessment: "进度判定", gate: "闸门判定", none: "未判定" };
  return <div className="standards-panel">
    {detail.criteria.length ? <ul className="standards-list">{detail.criteria.map((criterion) => <li key={criterion.id}>
      <ProgressRing quarters={criterion.quarters} label={criterion.statement}
        {...(criterion.quarters < 4 ? { onConfirm: () => void post(stepsApi(detail.id), { action: "confirm_criterion", criterionId: criterion.id }).then((ok) => ok && location.reload()) } : {})} />
      <span>{criterion.statement}{criterion.note && <small className="gen">{criterion.note}</small>}</span>
      <Tag>{by[criterion.by]}</Tag>
    </li>)}</ul> : <p className="muted">所属里程碑未设置达成标准。</p>}
    {detail.evidenceContract.length > 0 && <ul className="standards-contract">{detail.evidenceContract.map((item, index) => <li key={index}>
      <Tag tone="info">交付</Tag><span>{item.description}</span></li>)}</ul>}
    <form className="progress-report" onSubmit={(event) => { event.preventDefault(); if (!text.trim()) return;
      void post(stepsApi(detail.id), { action: "report", text }).then((ok) => { setStatus(ok ? "已提交，正在判定进度" : "未提交，请重试"); if (ok) setText(""); }); }}>
      <textarea value={text} maxLength={2000} rows={2} placeholder="描述当前进度，例如：第 1–3 题已完成，第 4 题卡在边界条件" aria-label="进度描述" onChange={(event) => setText(event.target.value)} />
      <button type="submit">判定进度</button>
    </form>
    {status && <small role="status">{status}</small>}
  </div>;
}

/** Every file that belongs to the task, each one openable: the person's own uploads, prepared materials, and the assistant's outputs. */
function MaterialsPanel({ detail }: { detail: TaskDetail }) {
  const empty = !detail.sources.length && !detail.preparedMaterials.length && !detail.agentOutputs.length;
  return <div className="materials-panel">
    {empty && <p className="muted">暂无材料。上传的课程文件和 Agent 产出会出现在这里。</p>}
    {detail.sources.length > 0 && <section><h4>本人上传</h4><ul>{detail.sources.map((doc) => <li key={doc.id}>
      <a href={`/api/source-documents/${encodeURIComponent(doc.id)}/file`} target="_blank" rel="noreferrer">{doc.fileName}</a>
      <a className="muted" href={`/api/source-documents/${encodeURIComponent(doc.id)}/file?view=text`} target="_blank" rel="noreferrer">文字版</a>
    </li>)}</ul></section>}
    {detail.preparedMaterials.length > 0 && <section><h4>已备材料</h4><ul>{detail.preparedMaterials.map((item) => <li key={item.id}>
      <a href={`/api/work-orders/${encodeURIComponent(detail.id)}/materials?uri=${encodeURIComponent(item.uri)}`} target="_blank" rel="noreferrer">{item.fileName}</a></li>)}</ul></section>}
    {detail.agentOutputs.length > 0 && <section><h4>Agent 产出</h4><ul>{detail.agentOutputs.flatMap((task) => task.files.map((file) => <li key={`${task.taskId}:${file.path}`}>
      <a href={`/api/agent/tasks/${encodeURIComponent(task.taskId)}/file?path=${encodeURIComponent(file.path)}`} target="_blank" rel="noreferrer">{file.name}</a>
      <small className="muted">{task.title}</small></li>))}</ul></section>}
    {detail.background && detail.background.length > 0 && <section><h4>背景资料</h4><ul>{detail.background.map((fact) => <li key={fact.key}>
      <span>{fact.value}</span><small className="gen">{fact.why}</small></li>)}</ul></section>}
  </div>;
}

type Tab = "steps" | "standards" | "materials" | "chat" | "tutorial" | "record";

/**
 * Everything about one task in one place, opened from any card: the figures at the top (deadline, duration, progress, cross-line
 * support), then tabs for the steps, the standards, the materials, a conversation scoped to the task, the tutorial when one was
 * prepared, and the record (sessions, completion and evidence).
 */
export function TaskDialog({ detail, open, onOpenChange, initialTab = "steps" }: { detail: TaskDetail; open: boolean; onOpenChange: (open: boolean) => void; initialTab?: Tab }) {
  return <Sheet title={detail.intent} open={open} onOpenChange={onOpenChange}
    footer={<a className="secondary" href={`/workbench/${encodeURIComponent(detail.id)}`}>完整页面</a>}>
    <TaskPanels detail={detail} initialTab={initialTab} />
  </Sheet>;
}

/** The dialog's content, also the whole of the task's own page (`/workbench/[id]`). */
export function TaskPanels({ detail, initialTab = "steps" }: { detail: TaskDetail; initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const tabs: Array<[Tab, string]> = [["steps", "步骤"], ["standards", "标准"], ["materials", "材料"], ["chat", "对话"],
    ...((detail.materialContract.length || detail.preparedMaterials.length) ? [["tutorial", "教程"] as [Tab, string]] : []), ["record", "记录"]];
  // With steps, the figure at the top is what is left (the open steps added up), edited step by step below; without, the task's own.
  const open = detail.stepPlan?.steps.filter((step) => step.status === "planned" && step.schedulable) ?? [];
  const remaining = open.length
    ? { estimate: open.reduce((sum, step) => ({ p25Minutes: sum.p25Minutes + step.estimate.p25Minutes, p50Minutes: sum.p50Minutes + step.estimate.p50Minutes,
        p85Minutes: sum.p85Minutes + step.estimate.p85Minutes }), { p25Minutes: 0, p50Minutes: 0, p85Minutes: 0 }), durationEditable: false, durationLabel: "剩余合计" }
    : { estimate: detail.estimate, durationLabel: "时长" };
  return <>
    <div className="task-dialog" data-line={detail.identityId}>
      <div className="task-dialog-tags">
        <LineTag line={detail.identityId}>{detail.identityLabel}</LineTag>
        {detail.projectName && <Tag tone="info">{detail.projectName}</Tag>}
        <Tag>{stateLabelFor(detail.state, detail.paused)}</Tag>
        {detail.riskTier !== "routine" && <Tag tone={riskTone[detail.riskTier] ?? "neutral"}>{riskLabel[detail.riskTier]}</Tag>}
        {detail.supports.map((item) => <SupportsTag key={`${item.line}:${item.target}`} line={item.line} lineLabel={item.lineLabel} target={item.target} {...(item.artifact ? { artifact: item.artifact } : {})} />)}
      </div>
      {detail.milestone && <p className="task-dialog-milestone">→ <a href={`/milestones/${encodeURIComponent(detail.milestone.id)}`}>{detail.milestone.title}</a></p>}
      <TaskQuickEdit workOrderId={detail.id} dueBy={detail.window.dueBy} samples={detail.estimate.observationCount} line={detail.identityId}
        editable={!["accepted", "archived"].includes(detail.state)} {...remaining} />
      <div className="task-dialog-tabs" role="tablist">
        {tabs.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>)}
      </div>
      <div role="tabpanel">
        {tab === "steps" && <StepsPanel detail={detail} />}
        {tab === "standards" && <StandardsPanel detail={detail} />}
        {tab === "materials" && <MaterialsPanel detail={detail} />}
        {tab === "chat" && <AssistantChat workOrderId={detail.id} storageKey={`crossline-task-chat-${detail.id}`}
          emptyText="围绕这项任务提问：拆解、资料、卡点、时间安排。" />}
        {tab === "tutorial" && <ManualbookView workOrderId={detail.id} building={detail.state === "preparing"} />}
        {tab === "record" && <div className="record-panel">
          <p className="record-figures"><span className="ui-stat"><b>{formatMinutes(detail.workedMinutes)}</b><span>已投入</span></span>
            <span className="ui-stat"><b>{detail.executions.length}</b><span>次计时</span></span>
            <span className="ui-stat"><b>{detail.executions.reduce((sum, item) => sum + item.interruptions.length, 0)}</b><span>次中断</span></span></p>
          <ExecutionActions workOrderId={detail.id} intent={detail.intent} state={detail.state} paused={detail.paused} ownerId={detail.ownerId}
            workspaceId={detail.workspaceId} evidenceChecklist={detail.evidenceChecklist} estimateP50={detail.estimate.p50Minutes}
            {...(detail.suggestedMinutes ? { suggestedMinutes: detail.suggestedMinutes } : {})} />
          {!["accepted", "archived"].includes(detail.state) && <WaitingForm workOrderId={detail.id} />}
        </div>}
      </div>
    </div>
  </>;
}
