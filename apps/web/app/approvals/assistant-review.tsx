import { AGENT_CATEGORIES } from "@crossline/core";
import type { AccessContext } from "@crossline/core";
import { loadAssistant, loadTaskAudit, outputNames, readTaskFile, type AssistantView, type TaskAudit } from "../../lib/agent";
import { ApprovalButtons, CategoryDecision, QuestionAnswer, RetryCheckButton, ReviewButtons, SendBackItem } from "./assistant-controls";
import { csvHead, groupOutputs, markdownHead, workflowSteps, type OutputItem } from "./assistant-outputs";
import { Markdown } from "../ui/markdown";
import { Namer, cleanText, humanTable, humanizeMarkdown } from "../materials/humanize";
import { Tag } from "../ui/tag";
import { Clamp } from "../ui/clamp";
import { localeFor, tOf } from "../../lib/locale";
import { entryDay, punct } from "../task/format";
import type { Locale, Translate } from "../../lib/i18n";

const minutes = (t: Translate, ms: number) => ms >= 60_000 ? t("{{count}} 分钟", { count: Math.round(ms / 60_000) }) : t("{{count}} 秒", { count: Math.max(1, Math.round(ms / 1000)) });

/** A file of the task's directory as text, for a preview; nothing when it cannot be read. */
function readText(ctx: AccessContext, taskId: string, relative: string): string | undefined {
  const file = readTaskFile(ctx, taskId, relative);
  return file && file.type.startsWith("text/") ? file.body.toString("utf8") : undefined;
}

/**
 * One deliverable: what it is and what it is for, opened in a new tab, with the opening of a document or the first rows of a table — both
 * cleaned of local paths, hashes and bookkeeping columns, each file called by its own name (`humanize`).
 */
function OutputCard({ ctx, taskId, item, namer }: { ctx: AccessContext; taskId: string; item: OutputItem; namer: Namer }) {
  const href = (relative: string) => `/api/agent/tasks/${encodeURIComponent(taskId)}/file?path=${encodeURIComponent(relative)}`;
  const t = tOf(ctx);
  const text = item.previewPath && item.preview !== "image" ? readText(ctx, taskId, item.previewPath) : undefined;
  return <li className="ar-output">
    <p className="ar-output-head"><a href={href(item.path)} target="_blank" rel="noreferrer"><b>{item.name}</b></a></p>
    {item.purpose && <p className="gen ar-output-purpose">{cleanText(item.purpose, namer)}</p>}
    {item.preview === "markdown" && text && (() => {
      // A glimpse of the file, not its whole opening: the file is a click away (「读全文」).
      const head = markdownHead(text, 6, 240);
      return <><div className="ar-preview gen long-form"><Markdown text={humanizeMarkdown(head.text, namer)} /></div>
        {head.more && <a className="ar-read" href={href(item.previewPath!)} target="_blank" rel="noreferrer">{t("读全文 →")}</a>}</>;
    })()}
    {item.preview === "table" && text && (() => {
      const head = csvHead(text, 5, 64);
      const table = humanTable(head.header, head.rows, namer);
      if (table.kind === "summary") return <p className="gen ar-output-purpose">{table.text}</p>;
      return <div className="ar-table-wrap">
        <table className="ar-table gen"><thead><tr>{table.header.map((cell, index) => <th key={index} scope="col">{cell}</th>)}</tr></thead>
          <tbody>{table.rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}>{cell}</td>)}</tr>)}</tbody></table>
        <small>{t(head.totalRows > table.rows.length ? "共 {{count}} 行，此处显示开头部分" : "共 {{count}} 行", { count: head.totalRows })}</small>
      </div>;
    })()}
    {item.preview === "image" && <img className="ar-image" src={href(item.path)} alt={item.name} loading="lazy" />}
  </li>;
}

/** A reusable workflow, in words and as a row of steps (whose each one is); no file names. */
function WorkflowCard({ ctx, taskId, workflow }: { ctx: AccessContext; taskId: string; workflow: NonNullable<ReturnType<typeof groupOutputs>["workflow"]> }) {
  let manifest: unknown;
  try { manifest = workflow.manifestPath ? JSON.parse(readText(ctx, taskId, workflow.manifestPath) ?? "null") : null; } catch { manifest = null; }
  const read = workflowSteps(manifest);
  const t = tOf(ctx);
  return <div className="ar-workflow">
    <p><b>{read.name || t("可复用工作流")}</b></p>
    {(read.summary || workflow.purpose) && <p className="gen">{read.summary || workflow.purpose}</p>}
    {read.steps.length > 0 && <ol className="ar-flow" aria-label={t("工作流步骤")}>{read.steps.map((step, index) =>
      <li key={index} data-by={step.by}><span className="gen">{step.title}</span><small>{t(step.by === "person" ? "本人" : "助手")}</small></li>)}</ol>}
    <small>{t("保留与启用在 设置 → 自动化与助手 → Skill 库。")}</small>
  </div>;
}

/**
 * What a finished assistant task made, in the person's terms: deliverables grouped by use with a preview, a reusable workflow as words and
 * steps, the self-checks as one line (only failures spelled out, each with a redo), what was not done and what was assumed with a way to
 * send it back, and — folded at the bottom — what the assistant did, without commands.
 */
function TaskBody({ ctx, task }: { ctx: AccessContext; task: AssistantView["tasks"][number] }) {
  const t = tOf(ctx);
  const detail = loadTaskAudit(ctx, task.taskId);
  if (!detail) return <p className="muted">{task.blockerCode ? t("未完成：{{reason}}", { reason: task.blockerMessage || t("运行中断") }) : t("未找到本次记录。")}</p>;
  const outputs = groupOutputs(detail.artifacts);
  const namer = new Namer(outputNames(ctx, task.taskId, detail), localeFor(ctx));
  const passed = detail.verification.filter((item) => item.result === "pass");
  // The check's name is the assistant's own words, set in its own span: quoted the way each language quotes.
  const quote = localeFor(ctx) === "en" ? [" “", "”"] : ["「", "」"];
  const failed = detail.verification.filter((item) => item.result !== "pass");
  return <div className="assistant-detail">
    <p className="gen"><Clamp text={cleanText(detail.summary, namer)} /></p>
    {detail.inputsModified.length > 0 && <p role="alert"><strong>{t("原文件被改动：")}</strong>{detail.inputsModified.join(punct(localeFor(ctx), "；"))}</p>}

    {(outputs.groups.length > 0 || outputs.workflow) && <div className="ar-outputs">
      {outputs.groups.map((entry) => <section key={entry.group} className="ar-group" aria-label={t(entry.group)}>
        <h4>{t(entry.group)} · {entry.items.length}</h4>
        <ul>{entry.items.map((item) => <OutputCard key={item.path} ctx={ctx} taskId={task.taskId} item={item} namer={namer} />)}</ul>
      </section>)}
      {outputs.workflow && <section className="ar-group" aria-label={t("可复用工作流")}><h4>{t("可复用工作流")}</h4>
        <WorkflowCard ctx={ctx} taskId={task.taskId} workflow={outputs.workflow} /></section>}
    </div>}

    {detail.verification.length > 0 && <div className="ar-checks">
      {passed.length > 0 && <p className="ar-check-line" title={passed.map((item) => item.check).join(punct(localeFor(ctx), "、"))}>
        <ChecksBar passed={passed.length} total={detail.verification.length} />{failed.length
          ? t("已自检 {{count}} 项，{{failed}} 项未通过", { count: passed.length, failed: failed.length })
          : t("已自检 {{count}} 项，全部通过", { count: passed.length })}</p>}
      {failed.map((item, index) => <p key={index} className="ar-check-failed">
        <Tag tone={item.result === "fail" ? "risk" : "neutral"}>{t(item.result === "fail" ? "未通过" : "未运行")}</Tag>
        <span>{t("检查")}{quote[0]}<span className="gen">{item.check}</span>{quote[1]}{t(item.result === "fail" ? "没有通过，这部分结果可能不可靠。" : "没有运行，这部分结果未经核对。")}</span>
        <RetryCheckButton taskId={task.taskId} check={item.check} />
      </p>)}
    </div>}

    {detail.needsHuman.length > 0 && <div className="ar-list"><h4>{t("需本人完成")}</h4><ul>{detail.needsHuman.map((item, index) => <li key={index}>
      <span className="gen">{item.what}</span>{item.why && <small className="gen">{item.why}</small>}</li>)}</ul></div>}
    <Leftovers taskId={task.taskId} title={t("本次没有做")} items={detail.notDone.map((item) => ({ what: item.what, why: item.why }))} />
    <Leftovers taskId={task.taskId} title={t("所依据的假设")} items={detail.assumptions.map((item) => ({ what: item, why: "" }))} />

    <RunRecord audit={detail.audit} t={t} locale={localeFor(ctx)} />
  </div>;
}

/** Things the assistant left out or assumed, each one returnable with a note. */
function Leftovers({ taskId, title, items }: { taskId: string; title: string; items: Array<{ what: string; why: string }> }) {
  if (!items.length) return null;
  return <div className="ar-list"><h4>{title}</h4><ul>{items.map((item, index) => <li key={index}>
    <span className="gen">{item.what}</span>{item.why && <small className="gen">{item.why}</small>}
    <SendBackItem taskId={taskId} what={item.what} />
  </li>)}</ul></div>;
}

function ChecksBar({ passed, total }: { passed: number; total: number }) {
  return <svg className="ar-checks-bar" viewBox={`0 0 ${total * 10} 8`} width={Math.min(120, total * 12)} height="8" aria-hidden="true">
    {Array.from({ length: total }, (_, index) => <rect key={index} x={index * 10} width="8" height="8" data-pass={index < passed || undefined} />)}
  </svg>;
}

/** For whoever wants it: what the assistant did, as steps and searches and refusals, never as command lines. */
function RunRecord({ audit, t, locale }: { audit: TaskAudit["audit"]; t: Translate; locale: Locale }) {
  const declined = audit.decisions.filter((item) => item.outcome === "declined");
  const steps = audit.commands.length;
  return <details className="fold advanced ar-record">
    <summary>{declined.length ? t("助手做了哪些操作（{{count}} 步） · 拦下 {{declined}} 次", { count: steps, declined: declined.length })
      : t("助手做了哪些操作（{{count}} 步）", { count: steps })}</summary>
    <ul>
      {audit.searches.length > 0 && <li>{t("上网查了 {{count}} 次：", { count: audit.searches.length })}<span className="gen">{audit.searches.slice(0, 6).join(punct(locale, "；"))}</span></li>}
      <li>{t("在任务目录里运行了 {{steps}} 步操作，改动 {{files}} 个文件。", { steps, files: audit.filesChanged.length })}</li>
      {declined.map((item, index) => <li key={index}>{t("拦下一次：{{reason}}", { reason: item.reason || t("超出允许范围") })}</li>)}
    </ul>
  </details>;
}

/** The assistant's part of 待确认: kinds of work it asks to start, questions it put mid-run, and results waiting for review. */
export function AssistantReview({ ctx, deferred = () => undefined }: { ctx: AccessContext; deferred?: (workOrderId: string) => string | undefined }) {
  const view = loadAssistant(ctx);
  const results = view.reviews;
  // Results for work that need not start within a week are folded (decided 2026-10-10), the soonest to come up first.
  const review = results.filter((task) => !deferred(task.workOrderId));
  const later = results.filter((task) => deferred(task.workOrderId)).sort((a, b) => deferred(a.workOrderId)!.localeCompare(deferred(b.workOrderId)!));
  if (!view.categoryRequests.length && !view.approvals.length && !view.questions.length && !results.length) return null;
  const t = tOf(ctx);
  const card = (task: AssistantView["tasks"][number]) => <article key={task.taskId} className="assistant-task" data-status={task.status}>
    <h3>{task.title}</h3>
    <p className="assistant-meta"><Tag>{t(AGENT_CATEGORIES[task.category])}</Tag><small>{t("用时 {{duration}}", { duration: minutes(t, task.durationMs) })}</small>
      {task.workOrderId && <a href={`/workbench/${encodeURIComponent(task.workOrderId)}`}>{t("对应任务")}</a>}
      {task.autoApproved && <Tag tone="info">{t("来自自动生效的任务")}</Tag>}
      {deferred(task.workOrderId) && <small>{t("{{day}} 起列入本周", { day: entryDay(localeFor(ctx), deferred(task.workOrderId)!) })}</small>}</p>
    <TaskBody ctx={ctx} task={task} />
    <ReviewButtons taskId={task.taskId} />
  </article>;
  return <section className="pending-block" id="assistant" aria-label={t("助手")}>
    <h2>{t("助手 · {{count}}", { count: view.categoryRequests.length + view.approvals.length + view.questions.length + review.length })}</h2>
    {view.questions.map((question) => <div key={question.id} className="assistant-ask">
      <p><strong>{t("运行中的提问")}</strong>{question.title && <> · {question.title}</>} <small className="muted">{t("10 分钟内未回答，助手按最稳妥的做法继续")}</small></p>
      <QuestionAnswer id={question.id} questions={question.questions} />
    </div>)}
    {view.categoryRequests.map((request) => <div key={request.category} className="assistant-ask">
      <p><strong>{t("请求开始「{{label}}」类工作", { label: t(request.label) })}</strong>{request.workOrderTitle && <> · {t("起因：{{title}}", { title: request.workOrderTitle })}</>}</p>
      <CategoryDecision category={request.category} label={t(request.label)} />
    </div>)}
    {view.approvals.map((approval) => <div key={approval.id} className="assistant-ask">
      <p><strong>{t("运行中请求许可：")}</strong>{approval.reason || approval.rule} <small className="muted">{t("10 分钟内未回复视为不同意")}</small></p>
      <ApprovalButtons id={approval.id} />
    </div>)}
    {review.map(card)}
    {later.length > 0 && <details className="fold advanced"><summary>{t("以后再定的助手成果 · {{count}}（对应任务一周后才需开始）", { count: later.length })}</summary>{later.map(card)}</details>}
  </section>;
}
