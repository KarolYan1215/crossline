import { notFound } from "next/navigation";
import { AppShell } from "../../app-shell";
import { requireSessionContext } from "../../../lib/access-guard";
import { loadWorkflowDetail } from "../../../lib/workflows";
import { localeFor } from "../../../lib/locale";
import { tFor } from "../../../lib/i18n";
import { GrownWorkflowCard } from "../../settings/skill-library";
import { WorkflowView } from "./workflow-view";
import "../automation.css";

export const dynamic = "force-dynamic";

/**
 * One workflow, or a conversation still making one (by its thread id): the conversation and the versions; a grown workflow also has its
 * controls (consent, logins, runs) under them, opened with its login started when the page was reached from 「去登录」 (`?login=1`).
 */
export default async function WorkflowPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireSessionContext();
  const { id } = await params;
  const detail = loadWorkflowDetail(ctx, decodeURIComponent(id));
  if (!detail) notFound();
  const t = tFor(localeFor(ctx));
  const asked = await searchParams;
  // `active` names the view in the frame's own table (i18n-ignore on the next line), not shown text.
  return <AppShell active="自动化" className="subpage settings-page automation-page"><div className="subpage-inner">
    <nav className="wf-back"><a href="/automation">{t("← 自动化")}</a></nav>
    <WorkflowView initial={detail} />
    {detail.kind === "grown" && detail.exists && <section className="st-section" aria-labelledby="wf-manage"><h2 id="wf-manage" className="ds-serif">{t("运行与授权")}</h2>
      <GrownWorkflowCard id={detail.id} autoLogin={asked.login === "1"} /></section>}
  </div></AppShell>;
}
