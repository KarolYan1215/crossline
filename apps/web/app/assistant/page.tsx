import { SubpageShell } from "../subpage-shell";
import { requireSessionContext } from "../../lib/access-guard";
import { ensureSeeded } from "../../lib/crossline";
import { loadAssistant, loadTaskAudit, type AssistantView } from "../../lib/agent";
import { AGENT_CATEGORIES } from "@crossline/core";
import { ApprovalButtons, CategoryDecision, CategoryRevoke, PauseSwitch, ReviewButtons } from "./assistant-controls";

export const dynamic = "force-dynamic";

const STATUS: Record<string, string> = { running: "进行中", stale: "没有结果（可能被中断）", blocked: "没做成", needs_review: "等你过目", accepted: "已采纳", rejected: "已退回" };
const RESULT: Record<string, string> = { pass: "通过", fail: "未通过", not_run: "没跑" };
const minutes = (ms: number) => ms >= 60_000 ? `${Math.round(ms / 60_000)} 分钟` : `${Math.max(1, Math.round(ms / 1000))} 秒`;

/** What one finished task did and made, read from the record written beside its files. Everything here is the app's own record except the assistant's own account, which is labelled as such. */
function TaskBody({ ctx, task }: { ctx: Awaited<ReturnType<typeof requireSessionContext>>; task: AssistantView["tasks"][number] }) {
  const detail = loadTaskAudit(ctx, task.taskId);
  if (!detail) return <p className="muted">{task.status === "running" ? "还在做，做完会出现在这里。" : task.blockerCode ? `没做成：${task.blockerCode}` : "找不到这次的记录文件。"}</p>;
  const file = (relative: string) => `/api/agent/tasks/${encodeURIComponent(task.taskId)}/file?path=${encodeURIComponent(relative)}`;
  return <div className="assistant-detail">
    <p>{detail.summary} <small className="muted">（这是助手自己的说明）</small></p>
    {detail.inputsModified.length > 0 && <p role="alert"><strong>你的原文件被改动了：</strong>{detail.inputsModified.join("；")}。请先确认没有损失。</p>}
    {detail.needsHuman.length > 0 && <div><h4>需要你做</h4><ul>{detail.needsHuman.map((item, i) => <li key={i}><strong>{item.what}</strong> — {item.why}</li>)}</ul></div>}
    {detail.artifacts.length > 0 && <div><h4>产出（{detail.artifacts.length}）</h4><ul>{detail.artifacts.map((item) => <li key={item.path}>
      <a href={file(item.path)} target="_blank" rel="noreferrer">{item.path}</a> — {item.purpose} <small className="muted">{item.bytes} B · {item.sha256.slice(0, 8)}</small></li>)}</ul>
      <p className="muted"><small>文件夹：{task.directory}</small></p></div>}
    {detail.verification.length > 0 && <div><h4>它做了哪些检查</h4><ul>{detail.verification.map((item, i) => <li key={i}>[{RESULT[item.result] ?? item.result}] {item.check}{item.evidence ? ` — ${item.evidence}` : ""}</li>)}</ul></div>}
    {detail.notDone.length > 0 && <div><h4>没做的</h4><ul>{detail.notDone.map((item, i) => <li key={i}>{item.what} — {item.why}</li>)}</ul></div>}
    {detail.assumptions.length > 0 && <div><h4>它替你做的假设</h4><ul>{detail.assumptions.map((item, i) => <li key={i}>{item}</li>)}</ul></div>}
    <details className="fold"><summary>应用自己记下的过程（不是助手的说法）：{detail.audit.commands.length} 条命令 · {detail.audit.filesChanged.length} 处文件改动 · {detail.audit.searches.length} 次搜索 · 被拦下 {detail.audit.decisions.filter((d) => d.outcome === "declined").length} 次</summary>
      {detail.audit.decisions.length > 0 && <ul>{detail.audit.decisions.map((d, i) => <li key={i}>[{d.outcome === "declined" ? "拦下" : "同意"}] {d.reason || d.rule} — <code>{d.subject}</code></li>)}</ul>}
      <ul>{detail.audit.commands.slice(0, 40).map((c, i) => <li key={i}><code>{c.exitCode ?? "—"}</code> {c.command.replace(/^"[^"]*powershell\.exe" -Command /i, "").slice(0, 160)}</li>)}</ul>
      {detail.audit.searches.length > 0 && <ul>{detail.audit.searches.map((q, i) => <li key={i}>搜索：{q}</li>)}</ul>}
    </details>
  </div>;
}

export default async function AssistantPage() {
  const ctx = await requireSessionContext();
  ensureSeeded(ctx);
  const view = loadAssistant(ctx);
  const review = view.tasks.filter((task) => task.status === "needs_review");
  const running = view.tasks.filter((task) => task.status === "running");
  const earlier = view.tasks.filter((task) => !["needs_review", "running"].includes(task.status));
  const waiting = view.categoryRequests.length + view.approvals.length + review.length;
  return <SubpageShell active="助手" title="助手"
    description={waiting ? `${waiting} 件事在等你。助手在你的电脑上读文件、跑命令、写脚本、画图，产出放在文件里；你定哪类活它可以做，并过目它做的。` : "助手在你的电脑上读文件、跑命令、写脚本、画图，产出放在文件里。你定哪类活它可以做，并过目它做的。"}>
    {(view.categoryRequests.length > 0 || view.approvals.length > 0) && <section className="pending-block" aria-label="等你同意">
      <h2>等你同意</h2>
      {view.categoryRequests.map((request) => <div key={request.category} className="assistant-ask">
        <p><strong>助手想开始做「{request.label}」这类事。</strong>{request.workOrderTitle && <> 起因：任务「{request.workOrderTitle}」。</>} {request.explained}</p>
        <p className="muted">每一类第一次开工前都要你同意。同意后它会自己开工，但前 {5} 次的产出都要你过目；连续被采纳且检查全过，才会改成检查通过即算完成、你抽查。</p>
        <CategoryDecision category={request.category} label={request.label} />
      </div>)}
      {view.approvals.map((approval) => <div key={approval.id} className="assistant-ask">
        <p><strong>助手在做事中途问你：</strong>{approval.reason || approval.rule}</p>
        <p><code>{approval.subject}</code></p>
        <p className="muted"><small>十分钟内没人回答就当作不同意。</small></p>
        <ApprovalButtons id={approval.id} />
      </div>)}
    </section>}

    {review.length > 0 && <section className="review-block" aria-label="等你过目">
      <h2>等你过目 · {review.length}</h2>
      {review.map((task) => <article key={task.taskId} className="assistant-task" data-status={task.status}>
        <h3>{task.title}</h3>
        <p className="muted">{AGENT_CATEGORIES[task.category]} · 用时 {minutes(task.durationMs)}{task.workOrderId && <> · <a href={`/workbench/${encodeURIComponent(task.workOrderId)}`}>对应任务</a></>}{!task.checksPassed && " · 它自己的检查没有全过"}</p>
        <TaskBody ctx={ctx} task={task} />
        <ReviewButtons taskId={task.taskId} />
      </article>)}
    </section>}

    {running.length > 0 && <section className="review-block" aria-label="进行中">
      <h2>进行中 · {running.length}</h2>
      <ul>{running.map((task) => <li key={task.taskId}>{task.title} <small className="muted">· {AGENT_CATEGORIES[task.category]} · 开始于 {task.requestedAt.slice(0, 16).replace("T", " ")}</small></li>)}</ul>
    </section>}

    <section className="review-block" aria-label="各类工作">
      <h2>各类工作</h2>
      <p className="muted">助手只做你同意过的类别，且每类单独积累信任：一开始产出都要你看，连续 {view.categories[0]?.runsToTrust ?? 5} 次被你采纳且检查全过，才改成检查通过即算完成；被退回一次，或检查没过一次，就回到全看。对外发送、付款交易、替你对别人做承诺，永远只能你来。</p>
      <ul className="assistant-categories">{view.categories.map((item) => <li key={item.category}>
        <strong>{item.label}</strong> —{" "}
        {item.state === "approved" ? <>已同意 · {item.trust === "auto_checked" ? "检查通过即算完成，你抽查" : `产出都要你过目（已连续 ${item.cleanRuns}/${item.runsToTrust} 次采纳）`} <CategoryRevoke category={item.category} label={item.label} /></>
          : item.state === "declined" ? <>你说这类自己做 <CategoryDecision category={item.category} label={item.label} /></>
          : <>还没问过你；有这类活时它会来请求 <CategoryDecision category={item.category} label={item.label} /></>}
        <br /><small className="muted">{item.explained}</small>
      </li>)}</ul>
      <PauseSwitch paused={view.paused} />
      <p className="muted"><small>{view.paused ? "已暂停：它不会再自己开工，你仍可以手动把任务交给它。" : "没有暂停：已同意的类别里，已批准、你还没开始做的任务，它会自己接着做（一次一个，额度快用完时不会开新的）。"}</small></p>
    </section>

    {earlier.length > 0 && <section className="review-block" aria-label="以前的">
      <h2>以前的</h2>
      {earlier.slice(0, 20).map((task) => <details key={task.taskId} className="fold"><summary>{STATUS[task.status] ?? task.status} · {task.title} · {AGENT_CATEGORIES[task.category]}{task.reviewNote ? ` · 备注：${task.reviewNote}` : ""}</summary>
        <TaskBody ctx={ctx} task={task} />
      </details>)}
    </section>}
  </SubpageShell>;
}
