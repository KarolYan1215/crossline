import { AppShell } from "../app-shell";
import { MilestoneActions } from "./milestone-actions";
import { MilestoneStats, MilestoneTimeline } from "./milestone-timeline";
import { appNow, ensureSeeded, getStore, milestonesRetiredBySystem, readLineShares } from "../../lib/crossline";
import { loadMilestoneBoard } from "../../lib/milestone-board";
import { requireSessionContext } from "../../lib/access-guard";
import { gateUntilReady } from "../../lib/start-gate";
import { identityLines } from "../../lib/lines";
import { domainRecordViews } from "../../lib/records";
import { LINE_PALETTE } from "@crossline/identity-packs";
import { LinesBar } from "./lines-bar";
import { lineHealth } from "./line-health";
import { lineCardDetails } from "../../lib/line-cards";
import { timed } from "../../lib/sections";
import { memoByLedgerAsync } from "../../lib/ledger-memo";
import { localeFor, tOf } from "../../lib/locale";
import { monthDay } from "../../lib/i18n";

export const dynamic = "force-dynamic";

/**
 * 主线 (laid out again 2026-10-28 after docs/plans/page-drafts-1028/milestones.html). Its one scenario: changing direction or looking at
 * the whole — where each line is headed and how far the next milestone is. The head carries the week's figures and the page's actions; the
 * lines side by side, each with its goal, an estimated health, its milestones and its usual presses as icons; the drafts waiting as one
 * banner; then one timeline every line shares, with 「当前焦点」 over it and, on a wide screen, the milestone's drawer beside it. Deciding a
 * risk is 待确认's and a candidate relation the weekly review's; the drawer shows them and links there.
 */
export default async function MilestonesPage() {
  const ctx = await requireSessionContext();
  gateUntilReady(ctx);
  ensureSeeded(ctx);
  const t = tOf(ctx);
  const locale = localeFor(ctx);
  // Reused until the ledger changes or a minute passes (`lib/ledger-memo.ts`).
  const board = await timed("milestones.board", () => memoByLedgerAsync(getStore(), `milestoneBoard:${ctx.workspaceId}:${appNow().toISOString().slice(0, 16)}`,
    60_000, () => loadMilestoneBoard(ctx)));
  // Drafts the architect replaced on its own are not shown; what the person archived themselves can be put back.
  const retired = milestonesRetiredBySystem(ctx);
  const archived = getStore().listMilestones(ctx.workspaceId).filter((milestone) => milestone.status === "archived" && !retired.has(milestone.id))
    .map((milestone) => ({ id: milestone.id, identityId: milestone.identityId, projectId: milestone.projectId ?? "", title: milestone.title,
      successCriteria: milestone.successCriteria ?? [], ...(milestone.templateId ? { templateId: milestone.templateId } : {}) }));
  const identities = identityLines(ctx);
  const details = lineCardDetails(ctx);
  const shares = readLineShares(ctx) ?? {};
  const records = Object.fromEntries(domainRecordViews(ctx).filter((view) => view.lineId).map((view) => [view.lineId!, { domain: view.domain, ...view.metrics, trends: view.trends,
    recent: view.recent.map(({ id, kind, at, value, unit, currency, category, source }) => ({ id, kind, at, value, unit, currency, category, source })) }]));
  const nearest = board.milestones.filter((milestone) => milestone.daysLeft !== undefined && milestone.daysLeft >= 0 && !milestone.retrospective)
    .sort((a, b) => a.daysLeft! - b.daysLeft!)[0];

  return <AppShell active={"主线"} className="page subpage ms-page">
    <div className="subpage-inner">
      <header className="ms-head">
        <div>
          <h1 className="ds-serif">{t("主线")}</h1>
          <p>{[t("{{count}} 条主线", { count: identities.length }), t("{{count}} 个里程碑", { count: board.milestones.length }),
            nearest ? t("最近截止 {{day}}「{{title}}」", { day: monthDay(locale, nearest.deadline!), title: nearest.title }) : ""].filter(Boolean).join(" · ")}</p>
        </div>
        <MilestoneStats board={board} />
        <MilestoneActions lines={identities.map((pack) => ({ id: pack.id, label: pack.label }))} archived={archived} />
      </header>
      <LinesBar lines={identities.map((pack) => ({ id: pack.id, label: pack.label, color: pack.color ?? pack.id, goals: pack.goals ?? [],
        hard: Boolean(pack.hard), rank: pack.rank ?? null, domain: pack.domain ?? null, records: records[pack.id] ?? null,
        attributes: (details[pack.id]?.attributes ?? []).map(({ text, kind }) => ({ text, kind })), goalParts: details[pack.id]?.goalParts ?? [],
        description: details[pack.id]?.description ?? "", pendingEdit: details[pack.id]?.pendingEdit ? { parts: details[pack.id]!.pendingEdit!.parts } : null,
        redraftDue: details[pack.id]?.redraftDue ?? false,
        interview: details[pack.id]?.interview ?? { reply: "", questions: [], waiting: false, turns: 0 },
        milestones: board.milestones.filter((milestone) => milestone.identityId === pack.id).length,
        drafts: board.milestones.filter((milestone) => milestone.identityId === pack.id && milestone.status === "draft").length,
        health: lineHealth(board.milestones, pack.id), ...(shares[pack.id] ? { share: shares[pack.id]! } : {}) }))}
        palette={Object.fromEntries(Object.entries(LINE_PALETTE).map(([key, value]) => [key, value.light]))} />
      <MilestoneTimeline board={board} />
      <p className="muted ms-foot"><a href="/review">{t("本周复盘 →")}</a></p>
    </div>
  </AppShell>;
}
