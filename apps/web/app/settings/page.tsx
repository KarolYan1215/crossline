import { SubpageShell } from "../subpage-shell";
import { AvailabilityEditor } from "../plan/availability-editor";
import { LocalActivityToggle } from "./local-activity-toggle";
import { UsageCard } from "./usage-card";
import { NotifyLevel } from "./notify-level";
import { EffectivenessCard } from "./effectiveness-card";
import { loadEffectiveness } from "../../lib/effectiveness";
import { defaultIdentityPacks } from "@crossline/identity-packs";
import { ConnectionsSection } from "../connectors/connections";
import {
  ACTIVITY_BLACKLIST, ACTIVITY_DETAIL_CONSENT, ACTIVITY_PAUSED_UNTIL, getStore, lastNight, LOCAL_ACTIVITY_CONSENT, readAvailability, readGoalSettings, readSchedulePreferences
} from "../../lib/crossline";
import { requireSessionContext } from "../../lib/access-guard";
import { suggestedAvailabilityFor } from "../../lib/timeline";

export const dynamic = "force-dynamic";
const USAGE_DAYS = 7;

/**
 * Everything that is configured rather than done, in one place: the hours the scheduler may use, the activity
 * consent, what the app is connected to, and what its model calls have cost. The schedule editor is the same
 * component the plan page folds in; editing it in either place changes the same settings row.
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
  const detailRaw = store.getSetting(ctx.workspaceId, ACTIVITY_DETAIL_CONSENT);
  const detail = detailRaw === "granted" || detailRaw === "denied" ? detailRaw : "unasked";
  let blacklist: string[] = [];
  try { const parsed = JSON.parse(store.getSetting(ctx.workspaceId, ACTIVITY_BLACKLIST) ?? "[]") as unknown; if (Array.isArray(parsed)) blacklist = parsed.filter((word): word is string => typeof word === "string"); } catch { /* unreadable counts as empty */ }
  const since = new Date(Date.now() - USAGE_DAYS * 86_400_000).toISOString();
  const summary = store.summarizeModelUsage(ctx.workspaceId, since);
  const night = lastNight(ctx.workspaceId, new Date());
  // The tailnet address the phone uses (stage six, `private` mode behind `tailscale serve`), when it is set up.
  const host = process.env.CROSSLINE_TAILSCALE_HOSTNAME?.trim();
  const phoneUrl = process.env.CROSSLINE_DEPLOYMENT_MODE === "private" && host ? `https://${host}` : undefined;

  return <SubpageShell active="设置" title="设置">
    <details className="fold" open><summary>作息与可用时间</summary>
      <AvailabilityEditor windows={readAvailability(ctx)} preferences={effectivePreferences} milestones={milestones} suggested={suggestedAvailabilityFor(ctx)} />
    </details>
    <details className="fold" open><summary>系统体检</summary>
      <EffectivenessCard data={await loadEffectiveness(ctx)} labels={Object.fromEntries(defaultIdentityPacks().map((pack) => [pack.id, pack.label]))} />
    </details>
    <details className="fold" open><summary>提醒</summary>
      <NotifyLevel level={store.getSetting(ctx.workspaceId, "notify.level") ?? "normal"} />
      <p className="muted">每个工作块开始前 10 分钟的提醒、等待项到期日和截止前 2 天的提醒，写在名为 Crossline 的日历上，由 Outlook 和手机推送。</p>
    </details>
    <details className="fold" id="phone"><summary>在手机上用</summary>
      {phoneUrl
        ? <div className="phone-setup">
          <p>手机和这台电脑在同一个 Tailscale 网络里时，用这个地址打开，和电脑上是同一个账本、同一份数据：</p>
          <p><a href={phoneUrl}><b>{phoneUrl}</b></a></p>
          <ol>
            <li>手机上打开 Tailscale App，确认已连接（和这台电脑同一个账号）。</li>
            <li>用 Safari 打开上面的地址并登录。</li>
            <li>点分享按钮 →「添加到主屏幕」：之后它像一个独立 App 一样全屏打开。</li>
          </ol>
          <p className="muted">这台电脑需要开着、Crossline 在运行（已设为开机自启，每 15 分钟自检一次）。离线时收集的内容会先存在手机上，联网后自动同步。
            手机上的提醒来自名为 Crossline 的日历：在 iPhone 的 Outlook 或系统日历里登录同一个 Outlook 账号即可收到工作块和截止提醒。</p>
        </div>
        : <p className="muted">还没开启手机访问：需要在这台电脑上把 <code>CROSSLINE_DEPLOYMENT_MODE</code> 设为 <code>private</code>、填上 <code>CROSSLINE_TAILSCALE_HOSTNAME</code>，并运行 <code>tailscale serve</code>。步骤见 docs/private-network-deployment.md。</p>}
    </details>
    <details className="fold"><summary>屏幕活动与隐私</summary>
      <LocalActivityToggle consent={consent} detail={detail} pausedUntil={store.getSetting(ctx.workspaceId, ACTIVITY_PAUSED_UNTIL) || null} blacklist={blacklist} />
    </details>
    <details className="fold" id="connections" open><summary>连接与账号</summary>
      <ConnectionsSection ctx={ctx} />
    </details>
    <details className="fold"><summary>模型用量（近 {USAGE_DAYS} 天）</summary>
      <UsageCard summary={summary} days={USAGE_DAYS} />
      {/* The nightly expansion's status, moved here from Today: it is about the system, not about the day. */}
      {night.state !== "none" && <p className="last-night">
        {night.state === "ran" ? `昨夜扩展 · 产出 ${night.proposals} 条候选` : `昨夜扩展没有运行 · ${night.reason}`}
      </p>}
    </details>
    <p className="muted"><a href="/onboarding">重新做「先了解你」→</a></p>
  </SubpageShell>;
}
