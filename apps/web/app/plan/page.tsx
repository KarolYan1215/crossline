import { PlanView } from "./plan-view";
import { ForecastDelta } from "./forecast-delta";
import { PlanExplainButton } from "./plan-explain-button";
import { CapacityPanel, ForecastChart, RankingPanel } from "./plan-charts";
import { TimeControls } from "./plan-controls";
import { SubpageShell } from "../subpage-shell";
import { getStore, loadCurrentPlan, loadGoalForecast, loadPlanExplanation, planToday } from "../../lib/crossline";
import { loadTimeline } from "../../lib/timeline";
import { loadPlanBoard } from "../../lib/plan-board";
import { requireSessionContext } from "../../lib/access-guard";

export const dynamic = "force-dynamic";

export default async function PlanPage() {
  const ctx = await requireSessionContext();
  const plan = await loadCurrentPlan(ctx);
  const calendar = await loadTimeline(ctx, plan);
  const board = await loadPlanBoard(ctx, plan);
  const explanation = loadPlanExplanation(ctx, planToday(ctx));
  const titles = new Map(getStore().listWorkOrders(ctx.workspaceId).map((order) => [order.id, order.intent]));
  const imported = plan.blocks.filter((block) => block.id.startsWith("graph_calendar:") || block.id.startsWith("import:")).length;
  return <SubpageShell active="计划" title="计划"
    description={imported ? `日历与文件中的 ${imported} 个固定日程，加上按可用时段排入的任务。` : "尚无日历或文件中的固定日程；任务按可用时段排入。"}>
    <PlanView plan={plan} calendar={calendar} />
    <div className="pl-row">
      <CapacityPanel board={board} />
      <ForecastChart board={board} />
    </div>
    <ForecastDelta forecast={loadGoalForecast(ctx)} />
    <RankingPanel board={board} explanation={<div className="pl-explain">
      {explanation && <>
        <p className="gen">{explanation.summary}</p>
        <p className="gen">{explanation.nextActionReason}</p>
        {explanation.alternatives.length > 0 && <ul>{explanation.alternatives.map((item) =>
          <li key={item.id}><b>{titles.get(item.id) ?? "已移除的任务"}</b> <span className="gen">{item.reason}</span></li>)}</ul>}
      </>}
      <PlanExplainButton hasExplanation={Boolean(explanation)} />
    </div>} />
    <TimeControls windows={board.week.windows} suggested={board.week.suggested} busy={board.week.busy} params={board.params} presets={board.presets}
      importance={board.importance} labels={board.labels} plannedHours={Math.round((board.capacity.plannedThisWeek / 60) * 10) / 10} />
  </SubpageShell>;
}
