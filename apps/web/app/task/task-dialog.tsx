"use client";

import { useEffect, useState } from "react";
import { STEP_ROLES, plainEstimateWords } from "@crossline/core";
import type { TaskDetail } from "../../lib/task-detail";
import { Sheet } from "../ui/overlay";
import { ProgressRing, formatMinutes, dayLabel } from "../ui/controls";
import { LineTag, SupportsTag, Tag } from "../ui/tag";
import { riskLabel, riskTone, stateLabelFor } from "../../lib/labels";
import { AssistantChat } from "../chat/assistant-chat";
import { ManualbookView } from "../manualbook-view";
import { ExecutionActions } from "../execution-actions";
import { PostponePanel } from "./postpone";
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
    {plan.rationale && <p className="gen steps-rationale">{plainEstimateWords(plan.rationale)}</p>}
    {plan.units.length > 0 && <p className="steps-units"><small>依据材料的内容</small>{plan.units.map((unit) => <span key={unit.id} className="tag" title={unit.quote}>{unit.title}</span>)}</p>}
    {plan.questions.length > 0 && <p className="steps-questions"><small>需要本人回答后才能定下的</small>{plan.questions.map((question) => <a key={question.id} href="/approvals">{question.text}</a>)}</p>}
    <ol className="steps-list">
      {done.map((step) => <li key={step.id} data-status={step.status}>
        <ProgressRing quarters={4} label={step.title} /><span className="step-title">{step.title}</span><Tag tone="ok">{step.status === "done" ? "已完成" : "已跳过"}</Tag>
      </li>)}
      {draft.map((item, index) => {
        const step = item.id ? byId.get(item.id) : undefined;
        // The assistant's preparation: done by itself before the person needs it; its result is linked here, in 材料 and in 教程.
        if (step?.executor === "agent") {
          const run = [...detail.agentOutputs].reverse().find((task) => task.stepId === step.id);
          const state = !run ? "待开始" : run.status === "running" || run.status === "requested" ? "准备中" : run.status === "blocked" ? "未做成" : "已备好";
          return <li key={step.id} className="step-prep" data-state={state}>
            <span className="step-grip" aria-hidden="true" />
            <span className="step-body"><span><Tag>助手准备</Tag> {step.title} <small className="muted">{state}</small></span>
              {run?.files.length ? <small>{run.files.map((file) => <a key={file.path} href={`/api/agent/tasks/${encodeURIComponent(run.taskId)}/file?path=${encodeURIComponent(file.path)}`}
                target="_blank" rel="noreferrer">{file.name}</a>)}</small> : step.deliverable ? <small className="gen muted">{step.deliverable}</small> : null}</span>
          </li>;
        }
        const covered = step ? plan.units.filter((unit) => (step.covers ?? []).includes(unit.id)).map((unit) => unit.title) : [];
        return <li key={item.id ?? `new-${index}`} draggable onDragStart={() => setDragging(index)} onDragOver={(event) => event.preventDefault()}
          onDrop={() => { if (dragging !== null && dragging !== index) move(dragging, index); setDragging(null); }}>
          <span className="step-grip" aria-hidden="true">⋮⋮</span>
          {step ? <ProgressRing quarters={step.progressQuarter} label={step.title}
            onConfirm={() => void post(stepsApi(detail.id), { action: "progress", stepId: step.id, status: "done" }).then((ok) => ok && location.reload())} />
            : <span className="ui-ring" />}
          <span className="step-body">
            <input value={item.title} aria-label="步骤名称" onChange={(event) => { const title = event.target.value; setDraft((list) => list.map((row, i) => i === index ? { ...row, title } : row)); setDirty(true); }} />
            {step && <small><Tag>{STEP_ROLES[step.role as keyof typeof STEP_ROLES] ?? step.role}</Tag>
              {step.notBefore || step.dueBy ? <span className="mono"> {step.notBefore ? dayLabel(step.notBefore) : "…"} → {step.dueBy ? dayLabel(step.dueBy) : "…"}</span> : null}
              {step.tickOutcome && <span className="step-tick" title="里程碑刻度"> ◆ {step.tickOutcome}</span>}</small>}
            {step && step.schedulable && <StepDuration workOrderId={detail.id} stepId={step.id} estimate={step.estimate} />}
            {step?.doneCriterion && <small className="gen step-criterion">{step.doneCriterion}</small>}
            {covered.length > 0 && <small className="step-covers">内容：{covered.join("、")}</small>}
            {step?.why && <small className="gen step-why">{step.why}</small>}
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

type TutorialMaterial = { index: number; title: string; publisher: string; kept: string; docId?: string; notes: number };

/**
 * Every material of the task, each opening its own page — the material on one side, the analysis of it for this task on the other —
 * the person's own files first, then what the tutorial found, the prepared files and the assistant's outputs.
 */
function MaterialsPanel({ detail }: { detail: TaskDetail }) {
  const [found, setFound] = useState<TutorialMaterial[]>([]);
  useEffect(() => {
    void fetch(`/api/work-orders/${encodeURIComponent(detail.id)}/manualbook`, { cache: "no-store" }).then((response) => response.json())
      .then((body: { materials?: TutorialMaterial[] }) => setFound(body.materials ?? [])).catch(() => setFound([]));
  }, [detail.id]);
  const preview = (query: string) => `/workbench/${encodeURIComponent(detail.id)}/material?${query}`;
  const web = found.filter((item) => !item.docId);
  const noted = new Map(found.filter((item) => item.docId).map((item) => [item.docId!, item.notes]));
  const empty = !detail.sources.length && !web.length && !detail.preparedMaterials.length && !detail.agentOutputs.length;
  return <div className="materials-panel">
    {empty && <p className="muted">暂无材料。本人上传的课程文件、教程找到的资料和 Agent 产出会出现在这里。</p>}
    {detail.sources.length > 0 && <section><h4>本人上传</h4><ul>{detail.sources.map((doc) => <li key={doc.id}>
      <a href={preview(`doc=${encodeURIComponent(doc.id)}`)}>{doc.fileName}</a>
      <small className="muted">{noted.get(doc.id) ? `${noted.get(doc.id)} 条解析` : "原文"}</small>
    </li>)}</ul></section>}
    {web.length > 0 && <section><h4>教程资料</h4><ul>{web.map((item) => <li key={item.index}>
      <a href={preview(`m=${item.index}`)}>{item.title}</a>
      <small className="muted">{item.publisher || "网络"} · {({ full_text: "已存全文", summary_only: "链接与摘要", unverified: "未能自动核实" } as Record<string, string>)[item.kept] ?? "链接与摘要"} · {item.notes} 条解析</small>
    </li>)}</ul></section>}
    {detail.preparedMaterials.length > 0 && <section><h4>已备文件</h4><ul>{detail.preparedMaterials.filter((item) => !/\/(flow|manifest|materials)\.json$|\/nodes\//.test(item.uri)).map((item) => <li key={item.id}>
      <a href={`/api/work-orders/${encodeURIComponent(detail.id)}/materials?uri=${encodeURIComponent(item.uri)}`} target="_blank" rel="noreferrer">{item.fileName}</a></li>)}</ul></section>}
    {detail.agentOutputs.some((task) => task.files.length) && <section><h4>Agent 产出</h4>{detail.agentOutputs.filter((task) => task.files.length).map((task) => <div key={task.taskId}>
      {/* The run's title once (it is the task's own wording when the whole task was handed over), then its files. */}
      {detail.agentOutputs.length > 1 && <small className="muted">{task.title}</small>}
      <ul>{task.files.map((file) => <li key={file.path}>
        <a href={`/api/agent/tasks/${encodeURIComponent(task.taskId)}/file?path=${encodeURIComponent(file.path)}`} target="_blank" rel="noreferrer">{file.name}</a></li>)}</ul>
    </div>)}</section>}
    {detail.background && detail.background.length > 0 && <section><h4>相关背景</h4><ul>{detail.background.map((fact) => <li key={fact.key}>
      <span>{fact.value}</span><small className="gen">{fact.why}</small></li>)}</ul></section>}
  </div>;
}

/** The task's record: time spent, the person's own notes and postponements, a box to record anything in words, and the timer. */
function RecordPanel({ detail }: { detail: TaskDetail }) {
  return <div className="record-panel">
    <p className="record-figures"><span className="ui-stat"><b>{formatMinutes(detail.workedMinutes)}</b><span>已投入</span></span>
      <span className="ui-stat"><b>{detail.executions.length}</b><span>次计时</span></span>
      <span className="ui-stat"><b>{detail.executions.reduce((sum, item) => sum + item.interruptions.length, 0)}</b><span>次中断</span></span></p>
    {!["accepted", "archived"].includes(detail.state) && <AssistantChat workOrderId={detail.id} mode="record" inputFirst storageKey={`crossline-task-record-${detail.id}`}
      emptyText="" placeholder="记录：做了什么、用了多久、卡在哪、在等谁、精力如何" />}
    {detail.notes.length > 0 && <ol className="record-notes">{detail.notes.map((note, index) => <li key={index} data-kind={note.kind}>
      <small className="mono">{note.at.slice(5, 16).replace("T", " ")}</small><span>{note.text}</span></li>)}</ol>}
    <ExecutionActions workOrderId={detail.id} intent={detail.intent} state={detail.state} paused={detail.paused} ownerId={detail.ownerId}
      workspaceId={detail.workspaceId} evidenceChecklist={detail.evidenceChecklist} estimateP50={detail.estimate.p50Minutes}
      {...(detail.suggestedMinutes ? { suggestedMinutes: detail.suggestedMinutes } : {})} />
  </div>;
}

type Tab = "steps" | "standards" | "materials" | "tutorial" | "record";

/**
 * Everything about one task in one place, opened from any card: the figures at the top (deadline, duration, progress, cross-line
 * support), the task's own input box (anything about it, in words: questions, changes, progress), then tabs for the steps, the
 * tutorial, the materials, the standards and the record (notes, sessions, completion and evidence).
 */
export function TaskDialog({ detail, open, onOpenChange, initialTab = "steps" }: { detail: TaskDetail; open: boolean; onOpenChange: (open: boolean) => void; initialTab?: Tab }) {
  return <Sheet title={detail.title} open={open} onOpenChange={onOpenChange}
    footer={<a className="secondary" href={`/workbench/${encodeURIComponent(detail.id)}`}>完整页面</a>}>
    <TaskPanels detail={detail} initialTab={initialTab} />
  </Sheet>;
}

/** The dialog's content, also the whole of the task's own page (`/workbench/[id]`). */
export function TaskPanels({ detail, initialTab = "steps" }: { detail: TaskDetail; initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const tabs: Array<[Tab, string]> = [["steps", "步骤"], ["tutorial", "教程"], ["materials", "材料"], ["standards", "标准"], ["record", "记录"]];
  const [postponing, setPostponing] = useState(false);
  const live = !["accepted", "archived", "evidence_review"].includes(detail.state);
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
      {detail.intent !== detail.title && <p className="task-dialog-description gen">{detail.intent}</p>}
      {detail.milestone && <p className="task-dialog-milestone">→ <a href={`/milestones/${encodeURIComponent(detail.milestone.id)}`}>{detail.milestone.title}</a></p>}
      <TaskQuickEdit workOrderId={detail.id} dueBy={detail.window.dueBy} samples={detail.estimate.observationCount} line={detail.identityId}
        editable={!["accepted", "archived"].includes(detail.state)} {...remaining} />
      {/* One way in for everything about this task: ask about it, change it, record what happened. Changes come back as a card to apply. */}
      <div className="task-entry">
        <AssistantChat workOrderId={detail.id} inputFirst storageKey={`crossline-task-chat-${detail.id}`} emptyText=""
          placeholder="对该任务的任何指令或问题：改截止、加步骤、记进度、推迟、讲解某一步…" />
        {live && !postponing && <button type="button" className="secondary-button task-postpone" onClick={() => setPostponing(true)}>推迟</button>}
        {postponing && <PostponePanel workOrderId={detail.id} onClose={() => setPostponing(false)} />}
      </div>
      <div className="task-dialog-tabs" role="tablist">
        {tabs.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>)}
      </div>
      <div role="tabpanel">
        {tab === "steps" && <StepsPanel detail={detail} />}
        {tab === "standards" && <StandardsPanel detail={detail} />}
        {tab === "materials" && <MaterialsPanel detail={detail} />}
        {tab === "tutorial" && <ManualbookView workOrderId={detail.id} building={detail.state === "preparing"} canBuild={live} />}
        {tab === "record" && <RecordPanel detail={detail} />}
      </div>
    </div>
  </>;
}
