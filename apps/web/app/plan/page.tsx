import { PlanView } from "./plan-view";
import { AvailabilityEditor } from "./availability-editor";
import { ScheduleSetup } from "./schedule-setup";
import { ForecastDelta } from "./forecast-delta";
import { SubpageShell } from "../subpage-shell";
import { getStore, loadCurrentPlan, loadGoalForecast, planToday, readAvailability, readGoalSettings, readSchedulePreferences,
  WORKSPACE_ID } from "../../lib/crossline";

export const dynamic = "force-dynamic";

export default async function PlanPage() {
  const plan = await loadCurrentPlan();
  const preferences = readSchedulePreferences();
  const forecast = preferences ? loadGoalForecast() : null;
  const milestones = getStore().listMilestones(WORKSPACE_ID).filter((item) => item.status === "approved")
    .map((item) => ({ id: item.id, title: item.title }));
  const effectivePreferences = preferences && { ...preferences, importance: {
    ...preferences.importance,
    ...Object.fromEntries(milestones.flatMap((milestone) => {
      const goal = readGoalSettings(milestone.id);
      return goal ? [[milestone.id, goal.importance]] : [];
    }))
  } };
  const today = planToday();
  const importedBlocks = plan.blocks.filter((block) => block.id.startsWith("graph_calendar:"));
  // Split by day on purpose. The header said 「已从日历导入 3 个真实块」 while the B lens — which only
  // ever shows today — displayed none of them, because all three sat later in the week. A true count
  // that contradicts what is on screen reads as a broken import.
  const todayCount = importedBlocks.filter((block) => block.day === today).length;
  const laterCount = importedBlocks.length - todayCount;
  const importedNote = importedBlocks.length === 0 ? "尚未导入任何真实日程；"
    : todayCount > 0
      // "本周" would be wrong: the sync window is a rolling seven days from today, which runs past the
      // end of the Sunday–Saturday week the A lens draws.
      ? `今天有 ${todayCount} 个来自日历的真实块${laterCount > 0 ? `，未来 8 周内还有 ${laterCount} 个（在 A 视图里看）` : ""}；`
      : `今天没有日历日程；未来 8 周内有 ${laterCount} 个真实块，在 A 视图里看；`;
  // No more 「示例数据」. The AI lane used to be seeded blocks because nothing knew when the person was
  // free; it now comes out of `planSchedule` against the availability edited below.
  const description = `B 看今天的现实与 AI 并行，C 批准差异，A 查看整周；三者共用同一计划版本。${importedNote}AI 那条道是排程器按下面的可用时间实时算出来的，不落库，所以不会和作业本身对不上。`;
  return <SubpageShell eyebrow="PLAN / B · C · A" title="共享时间轴" description={description}>
    {!preferences ? <ScheduleSetup windows={readAvailability()} milestones={milestones} /> : <>
    <AvailabilityEditor windows={readAvailability()} preferences={effectivePreferences!} milestones={milestones} />
    <PlanView plan={plan} today={today} />
    {forecast && <section className="goal-forecast" aria-label="未来八周目标情景">
      <h2>未来 8 周 · 容量与目标情景</h2>
      <ForecastDelta forecast={forecast} />
      <p>近 7 天按净可用时间留 15% 缓冲，第 2–8 周预留 20%。日期是按目前作业估时和容量推算的情景，不是完成承诺。</p>
      <p>真实日历优先；按重复日历事件推测的固定占用 {forecast.inferredRegularBlocks} 块，仅作为软预留，真实事件到来时覆盖。</p>
      <ol>{forecast.weeks.map((week) => <li key={week.week}>第 {week.week} 周：净 {week.netMinutes} 分钟，预留 {week.reservedMinutes} 分钟，可用于预测 {week.usableMinutes} 分钟</li>)}</ol>
      <h3>跨主线目标</h3>
      <ul>{forecast.goals.map((goal) => <li key={goal.milestoneId}>
        <strong>{goal.title}</strong> · p50 最早可行 {goal.p50Day ?? "无法推算"} · p85 稳妥情景 {goal.p85Day ?? "无法推算"}
        {goal.confirmedDeadline ? ` · 已确认硬截止 ${goal.confirmedDeadline}` : goal.suggestedTargetDay ? ` · 建议软目标日 ${goal.suggestedTargetDay}` : ""}
        {goal.bottleneck && <span> · 瓶颈：{goal.bottleneck}</span>}
      </li>)}</ul>
    </section>}
    </>}
  </SubpageShell>;
}
