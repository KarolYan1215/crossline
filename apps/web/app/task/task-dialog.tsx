"use client";

import { useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { BookOpen, Bot, CalendarClock, Check, Clock, Pencil, SlidersHorizontal } from "lucide-react";
import { localStamp, plainEstimateWords, stepLeavesMachine } from "@crossline/core";
import type { TaskDetail } from "../../lib/task-detail";
import type { Locale, Translate } from "../../lib/i18n";
import { weekdayShort } from "../../lib/i18n";
import { Sheet } from "../ui/overlay";
import { DateChip, DurationBar, ProgressRing } from "../ui/controls";
import { ArtifactTag, SupportsTag, Tag } from "../ui/tag";
import { Clamp } from "../ui/clamp";
import { ICON, IconButton } from "../ui/icon-button";
import { riskLabel, riskTone, stateLabelFor } from "../../lib/labels";
import { Conversation } from "../chat/conversation";
import { EnergyProbe } from "../energy-probe";
import { currentStep, hoursShort, remainingMinutes, type TaskSlotLike } from "./card-model";
import { CompletionChoice } from "./completion-choice";
import { ImpactCard, useImpact } from "./impact";
import { PostponePanel } from "./postpone";
import { StepDuration } from "./quick-edit";
import { RunningChip } from "./running-chip";
import { StepStrip } from "./step-strip";
import { TaskActions } from "./task-actions";
import { COMPLETABLE, TaskCompletion } from "./task-completion";
import { StepMaterials, TaskMaterials } from "./task-materials";
import { useWholeDetail } from "./whole-detail";
import { stepAnchor, tutorialAnchor } from "../materials/tutorial-model";
import { useLocale, useT } from "../locale-context";
import { dayText, minutesText, shortDate } from "./format";
import { handOff } from "./handoff";

const SMALL = { ...ICON, size: 14 } as const;
const post = (path: string, body: unknown) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then((response) => response.ok).catch(() => false);
const stepsApi = (id: string) => `/api/work-orders/${encodeURIComponent(id)}/steps`;
type Step = NonNullable<TaskDetail["stepPlan"]>["steps"][number];

/**
 * The steps, read top to bottom: done ones folded to a line, the current one open with its first move, what counts as done and why it is
 * there, the others a line each that opens on a click. Editing (reorder, rename, add, remove, a one-line replan) is a mode of its own, so
 * the list reads as a plan rather than a form.
 */
type StepQuestion = NonNullable<TaskDetail["stepPlan"]>["questions"][number];

/**
 * The plan's questions with what they rest on now: the person's answer, the app's assumption (only important tasks' first two questions
 * are put to the person; the rest are assumed so nothing waits), or still waiting on 待确认. Any of them can be changed here, which
 * plans the task again with it.
 */
function StepQuestions({ workOrderId, questions }: { workOrderId: string; questions: StepQuestion[] }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState("");
  const t = useT();
  const save = async (question: StepQuestion, answer: string) => {
    if (!answer.trim()) { setStatus(t("回答未填写")); return; }
    setStatus(t("保存中…"));
    const ok = await post(`/api/work-orders/${encodeURIComponent(workOrderId)}/step-answer`, { question: question.text, answer });
    if (!ok) { setStatus(t("未能保存，请重试")); return; }
    setEditing(null); setStatus(t("已记下，步骤会按此重排"));
    window.location.reload();
  };
  const answered = questions.filter((question) => question.answer && !question.answer.assumed).length;
  const assumed = questions.filter((question) => question.answer?.assumed).length;
  const waiting = questions.length - answered - assumed;
  // One line under the steps; the list opens on a click. A question still waiting is answered on 待确认 (its one home), only changed here.
  return <details className="steps-questions advanced">
    <summary><b>{t("计划依据的问题")}</b>
      <span>{t("已答 {{count}}", { count: answered })}</span><span>{t("按假设 {{count}}", { count: assumed })}</span>
      {waiting > 0 && <span>{t("待回答 {{count}}（在待确认）", { count: waiting })}</span>}
      <span className="steps-questions-open">{t("查看或修改")}</span></summary>
    <ul>{questions.map((question) => <li key={question.id}>
      <span>{question.text}</span>
      {question.answer
        ? <span className={question.answer.assumed ? "steps-answer-assumed" : "steps-answer"}>{t(question.answer.assumed ? "按假设：{{text}}" : "已答：{{text}}", { text: question.answer.text })}</span>
        : <a href="/approvals">{t("在待确认回答")}</a>}
      {!question.answer ? null : editing === question.id
        ? <span className="steps-answer-edit">
          {question.options.map((option) => <button key={option} type="button" className="text-button" onClick={() => void save(question, option)}>{option}</button>)}
          <input type="text" value={draft} maxLength={300} placeholder={t("或自己写")} onChange={(event) => setDraft(event.target.value)} />
          <button type="button" className="secondary-button" onClick={() => void save(question, draft)}>{t("保存")}</button>
          <button type="button" className="text-button" onClick={() => setEditing(null)}>{t("取消")}</button>
        </span>
        : <button type="button" className="text-button" onClick={() => { setEditing(question.id); setDraft(""); setStatus(""); }}>{t("改")}</button>}
    </li>)}</ul>
    {status && <small role="status">{status}</small>}
  </details>;
}

function StepsPanel({ detail, editing, onEditing }: { detail: TaskDetail; editing: boolean; onEditing: (editing: boolean) => void }) {
  const plan = detail.stepPlan;
  const current = currentStep(detail);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(current ? [current.id] : []));
  const [status, setStatus] = useState("");
  const t = useT(), locale = useLocale();
  // The person's part is not said again when it only repeats the task's name (the 2026-10-28 review found 「本人负责 · <the title>」).
  const own = detail.humanCore.filter((part) => part.intent.trim() !== detail.title.trim() && part.intent.trim() !== detail.intent.trim());
  const division = (own.length > 0 || detail.automationParts.length > 0) && <dl className="steps-division">
    {own.length > 0 && <div><dt>{t("本人负责")}</dt>{own.map((part) => <dd key={part.id} className="gen">{part.intent}</dd>)}</div>}
    {detail.automationParts.length > 0 && <div><dt>{t("系统准备")}</dt>{detail.automationParts.map((part) => <dd key={part.id} className="gen">{part.intent}</dd>)}</div>}
  </dl>;
  if (!plan) return <div className="steps-panel"><p className="muted">{t("步骤规划中，完成后显示在此处。")}</p>{division}</div>;
  if (editing) return <div className="steps-panel"><StepsEditor detail={detail} onDone={() => onEditing(false)} />{division}</div>;
  const toggle = (id: string) => setExpanded((set) => { const next = new Set(set); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  return <div className="steps-panel">
    {plan.rationale && <p className="gen steps-rationale"><Clamp text={plainEstimateWords(plan.rationale, locale)} /></p>}
    {plan.units.length > 0 && <p className="steps-units"><small>{t("依据材料的内容")}</small>{plan.units.map((unit) => <span key={unit.id} className="tag" title={unit.quote}>{unit.title}</span>)}</p>}
    <ol className="steps-list">{plan.steps.map((step, index) => {
      const open = expanded.has(step.id);
      const kind = step.status !== "planned" ? "done" : step.executor === "agent" ? "agent" : step === current ? "current" : "open";
      const waits = !step.schedulable && step.executor !== "agent";
      return <li key={step.id} id={stepAnchor(step.id)} className="step-row" data-kind={kind} data-wait={waits || undefined} data-open={open || undefined}>
        <span className="step-index mono" aria-hidden="true">{index + 1}</span>
        <StepRing detail={detail} step={step} />
        <div className="step-body">
          <button type="button" className="step-head" aria-expanded={open} onClick={() => toggle(step.id)}>
            <span className="step-title">{step.title}</span>
            <span className="step-facts">
              {kind === "current" && <Tag tone="info">{t("当前")}</Tag>}
              {kind === "agent" && <Tag>{t("助手准备 · {{state}}", { state: t(agentState(detail, step)) })}</Tag>}
              {kind === "done" && <Tag tone="ok">{t(step.status === "done" ? "已完成" : "已跳过")}</Tag>}
              {kind !== "done" && kind !== "agent" && <span className="step-owner">{t(waits ? "等待" : step.executor === "human" ? "本人" : "本人 · 可交给助手")}</span>}
              {kind !== "done" && step.executor !== "agent" && stepLeavesMachine(step.title) && <span className="step-owner" data-tone="external">{t("对外 · 本人操作")}</span>}
              {step.schedulable && kind !== "done" && <small className="mono">{minutesText(locale, step.estimate.p50Minutes)}</small>}
              {(step.notBefore || step.dueBy) && kind !== "done" && <small className="mono">{step.notBefore ? dayText(locale, step.notBefore) : "…"} → {step.dueBy ? dayText(locale, step.dueBy) : "…"}</small>}
            </span>
          </button>
          {kind === "current" && step.firstAction && <p className="step-first"><small>{t("先做（5 分钟）")}</small><span className="gen">{step.firstAction}</span></p>}
          {open && <StepDetail detail={detail} step={step} kind={kind} onStatus={setStatus} />}
        </div>
      </li>;
    })}</ol>
    {plan.questions.length > 0 && <StepQuestions workOrderId={detail.id} questions={plan.questions} />}
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
  const t = useT();
  const covered = (detail.stepPlan?.units ?? []).filter((unit) => (step.covers ?? []).includes(unit.id)).map((unit) => unit.title);
  return <div className="step-detail">
    {kind !== "current" && step.firstAction && kind !== "done" && <p className="step-first"><small>{t("先做")}</small><span className="gen">{step.firstAction}</span></p>}
    {step.doneCriterion && <p className="step-line"><small>{t("完成标准")}</small><span className="gen">{step.doneCriterion}</span></p>}
    {step.deliverable && kind === "agent" && <p className="step-line"><small>{t("产出")}</small><span className="gen">{step.deliverable}</span></p>}
    {covered.length > 0 && <p className="step-line"><small>{t("内容", { context: "covers" })}</small><span className="step-covers">{covered.map((title) => <span key={title} className="tag">{title}</span>)}</span></p>}
    {step.why && <p className="step-line"><small>{t("为什么")}</small><span className="gen">{step.why}</span></p>}
    {step.aiAssist?.tool && <p className="step-line" title={t("计划按用这个工具估算时间")}><small>{t("AI 辅助")}</small><span><Tag tone="info">{step.aiAssist.tool}</Tag> <span className="gen">{step.aiAssist.how}</span>
      {step.aiAssist.minutesSaved > 0 && <span className="muted">{t("（约省 {{count}} 分钟）", { count: step.aiAssist.minutesSaved })}</span>}</span></p>}
    {step.tickOutcome && <p className="step-line step-tick" title={t("里程碑刻度")}><small>{t("刻度")}</small><span>◆ {step.tickOutcome}</span></p>}
    <StepMaterials detail={detail} stepId={step.id} />
    {kind !== "done" && kind !== "agent" && step.schedulable && <div className="step-line"><small>{t("时长")}</small><StepDuration workOrderId={detail.id} stepId={step.id} estimate={step.estimate} /></div>}
    {kind !== "done" && step.provides && <ProvideBox workOrderId={detail.id} step={step} onStatus={onStatus} />}
    {kind !== "done" && !step.provides && <OwnerSwitch workOrderId={detail.id} step={step} onStatus={onStatus} />}
    {kind !== "done" && <p className="step-actions">
      {kind !== "agent" && <button type="button" className="secondary-button" onClick={() => void post(stepsApi(detail.id), { action: "progress", stepId: step.id, status: "done" })
        .then((ok) => ok ? location.reload() : onStatus(t("未能保存，请重试")))}><Check {...ICON} />{t("这一步做完了")}</button>}
      {step.executor === "human" && detail.preparedMaterials.some((item) => /manual\.md$/.test(item.uri)) &&
        <a className="text-button" href={`#${tutorialAnchor(step.id)}`}><BookOpen {...ICON} />{t("本步教程")}</a>}
      {/* A decision is the person's whatever the executor says (the dispatcher refuses it), so it offers no hand-over. */}
      {step.executor !== "human" && step.role !== "decide" && <button type="button" className="text-button" onClick={() => void handOff(detail.id, step.id)
        .then((outcome) => onStatus(outcome.kind === "started" ? t("已交给助手：{{title}}，进度在小帮手里看", { title: step.title })
          : outcome.kind === "needs_category" ? t("这类工作尚未允许 Agent 执行，已加入待决事项。")
          : outcome.message ? t("未能交给助手：{{reason}}", { reason: outcome.message }) : t("未能交给助手")))}><Bot {...ICON} />{t("交给助手")}</button>}
    </p>}
  </div>;
}

/**
 * Who does the step, as the person sees fit (4A): a step of the person's whose product is material or an output can go to the assistant, and
 * any assistant's step can be taken back. The choice holds for that kind of step on the line; acts, practice and decisions stay the person's
 * (the server says why when it refuses).
 */
function OwnerSwitch({ workOrderId, step, onStatus }: { workOrderId: string; step: Step; onStatus: (text: string) => void }) {
  const toAssistant = step.executor !== "agent";
  const t = useT();
  if (toAssistant && (step.product === "ability" || step.product === "action" || step.role === "decide" || step.role === "wait")) return null;
  const choose = async () => {
    onStatus(t("保存中…"));
    const response = await fetch(stepsApi(workOrderId), { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "owner", stepId: step.id, owner: toAssistant ? "assistant" : "person" }) }).catch(() => null);
    const body = await response?.json().catch(() => ({})) as { ok?: boolean; message?: string } | undefined;
    if (!body?.ok) { onStatus(body?.message ? t("未改：{{message}}", { message: body.message }) : t("未能保存，请重试")); return; }
    location.reload();
  };
  return <p className="step-line"><small>{t("由谁做")}</small><span>{t(toAssistant ? "本人" : "助手")}
    <button type="button" className="text-button" title={t("以后这条线上同类的步骤也这样分")} onClick={() => void choose()}>{t(toAssistant ? "交给助手" : "改为本人做")}</button></span></p>;
}

/**
 * A provide step: material only the person has (their notes, the problem set behind their course login). Uploading it or saying there is
 * none settles the step; until then the tutorial sections and the assistant's work that use it wait.
 */
function ProvideBox({ workOrderId, step, onStatus }: { workOrderId: string; step: Step; onStatus: (text: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const t = useT();
  const upload = async () => {
    const files = [...(input.current?.files ?? [])];
    if (!files.length) { onStatus(t("还没有选文件")); return; }
    setBusy(true); onStatus(t("上传中…"));
    const form = new FormData();
    form.set("stepId", step.id);
    for (const file of files) form.append("file", file);
    const ok = await fetch(`/api/work-orders/${encodeURIComponent(workOrderId)}/steps/provide`, { method: "POST", body: form }).then((response) => response.ok).catch(() => false);
    setBusy(false);
    if (!ok) { onStatus(t("未能上传，请重试")); return; }
    location.reload();
  };
  const none = async () => {
    setBusy(true);
    const ok = await post(stepsApi(workOrderId), { action: "provide_none", stepId: step.id });
    setBusy(false);
    if (!ok) { onStatus(t("未能保存，请重试")); return; }
    location.reload();
  };
  const checking = (step as { needState?: string }).needState === "checking";
  return <div className="step-line step-provide"><small>{t("提交材料")}</small>
    <span>
      <span className="muted">{t(checking ? "系统正在已有文件和网上查找这份材料，找到就不用提交；手里有也可以直接上传。"
        : "已有文件和网上都没找到。用到这份材料的教程和助手准备，在提交或说明没有之后才生成。")}</span>
      <input ref={input} type="file" multiple aria-label={t("上传：{{name}}", { name: step.deliverable || step.title })} disabled={busy} />
      <span className="step-provide-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void upload()}>{t("上传")}</button>
        <button type="button" className="text-button" disabled={busy} onClick={() => void none()}>{t("没有")}</button>
      </span>
    </span></div>;
}

/** The step list as a form: drag or arrow to reorder, rename in place, add, remove, save; or ask for a replan in one line. */
function StepsEditor({ detail, onDone }: { detail: TaskDetail; onDone: () => void }) {
  const plan = detail.stepPlan!;
  const [draft, setDraft] = useState(() => plan.steps.filter((step) => step.status === "planned").map((step) => ({ id: step.id as string | undefined, title: step.title })));
  const [dirty, setDirty] = useState(false);
  const [dragging, setDragging] = useState<number | null>(null);
  const [fix, setFix] = useState("");
  const [status, setStatus] = useState("");
  const t = useT();
  const move = (from: number, to: number) => { setDraft((list) => { const next = [...list]; const [item] = next.splice(from, 1); next.splice(to, 0, item!); return next; }); setDirty(true); };
  return <>
    <ol className="steps-list steps-editing">{draft.map((item, index) => <li key={item.id ?? `new-${index}`} draggable onDragStart={() => setDragging(index)} onDragOver={(event) => event.preventDefault()}
      onDrop={() => { if (dragging !== null && dragging !== index) move(dragging, index); setDragging(null); }}>
      <span className="step-grip" aria-hidden="true">⋮⋮</span>
      <input value={item.title} aria-label={t("步骤名称")} onChange={(event) => { const title = event.target.value; setDraft((list) => list.map((row, i) => i === index ? { ...row, title } : row)); setDirty(true); }} />
      <span className="step-tools">
        {index > 0 && <button type="button" aria-label={t("上移")} onClick={() => move(index, index - 1)}>↑</button>}
        {index < draft.length - 1 && <button type="button" aria-label={t("下移")} onClick={() => move(index, index + 1)}>↓</button>}
        <button type="button" aria-label={t("删除步骤")} onClick={() => { setDraft((list) => list.filter((_, i) => i !== index)); setDirty(true); }}>×</button>
      </span>
    </li>)}</ol>
    <div className="steps-actions">
      <button type="button" onClick={() => { setDraft((list) => [...list, { id: undefined, title: "" }]); setDirty(true); }}>{t("＋ 添加步骤")}</button>
      {dirty && <button type="button" className="primary-button" onClick={() => void post(stepsApi(detail.id), { action: "edit", steps: draft }).then((ok) => ok ? location.reload() : setStatus(t("未保存，请重试")))}>{t("保存步骤")}</button>}
      <button type="button" onClick={onDone}>{t(dirty ? "放弃修改" : "完成")}</button>
    </div>
    <form className="steps-fix" onSubmit={(event) => { event.preventDefault(); if (!fix.trim()) return;
      void post(stepsApi(detail.id), { action: "replan", feedback: fix }).then((ok) => { setStatus(t(ok ? "已提交，正在重新规划" : "未提交，请重试")); if (ok) setFix(""); }); }}>
      <input value={fix} maxLength={1000} placeholder={t("用一句话调整步骤，例如：先做第 3 题，检查合并到最后")} aria-label={t("用自然语言调整步骤")} onChange={(event) => setFix(event.target.value)} />
      <button type="submit">{t("重新规划")}</button>
    </form>
    {status && <small role="status">{status}</small>}
  </>;
}

/**
 * Handing in: how finishing is taken, what the task promised to deliver, what it is judged against (rings a click confirms), a progress
 * report in words for the judge, then the one completion form (`TaskCompletion`, shared with Today's block panel), and the record folded
 * at the foot. Before work starts the person can say how they feel; after, how heavy it was.
 */
function FinishPanel({ detail }: { detail: TaskDetail }) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState("");
  const t = useT(), locale = useLocale();
  const by: Record<string, string> = { person: "本人确认", assessment: "进度判定", gate: "闸门判定", none: "未判定" };
  const started = ["active", "evidence_review", "accepted"].includes(detail.state);
  return <div className="finish-panel">
    <CompletionChoice detail={detail} />
    {detail.evidenceContract.length > 0 && <div><h4 className="task-subhead">{t("要交付的")}</h4>
      <ul className="standards-contract">{detail.evidenceContract.map((item, index) => <li key={index}>
        <Tag tone={item.required ? "info" : "neutral"}>{t(item.required ? "必交" : "可选")}</Tag><span>{item.description}</span></li>)}</ul></div>}
    <div><h4 className="task-subhead">{t("达成标准")}</h4>
      {detail.criteria.length ? <ul className="standards-list">{detail.criteria.map((criterion) => <li key={criterion.id}>
        <ProgressRing quarters={criterion.quarters} label={criterion.statement}
          {...(criterion.quarters < 4 ? { onConfirm: () => void post(stepsApi(detail.id), { action: "confirm_criterion", criterionId: criterion.id }).then((ok) => ok && location.reload()) } : {})} />
        <span>{criterion.statement}{criterion.note && <small className="gen">{criterion.note}</small>}</span>
        <Tag>{by[criterion.by] ? t(by[criterion.by]!) : ""}</Tag>
      </li>)}</ul> : <p className="muted">{t("所属里程碑没有写达成标准：按「要交付的」交齐即算完成。")}{detail.milestone && <> <a href={`/milestones?open=${encodeURIComponent(detail.milestone.id)}`}>{t("去主线补标准")}</a></>}</p>}</div>
    {detail.state === "active" && <form className="progress-report" onSubmit={(event) => { event.preventDefault(); if (!text.trim()) return;
      void post(stepsApi(detail.id), { action: "report", text }).then((ok) => { setStatus(t(ok ? "已提交，正在判定进度" : "未提交，请重试")); if (ok) setText(""); }); }}>
      <textarea value={text} maxLength={2000} rows={2} placeholder={t("描述当前进度，例如：第 1–3 题已完成，第 4 题卡在边界条件")} aria-label={t("进度描述")} onChange={(event) => setText(event.target.value)} />
      <button type="submit">{t("判定进度")}</button>
    </form>}
    {status && <small role="status">{status}</small>}
    {(detail.state === "approved" || detail.state === "ready_for_human") && <p className="finish-probe"><small>{t("开始前精力")}</small><EnergyProbe context="before_task" workOrderId={detail.id} /></p>}
    {COMPLETABLE.includes(detail.state) && <TaskCompletion task={detail} />}
    {(detail.state === "evidence_review" || detail.state === "accepted") && <p className="finish-probe">
      <small>{t("顺手记一下（可跳过，用来校准估时与精力）")}</small><EnergyProbe context="after_task" workOrderId={detail.id} /></p>}
    {!started && !COMPLETABLE.includes(detail.state) && <p className="muted">{t("批准并开始后，在此提交成果。")}</p>}
    <details className="advanced task-record">
      <summary><Clock {...ICON} />{t("已投入 {{duration}} · {{count}} 次计时", { duration: minutesText(locale, detail.workedMinutes), count: detail.executions.length })}</summary>
      <RecordPanel detail={detail} />
    </details>
  </div>;
}

/** The task's record: time spent and the person's own notes and postponements (recording in words is the task's input box). */
function RecordPanel({ detail }: { detail: TaskDetail }) {
  const t = useT(), locale = useLocale();
  const interruptions = detail.executions.reduce((sum, item) => sum + item.interruptions.length, 0);
  return <div className="record-panel">
    <p className="record-figures"><span className="ui-stat"><b>{minutesText(locale, detail.workedMinutes)}</b><span>{t("已投入")}</span></span>
      <span className="ui-stat"><b>{detail.executions.length}</b><span>{t("次计时", { count: detail.executions.length })}</span></span>
      <span className="ui-stat"><b>{interruptions}</b><span>{t("次中断", { count: interruptions })}</span></span></p>
    {detail.notes.length > 0 ? <ol className="record-notes">{detail.notes.map((note, index) => <li key={index} data-kind={note.kind}>
      <small className="mono">{localStamp(note.at, detail.timeZone)}</small><span>{note.text}</span></li>)}</ol> : <p className="muted">{t("尚无记录。")}</p>}
  </div>;
}

/** Materials still being prepared by the system: start it over, or say they are ready (the old execution panel's two buttons). */
function PreparingActions({ detail }: { detail: TaskDetail }) {
  const t = useT();
  const [status, setStatus] = useState("");
  if (detail.state !== "preparing") return null;
  const send = (action: string) => void post(`/api/work-orders/${encodeURIComponent(detail.id)}/execution`, { action })
    .then((ok) => ok ? location.reload() : setStatus(t("操作未生效，请刷新查看真实状态。")));
  return <p className="materials-preparing"><small>{t("材料准备中")}</small>
    <button type="button" className="text-button" onClick={() => send("materials_retry")}>{t("重新准备材料")}</button>
    <button type="button" className="text-button" onClick={() => send("materials_ready")}>{t("材料已备好")}</button>
    {status && <small role="status">{status}</small>}</p>;
}

/**
 * The task opened from any card, in place: the same content as its own page, and a link to that page (which has the back button and
 * keeps the address). `slot` is the card's next block, which the detail's head shows.
 */
export function TaskDialog({ detail, slot, today, open, onOpenChange }: {
  detail: TaskDetail; slot?: TaskSlotLike | undefined; today?: string | undefined; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const full = useWholeDetail(detail, open);
  return <Sheet title={detail.title} size="wide" open={open} onOpenChange={onOpenChange}
    footer={<Link className="secondary" href={`/workbench/${encodeURIComponent(detail.id)}`} prefetch={false}>{t("完整页面")}</Link>}>
    {full === "failed" ? <p role="alert">{t("读取失败")}</p> : full ? <TaskPanels detail={full} slot={slot} today={today} /> : <p role="status" className="muted">{t("正在读取…")}</p>}
  </Sheet>;
}

type Pane = "steps" | "materials" | "finish";

/** A head figure: its name, the number large, a line under it, and — where it can be changed in place — a pencil. */
function Figure({ label, value, sub, edit, children }: { label: string; value: ReactNode; sub?: ReactNode; edit?: ReactNode; children?: ReactNode }) {
  return <div className="tk-figure">
    <span className="tk-figure-label">{label}{edit}</span>
    <b className="tk-figure-value">{value}</b>
    {sub && <small className="tk-figure-sub">{sub}</small>}
    {children}
  </div>;
}

/** 截止: the due day, changed through the date picker and previewed before it applies. */
function DueFigure({ detail, editable }: { detail: TaskDetail; editable: boolean }) {
  const t = useT(), locale = useLocale();
  const impact = useImpact();
  const due = detail.window.dueBy;
  return <Figure label={t("截止")} value={due ? <span className="ds-serif">{shortDate(locale, due)}</span> : t("未定")}
    sub={due ? weekdayShort(locale, new Date(`${due.slice(0, 10)}T12:00:00`).getDay()) : undefined}
    edit={editable ? <DateChip label={t("改截止日期")} value={due} onChange={(date) => void impact.propose({ kind: "due", workOrderId: detail.id, date })} icon={<Pencil {...SMALL} />} /> : undefined}>
    {impact.busy && !impact.pending && <small role="status">{t("计算影响…")}</small>}
    {impact.error && <small role="status">{impact.error}</small>}
    {impact.pending && <ImpactCard impact={impact.pending.impact} busy={impact.busy} onApply={() => void impact.apply()} onCancel={impact.cancel} />}
  </Figure>;
}

/** 剩余: the open steps' usual time and the cautious one; without steps the task's own estimate, dragged in place. */
function RemainingFigure({ detail, editable }: { detail: TaskDetail; editable: boolean }) {
  const t = useT(), locale = useLocale();
  const [editing, setEditing] = useState(false);
  const impact = useImpact();
  const left = remainingMinutes(detail);
  const byStep = Boolean(detail.stepPlan);
  return <Figure label={t("剩余")} value={<span className="ds-serif">{hoursShort(left.p50, locale)}</span>} sub={t("保守 {{hours}}", { hours: hoursShort(left.p85, locale) })}
    edit={editable ? <IconButton label={byStep ? t("改时长：在下面的步骤里逐步调整") : t("改时长")} icon={<Pencil {...SMALL} />} className="tk-figure-edit"
      aria-expanded={editing} onClick={() => setEditing((value) => !value)} /> : undefined}>
    {editing && (byStep ? <small className="tk-figure-note">{t("剩余是各未完成步骤之和；点开一步，拖它的时长条。")}</small>
      : <DurationBar p25={detail.estimate.p25Minutes} p50={detail.estimate.p50Minutes} p85={detail.estimate.p85Minutes} samples={detail.estimate.observationCount} label={t("时长")}
        onCommit={(p50Minutes) => void impact.propose({ kind: "estimate", workOrderId: detail.id, p50Minutes })} />)}
    {impact.pending && <ImpactCard impact={impact.pending.impact} busy={impact.busy} onApply={() => void impact.apply()} onCancel={impact.cancel} />}
  </Figure>;
}

/**
 * Everything about one task (redesigned 2026-10-28 after the page draft). The head: line, state, risk, the milestone it serves and what it
 * supports on other lines; four figures — progress, due (edited in place), what is left (edited in place without steps) and the next
 * block (with the running timer or the time already spent) — and the actions (start, pause, 完成并提交, 交给助手, 推迟, more). Then two
 * columns where there is room: 步骤 on the left; 材料与教程 and 提交与完成 on the right. Where there is not (a phone, a narrow sheet) a
 * switch shows one of the three and the actions sit at the foot. The task's own input box closes it. The dialog's content and the whole
 * of the task's page (`/workbench/[id]`, where `anchors` gives the sections the ids links such as 「#tutorial」 and 「#materials」 land on).
 */
export function TaskPanels({ detail, slot, today, anchors = false }: {
  detail: TaskDetail; slot?: TaskSlotLike | undefined; today?: string | undefined; anchors?: boolean;
}) {
  const [postponing, setPostponing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [pane, setPane] = useState<Pane>("steps");
  const t = useT(), locale = useLocale();
  const root = useRef<HTMLDivElement>(null);
  const live = !["accepted", "archived", "evidence_review"].includes(detail.state);
  const editable = !["accepted", "archived"].includes(detail.state);
  const steps = detail.stepPlan?.steps ?? [];
  const done = steps.filter((step) => step.status !== "planned").length;
  const percent = Math.round((detail.stepPlan?.progress ?? (detail.state === "accepted" ? 1 : 0)) * 100);
  const crossLine = detail.supports.length > 0 || (detail.artifactLinks?.length ?? 0) > 0;
  const running = detail.agentOutputs.find((task) => task.status === "running");
  const toComplete = () => {
    setPane("finish");
    requestAnimationFrame(() => root.current?.querySelector("#complete, .tk-complete")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  const actions = (where: "head" | "dock") => <div className={where === "head" ? "tk-head-actions" : "tk-dock"}>
    <TaskActions iconic labelPrimary workOrderId={detail.id} state={detail.state} approvable={!detail.preparing} paused={detail.paused}
      agentReady={detail.agentSteps.length > 0} agentStepId={detail.agentSteps[0]?.id}
      offline={{ ownerId: detail.viewerId, workspaceId: detail.workspaceId, intent: detail.intent }}>
      {COMPLETABLE.includes(detail.state) && <button type="button" className={detail.state === "active" ? "primary-button task-actions-main" : "secondary-button task-actions-main"}
        onClick={toComplete}><Check {...ICON} /><span>{t("完成并提交")}</span></button>}
      {live && <IconButton label={t("推迟")} icon={<CalendarClock {...ICON} />} aria-expanded={postponing} onClick={() => setPostponing((value) => !value)} />}
    </TaskActions>
  </div>;
  const section = (id: Pane, title: string, extra: ReactNode, body: ReactNode) => <section className="task-section tk-card" data-section={id}
    data-shown={pane === id || undefined} aria-labelledby={`${detail.id}-${id}`} {...(anchors ? { id } : {})}>
    <header className="tk-section-head"><h3 id={`${detail.id}-${id}`} className="task-section-title">{t(title)}</h3>{extra}</header>
    {body}
  </section>;
  return <div className="task-dialog tk-detail" data-line={detail.identityId} ref={root}>
    <header className="tk-head tk-card">
      <p className="tk-tags">
        <span className="tk-line"><i className="task-card-dot" aria-hidden="true" />{detail.identityLabel}</span>
        {detail.projectName && <span className="tk-project">{detail.projectName}</span>}
        <Tag>{t(stateLabelFor(detail.state, detail.paused))}</Tag>
        {detail.riskTier !== "routine" && <Tag tone={riskTone[detail.riskTier] ?? "neutral"}>{t(riskLabel[detail.riskTier] ?? detail.riskTier)}</Tag>}
        {detail.milestone && <a className="tk-milestone" href={`/milestones?open=${encodeURIComponent(detail.milestone.id)}`}>→ {detail.milestone.title}</a>}
        {crossLine && <span className="tk-cross">
          {detail.supports.map((item) => <SupportsTag key={`${item.line}:${item.target}`} line={item.line} lineLabel={item.lineLabel} target={item.target} {...(item.artifact ? { artifact: item.artifact } : {})} />)}
          {detail.artifactLinks?.map((item) => <ArtifactTag key={`${item.direction}:${item.line}:${item.title}`} {...item} />)}</span>}
      </p>
      {detail.intent !== detail.title && <p className="task-dialog-description gen">{detail.intent}</p>}
      <div className="tk-figures">
        <Figure label={t("进度")} value={<><span className="ds-serif">{percent}</span><small>%</small></>} sub={steps.length ? t("{{done}}/{{total}} 步", { done, total: steps.length }) : undefined}>
          {steps.length > 0 && <StepStrip detail={detail} size="page" />}
        </Figure>
        <DueFigure detail={detail} editable={editable} />
        <RemainingFigure detail={detail} editable={editable && live} />
        <Figure label={t("下一次时段")} value={slot ? slotWhen(locale, slot, t, today) : t("未排")}
          sub={detail.state === "active" ? <RunningChip detail={detail} /> : detail.workedMinutes > 0 ? t("已计时 {{duration}}", { duration: minutesText(locale, detail.workedMinutes) }) : undefined} />
      </div>
      {actions("head")}
      {postponing && <PostponePanel workOrderId={detail.id} onClose={() => setPostponing(false)} />}
      {/* The assistant's run is watched and stopped in 小帮手 (scenarios.md 11): here only that it runs, and where. */}
      {running && <p className="tk-agent-running" role="status"><Bot {...SMALL} />{t("助手正在做「{{title}}」", { title: running.title || detail.title })} <a href="/helper">{t("在小帮手查看进度")}</a></p>}
    </header>
    <div className="tk-switch" role="tablist" aria-label={t("任务内容")}>
      {([["steps", t("步骤 {{count}}", { count: steps.length })], ["materials", t("材料")], ["finish", t("提交")]] as const).map(([id, label]) =>
        <button key={id} type="button" role="tab" aria-selected={pane === id} onClick={() => setPane(id)}>{label}</button>)}
    </div>
    <div className="tk-cols">
      {section("steps", "步骤", detail.stepPlan && !editing && <span className="tk-section-tools">
        <small>{detail.stepPlan.archetypeLabel} · {detail.stepPlan.quantity.amount > 0 ? `${detail.stepPlan.quantity.amount} ${detail.stepPlan.quantity.unit}` : detail.stepPlan.quantity.basis}</small>
        <button type="button" className="text-button" onClick={() => setEditing(true)}><SlidersHorizontal {...SMALL} />{t("调整步骤")}</button></span>,
        <StepsPanel detail={detail} editing={editing} onEditing={setEditing} />)}
      <div className="tk-side">
        {section("materials", "材料与教程", <a className="tk-section-link" href={`/materials/${encodeURIComponent(detail.id)}`}><BookOpen {...SMALL} />{t("阅读页")}</a>,
          <><PreparingActions detail={detail} /><TaskMaterials detail={detail} live={live} anchors={anchors} /></>)}
        {section("finish", "提交与完成", null, <FinishPanel detail={detail} />)}
      </div>
    </div>
    {/* One way in for everything about this task: ask about it, change it, record what happened. Changes come back as a card to apply. */}
    <div className="task-entry">
      <Conversation variant="task" page={{ kind: "task", entityId: detail.id }}
        placeholder={t("对这个任务说一句：改到下周一、这一步做完了、卡在哪、讲解第 3 步……")} />
    </div>
    {actions("dock")}
  </div>;
}

/** 「今天 14:00」 for today's block, else 「10/30 周五 14:00」. */
function slotWhen(locale: Locale, slot: TaskSlotLike, t: Translate, today: string | undefined): ReactNode {
  return <><small className="tk-figure-day">{slot.day === today ? t("今天") : dayText(locale, slot.day)}</small> <span className="ds-serif">{slot.start}</span></>;
}
