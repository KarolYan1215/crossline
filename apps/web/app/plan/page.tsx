import { PlanView } from "./plan-view";
import { AvailabilityEditor } from "./availability-editor";
import { SubpageShell } from "../subpage-shell";
import { loadCurrentPlan, planToday, readAvailability } from "../../lib/crossline";

export const dynamic = "force-dynamic";

export default function PlanPage() {
  const plan = loadCurrentPlan();
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
      ? `今天有 ${todayCount} 个来自日历的真实块${laterCount > 0 ? `，未来 7 天内还有 ${laterCount} 个（在 A 视图里看）` : ""}；`
      : `今天没有日历日程；未来 7 天内有 ${laterCount} 个真实块，在 A 视图里看；`;
  // No more 「示例数据」. The AI lane used to be seeded blocks because nothing knew when the person was
  // free; it now comes out of `planSchedule` against the availability edited below.
  const description = `B 看今天的现实与 AI 并行，C 批准差异，A 查看整周；三者共用同一计划版本。${importedNote}AI 那条道是排程器按下面的可用时间实时算出来的，不落库，所以不会和作业本身对不上。`;
  return <SubpageShell eyebrow="PLAN / B · C · A" title="共享时间轴" description={description}>
    <AvailabilityEditor windows={readAvailability()} />
    <PlanView plan={plan} today={today} />
  </SubpageShell>;
}
