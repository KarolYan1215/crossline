import "./plan-stats.css";
import { PlanView } from "./plan-view";
import { ForecastDelta } from "./forecast-delta";
import { PlanExplainButton } from "./plan-explain-button";
import { AdvancedSettings, LongTermGoals, TimeEnergy } from "./plan-controls";
import { RankingTable } from "./ranking-table";
import { HorizonSelect } from "./horizon-select";
import { PlanPreviewProvider } from "./preview-context";
import { CapacityChart, EstimateChart, InvestmentChart, MilestoneTimeline } from "./plan-stats-charts";
import { SubpageShell } from "../subpage-shell";
import { getStore, loadCurrentPlan, loadPlanExplanation, planToday } from "../../lib/crossline";
import { loadPlanBoard } from "../../lib/plan-board";
import { requireSessionContext } from "../../lib/access-guard";
import { gateUntilReady } from "../../lib/start-gate";

export const dynamic = "force-dynamic";

/**
 * The plan page (decided 2026-10-10, laid out again 2026-10-15): no calendar — that is on Today — but the long view. On top, one
 * timeline per line with every approved milestone and its state; under it capacity against demand over the chosen horizon, planned
 * against timed hours per line, and estimate accuracy; then the week's hours and energy beside the timed rhythm, with the weekly energy
 * advice laid over them; then each line's long-term goal; the packing numbers, shares and the scheduler's ordering in one advanced fold.
 * Every change is previewed in the charts before it is applied.
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
      <MilestoneTimeline rows={board.charts.goals} today={board.today} weeks={board.horizon.weeks} spanDays={board.horizon.days} done={board.doneMilestones}
        labels={board.labels} lineOrder={board.lineOrder}
        aside={<ForecastDelta forecast={board.forecastSummary} storageKey={`h${board.horizon.days}`} />} />
      <div className="pl-stats">
        <CapacityChart weeks={board.charts.capacity} labels={board.labels} statedWeekly={board.capacity.statedWeekly}
          configuredWeekly={board.capacity.configuredWeekly} usingDefault={board.capacity.usingDefault} source={board.capacity.source} />
        <InvestmentChart data={board.investment} labels={board.labels} />
        <EstimateChart estimates={board.estimates} labels={board.labels} />
      </div>
      {board.inferredRegularBlocks > 0 && <small className="pl-chart-foot">第 2 周起按日历中的 {board.inferredRegularBlocks} 个重复日程预留时间。</small>}
      <TimeEnergy windows={board.week.windows} suggested={board.week.suggested} proposed={board.week.proposed} busy={board.week.busy}
        statedWeekly={board.capacity.statedWeekly} worked={board.rhythm.worked} advice={board.advice} />
      <LongTermGoals goals={board.goals} shares={board.shares.effective} />
      <AdvancedSettings params={board.params} presets={board.presets} shares={board.shares} labels={board.labels} lineOrder={board.lineOrder}>
        <RankingTable ranking={board.ranking} today={board.today} />
        <div className="pl-explain">
          {explanation && <>
            <p className="gen">{explanation.summary}</p>
            <p className="gen">{explanation.nextActionReason}</p>
            {explanation.alternatives.length > 0 && <ul>{explanation.alternatives.map((item) =>
              <li key={item.id}><b>{titles.get(item.id) ?? "已移除的任务"}</b> <span className="gen">{item.reason}</span></li>)}</ul>}
          </>}
          <PlanExplainButton hasExplanation={Boolean(explanation)} />
        </div>
      </AdvancedSettings>
    </PlanPreviewProvider>
  </SubpageShell>;
}
