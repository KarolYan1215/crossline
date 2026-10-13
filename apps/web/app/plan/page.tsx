import "./plan-stats.css";
import { PlanView } from "./plan-view";
import { ForecastDelta } from "./forecast-delta";
import { PlanExplainButton } from "./plan-explain-button";
import { TimeControls } from "./plan-controls";
import { RankingTable } from "./ranking-table";
import { HorizonSelect } from "./horizon-select";
import { PlanPreviewProvider } from "./preview-context";
import { CapacityChart, EstimateRhythm, InvestmentChart, MilestoneForecast } from "./plan-stats-charts";
import { SubpageShell } from "../subpage-shell";
import { getStore, loadCurrentPlan, loadPlanExplanation, planToday } from "../../lib/crossline";
import { loadPlanBoard } from "../../lib/plan-board";
import { requireSessionContext } from "../../lib/access-guard";
import { gateUntilReady } from "../../lib/start-gate";

export const dynamic = "force-dynamic";

/**
 * The plan page (decided 2026-10-10, docs/flywheel-and-views.md §3): no calendar — that is on Today — but the long view over a chosen
 * horizon (four or eight weeks, or to the farthest deadline): capacity against demand, when each milestone finishes, planned against
 * timed hours per line, and how estimates and the weekly rhythm hold up; the schedule's settings at the foot, every change previewed in
 * the charts before it is applied.
 */
export default async function PlanPage(props: { searchParams?: Promise<{ horizon?: string }> }) {
  const ctx = await requireSessionContext();
  gateUntilReady(ctx);
  const requested = (await props.searchParams)?.horizon;
  const plan = await loadCurrentPlan(ctx);
  const board = await loadPlanBoard(ctx, plan, requested);
  const explanation = loadPlanExplanation(ctx, planToday(ctx));
  const titles = new Map(getStore().listWorkOrders(ctx.workspaceId).map((order) => [order.id, order.intent]));
  const imported = plan.blocks.filter((block) => block.id.startsWith("graph_calendar:") || block.id.startsWith("import:")).length;
  return <SubpageShell active="计划" title="计划"
    description={imported ? `日历与文件中的 ${imported} 个固定日程，加上按可用时段排入的任务；日程本身在今日页。` : "任务按可用时段排入；日程本身在今日页。"}>
    <PlanPreviewProvider horizonDays={board.horizon.days}>
      <PlanView plan={plan} aside={<HorizonSelect horizon={board.horizon} />} />
      <div className="pl-stats">
        <CapacityChart weeks={board.charts.capacity} labels={board.labels} statedWeekly={board.capacity.statedWeekly}
          configuredWeekly={board.capacity.configuredWeekly} usingDefault={board.capacity.usingDefault} source={board.capacity.source} />
        <MilestoneForecast rows={board.charts.goals} today={board.today} spanDays={board.horizon.days} weeks={board.horizon.weeks} labels={board.labels}
          inferredRegularBlocks={board.inferredRegularBlocks} />
        <ForecastDelta forecast={board.forecastSummary} storageKey={`h${board.horizon.days}`} />
        <InvestmentChart data={board.investment} labels={board.labels} />
        <EstimateRhythm estimates={board.estimates} rhythm={board.rhythm} labels={board.labels} />
      </div>
      <TimeControls windows={board.week.windows} suggested={board.week.suggested} proposed={board.week.proposed} busy={board.week.busy} params={board.params}
        presets={board.presets} statedWeekly={board.capacity.statedWeekly} shares={board.shares} labels={board.labels} lineOrder={board.lineOrder}
        ranking={<>
          <RankingTable ranking={board.ranking} today={board.today} importance={board.importance} />
          <div className="pl-explain">
            {explanation && <>
              <p className="gen">{explanation.summary}</p>
              <p className="gen">{explanation.nextActionReason}</p>
              {explanation.alternatives.length > 0 && <ul>{explanation.alternatives.map((item) =>
                <li key={item.id}><b>{titles.get(item.id) ?? "已移除的任务"}</b> <span className="gen">{item.reason}</span></li>)}</ul>}
            </>}
            <PlanExplainButton hasExplanation={Boolean(explanation)} />
          </div>
        </>} />
    </PlanPreviewProvider>
  </SubpageShell>;
}
