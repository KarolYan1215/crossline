import { CodexAccountControl } from "./codex-account-control";
import { ModelProviderCard } from "../settings/model-provider-card";
import { CalendarSources } from "./calendar-sources";
import { CalendarApps } from "./calendar-apps";
import { CalendarSubscriptions } from "./calendar-subscriptions";
import { SourceFolders } from "./source-folders";
import { TailscaleTrust } from "./tailscale-trust";
import { DeviceLeases } from "./device-leases";
import { effectiveSchedulePreferences, loadCalendarConnectorState } from "../../lib/crossline";
import { publishStatus } from "../../lib/calendar-publish";
import { CalendarWriteLogin } from "./calendar-write-login";
import { localStamp, type AccessContext } from "@crossline/core";
import { Tag } from "../ui/tag";
import { graphConfigured, isHostedBeta } from "../../lib/hosting";

/**
 * The calendar as one module (it was two cards that did not mention each other): which calendars are read, the last sync, and
 * whether the Crossline calendar has an account to write to. Settings → 日历与连接.
 */
export function CalendarModule({ ctx }: { ctx: AccessContext }) {
  const calendar = loadCalendarConnectorState(ctx);
  const publish = publishStatus(ctx);
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  // A failure older than the last write that went through is over.
  const failure = publish.failure && (!publish.last || publish.failure.at > publish.last.at) ? publish.failure : undefined;
  // The Microsoft calendar (read sync, the writer's sign-in, the calendar list) needs an Entra app this install may not have: the
  // hosted beta has none, and there its cards only offered a sign-in that could not work and a list that answered 404.
  const graph = graphConfigured() || !isHostedBeta();
  return <div className="st-modules">
    {graph && <section className="st-card" aria-label="日历状态">
      <header><h3>日历</h3></header>
      <div className="st-row"><span className="st-row-label">读取<small>{calendar.synced
        ? `今日导入 ${calendar.importedBlocks} 个日程${calendar.lastChangeAt ? ` · 最近变化 ${localStamp(calendar.lastChangeAt, effectiveSchedulePreferences(ctx).preferences.timeZone)}（${calendar.lastChangeCount} 项）` : " · 无变化"}`
        : "尚未完成首次同步"}</small></span>
        <Tag tone={calendar.synced ? "ok" : "warn"}>{calendar.synced ? "只读同步中" : "未连接"}</Tag></div>
      <div className="st-row"><span className="st-row-label">写入 Crossline 日历<small>只写入名为 Crossline 的日历，只改动本应用创建且未被手动修改的日程</small></span>
        <Tag tone={!publish.account ? "neutral" : failure ? "warn" : "ok"}>{!publish.account ? "未设置账户" : failure ? "写入未完成" : "自动写入中"}</Tag></div>
      {publish.account && <div className="st-row"><span className="st-row-label">最近一次写入<small>{publish.last
        ? `${localStamp(publish.last.at, zone)} · 新增 ${publish.last.created}、调整 ${publish.last.updated}、移除 ${publish.last.deleted}、不变 ${publish.last.unchanged}`
        : "尚未写入"}{publish.last?.keptAsEdited ? ` · ${publish.last.keptAsEdited} 条按本人修改处理，保持原样` : ""}。计划变化后约 2 分钟内写入，最迟 10 分钟。</small></span></div>}
      <CalendarWriteLogin relogin={publish.account} />
      {failure && <div className="st-row"><span className="st-row-label">写入未完成<small>{localStamp(failure.at, zone)} · {failure.text}{failure.relogin
        ? "。用上面的「获取登录代码」重新登录后会自动重试" : ""}。其他日历未受影响。</small></span>
        <a href="/approvals#asks">去处理</a></div>}
    </section>}
    <CalendarApps />
    <div id="calendar-subscriptions"><CalendarSubscriptions /></div>
    <SourceFolders />
    {graph && <CalendarSources />}
  </div>;
}

/** Accounts and devices: the model service, the private network identity, devices allowed to queue offline. */
export function ConnectionsSection() {
  return <div className="st-modules">
    <div id="model"><CodexAccountControl /></div>
    <ModelProviderCard local={!isHostedBeta()} />
    {!isHostedBeta() && <TailscaleTrust />}
    <DeviceLeases />
  </div>;
}
