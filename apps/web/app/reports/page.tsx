import { AppShell } from "../app-shell";
import { RitualHead } from "../ritual-head";
import { requireSessionContext } from "../../lib/access-guard";
import { gateUntilReady } from "../../lib/start-gate";
import { listReports } from "../../lib/reports";
import { localeFor, tOf } from "../../lib/locale";
import { monthDay } from "../../lib/i18n";
import "../rituals.css";

export const dynamic = "force-dynamic";

/** Every workflow's latest report (docs/skills-library.md 「报告」), newest first. */
export default async function ReportsPage() {
  const ctx = await requireSessionContext();
  gateUntilReady(ctx);
  const t = tOf(ctx), locale = localeFor(ctx);
  const reports = listReports(ctx);
  return <AppShell active={"报告"} className="subpage rd-page"><div className="rd-inner">
    <RitualHead title={t("报告")} sub={t("工作流整理出的结果，每个工作流一份最新的报告；报告里的可落地项可以加入任务。")} />
    {reports.length ? reports.map((report) => <section key={report.id} className="rd-card">
      <header className="rd-card-head"><h2><a href={`/reports/${encodeURIComponent(report.id)}`}>{report.title}</a></h2>
        <small>{monthDay(locale, report.at.slice(0, 10))}</small></header>
      <p className="rd-note">{report.notes !== undefined ? t("{{files}} 份文档 · 涵盖 {{notes}} 条笔记", { files: report.files, notes: report.notes }) : t("{{files}} 份文档", { files: report.files })}</p>
    </section>) : <p className="rd-empty-line">{t("还没有报告。工作流整理好结果后会出现在这里。")}</p>}
  </div></AppShell>;
}
