import { notFound } from "next/navigation";
import { AppShell } from "../../app-shell";
import { RitualHead } from "../../ritual-head";
import { Markdown } from "../../ui/markdown";
import { requireSessionContext } from "../../../lib/access-guard";
import { gateUntilReady } from "../../../lib/start-gate";
import { loadReport } from "../../../lib/reports";
import { identityLines } from "../../../lib/lines";
import { localeFor, tOf } from "../../../lib/locale";
import { monthDay } from "../../../lib/i18n";
import { ReportItems } from "./report-items";
import "../../rituals.css";

export const dynamic = "force-dynamic";

/**
 * One report (docs/skills-library.md 「报告」): the overview first, then each topic's document, and above them what the report says to put
 * into practice, each added to the tasks with one click or set aside.
 */
export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireSessionContext();
  gateUntilReady(ctx);
  const { id } = await params;
  const report = /^[a-zA-Z0-9_-]{1,128}$/.test(id) ? loadReport(ctx, id) : undefined;
  if (!report) notFound();
  const t = tOf(ctx), locale = localeFor(ctx);
  const lines = Object.fromEntries(identityLines(ctx).map((line) => [line.id, line.label]));
  const day = (at: string) => monthDay(locale, at.slice(0, 10));
  const sub = [t("{{date}} 生成", { date: day(report.at) }), ...(report.notes !== undefined ? [t("涵盖 {{notes}} 条笔记", { notes: report.notes })] : [])].join(" · ");
  return <AppShell active={"报告"} className="subpage rd-page"><div className="rd-inner">
    <RitualHead title={report.title} sub={sub} actions={<a className="secondary-button" href="/reports">{t("全部报告")}</a>} />
    {report.documents.length > 1 && <nav className="rd-card" aria-label={t("报告目录")}>
      <div className="rd-preview"><ul>{report.documents.map((doc, index) => <li key={doc.path}><a href={`#doc-${index}`}>{doc.name}</a></li>)}</ul></div>
    </nav>}
    {report.items.length > 0 && <ReportItems reportId={report.id} items={report.items.filter((item) => item.state !== "dismissed")} lines={lines} />}
    {report.documents.map((doc, index) => <section key={doc.path} id={`doc-${index}`} className="rd-card">
      <header className="rd-card-head"><h2>{doc.name}</h2></header>
      <Markdown text={doc.text} className="gen" />
    </section>)}
    {report.versions.length > 0 && <section className="rd-card">
      <header className="rd-card-head"><h2>{t("较早的版本")}</h2></header>
      <div className="rd-preview"><ul>{report.versions.map((version) => <li key={version.id}><a href={`/reports/${encodeURIComponent(version.id)}`}>{day(version.at)}</a></li>)}</ul></div>
    </section>}
  </div></AppShell>;
}
