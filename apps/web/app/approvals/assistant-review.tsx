import { AGENT_CATEGORIES } from "@crossline/core";
import type { AccessContext } from "@crossline/core";
import { loadAssistant, loadTaskAudit, type AssistantView } from "../../lib/agent";
import { ApprovalButtons, CategoryDecision, ReviewButtons } from "./assistant-controls";
import { Tag } from "../ui/tag";

const RESULT: Record<string, string> = { pass: "通过", fail: "未通过", not_run: "未运行" };
const minutes = (ms: number) => ms >= 60_000 ? `${Math.round(ms / 60_000)} 分钟` : `${Math.max(1, Math.round(ms / 1000))} 秒`;

/**
 * What a finished assistant task did and made, from the record written beside its files. The assistant's own account is set in the
 * generated-text face; the app's own record (commands, refusals, file changes) is listed apart from it.
 */
function TaskBody({ ctx, task }: { ctx: AccessContext; task: AssistantView["tasks"][number] }) {
  const detail = loadTaskAudit(ctx, task.taskId);
  if (!detail) return <p className="muted">{task.blockerCode ? `未完成：${task.blockerMessage || "运行中断"}` : "未找到本次记录。"}</p>;
  const file = (relative: string) => `/api/agent/tasks/${encodeURIComponent(task.taskId)}/file?path=${encodeURIComponent(relative)}`;
  const declined = detail.audit.decisions.filter((d) => d.outcome === "declined").length;
  return <div className="assistant-detail">
    <p className="gen">{detail.summary}</p>
    {detail.inputsModified.length > 0 && <p role="alert"><strong>原文件被改动：</strong>{detail.inputsModified.join("；")}</p>}
    {detail.needsHuman.length > 0 && <div><h4>需本人完成</h4><ul>{detail.needsHuman.map((item, i) => <li key={i}><strong>{item.what}</strong> <span className="gen">{item.why}</span></li>)}</ul></div>}
    {detail.artifacts.length > 0 && <div><h4>产出 · {detail.artifacts.length}</h4><ul>{detail.artifacts.map((item) => <li key={item.path}>
      <a href={file(item.path)} target="_blank" rel="noreferrer">{item.path}</a> <span className="gen">{item.purpose}</span></li>)}</ul></div>}
    {detail.verification.length > 0 && <div><h4>自检</h4><ul>{detail.verification.map((item, i) => <li key={i}>
      <Tag tone={item.result === "pass" ? "ok" : item.result === "fail" ? "risk" : "neutral"}>{RESULT[item.result] ?? item.result}</Tag> <span className="gen">{item.check}</span></li>)}</ul></div>}
    {detail.notDone.length > 0 && <div><h4>未完成</h4><ul>{detail.notDone.map((item, i) => <li key={i} className="gen">{item.what} — {item.why}</li>)}</ul></div>}
    {detail.assumptions.length > 0 && <div><h4>假设</h4><ul>{detail.assumptions.map((item, i) => <li key={i} className="gen">{item}</li>)}</ul></div>}
    <details className="fold advanced"><summary>运行记录：{detail.audit.commands.length} 条命令 · {detail.audit.filesChanged.length} 处文件改动 · {detail.audit.searches.length} 次搜索 · 拦下 {declined} 次</summary>
      {detail.audit.decisions.length > 0 && <ul>{detail.audit.decisions.map((d, i) => <li key={i}>{d.outcome === "declined" ? "拦下" : "允许"} · {d.reason || d.rule}</li>)}</ul>}
      {detail.audit.searches.length > 0 && <ul>{detail.audit.searches.map((q, i) => <li key={i}>搜索：{q}</li>)}</ul>}
    </details>
  </div>;
}

/** The assistant's part of 待确认: kinds of work it asks to start, questions it put mid-run, and results waiting for review. */
export function AssistantReview({ ctx, deferred = () => undefined }: { ctx: AccessContext; deferred?: (workOrderId: string) => string | undefined }) {
  const view = loadAssistant(ctx);
  const results = view.tasks.filter((task) => task.status === "needs_review");
  // Results for work that need not start within a week are folded (decided 2026-10-10), the soonest to come up first.
  const review = results.filter((task) => !deferred(task.workOrderId));
  const later = results.filter((task) => deferred(task.workOrderId)).sort((a, b) => deferred(a.workOrderId)!.localeCompare(deferred(b.workOrderId)!));
  if (!view.categoryRequests.length && !view.approvals.length && !results.length) return null;
  const card = (task: AssistantView["tasks"][number]) => <article key={task.taskId} className="assistant-task" data-status={task.status}>
    <h3>{task.title}</h3>
    <p className="assistant-meta"><Tag>{AGENT_CATEGORIES[task.category]}</Tag><small>用时 {minutes(task.durationMs)}</small>
      {task.workOrderId && <a href={`/workbench/${encodeURIComponent(task.workOrderId)}`}>对应任务</a>}
      {!task.checksPassed && <Tag tone="warn">自检未全部通过</Tag>}{task.autoApproved && <Tag tone="info">来自自动生效的任务</Tag>}
      {deferred(task.workOrderId) && <small>{deferred(task.workOrderId)!.slice(5)} 起列入本周</small>}</p>
    <TaskBody ctx={ctx} task={task} />
    <ReviewButtons taskId={task.taskId} />
  </article>;
  return <section className="pending-block" id="assistant" aria-label="助手">
    <h2>助手 · {view.categoryRequests.length + view.approvals.length + review.length}</h2>
    {view.categoryRequests.map((request) => <div key={request.category} className="assistant-ask">
      <p><strong>请求开始「{request.label}」类工作</strong>{request.workOrderTitle && <> · 起因：{request.workOrderTitle}</>}</p>
      <CategoryDecision category={request.category} label={request.label} />
    </div>)}
    {view.approvals.map((approval) => <div key={approval.id} className="assistant-ask">
      <p><strong>运行中请求许可：</strong>{approval.reason || approval.rule} <small className="muted">10 分钟内未回复视为不同意</small></p>
      <ApprovalButtons id={approval.id} />
    </div>)}
    {review.map(card)}
    {later.length > 0 && <details className="fold advanced"><summary>以后再定的助手成果 · {later.length}（对应任务一周后才需开始）</summary>{later.map(card)}</details>}
  </section>;
}
