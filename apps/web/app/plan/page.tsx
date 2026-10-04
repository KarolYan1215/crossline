import { PlanView } from "./plan-view";
import { AvailabilityEditor } from "./availability-editor";
import { ScheduleSetup } from "./schedule-setup";
import { ForecastDelta } from "./forecast-delta";
import { PlanExplainButton } from "./plan-explain-button";
import { SubpageShell } from "../subpage-shell";
import { getStore, loadCurrentPlan, loadGoalForecast, loadPlanExplanation, planToday, readAvailability, readGoalSettings, readSchedulePreferences
} from "../../lib/crossline";
import { loadTimeline, suggestedAvailabilityFor } from "../../lib/timeline";
import { requireSessionContext } from "../../lib/access-guard";

export const dynamic = "force-dynamic";

export default async function PlanPage() {
  const ctx = await requireSessionContext();
  const plan = await loadCurrentPlan(ctx);
  const calendar = await loadTimeline(ctx, plan);
  const forecast = loadGoalForecast(ctx);
  const store = getStore();
  const milestones = store.listMilestones(ctx.workspaceId).filter((item) => item.status === "approved")
    .map((item) => ({ id: item.id, title: item.title }));
  // Real saved preferences if there are any, otherwise the same sane defaults `loadCurrentPlan` already
  // previewed against — the editor's initial values must agree with what produced the preview on screen.
  const preferences = readSchedulePreferences(ctx);
  const effectivePreferences = { ...(preferences ?? { timeZone: "America/Chicago", mode: "buffered" as const, importance: {} }),
    importance: {
      ...preferences?.importance,
      ...Object.fromEntries(milestones.flatMap((milestone) => {
        const goal = readGoalSettings(ctx, milestone.id);
        return goal ? [[milestone.id, goal.importance]] : [];
      }))
    } };
  const explanation = loadPlanExplanation(ctx, planToday(ctx));
  const imported = plan.blocks.filter((block) => block.id.startsWith("graph_calendar:") || block.id.startsWith("import:")).length;
  return <SubpageShell active="计划" title="计划"
    description={imported ? `日历与文件里的 ${imported} 个真实块，加上排程器按你的可用时间排出的任务。` : "还没有日历或文件里的真实日程；排程器按你的可用时间排任务。"}>
    {plan.usingDefaultPreferences && <details className="schedule-setup-prompt">
      <summary>以下是按默认时区/时段生成的预览，还不是你的真实设置 —— 填一下可以更准 →</summary>
      <ScheduleSetup windows={readAvailability(ctx)} milestones={milestones} />
    </details>}
    <PlanView plan={plan} calendar={calendar} />
    <details className="fold"><summary>可用时间与排程偏好</summary>
      <AvailabilityEditor windows={readAvailability(ctx)} preferences={effectivePreferences} milestones={milestones} suggested={suggestedAvailabilityFor(ctx)} />
    </details>
    <details className="fold"><summary>为什么这样排{explanation ? "" : "（还没有解释）"}</summary>
      <section className="plan-explanation" aria-label="AI 排序解释">
        <PlanExplainButton />
        {explanation ? <>
          <p>{explanation.summary}</p>
          <p><strong>为什么是这一条：</strong>{explanation.nextActionReason}</p>
          {explanation.alternatives.length > 0 && <ul>{explanation.alternatives.map((item) => {
            const order = store.listWorkOrders(ctx.workspaceId).find((w) => w.id === item.id);
            return <li key={item.id}>{order?.intent ?? item.id}：{item.reason}</li>;
          })}</ul>}
        </> : <p className="plan-sync-note">点上面的按钮生成一次。</p>}
      </section>
    </details>
    <details className="fold"><summary>未来 8 周 · 容量与目标情景</summary>
      <section className="goal-forecast" aria-label="未来八周目标情景">
        <ForecastDelta forecast={forecast} />
        <p>近 7 天按净可用时间留 15% 缓冲，第 2–8 周预留 20%。日期是按目前作业估时和容量推算的情景，不是完成承诺。真实日历优先；按重复日历事件推测的固定占用 {forecast.inferredRegularBlocks} 块，仅作为软预留。</p>
        <ol>{forecast.weeks.map((week) => <li key={week.week}>第 {week.week} 周：净 {week.netMinutes} 分钟，预留 {week.reservedMinutes} 分钟，可用于预测 {week.usableMinutes} 分钟</li>)}</ol>
        <h3>跨主线目标</h3>
        <ul>{forecast.goals.map((goal) => <li key={goal.milestoneId}>
          <strong>{goal.title}</strong> · p50 最早可行 {goal.p50Day ?? "无法推算"} · p85 稳妥情景 {goal.p85Day ?? "无法推算"}
          {goal.confirmedDeadline ? ` · 已确认硬截止 ${goal.confirmedDeadline}` : goal.suggestedTargetDay ? ` · 建议软目标日 ${goal.suggestedTargetDay}` : ""}
          {goal.bottleneck && <span> · 瓶颈：{goal.bottleneck}</span>}
        </li>)}</ul>
      </section>
    </details>
  </SubpageShell>;
}
