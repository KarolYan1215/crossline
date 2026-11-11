import { AppShell } from "../app-shell";
import { RitualHead } from "../ritual-head";
import { LineTag } from "../ui/tag";
import { requireSessionContext } from "../../lib/access-guard";
import { gateUntilReady } from "../../lib/start-gate";
import { loadAgentOutputs } from "../../lib/agent-outputs";
import { OUTPUT_SOURCES, SOURCE_LABEL, filterOutputs, outputsHref, parseOutputFilter, type OutputFilter } from "../../lib/agent-outputs-model";
import { localeFor, tOf } from "../../lib/locale";
import { monthDay } from "../../lib/i18n";
import "../rituals.css";
import "./outputs.css";

export const dynamic = "force-dynamic";

const size = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;

/**
 * 「Agent 产出」 (2026-11-10, the owner; it replaced 「报告」 and settings' 「助手产出」): the workflows' reports, the assistant's results
 * and the files they handed over, narrowed by source and by line through the address (`?source=&line=`), so every view is a link and needs
 * no script. Results waiting for a look are still decided on 待确认; here they are found again.
 */
export default async function OutputsPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const ctx = await requireSessionContext();
  gateUntilReady(ctx);
  const t = tOf(ctx), locale = localeFor(ctx);
  const filter: OutputFilter = parseOutputFilter(await searchParams);
  const view = loadAgentOutputs(ctx);
  const shown = filterOutputs(view, filter);
  const lineLabel = new Map(view.lines.map((line) => [line.id, line.label]));
  const chip = (label: string, href: string, current: boolean, count?: number) => <a key={href} href={href} className="ao-chip"
    aria-current={current ? "true" : undefined}>{label}{count !== undefined && <small>{count}</small>}</a>;
  const total = shown.counts.workflow + shown.counts.task + shown.counts.file;
  const nothing = !shown.reports.length && !shown.runs.length && !shown.files.length;
  const fileCount = shown.files.reduce((sum, line) => sum + line.tasks.reduce((inner, task) => inner + task.files.length, 0), 0);
  const fileBytes = shown.files.reduce((sum, line) => sum + line.tasks.reduce((inner, task) => inner + task.files.reduce((all, file) => all + file.bytes, 0), 0), 0);

  return <AppShell active={"Agent 产出"} className="subpage rd-page"><div className="rd-inner">
    <RitualHead title={t("Agent 产出")} sub={t("工作流的报告、交给 Agent 的任务结果和它们交出的文件；等待确认的结果仍在「待确认」处理。")} />

    <div className="ao-filters">
      <div className="ao-chips" role="group" aria-label={t("来源")}>
        {chip(t("全部"), outputsHref(filter, { source: undefined }), !filter.source, total)}
        {OUTPUT_SOURCES.map((source) => chip(t(SOURCE_LABEL[source]), outputsHref(filter, { source }), filter.source === source, shown.counts[source]))}
      </div>
      {shown.lines.length > 1 || filter.line ? <div className="ao-chips" role="group" aria-label={t("主线")}>
        {chip(t("全部主线"), outputsHref(filter, { line: undefined }), !filter.line)}
        {shown.lines.map((line) => chip(line.label, outputsHref(filter, { line: line.id }), filter.line === line.id))}
      </div> : null}
    </div>

    {shown.reports.length > 0 && <section aria-labelledby="ao-reports" className="ao-section">
      <h2 id="ao-reports" className="ao-part ds-serif">{t("工作流报告")}</h2>
      {shown.reports.map((report) => <article key={report.id} className="rd-card">
        <header className="rd-card-head"><h2><a href={`/reports/${encodeURIComponent(report.id)}`}>{report.title}</a></h2>
          <LineTag line={report.lineId}>{lineLabel.get(report.lineId) ?? report.lineId}</LineTag>
          <small>{monthDay(locale, report.at.slice(0, 10))}</small></header>
        <p className="rd-note">{report.notes !== undefined ? t("{{files}} 份文档 · 涵盖 {{notes}} 条笔记", { files: report.files, notes: report.notes }) : t("{{files}} 份文档", { files: report.files })}</p>
      </article>)}
    </section>}

    {shown.runs.length > 0 && <section aria-labelledby="ao-runs" className="ao-section rd-card">
      <h2 id="ao-runs" className="ao-part ds-serif">{t("Agent 任务")}</h2>
      <ul className="ao-runs">{shown.runs.map((run) => <li key={run.taskId}>
        <small>{monthDay(locale, run.at.slice(0, 10))}</small>
        {run.href ? <a href={run.href}>{run.title}</a> : <span>{run.title}</span>}
        <LineTag line={run.lineId}>{lineLabel.get(run.lineId) ?? run.lineId}</LineTag>
        <small>{[run.status === "needs_review" ? t("待确认") : "", run.partial ? t("未做完") : "",
          run.files ? t("{{count}} 个文件", { count: run.files }) : ""].filter(Boolean).join(" · ")}</small>
      </li>)}</ul>
    </section>}

    {shown.files.length > 0 && <section aria-labelledby="ao-files" className="ao-section rd-card" id="files">
      <header className="rd-card-head"><h2 id="ao-files" className="ao-part ds-serif">{t("文件")}</h2>
        <small>{t("{{count}} 个文件，共 {{size}}", { count: fileCount, size: size(fileBytes) })}</small>
        <a href={filter.line ? `/api/outputs/zip?line=${encodeURIComponent(filter.line)}` : "/api/outputs/zip"} download>{t("全部打包下载")}</a></header>
      <p className="rd-note">{t("助手每次做完交出的文件都放在这里，按主线和任务分开；不改动本人上传的原文件")}</p>
      {shown.files.map((line) => <details key={line.id} className="ao-line" open={shown.files.length === 1}>
        <summary>{line.label} · {t("{{count}} 个任务", { count: line.tasks.length })}
          <a className="ao-zip" href={`/api/outputs/zip?line=${encodeURIComponent(line.id)}`} download>{t("打包下载")}</a></summary>
        <ul className="ao-tasks">{line.tasks.map((task) => <li key={task.taskId}>
          <span className="ao-task">{monthDay(locale, task.at.slice(0, 10))} {task.title}{task.status === "needs_review" ? ` · ${t("待确认")}` : ""}{task.partial ? ` · ${t("未做完")}` : ""}
            <a className="ao-zip" href={`/api/outputs/zip?task=${encodeURIComponent(task.taskId)}`} download>{t("打包下载")}</a></span>
          <ul className="ao-files">{task.files.map((file) => <li key={file.path}><a href={file.href} download>{file.name}</a> <small>{size(file.bytes)}</small></li>)}</ul>
        </li>)}</ul>
      </details>)}
    </section>}

    {view.folder.elsewhere > 0 && (!filter.source || filter.source === "file") && <p className="rd-note">
      {t("另有 {{count}} 次较早的运行在本人电脑上完成，文件没有随账本搬到服务器，这里不列出。", { count: view.folder.elsewhere })}</p>}
    {nothing && <p className="rd-empty-line">{filter.source || filter.line ? t("这个筛选下没有产出。") : t("还没有产出。工作流整理好报告、交给 Agent 的任务做完后，结果和文件会出现在这里。")}</p>}
  </div></AppShell>;
}
