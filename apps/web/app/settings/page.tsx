import { SubpageShell } from "../subpage-shell";
import { AvailabilityEditor } from "../plan/availability-editor";
import { LocalActivityToggle } from "./local-activity-toggle";
import { UsageCard } from "./usage-card";
import { ConnectionsSection } from "../connectors/connections";
import {
  ACTIVITY_BLACKLIST, ACTIVITY_DETAIL_CONSENT, ACTIVITY_PAUSED_UNTIL, getStore, LOCAL_ACTIVITY_CONSENT, readAvailability, readGoalSettings, readSchedulePreferences
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

  return <SubpageShell active="设置" title="设置">
    <details className="fold" open><summary>作息与可用时间</summary>
      <AvailabilityEditor windows={readAvailability(ctx)} preferences={effectivePreferences} milestones={milestones} suggested={suggestedAvailabilityFor(ctx)} />
    </details>
    <details className="fold"><summary>屏幕活动与隐私</summary>
      <LocalActivityToggle consent={consent} detail={detail} pausedUntil={store.getSetting(ctx.workspaceId, ACTIVITY_PAUSED_UNTIL) || null} blacklist={blacklist} />
    </details>
    <details className="fold" id="connections" open><summary>连接与账号</summary>
      <ConnectionsSection ctx={ctx} />
    </details>
    <details className="fold"><summary>模型用量（近 {USAGE_DAYS} 天）</summary>
      <UsageCard summary={summary} days={USAGE_DAYS} />
    </details>
    <p className="muted"><a href="/onboarding">重新做「先了解你」→</a></p>
  </SubpageShell>;
}
