import { CodexAccountControl } from "./codex-account-control";
import { ModelProviderCard } from "../settings/model-provider-card";
import { CalendarSources } from "./calendar-sources";
import { CalendarApps } from "./calendar-apps";
import { TailscaleTrust } from "./tailscale-trust";
import { DeviceLeases } from "./device-leases";
import { effectiveSchedulePreferences, getStore, loadCalendarConnectorState } from "../../lib/crossline";
import { localStamp, type AccessContext } from "@crossline/core";
import { Tag } from "../ui/tag";

/**
 * The calendar as one module (it was two cards that did not mention each other): which calendars are read, the last sync, and
 * whether the Crossline calendar has an account to write to. Settings → 日历与连接.
 */
export function CalendarModule({ ctx }: { ctx: AccessContext }) {
  const calendar = loadCalendarConnectorState(ctx);
  const writer = Boolean(getStore().getSetting(ctx.workspaceId, "calendar.write.account"));
  return <div className="st-modules">
    <section className="st-card" aria-label="日历状态">
      <header><h3>日历</h3></header>
      <div className="st-row"><span className="st-row-label">读取<small>{calendar.synced
        ? `今日导入 ${calendar.importedBlocks} 个日程${calendar.lastChangeAt ? ` · 最近变化 ${localStamp(calendar.lastChangeAt, effectiveSchedulePreferences(ctx).preferences.timeZone)}（${calendar.lastChangeCount} 项）` : " · 无变化"}`
        : "尚未完成首次同步"}</small></span>
        <Tag tone={calendar.synced ? "ok" : "warn"}>{calendar.synced ? "只读同步中" : "未连接"}</Tag></div>
      <div className="st-row"><span className="st-row-label">写入 Crossline 日历<small>只写入名为 Crossline 的日历，只改动本应用创建且未被手动修改的日程</small></span>
        <Tag tone={writer ? "ok" : "neutral"}>{writer ? "已设置账户" : "未设置账户"}</Tag></div>
    </section>
    <CalendarApps />
    <CalendarSources />
  </div>;
}

/** Accounts and devices: the model service, the private network identity, devices allowed to queue offline. */
export function ConnectionsSection() {
  return <div className="st-modules">
    <CodexAccountControl />
    <ModelProviderCard />
    <TailscaleTrust />
    <DeviceLeases />
  </div>;
}
