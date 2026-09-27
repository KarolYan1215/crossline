import { SubpageShell } from "../subpage-shell";
import { AvailabilityEditor } from "../plan/availability-editor";
import { LocalActivityToggle } from "./local-activity-toggle";
import {
  getStore, LOCAL_ACTIVITY_CONSENT, readAvailability, readGoalSettings, readSchedulePreferences
} from "../../lib/crossline";
import { requireSessionContext } from "../../lib/access-guard";

export const dynamic = "force-dynamic";

/**
 * A hub, not a third copy: the schedule editor is the same component Plan already renders (editing it
 * here changes the same settings row, read back wherever it is shown), and calendar sources / Tailscale
 * / device leases / the Codex account stay on Connectors rather than being duplicated here — this page
 * only reads their real state and links out, the same "read real state, don't just link blind" rule the
 * rest of this app already follows.
 */
export default async function SettingsPage() {
  const ctx = await requireSessionContext();
  const store = getStore();
  const milestones = store.listMilestones(ctx.workspaceId).filter((item) => item.status === "approved")
    .map((item) => ({ id: item.id, title: item.title }));
  const preferences = readSchedulePreferences(ctx);
  const effectivePreferences = { ...(preferences ?? { timeZone: "America/Chicago", mode: "buffered" as const, importance: {} }),
    importance: {
      ...preferences?.importance,
      ...Object.fromEntries(milestones.flatMap((milestone) => {
        const goal = readGoalSettings(ctx, milestone.id);
        return goal ? [[milestone.id, goal.importance]] : [];
      }))
    } };
  const consentRaw = store.getSetting(ctx.workspaceId, LOCAL_ACTIVITY_CONSENT);
  const consent = consentRaw === "granted" || consentRaw === "denied" ? consentRaw : "unasked";

  return <SubpageShell eyebrow="设置" title="设置"
    description="作息时间在这里改；日历来源、Tailscale、离线设备和 Codex 账号仍在 Connections 页，这里只显示真实状态并链接过去。">
    <section className="review-block">
      <h2>作息与可用时间</h2>
      <AvailabilityEditor windows={readAvailability(ctx)} preferences={effectivePreferences} milestones={milestones} />
    </section>

    <section className="review-block">
      <h2>本机活动采集</h2>
      <p className="review-note">只读取距上次输入的毫秒数和一个不透明的窗口句柄数字，不读取窗口标题、不记录按键、不上传内容。</p>
      <LocalActivityToggle consent={consent} />
    </section>

    <section className="review-block">
      <h2>连接与账号</h2>
      <p className="review-note">日历来源、Tailscale 身份、离线设备授权、Codex 账号与跨运行 memory 披露都在这里管理。</p>
      <a href="/connectors">前往 Connections →</a>
    </section>

    <section className="review-block">
      <h2>首次设置</h2>
      <p className="review-note">回答几个问题，AI 提出可能的里程碑草案，供你批准。</p>
      <a href="/onboarding">前往入职访谈 →</a>
    </section>
  </SubpageShell>;
}
