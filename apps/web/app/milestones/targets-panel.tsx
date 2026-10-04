"use client";

import { useState } from "react";
import { TARGET_GRADE_OPTIONS, type SuccessCriterion } from "@crossline/core";

export type CourseTargetRow = { projectId: string; identityId: string; name: string; value: string; why: string; proposed: boolean };
export type ThresholdMilestone = {
  id: string; identityId: string; projectId: string; title: string; status: "draft" | "approved" | "archived";
  successCriteria: SuccessCriterion[]; templateId?: string;
};

/**
 * The numbers a plan is built on, in one place and one click from changed. A course's target grade is first proposed by the
 * architect from the person's long-term goals, with its reason; here they accept it or pick another, and the line's draft
 * milestones are redone from the new target. Below it every score line / quantity can be edited in place, with the lowest line
 * that still reaches the outcome beside it so a change that leaves no margin is visible.
 */
export function TargetsPanel({ courses, milestones }: { courses: CourseTargetRow[]; milestones: ThresholdMilestone[] }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const setTarget = async (course: CourseTargetRow, value: string, redo: boolean) => {
    setBusy(true); setMessage("保存中…");
    const saved = await fetch("/api/targets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: course.projectId, value }) }).catch(() => undefined);
    if (!saved?.ok) { setMessage("没有保存成功，请重试。"); setBusy(false); return; }
    if (!redo) { location.reload(); return; }
    setMessage(`目标已改为「${value}」，正在按它重算「${course.name}」所在主线的里程碑草稿…（通常 2–5 分钟，可以先离开）`);
    const response = await fetch("/api/milestones/propose", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: "", only: [course.identityId] }) }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as { state?: string; message?: string; blocker?: { message?: string } } | undefined;
    if (!response?.ok || body?.state === "blocked") { setMessage(body?.message ?? body?.blocker?.message ?? "目标已保存，但重算没有完成；可以稍后在「补充你的情况」里重新设计。"); setBusy(false); return; }
    location.reload();
  };

  const saveValue = async (milestone: ThresholdMilestone, criterionId: string, value: number) => {
    setBusy(true); setMessage("保存中…");
    const successCriteria = milestone.successCriteria.map((criterion) => criterion.id === criterionId && criterion.measure.kind === "threshold"
      ? { ...criterion, measure: { ...criterion.measure, value } } : criterion);
    const response = await fetch("/api/milestones", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      id: milestone.id, identityId: milestone.identityId, projectId: milestone.projectId, title: milestone.title, status: milestone.status, successCriteria,
      ...(milestone.templateId ? { templateId: milestone.templateId } : {}) }) }).catch(() => undefined);
    if (response?.ok) { location.reload(); return; }
    setMessage("没有保存成功，请检查数值后重试。"); setBusy(false);
  };

  if (!courses.length && !milestones.length) return null;
  return <section className="review-block targets" aria-label="目标与分数线">
    <h2>目标与分数线{courses.some((course) => course.proposed) ? " · 有暂定目标等你过目" : ""}</h2>
    <p className="review-note">下面的数字都是从你要的结果倒推的。目标先由系统按你的长期目标暂定，不合适就直接改；改完所在主线的草稿里程碑会按新目标重算（已批准的不动，直接在下面改它的分数线）。</p>
    {courses.map((course) => <CourseRow key={course.projectId} course={course} busy={busy} onSet={(value, redo) => void setTarget(course, value, redo)} />)}
    {milestones.length > 0 && <details className="fold"><summary>每个里程碑的分数线与量化标准（可直接改数值）</summary>
      {milestones.map((milestone) => <div key={milestone.id} className="target-milestone">
        <b>{milestone.title}</b> <small>{milestone.status === "approved" ? "已批准" : "草稿"}</small>
        {milestone.successCriteria.flatMap((criterion) => criterion.measure.kind === "threshold"
          ? [<ThresholdRow key={criterion.id} criterion={criterion} busy={busy} onSave={(value) => void saveValue(milestone, criterion.id, value)} />] : [])}
      </div>)}
    </details>}
    {message && <p role="status">{message}</p>}
  </section>;
}

function CourseRow({ course, busy, onSet }: { course: CourseTargetRow; busy: boolean; onSet: (value: string, redo: boolean) => void }) {
  const [pick, setPick] = useState("");
  const [other, setOther] = useState("");
  const chosen = other.trim() || TARGET_GRADE_OPTIONS.find((option) => option.id === pick)?.label || "";
  return <div className="target-course">
    <b>{course.name}</b>：目标 <strong>{course.value}</strong> <small>{course.proposed ? "暂定（系统按你的长期目标提的）" : "你定的"}</small>
    {course.why && <p className="muted">理由：{course.why}</p>}
    <div className="target-controls">
      {course.proposed && <button type="button" disabled={busy} onClick={() => onSet(course.value, false)}>就按这个</button>}
      <label>改成<select value={pick} disabled={busy} onChange={(event) => setPick(event.target.value)}>
        <option value="">选一个…</option>
        {TARGET_GRADE_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select></label>
      <label>或自己写<input value={other} maxLength={120} disabled={busy} placeholder="如 总评 92 以上" onChange={(event) => setOther(event.target.value)} /></label>
      <button type="button" disabled={busy || !chosen} onClick={() => onSet(chosen, true)}>改并重算本线草稿</button>
    </div>
  </div>;
}

function ThresholdRow({ criterion, busy, onSave }: { criterion: SuccessCriterion; busy: boolean; onSave: (value: number) => void }) {
  const measure = criterion.measure as Extract<SuccessCriterion["measure"], { kind: "threshold" }>;
  const [value, setValue] = useState(String(measure.value));
  const number = Number(value);
  const bare = measure.bareLine;
  const noMargin = bare !== undefined && Number.isFinite(number) && (measure.comparator === "lte" ? number >= bare : number <= bare);
  return <div className="target-threshold">
    <span>{criterion.statement}</span>
    <label>{measure.comparator === "lte" ? "不超过" : "不低于"}<input type="number" step="any" value={value} disabled={busy} onChange={(event) => setValue(event.target.value)} /> {measure.unit}</label>
    {bare !== undefined && <small>刚好够到结果的最低线是 {bare}{noMargin ? "——这样改没有留余量" : ""}</small>}
    <button type="button" disabled={busy || !Number.isFinite(number) || number === measure.value} onClick={() => onSave(number)}>保存</button>
  </div>;
}
