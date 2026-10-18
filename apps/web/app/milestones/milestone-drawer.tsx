"use client";

import { useState } from "react";
import { Clamp } from "../ui/clamp";
import { riskLevelOf, TARGET_GRADE_OPTIONS, type SuccessCriterion } from "@crossline/core";
import type { BoardCourse, BoardCriterion, BoardMilestone } from "../../lib/milestone-board";
import { Sheet } from "../ui/overlay";
import { DateChip, ProgressRing, Slider, formatMinutes } from "../ui/controls";
import { Bullet } from "../ui/charts";
import { LineTag, Tag } from "../ui/tag";
import { RiskGlyph, RiskList } from "./risk-glyph";

const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .catch(() => undefined);
const md = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
/** The margin rule the architect is held to (`MARGIN_RATIO`): a line within 3% of the bare line is flagged, not refused. */
const MARGIN = 0.03;

/** Reloads with the drawer open again (`?open=<id>`): a plain reload closed it after every edit, and the person lost their place. */
function reopen(id: string) {
  const url = new URL(location.href);
  url.searchParams.set("open", id);
  location.replace(url.toString());
}

function useAction(reopenId?: string) {
  const [state, setState] = useState<{ busy: boolean; message: string }>({ busy: false, message: "" });
  const run = async (pending: string, work: () => Promise<Response | undefined>, failed: string, keepOpen = true) => {
    setState({ busy: true, message: pending });
    const response = await work();
    if (response?.ok) { if (reopenId && keepOpen) reopen(reopenId); else location.reload(); return; }
    setState({ busy: false, message: failed });
  };
  return { ...state, run };
}

/**
 * Everything about one milestone beside the timeline, decided and edited in place: what could keep it from being reached (risk glyphs and
 * short tags), its title, date and importance (always editable — a draft's date is its proposal, an approved one's is confirmed), what it
 * is judged by with each reading as a ring and each score line as a bullet chart, how it feeds or draws on other lines, the tasks and
 * steps under it, the reasoning it was proposed with, and — once every criterion is met — its retrospective. A draft is approved or
 * withdrawn from the footer, next to its risks.
 */
export function MilestoneDrawer({ milestone, labels, onClose }: { milestone: BoardMilestone; labels: Record<string, string>; onClose: () => void }) {
  const action = useAction(milestone.id);
  const [weight, setWeight] = useState(milestone.weight);
  const approved = milestone.status === "approved";
  const saveGoal = (body: Record<string, unknown>) => action.run("保存中…", () => post(`/api/goals/${encodeURIComponent(milestone.id)}`, body), "未保存，请重试。");
  const decideDraft = (decision: "approved" | "archived") => action.run(decision === "approved" ? "批准中…" : "撤销中…",
    () => post("/api/milestones/approve-batch", { ids: [milestone.id], decision }), "操作未完成，请刷新后重试。", decision === "approved");
  // Every edit here is a new version of the milestone (`/api/milestones`), so the criteria a past verdict was judged against stay readable.
  const saveMilestone = (patch: { title?: string; status?: string; successCriteria?: SuccessCriterion[] }, pending = "保存中…", failed = "未保存，请检查后重试。") =>
    action.run(pending, () => post("/api/milestones", {
      id: milestone.id, identityId: milestone.identityId, projectId: milestone.projectId, title: milestone.title, status: milestone.status,
      successCriteria: milestone.successCriteria, ...(milestone.templateId ? { templateId: milestone.templateId } : {}), ...patch }), failed,
    patch.status !== "archived");
  const saveThreshold = (criterionId: string, value: number) => saveMilestone({
    successCriteria: milestone.successCriteria.map((criterion: SuccessCriterion) => criterion.id === criterionId && criterion.measure.kind === "threshold"
      ? { ...criterion, measure: { ...criterion.measure, value } } : criterion) }, "保存中…", "未保存，请检查数值。");
  const [title, setTitle] = useState(milestone.title);
  const level = riskLevelOf(milestone.risks);
  // A draft's date and importance wait beside it until approval; an approved milestone's are its goal settings.
  const saveDraft = (body: { deadline?: string; weight?: number }) =>
    action.run("保存中…", () => post(`/api/milestones/${encodeURIComponent(milestone.id)}/draft-settings`, body), "未保存，请重试。");
  const saveDeadline = (value: string) => approved ? saveGoal({ confirmedDeadline: value }) : saveDraft({ deadline: value });
  const saveWeight = (value: number) => approved ? saveGoal({ weight: value }) : saveDraft({ weight: value });
  const removeFlow = (id: string) => action.run("去掉中…", () => fetch(`/api/milestone-relations/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined),
    "未完成，请刷新后重试。");

  return <Sheet side="right" title={milestone.title} open onOpenChange={(open) => !open && onClose()}
    footer={<div className="md-actions">
      {milestone.status === "draft" && <>
        <span className="md-approve-risk">{level ? <><RiskGlyph level={level} />批准即接受 {milestone.risks.length} 项风险</> : "未见明显风险"}</span>
        <button type="button" className="primary-button" disabled={action.busy} onClick={() => void decideDraft("approved")}>批准</button>
        <button type="button" disabled={action.busy} onClick={() => void decideDraft("archived")}>撤销草稿</button>
      </>}
      {approved && <button type="button" disabled={action.busy} onClick={() => void saveMilestone({ status: "archived" }, "归档中…")}>归档</button>}
    </div>}>
    <div className="md" data-line={milestone.identityId}>
      <div className="md-tags">
        <LineTag line={milestone.identityId}>{labels[milestone.identityId] ?? milestone.identityId}</LineTag>
        {milestone.projectName && <Tag>{milestone.projectName}</Tag>}
        <Tag tone={approved ? "ok" : "info"}>{approved ? "已批准" : "待批准"}</Tag>
      </div>

      <section className="md-risk" aria-label="风险">
        <h3><RiskGlyph level={level} size={14} />{level ? `风险 ${milestone.risks.length} 项` : "未见明显风险"}
          <small className="md-sub">{milestone.riskSource === "model" ? "里程碑生成时审查" : "按日期、依赖与标准估算"}</small></h3>
        <RiskList risks={milestone.risks} gen={milestone.riskSource === "model"} />
      </section>

      <form className="md-row md-title" onSubmit={(event) => { event.preventDefault(); if (title.trim() && title.trim() !== milestone.title) void saveMilestone({ title: title.trim() }); }}>
        <label className="md-key" htmlFor={`md-title-${milestone.id}`}>标题</label>
        <input id={`md-title-${milestone.id}`} value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} />
        {title.trim() && title.trim() !== milestone.title && <button type="submit" disabled={action.busy}>保存</button>}
      </form>

      <section className="md-block" aria-label="日期与重要性">
        <div className="md-row"><span className="md-key">截止</span>
          <DateChip label="截止日" value={milestone.deadline} onChange={(value) => void saveDeadline(value)} />
          {milestone.daysLeft !== undefined && <span className="mono md-sub">{milestone.daysLeft >= 0 ? `剩 ${milestone.daysLeft} 天` : `已过 ${-milestone.daysLeft} 天`}</span>}
          {milestone.confirmedDeadline && <Tag tone="info" title="排程以此日期为硬约束">已确认</Tag>}
        </div>
        <div className="md-row"><span className="md-key">重要性</span>
          <Slider label="重要性" value={weight} preset={milestone.presetWeight} onChange={setWeight}
            onCommit={(value) => value !== milestone.weight && void saveWeight(value)} />
          <small className="md-sub">{milestone.ownWeight ? approved ? "本人调整" : "本人调整，批准后生效" : "系统判断，可拖动调整"}</small>
        </div>
        {milestone.ticks.length > 0 && <TickStrip milestone={milestone} />}
      </section>

      <section className="md-block" aria-label="验收标准">
        <h3>验收标准 <span className="mono md-sub">{milestone.criteria.filter((criterion) => criterion.quarters === 4).length}/{milestone.criteria.length}</span></h3>
        {milestone.criteria.length === 0 && <p className="md-sub">尚无验收标准：关联任务仍按各自证据验收，但里程碑进度无法记录。</p>}
        {milestone.criteria.map((criterion) => <CriterionRow key={criterion.id} criterion={criterion} busy={action.busy}
          onSave={(value) => void saveThreshold(criterion.id, value)}
          onReword={(statement) => void saveMilestone({ successCriteria: milestone.successCriteria.map((item: SuccessCriterion) =>
            item.id === criterion.id ? { ...item, statement } : item) })}
          {...(milestone.successCriteria.length > 1 ? { onRemove: () => void saveMilestone({
            successCriteria: milestone.successCriteria.filter((item: SuccessCriterion) => item.id !== criterion.id) }, "去掉中…", "未去掉：至少保留一条衡量结果的标准。") } : {})} />)}
        {milestone.successCriteria.length < 10 && <AddCriterion busy={action.busy}
          onAdd={(criterion) => void saveMilestone({ successCriteria: [...milestone.successCriteria, criterion] })} />}
      </section>

      {milestone.tasks.length > 0 && <section className="md-block" aria-label="任务与步骤">
        <h3>任务与步骤</h3>
        <ul className="md-tree">{milestone.tasks.map((task) => <li key={task.id}>
          <a href={`/workbench/${encodeURIComponent(task.id)}`} className="md-task">
            <span className="md-task-bar" aria-hidden="true"><i style={{ width: `${Math.round((task.progress ?? 0) * 100)}%` }} /></span>
            <b>{task.intent}</b><span className="mono md-sub">{task.progress === null ? "未拆分" : `${Math.round(task.progress * 100)}%`}</span>
          </a>
          {task.steps.length > 0 && <ol className="md-steps">{task.steps.map((step) => <li key={step.id} data-status={step.status}>
            <span className="md-step-dot" aria-hidden="true" />{step.title}{step.tick && <small className="gen"> → {step.tick}</small>}
          </li>)}</ol>}
        </li>)}</ul>
      </section>}

      {milestone.relations.length > 0 && <section className="md-block" aria-label="与其他主线的关系">
        <h3>与其他主线的关系</h3>
        {milestone.relations.map((relation) => <RelationRow key={relation.id} relation={relation} labels={labels} busy={action.busy}
          onDecide={(decision) => void action.run("保存中…", () => post("/api/milestone-relations/decide", { ids: [relation.id], decision }), "未保存，请重试。")}
          onRemove={relation.artifact && relation.pending ? () => void removeFlow(relation.id) : undefined} />)}
      </section>}

      {milestone.retrospective && <Retrospective milestone={milestone} />}

      {milestone.rationale && <section className="md-block" aria-label="依据与推导"><h3>依据与推导</h3><p className="gen md-rationale"><Clamp lines={3} text={milestone.rationale.replace(/\s*[（(]?\s*bareLine\s*[)）]?/g, "（最低够线）").replace(/（最低够线）（最低够线）/g, "（最低够线）")} /></p></section>}
      {action.message && <p role="status" className="md-status">{action.message}</p>}
    </div>
  </Sheet>;
}

/** One more criterion: a thing that must exist (产出物), or a result judged against a stated way it fails (结果). */
function AddCriterion({ busy, onAdd }: { busy: boolean; onAdd: (criterion: SuccessCriterion) => void }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"outcome" | "output">("outcome");
  const [statement, setStatement] = useState("");
  const [failsWhen, setFailsWhen] = useState("");
  if (!open) return <button type="button" className="text-button" onClick={() => setOpen(true)}>加一条标准</button>;
  const ready = statement.trim() && (kind === "output" || failsWhen.trim());
  return <form className="md-add-criterion" onSubmit={(event) => {
    event.preventDefault();
    if (!ready) return;
    const id = `c-${Math.random().toString(36).slice(2, 9)}`;
    onAdd(kind === "output"
      ? { id, statement: statement.trim(), required: true, evidenceOf: "output", measure: { kind: "artifact", mustExist: statement.trim() } }
      : { id, statement: statement.trim(), required: true, evidenceOf: "outcome", measure: { kind: "judgement", rubric: statement.trim(), failsWhen: failsWhen.trim() } });
  }}>
    <select value={kind} onChange={(event) => setKind(event.target.value as "outcome" | "output")} aria-label="标准类型">
      <option value="outcome">结果</option><option value="output">产出物</option>
    </select>
    <input value={statement} maxLength={400} placeholder={kind === "output" ? "必须存在的产出，例如：投稿确认邮件" : "达成的结果，例如：审稿意见为小修"} onChange={(event) => setStatement(event.target.value)} />
    {kind === "outcome" && <input value={failsWhen} maxLength={400} placeholder="什么情况算未达成" onChange={(event) => setFailsWhen(event.target.value)} />}
    <button type="submit" disabled={busy || !ready}>添加</button>
    <button type="button" className="text-button" onClick={() => setOpen(false)}>取消</button>
  </form>;
}

/** The milestone's ticks on a strip from today to its deadline, so the near-term results read as a run-up rather than a list. */
function TickStrip({ milestone }: { milestone: BoardMilestone }) {
  const days = milestone.ticks.flatMap((tick) => tick.day ? [tick.day] : []);
  const end = milestone.deadline ?? days.sort().at(-1);
  const start = [...days].sort()[0];
  if (!end || !start) return null;
  const span = Math.max(1, (Date.parse(end) - Date.parse(start)) / 86_400_000);
  const at = (day: string) => `${Math.max(0, Math.min(100, ((Date.parse(day) - Date.parse(start)) / 86_400_000 / span) * 100))}%`;
  return <div className="md-strip" aria-label="刻度">
    <span className="md-strip-axis" aria-hidden="true" />
    {milestone.ticks.map((tick) => <span key={tick.id} className="mt-tick md-strip-tick" data-state={tick.state} style={{ left: tick.day ? at(tick.day) : "0%" }}
      title={`${tick.outcome}${tick.day ? ` · ${md(tick.day)}` : ""}${tick.state === "postponed" ? " · 已顺延" : ""}`} />)}
    {milestone.deadline && <span className="mt-marker md-strip-end" data-kind="milestone" data-status={milestone.status} style={{ left: "100%" }} aria-hidden="true" />}
    <small className="mono md-strip-start">{md(start)}</small><small className="mono md-strip-stop">{md(end)}</small>
  </div>;
}

/**
 * One criterion: its reading as a ring, a score line edited in place, and its wording changed or the criterion taken out — before
 * 2026-10-18 an approved milestone's criteria could only be added to. Each change is a new version, so past verdicts stay readable.
 */
function CriterionRow({ criterion, busy, onSave, onReword, onRemove }: { criterion: BoardCriterion; busy: boolean; onSave: (value: number) => void;
  onReword: (statement: string) => void; onRemove?: (() => void) | undefined }) {
  const threshold = criterion.threshold;
  const [value, setValue] = useState(threshold ? String(threshold.value) : "");
  const [wording, setWording] = useState<string | null>(null);
  const number = Number(value);
  const bare = threshold?.bare;
  const thin = threshold && bare !== undefined && Number.isFinite(number)
    && (threshold.comparator === "lte" ? number > bare * (1 - MARGIN) : number < bare * (1 + MARGIN));
  return <div className="md-criterion">
    <ProgressRing quarters={criterion.quarters} label={criterion.statement} />
    <div>
      {wording === null
        ? <p>{criterion.statement} <button type="button" className="text-button" disabled={busy} onClick={() => setWording(criterion.statement)}>改</button>
          {onRemove && <button type="button" className="text-button" disabled={busy} onClick={onRemove}>去掉</button>}</p>
        : <form className="md-reword" onSubmit={(event) => { event.preventDefault(); const next = wording.trim();
            if (next && next !== criterion.statement) onReword(next); else setWording(null); }}>
          <input value={wording} maxLength={300} aria-label="验收标准" autoFocus onChange={(event) => setWording(event.target.value)} />
          <button type="submit" disabled={busy || !wording.trim()}>保存</button>
          <button type="button" className="text-button" onClick={() => setWording(null)}>取消</button>
        </form>}
      {criterion.observed && <small className="gen">{criterion.observed}</small>}
      {threshold && <div className="md-threshold">
        <Bullet label={criterion.statement} target={Number.isFinite(number) ? number : threshold.value} {...(bare !== undefined ? { bare } : {})}
          max={Math.max(threshold.value, number || 0, bare ?? 0) * 1.15 || 100} unit={threshold.unit} />
        <label>{threshold.comparator === "lte" ? "≤" : "≥"}<input type="number" step="any" value={value} disabled={busy} aria-label="分数线"
          onChange={(event) => setValue(event.target.value)} />{threshold.unit}</label>
        {bare !== undefined && <small className="mono md-sub">最低够线 {bare}{threshold.unit}</small>}
        {thin && <Tag tone="warn" title="分数线与最低够线的差距不足 3%">余量不足</Tag>}
        {Number.isFinite(number) && number !== threshold.value && <button type="button" disabled={busy} onClick={() => onSave(number)}>保存</button>}
      </div>}
    </div>
  </div>;
}

function RelationRow({ relation, labels, busy, onDecide, onRemove }: { relation: BoardMilestone["relations"][number]; labels: Record<string, string>; busy: boolean;
  onDecide: (decision: "approved" | "archived") => void;
  /** A cross-line artifact on a draft: removed on its own (it is approved together with the downstream milestone otherwise). */
  onRemove?: (() => void) | undefined }) {
  return <div className="md-relation" data-line={relation.otherLine} data-pending={relation.pending || undefined}>
    <div className="md-relation-head">
      <span className="md-relation-dir" aria-hidden="true">{relation.direction === "out" ? "→" : "←"}</span>
      <LineTag line={relation.otherLine}>{labels[relation.otherLine] ?? relation.otherLine}</LineTag>
      <b>{relation.otherTitle}</b>
      <Tag>{relation.kindLabel}</Tag>
      {relation.pending && <Tag tone="info">待审阅</Tag>}
      {relation.warning && <Tag tone="warn">{relation.warning}</Tag>}
      {relation.broken && <Tag tone="risk" title={relation.broken}>时间顺序不成立</Tag>}
      {onRemove && <button type="button" className="text-button md-relation-remove" disabled={busy} aria-label={`去掉「${relation.artifact?.title ?? relation.otherTitle}」这条飞轮关系`}
        onClick={onRemove}>去掉</button>}
    </div>
    {relation.artifact && <p className="md-artifact"><span className="md-key">{relation.direction === "in" ? "使用" : "供给"}</span>
      <span className="gen">「{relation.artifact.title}」</span>{relation.transfer && <small className="mono md-sub">{relation.transfer.expected} {relation.transfer.unit}{relation.transfer.metric}</small>}</p>}
    {relation.explanation && <p className="gen">{relation.explanation}</p>}
    {relation.refutedWhen && <p className="md-refuted"><span className="md-key">证伪条件</span><span className="gen">{relation.refutedWhen}</span></p>}
    {relation.pending && <div className="md-actions">
      <button type="button" disabled={busy || !relation.explanation} title={relation.explanation ? undefined : "缺少说明，无法批准"}
        onClick={() => onDecide("approved")}>批准</button>
      <button type="button" disabled={busy} onClick={() => onDecide("archived")}>撤销</button>
    </div>}
  </div>;
}

function Retrospective({ milestone }: { milestone: BoardMilestone }) {
  const retro = milestone.retrospective!;
  const [note, setNote] = useState(retro.note ?? "");
  const action = useAction();
  return <section className="md-block md-retro" aria-label="回顾">
    <h3>回顾</h3>
    <div className="md-retro-figures">
      <div className="ui-stat"><b>{retro.tasks}</b><span>任务</span></div>
      <div className="ui-stat"><b>{formatMinutes(retro.workedMinutes)}</b><span>计时</span></div>
      <div className="ui-stat"><b>{retro.reused}</b><span>跨主线复用</span></div>
    </div>
    {retro.readings.filter((reading) => reading.observed).map((reading) => <p key={reading.statement} className="md-reading">
      <span>{reading.statement}</span><span className="gen">{reading.observed}</span></p>)}
    <textarea value={note} maxLength={2000} rows={3} placeholder="有效做法、偏差与下次调整" aria-label="回顾记录" data-user-text
      onChange={(event) => setNote(event.target.value)} />
    <div className="md-actions">
      <button type="button" disabled={action.busy || !note.trim() || note === retro.note}
        onClick={() => void action.run("保存中…", () => post(`/api/milestones/${encodeURIComponent(milestone.id)}/retrospective`, { note }), "未保存，请重试。")}>保存回顾</button>
      {action.message && <span role="status">{action.message}</span>}
    </div>
  </section>;
}

/**
 * A course's score line as the end of its chain: the target with the reason it was proposed, accepted as is or changed — a change
 * redoes the line's untouched drafts from the new target (approved milestones keep theirs; their score lines are edited on each node).
 */
export function CourseDrawer({ course, milestones, onClose }: { course: BoardCourse; milestones: BoardMilestone[]; onClose: () => void }) {
  const [pick, setPick] = useState("");
  const [other, setOther] = useState("");
  const [state, setState] = useState({ busy: false, message: "" });
  const chosen = other.trim() || TARGET_GRADE_OPTIONS.find((option) => option.id === pick)?.label || "";
  const setTarget = async (value: string, redo: boolean) => {
    setState({ busy: true, message: "保存中…" });
    const saved = await post("/api/targets", { projectId: course.projectId, value });
    if (!saved?.ok) { setState({ busy: false, message: "未保存，请重试。" }); return; }
    if (!redo) { location.reload(); return; }
    setState({ busy: true, message: `分数线已改为「${value}」，正在重算该主线的里程碑草稿（约 2–5 分钟，可离开本页）` });
    const response = await post("/api/milestones/propose", { request: "", only: [course.identityId] });
    const body = await response?.json().catch(() => undefined) as { state?: string; blocker?: { message?: string } } | undefined;
    if (!response?.ok || body?.state === "blocked") { setState({ busy: false, message: body?.blocker?.message ?? "分数线已保存，草稿重算未完成。" }); return; }
    location.reload();
  };
  const thresholds = milestones.flatMap((milestone) => milestone.criteria.filter((criterion) => criterion.threshold)
    .map((criterion) => ({ milestone, criterion })));
  return <Sheet side="right" title={course.name} open onOpenChange={(open) => !open && onClose()}>
    <div className="md" data-line={course.identityId}>
      <div className="md-tags"><Tag>课程分数线</Tag><Tag tone={course.proposed ? "info" : "ok"}>{course.proposed ? "待审阅" : "已确认"}</Tag></div>
      <section className="md-block" aria-label="分数线">
        <p className="md-target"><b>{course.value}</b></p>
        {course.why && <p className="gen md-rationale"><Clamp lines={3} text={course.why} /></p>}
        <div className="md-actions">
          {course.proposed && <button type="button" className="primary-button" disabled={state.busy} onClick={() => void setTarget(course.value, false)}>批准</button>}
          <select value={pick} disabled={state.busy} aria-label="改为" onChange={(event) => setPick(event.target.value)}>
            <option value="">改为…</option>
            {TARGET_GRADE_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
          <input value={other} maxLength={120} disabled={state.busy} placeholder="或输入，如 总评 92 以上" aria-label="自定义分数线" onChange={(event) => setOther(event.target.value)} />
          <button type="button" disabled={state.busy || !chosen} onClick={() => void setTarget(chosen, true)}>修改并重算草稿</button>
        </div>
        {state.message && <p role="status" className="md-status">{state.message}</p>}
      </section>
      {thresholds.length > 0 && <section className="md-block" aria-label="链上的分数线"><h3>链上的分数线</h3>
        {thresholds.map(({ milestone, criterion }) => <div key={`${milestone.id}:${criterion.id}`} className="md-chainline">
          <span>{milestone.title}{milestone.deadline ? <small className="mono md-sub"> · {md(milestone.deadline)}</small> : null}</span>
          <Bullet label={criterion.statement} target={criterion.threshold!.value} {...(criterion.threshold!.bare !== undefined ? { bare: criterion.threshold!.bare } : {})}
            max={Math.max(criterion.threshold!.value, criterion.threshold!.bare ?? 0) * 1.15 || 100} unit={criterion.threshold!.unit} />
          <small className="mono">{criterion.threshold!.value}{criterion.threshold!.unit}</small>
        </div>)}
      </section>}
    </div>
  </Sheet>;
}
