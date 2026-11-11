import { redirect } from "next/navigation";
import { assistantAvailable, categoryMode, isAutoHandoff, nodeShellHost, readCategories } from "@crossline/db";
import { AppShell } from "../app-shell";
import { requireSessionContext } from "../../lib/access-guard";
import { getStore } from "../../lib/crossline";
import { loadAssistant } from "../../lib/agent";
import { agentTaskStatusLabel } from "../../lib/labels";
import { permissionModeEnabled } from "../../lib/permission-mode";
import { loadOpportunitySettings } from "../../lib/opportunities";
import { identityLines } from "../../lib/lines";
import { isHostedBeta } from "../../lib/hosting";
import { localeFor } from "../../lib/locale";
import { tFor } from "../../lib/i18n";
import { loadWorkflowList } from "../../lib/workflows";
import { AutomationModule, type RecentTask } from "../settings/automation";
import { OpportunityCard } from "../settings/opportunity-card";
import { SkillLibraryLoader } from "../settings/skill-library";
import { WorkflowList } from "./workflow-list";
import "./automation.css";

export const dynamic = "force-dynamic";
const TONE: Record<string, RecentTask["tone"]> = { running: "info", needs_review: "warn", accepted: "ok", rejected: "neutral", blocked: "risk", stale: "neutral" };

/**
 * 自动化 (2026-11-10, the owner's decision): everything about the assistant's workflows on one page, moved out of 设置 — the workflows
 * (automations and grown ones, one list), the line skills and the rest of the library, the opportunity agent, and what the assistant may
 * do by itself. Each workflow opens on its own page with its conversation and versions.
 */
export default async function AutomationPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireSessionContext();
  // 「去登录」 / 「查看风险」 written before the move named the workflow as a query.
  const asked = await searchParams;
  const moved = [asked.login, asked.flow].find((value): value is string => typeof value === "string" && value.length > 0);
  if (moved) redirect(`/automation/${encodeURIComponent(moved)}${asked.login ? "?login=1" : ""}`);
  const t = tFor(localeFor(ctx));
  const store = getStore();
  const machine = assistantAvailable(store, ctx.workspaceId);
  const shellNode = machine ? undefined : nodeShellHost(store, ctx.workspaceId);
  const assistant = loadAssistant(ctx);
  const states = readCategories(store, ctx.workspaceId);
  const opportunity = loadOpportunitySettings(ctx);
  const lines = identityLines(ctx).map((line) => ({ id: line.id, label: line.label }));
  const { items, drafts } = loadWorkflowList(ctx);
  // `active` names the view in the frame's own table (i18n-ignore on the next line), not shown text.
  return <AppShell active="自动化" className="subpage settings-page automation-page"><div className="subpage-inner">
    <header className="wf-page-head"><h1 className="ds-serif">{t("自动化")}</h1>
      <p className="muted">{t("工作流、主线 skill、机会代理和助手能做的事")}</p></header>
    <div className="st-modules"><WorkflowList items={items} drafts={drafts} lines={lines} /></div>

    <section id="capabilities" className="st-section" aria-labelledby="au-capabilities"><h2 id="au-capabilities" className="ds-serif">{t("助手能做的事")}</h2>
      {shellNode && <p className="muted">{t("助手在本账号的节点电脑「{{host}}」上执行命令：每条命令先经过同一套检查，发送、报名和付款的最后一步留给本人。", { host: shellNode })}</p>}
      {!machine && !shellNode && <p className="muted">{isHostedBeta()
        ? t("网页版的助手通过 Crossline 自己的功能工作：读写和整理文件、查网页、读已接入的邮箱、把待办放进收件箱、按时或按条件跑自动化；不在电脑上执行命令。")
        : t("这个账号的助手通过 Crossline 自己的功能工作（读写整理文件、查网页、读邮箱、跑自动化）；能在电脑上执行命令的助手只为电脑主人工作。")}</p>}
      <AutomationModule toolsMode={!machine && !shellNode} paused={assistant.paused} permissionMode={permissionModeEnabled(ctx)} autoHandoff={isAutoHandoff(store, ctx.workspaceId)}
        categories={assistant.categories.map((item) => ({ category: item.category, label: item.label, explained: item.explained,
          mode: categoryMode(states[item.category]), cleanRuns: item.cleanRuns, runsToTrust: item.runsToTrust }))}
        recent={assistant.tasks.slice(0, 8).map((task) => ({ taskId: task.taskId, title: task.title, kind: assistant.categories.find((item) => item.category === task.category)?.label ?? "",
          status: t(agentTaskStatusLabel[task.status] ?? task.status), tone: TONE[task.status] ?? "neutral", day: task.requestedAt.slice(5, 10).replace("-", "/"),
          workOrderId: task.workOrderId }))} />
    </section>

    {opportunity && <section id="opportunity" className="st-section" aria-labelledby="au-opportunity"><h2 id="au-opportunity" className="ds-serif">{t("机会代理")}</h2>
      <div className="st-modules"><OpportunityCard view={opportunity} /></div>
    </section>}

    <section id="skills" className="st-section" aria-labelledby="au-skills"><h2 id="au-skills" className="ds-serif">{t("Skill 库")}</h2>
      <SkillLibraryLoader workflowsElsewhere />
    </section>
  </div></AppShell>;
}
