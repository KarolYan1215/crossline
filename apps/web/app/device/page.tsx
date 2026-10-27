import { AGENT_HISTORY_CONSENT, AGENT_HISTORY_SUMMARY, activityCategoryLabel, INPUT_RHYTHM_CONSENT, SLEEP_TRACKING_CONSENT, type AgentHistorySummary } from "@crossline/core";
import { assistantAvailable } from "@crossline/db";
import { requireSessionContext } from "../../lib/access-guard";
import { ACTIVITY_BLACKLIST, ACTIVITY_DETAIL_CONSENT, ACTIVITY_PAUSED_UNTIL, dataDirectory, effectiveSchedulePreferences, getStore, LOCAL_ACTIVITY_CONSENT, planToday, toZonedInstant } from "../../lib/crossline";
import { isHostedBeta } from "../../lib/hosting";
import { recordingOverview } from "../../lib/recordings";
import { SourceFolders } from "../connectors/source-folders";
import { AgentHistoryCard } from "../settings/agent-history-card";
import { LocalActivityToggle } from "../settings/local-activity-toggle";
import { RecordingCard } from "../settings/recording-card";
import { SubpageShell } from "../subpage-shell";
import { DeviceLinkCard, DeviceSignals } from "./device-link-card";
import { localeFor } from "../../lib/locale";
import { tFor } from "../../lib/i18n";

export const dynamic = "force-dynamic";

/**
 * This computer as a device of the hosted account (docs/device-mode.md): the link, and the switches for what this machine reads — screen
 * activity, idle stretches, input rhythm, coding-agent time, recordings, folders. Once linked it is the one page that stays here; every
 * other page opens the hosted site. Not offered on the hosted site itself, which is no one's computer.
 */
export default async function DevicePage() {
  const ctx = await requireSessionContext();
  const locale = localeFor(ctx);
  const t = tFor(locale);
  // `active` names the view in the frame's own table, not shown text.
  if (isHostedBeta()) return <SubpageShell title={t("这台电脑")} active={"设置"}><p className="muted">{t("网页版不是谁的电脑：在本人电脑上的 Crossline 打开这个页面。")}</p></SubpageShell>;
  const store = getStore();
  const setting = (key: string) => store.getSetting(ctx.workspaceId, key);
  const level = (value: string | null | undefined) => value === "granted" || value === "denied" ? value : "unasked";
  const machine = assistantAvailable(store, ctx.workspaceId);
  const detail = level(setting(ACTIVITY_DETAIL_CONSENT));
  let blacklist: string[] = [];
  try { const parsed = JSON.parse(setting(ACTIVITY_BLACKLIST) ?? "[]") as unknown; if (Array.isArray(parsed)) blacklist = parsed.filter((word): word is string => typeof word === "string"); } catch { /* empty */ }
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  const hours = Array.from({ length: 24 }, () => 0);
  const byCategory = new Map<string, number>();
  if (detail === "granted") {
    const since = toZonedInstant(planToday(ctx), "00:00", zone);
    const hourOf = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", hourCycle: "h23" });
    for (const segment of store.listActivitySegments(ctx.workspaceId, since)) {
      if (segment.idle) continue;
      for (let at = Math.max(Date.parse(segment.start), Date.parse(since)); at < Date.parse(segment.end); at += 60_000) {
        hours[Number(hourOf.format(new Date(at))) % 24]! += 1;
        byCategory.set(segment.category, (byCategory.get(segment.category) ?? 0) + 1);
      }
    }
  }
  const summary = (() => { try { return JSON.parse(setting(AGENT_HISTORY_SUMMARY) ?? "null") as AgentHistorySummary | null; } catch { return null; } })();
  return <SubpageShell title={t("这台电脑")} active={"设置"} description={t("本机读什么、发到哪里。连接网页版后，这是电脑上唯一留下的页面。")}>
    <div className="st-modules">
      <DeviceLinkCard />
      {machine ? <>
        <LocalActivityToggle consent={level(setting(LOCAL_ACTIVITY_CONSENT))} detail={detail} pausedUntil={setting(ACTIVITY_PAUSED_UNTIL) || null} blacklist={blacklist}
          hours={hours} categories={[...byCategory].sort((a, b) => b[1] - a[1]).map(([category, minutes]) => ({ label: activityCategoryLabel(category, locale), minutes }))} />
        <DeviceSignals sleep={setting(SLEEP_TRACKING_CONSENT) === "granted"} rhythm={setting(INPUT_RHYTHM_CONSENT) === "granted"} />
        <AgentHistoryCard on={setting(AGENT_HISTORY_CONSENT) === "on"} summary={summary} />
        <RecordingCard overview={recordingOverview(store, ctx.workspaceId, dataDirectory(), zone)} />
        <SourceFolders />
      </> : <p className="muted">{t("本机的读取只对这台电脑的主人开放。")}</p>}
    </div>
  </SubpageShell>;
}
