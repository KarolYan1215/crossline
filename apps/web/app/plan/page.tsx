import "./plan-stats.css";
import { Flag } from "lucide-react";
import { PlanActions, ScheduleStatus } from "./plan-view";
import { ForecastDelta } from "./forecast-delta";
import { PlanExplainButton } from "./plan-explain-button";
import { AdvancedCard, SharesCard, TimeEnergy } from "./plan-controls";
import { RankingTable } from "./ranking-table";
import { HorizonSelect } from "./horizon-select";
import { PlanPreviewProvider } from "./preview-context";
import { CapacityChart } from "./plan-stats-charts";
import { LineShareChart, PlanKpiRow, UnplacedCard } from "./plan-head";
import { AppShell } from "../app-shell";
import { appNow, getStore, loadCurrentPlan, loadPlanExplanation, planToday } from "../../lib/crossline";
import { loadPlanBoard } from "../../lib/plan-board";
import { milestoneSummary } from "../../lib/plan-stats";
import { requireSessionContext } from "../../lib/access-guard";
import { gateUntilReady } from "../../lib/start-gate";
import { timed, timedSync } from "../../lib/sections";
import { memoByLedgerAsync } from "../../lib/ledger-memo";
import { localeFor } from "../../lib/locale";
import { tFor } from "../../lib/i18n";

export const dynamic = "force-dynamic";

/**
 * The plan page (decided 2026-10-10; laid out again 2026-10-28 after docs/plans/page-drafts-1028/plan.html). Its one scenario: once a
 * week, or after the person's hours changed — are the coming weeks' hours enough, does each line get its share, and why does anything
 * not fit. Four figures on top; one line about milestones (their timeline, with the state colours this page used to draw, is on 主线);
 * capacity against demand, each line against its share, and what could not be placed with why; the week's hours and energy; the shares
 * and the packing numbers in the open, with the scheduler's ordering a click away. Every change is previewed before it is applied.
 */
export default async function PlanPage(props: { searchParams?: Promise<{ horizon?: string }> }) {
  const ctx = await requireSessionContext();
  gateUntilReady(ctx);
  const locale = localeFor(ctx);
  const t = tFor(locale);
  const requested = (await props.searchParams)?.horizon;
  const plan = await timed("plan.current", () => loadCurrentPlan(ctx));
  // Reused until the ledger changes or a minute passes, like the plan it is drawn from (`lib/ledger-memo.ts`).
  const board = await timed("plan.board", () => memoByLedgerAsync(getStore(), `planBoard:${ctx.workspaceId}:${requested ?? ""}:${appNow().toISOString().slice(0, 16)}`,
    60_000, () => loadPlanBoard(ctx, plan, requested)));
  const explanation = timedSync("plan.explanation", () => loadPlanExplanation(ctx, planToday(ctx)));
  const titles = new Map(getStore().listWorkOrders(ctx.workspaceId).map((order) => [order.id, order.intent]));
  const imported = plan.blocks.filter((block) => block.id.startsWith("graph_calendar:") || block.id.startsWith("import:")).length;
  const milestones = milestoneSummary(board.charts.goals, board.today, board.horizon.days, new Set(board.doneMilestones));
  const firstRisk = milestones.risk[0];
  return <AppShell active={"计划"} className="page subpage plan-page">
    <div className="subpage-inner" data-plan-version={plan.id}>
      <PlanPreviewProvider horizonDays={board.horizon.days}>
        <header className="pl-head">
          <div>
            <h1 className="ds-serif">{t("计划")}</h1>
            <p>{t("未来 {{count}} 周时间够不够、给了谁、哪项为什么排不下；当天日程在「今日」", { count: board.horizon.weeks })}
              {imported ? ` · ${t("含日历与文件中的 {{count}} 个固定日程", { count: imported })}` : ""}</p>
          </div>
          <PlanActions calendarWrite={Boolean(getStore().getSetting(ctx.workspaceId, "calendar.write.account"))}>
            <HorizonSelect horizon={board.horizon} />
          </PlanActions>
        </header>
        <PlanKpiRow kpis={board.kpis} configuredWeekly={board.capacity.configuredWeekly} estimates={board.estimates} labels={board.labels} />
        <ScheduleStatus plan={plan} />
        <div className="pl-milestones" role="note">
          <Flag size={18} strokeWidth={1.6} aria-hidden />
          <span>{milestones.shown
            ? [t("范围内 {{count}} 个里程碑", { count: milestones.shown }),
              milestones.risk.length ? (milestones.risk.length === 1 && firstRisk ? t("1 个有完不成风险（{{title}}）", { title: firstRisk.title })
                : t("{{count}} 个有完不成风险", { count: milestones.risk.length })) : t("均按计划"),
              milestones.unprepared ? t("{{count}} 个待准备", { count: milestones.unprepared }) : "",
              milestones.library ? t("{{count}} 个任务在任务库", { count: milestones.library }) : ""].filter(Boolean).join(" · ")
            : milestones.outside ? t("统计范围内没有未完成的里程碑。") : t("尚无已批准的里程碑。")}</span>
          <a href="/milestones">{t("里程碑时间轴在「主线」→")}</a>
          <ForecastDelta forecast={board.forecastSummary} storageKey={`h${board.horizon.days}`} />
        </div>
        <div className="pl-stats">
          <CapacityChart weeks={board.charts.capacity} labels={board.labels} statedWeekly={board.capacity.statedWeekly}
            configuredWeekly={board.capacity.configuredWeekly} usingDefault={board.capacity.usingDefault} source={board.capacity.source} basis={board.capacity.basis} />
          <LineShareChart capacity={board.charts.capacity} shares={board.shares.effective} lineOrder={board.lineOrder} labels={board.labels} />
          <UnplacedCard items={board.unplaced} labels={board.labels} today={board.today} />
        </div>
        {board.inferredRegularBlocks > 0 && <small className="pl-chart-foot">{t("第 2 周起按日历中的 {{count}} 个重复日程预留时间。", { count: board.inferredRegularBlocks })}</small>}
        <TimeEnergy windows={board.week.windows} suggested={board.week.suggested} proposed={board.week.proposed} busy={board.week.busy}
          statedWeekly={board.capacity.statedWeekly} worked={board.rhythm.worked} advice={board.advice} />
        <div className="pl-settings">
          <SharesCard shares={board.shares} labels={board.labels} lineOrder={board.lineOrder} goals={board.goals} />
          <AdvancedCard params={board.params} presets={board.presets} explain={<div className="pl-explain">
            {explanation && <>
              <p className="gen">{explanation.summary}</p>
              <p className="gen">{explanation.nextActionReason}</p>
              {explanation.alternatives.length > 0 && <ul>{explanation.alternatives.map((item) =>
                <li key={item.id}><b>{titles.get(item.id) ?? t("已移除的任务")}</b> <span className="gen">{item.reason}</span></li>)}</ul>}
            </>}
            <PlanExplainButton hasExplanation={Boolean(explanation)} />
          </div>}>
            <RankingTable ranking={board.ranking} today={board.today} locale={locale} />
          </AdvancedCard>
        </div>
      </PlanPreviewProvider>
    </div>
  </AppShell>;
}
