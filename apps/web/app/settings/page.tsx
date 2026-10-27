import { ACTIVITY_HOURLY, atComputerByHour, type ActivityHour, AGENT_HISTORY_CONSENT, AGENT_HISTORY_SUMMARY, CATEGORY_LABEL, SLEEP_TRACKING_CONSENT, TELEMETRY_ENABLED_SETTING, type ActivityCategory, type AgentHistorySummary } from "@crossline/core";
import { assistantAvailable, categoryMode, isAutoHandoff, readCategories } from "@crossline/db";
import { SubpageShell } from "../subpage-shell";
import { LocalActivityToggle } from "./local-activity-toggle";
import { AgentHistoryCard } from "./agent-history-card";
import { RecordingCard } from "./recording-card";
import { ServerRecordingCard } from "./server-recording-card";
import { recordingOverview } from "../../lib/recordings";
import { TelemetryCard } from "./telemetry-card";
import { AutostartCard } from "./autostart-card";
import { DeviceCard } from "./device-card";
import { autostartAvailable, readAutostart } from "../../lib/autostart";
import { isLocalInstall } from "../../lib/install-mode";
import { isHostedBeta } from "../../lib/hosting";
import { headers } from "next/headers";
import { getAuth, isEmailAuthConfigured } from "../../lib/auth";
import { PasswordCard } from "./password-card";
import { DeleteAccountCard } from "./delete-account-card";
import { ResetAccountCard } from "./reset-account-card";
import { deletionRefused } from "../../lib/account-deletion";
import { EnergyCard, type EnergyStatus } from "./energy-card";
import { HEALTH_TOKEN_SETTING, energyModel, phoneDailyLatest, phoneHealthOn } from "../../lib/energy";
import { UsageCard } from "./usage-card";
import { QuotaCard } from "./quota-card";
import { readQuota } from "../../lib/quota";
import { NotifyLevel } from "./notify-level";
import { TravelCard } from "./travel-card";
import { PhonePush } from "./phone-push";
import { EffectivenessCard } from "./effectiveness-card";
import { AutomationModule, type RecentTask } from "./automation";
import { BackgroundModule } from "./background-module";
import { backgroundOverview } from "../../lib/background";
import { SettingsNav, type SettingsSection } from "./settings-nav";
import { PersonalizationModule } from "./personalization";
import { SkillLibraryModule } from "./skill-library";
import { loadSkillLibrary } from "../../lib/skill-library";
import { loadPreferences } from "../../lib/preferences";
import { CalendarModule, ConnectionsSection } from "../connectors/connections";
import { loadEffectiveness } from "../../lib/effectiveness";
import { loadAssistant } from "../../lib/agent";
import { agentTaskStatusLabel } from "../../lib/labels";
import { permissionModeEnabled } from "../../lib/permission-mode";
import {
  ACTIVITY_BLACKLIST, ACTIVITY_DETAIL_CONSENT, ACTIVITY_PAUSED_UNTIL, dataDirectory, effectiveSchedulePreferences, getStore, LOCAL_ACTIVITY_CONSENT, planToday, readAvailability, toZonedInstant, travelStateOf
} from "../../lib/crossline";
import { requireSessionContext } from "../../lib/access-guard";
import { identityLines, lineLabels } from "../../lib/lines";
import { AutomationsCard } from "./automations-card";
import { OutputsCard } from "./outputs-card";
import { MailAccounts } from "../connectors/mail-accounts";
import { interviewStatus } from "../../lib/interview-status";
import { timed, timedSync } from "../../lib/sections";
import { memoForAsync } from "../../lib/ledger-memo";

export const dynamic = "force-dynamic";
const USAGE_DAYS = 7;
const TONE: Record<string, RecentTask["tone"]> = { running: "info", needs_review: "warn", accepted: "ok", rejected: "neutral", blocked: "risk", stale: "neutral" };

/**
 * Everything configured rather than done, as modules under a left-hand index (a strip of tabs on a phone). When the person is free
 * and how the schedule is packed are set on the plan page, next to the schedule they change; what waits for a decision is on 待确认.
 */
export default async function SettingsPage() {
  const ctx = await requireSessionContext();
  const interview = timedSync("settings.interview", () => interviewStatus(ctx));
  const store = getStore();
  const setting = (key: string) => store.getSetting(ctx.workspaceId, key);
  const level = (value: string | null | undefined) => value === "granted" || value === "denied" ? value : "unasked";
  const consent = level(setting(LOCAL_ACTIVITY_CONSENT));
  const detail = level(setting(ACTIVITY_DETAIL_CONSENT));
  let blacklist: string[] = [];
  try { const parsed = JSON.parse(setting(ACTIVITY_BLACKLIST) ?? "[]") as unknown; if (Array.isArray(parsed)) blacklist = parsed.filter((word): word is string => typeof word === "string"); } catch { /* unreadable counts as empty */ }

  // Today's activity, drawn only at the detailed level the person chose; segments carry no window titles.
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

  const since = new Date(Date.now() - USAGE_DAYS * 86_400_000).toISOString();
  const assistant = timedSync("settings.assistant", () => loadAssistant(ctx));
  const states = readCategories(store, ctx.workspaceId);
  const host = process.env.CROSSLINE_TAILSCALE_HOSTNAME?.trim();
  const hosted = isHostedBeta();
  const deviceLinked = hosted && Boolean(store.getSetting(ctx.workspaceId, "device.token.sha256"));
  // 删除账号 is offered on the hosted beta to every account but the machine owner's; 清空数据重新开始 to every hosted account
  // (lib/account-deletion.ts).
  // The signed-in account's email, also said on the mailbox card: mailboxes belong to the account they were connected under.
  const sessionEmail = await (async () => { try { return (await getAuth().api.getSession({ headers: await headers() }))?.user.email; } catch { return undefined; } })();
  const accountEmail = hosted ? sessionEmail : undefined;
  const deletable = accountEmail && !deletionRefused(store, ctx.workspaceId) ? accountEmail : undefined;
  // On the hosted beta the app already is a web address; elsewhere the phone reaches this machine over the private network.
  const phoneUrl = hosted ? process.env.CROSSLINE_WEB_BASE_URL?.trim() || undefined
    : process.env.CROSSLINE_DEPLOYMENT_MODE === "private" && host ? `https://${host}` : undefined;
  // 精力: what the model reads now, and from how many nights and reports (docs/one-input.md §5).
  const energy = timedSync("settings.energy", () => energyModel(ctx, readAvailability(ctx)));
  const fortnight = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const recentNights = energy.episodes.filter((episode) => episode.wakeAt >= fortnight);
  const phoneDaily = phoneDailyLatest(ctx.workspaceId);
  const energyStatus: EnergyStatus = { now: energy.predict(new Date().toISOString()),
    nights: { screen: recentNights.filter((episode) => episode.source === "screen").length, phone: recentNights.filter((episode) => episode.source !== "screen").length },
    reports: energy.calibration.reports, agreement: energy.calibration.agreement, phoneConnected: Boolean(store.getSetting(ctx.workspaceId, HEALTH_TOKEN_SETTING)),
    sleepTracking: store.getSetting(ctx.workspaceId, SLEEP_TRACKING_CONSENT) === "granted",
    inputRhythm: store.getSetting(ctx.workspaceId, "activity.inputRhythm") === "granted",
    camera: store.getSetting(ctx.workspaceId, "energy.camera") === "granted",
    phoneHealth: phoneHealthOn(ctx.workspaceId), ...(phoneDaily ? { phoneDaily } : {}),
    signals: energy.covariates.map(({ id, label, use, evaluated, hitsWith, hitsWithout, enabled }) => ({ id, label, use, evaluated, hitsWith, hitsWithout, enabled })) };

  // This computer's own readings (folders, screen, idle stretches, coding agents' logs) are the machine owner's only.
  const machine = assistantAvailable(store, ctx.workspaceId);
  // When the person is at the computer, hour by hour (activity.hourly, under the activity consent).
  const recordings = recordingOverview(store, ctx.workspaceId, dataDirectory(), zone);
  const usualDay = (() => { try { return atComputerByHour(JSON.parse(setting(ACTIVITY_HOURLY) ?? "[]") as ActivityHour[], zone); } catch { return undefined; } })();
  const autostart = autostartAvailable() ? await readAutostart() : undefined;
  // The index, with the parts of the long modules under their entry so every card is one click away (2026-10-21). Connections come
  // second: they are what the person most often comes here for.
  const sections: SettingsSection[] = [
    { id: "general", label: "通用", parts: [{ id: "phone", label: "手机访问与推送" }, ...(hosted ? [{ id: "device", label: "这台电脑" }] : [])] },
    { id: "calendar", label: "日历与连接", parts: [{ id: "calendar-subscriptions", label: "订阅日历" }, { id: "mail", label: "邮箱" }, { id: "model", label: "模型连接" }] },
    { id: "notify", label: "时间与提醒", parts: [{ id: "travel", label: "出行" }] },
    { id: "automation", label: "自动化与助手", parts: [{ id: "automations", label: "自动化" }, { id: "outputs", label: "助手产出" }] },
    { id: "background", label: "后台任务" },
    { id: "personal", label: "个性化" },
    { id: "skills", label: "Skill 库" },
    { id: "privacy", label: "隐私与屏幕活动", parts: [{ id: "energy", label: "精力与手机健康" },
      ...(machine || recordings.server ? [{ id: "recordings", label: "录音转写" }] : [])] },
    { id: "usage", label: "用量与体检" }
  ];

  return <SubpageShell active="设置" title="设置">
    <div className="st-layout">
      <SettingsNav sections={sections} />
      <div className="st-sections">
        <section id="general" className="st-section" aria-labelledby="st-general"><h2 id="st-general">通用</h2>
          <div className="st-modules">
            {!isLocalInstall() && isEmailAuthConfigured() && <PasswordCard />}
            <section className="st-card" aria-label="个人情况">
              <header><h3>个人情况</h3><small>主线、项目、日期与长期目标的来源</small></header>
              <div className="st-row"><span className="st-row-label">访谈<small>{!interview.started ? "尚未开始"
                : interview.complete ? "已完成；补充或修改后，里程碑草稿按新情况重新设计"
                  : `未完成 · 第 ${interview.stageIndex}/${interview.stageCount} 阶段${interview.openQuestions ? ` · 待答 ${interview.openQuestions} 题` : ""}${interview.parked ? " · 问题已列在待决事项" : ""}`}</small></span>
                <a className="secondary-button" href="/onboarding">{interview.started && !interview.complete ? "继续访谈" : "打开访谈"}</a></div>
            </section>
            <section className="st-card" aria-label="手机访问" id="phone">
              <header><h3>手机访问</h3><small>{hosted ? "手机与电脑用同一个账号、同一本账" : "与电脑同一账本；本机需保持运行"}</small></header>
              {phoneUrl ? <>
                <div className="st-row"><span className="st-row-label">地址<small>{hosted ? "在手机浏览器打开并登录，添加到主屏幕" : "手机连接同一私有网络后打开，添加到主屏幕"}</small></span><a href={phoneUrl}><b>{phoneUrl}</b></a></div>
                <PhonePush privateNetwork={!hosted} />
              </> : <p className="muted">手机访问未开启。</p>}
            </section>
            {hosted && <DeviceCard siteUrl={process.env.CROSSLINE_WEB_BASE_URL?.trim() || null} />}
            {autostart !== undefined && <AutostartCard on={autostart} />}
            {accountEmail && <ResetAccountCard email={accountEmail} />}
            {deletable && <DeleteAccountCard email={deletable} />}
          </div>
        </section>

        <section id="calendar" className="st-section" aria-labelledby="st-calendar"><h2 id="st-calendar">日历与连接</h2>
          <CalendarModule ctx={ctx} />
          <div className="st-modules"><div id="mail"><MailAccounts accountEmail={sessionEmail} /></div></div>
          <ConnectionsSection />
        </section>

        <section id="notify" className="st-section" aria-labelledby="st-notify"><h2 id="st-notify">时间与提醒</h2>
          <div className="st-modules">
            <section className="st-card" aria-label="通知">
              <header><h3>通知</h3><small>{store.getSetting(ctx.workspaceId, "calendar.write.account")
                ? "工作块开始前 10 分钟、等待项到期日和截止前 2 天的提醒写在 Crossline 日历上"
                : "工作块开始、等待项到期和临近截止时提醒到桌面与手机"}</small></header>
              <NotifyLevel level={setting("notify.level") ?? "normal"} />
              <div className="st-row"><span className="st-row-label">可用时段、排程参数与重要性<small>在「计划」页设置，修改前预览影响</small></span>
                <a className="secondary-button" href="/plan#why">打开计划</a></div>
            </section>
            <TravelCard initial={travelStateOf(ctx).settings} />
          </div>
        </section>

        <section id="automation" className="st-section" aria-labelledby="st-automation"><h2 id="st-automation">自动化与助手</h2>
          {/* The shell assistant runs as this machine's user (decided 2026-10-10); every other account's works through Crossline's functions. */}
          {!machine && <p className="muted">{hosted
            ? "网页版的助手通过 Crossline 自己的功能工作：读写和整理文件、查网页、读已接入的邮箱、把待办放进收件箱、按时或按条件跑自动化；不在电脑上执行命令。"
            : "这个账号的助手通过 Crossline 自己的功能工作（读写整理文件、查网页、读邮箱、跑自动化）；能在电脑上执行命令的助手只为电脑主人工作。"}</p>}
          <AutomationModule toolsMode={!machine} paused={assistant.paused} permissionMode={permissionModeEnabled(ctx)} autoHandoff={isAutoHandoff(store, ctx.workspaceId)}
            categories={assistant.categories.map((item) => ({ category: item.category, label: item.label, explained: item.explained,
              mode: categoryMode(states[item.category]), cleanRuns: item.cleanRuns, runsToTrust: item.runsToTrust }))}
            recent={assistant.tasks.slice(0, 8).map((task) => ({ taskId: task.taskId, title: task.title, kind: assistant.categories.find((item) => item.category === task.category)?.label ?? "",
              status: agentTaskStatusLabel[task.status] ?? task.status, tone: TONE[task.status] ?? "neutral", day: task.requestedAt.slice(5, 10).replace("-", "/"),
              workOrderId: task.workOrderId }))} />
          <div className="st-modules"><div id="automations"><AutomationsCard lines={identityLines(ctx).map((line) => ({ id: line.id, label: line.label }))} /></div>
            <div id="outputs"><OutputsCard /></div></div>
        </section>

        <section id="background" className="st-section" aria-labelledby="st-background"><h2 id="st-background">后台任务</h2>
          <BackgroundModule overview={backgroundOverview(ctx)} />
        </section>

        <section id="personal" className="st-section" aria-labelledby="st-personal"><h2 id="st-personal">个性化</h2>
          <PersonalizationModule {...loadPreferences(ctx)} />
        </section>

        <section id="skills" className="st-section" aria-labelledby="st-skills"><h2 id="st-skills">Skill 库</h2>
          <SkillLibraryModule library={loadSkillLibrary(ctx)} />
        </section>

        <section id="privacy" className="st-section" aria-labelledby="st-privacy"><h2 id="st-privacy">隐私与屏幕活动</h2>
          {!machine && <p className="muted">{hosted
            ? deviceLinked
              ? "屏幕活动、作息记录、键鼠节律、Codex 使用记录和录音自动转写由「这台电脑」读取，开关在那台电脑的设备页；读到的结果在这里使用。"
              : "屏幕活动、作息记录、键鼠节律、Codex 使用记录和录音自动转写要读本人电脑，网页版不提供；在「通用 → 这台电脑」连接本人电脑后可用。精力按本人自评和手机记录推算。"
            : "屏幕活动、作息记录、键鼠节律、Codex 使用记录和录音自动转写读的是运行 Crossline 的那台电脑，只对它的主人开放。"}</p>}
          {machine && <LocalActivityToggle consent={consent} detail={detail} pausedUntil={setting(ACTIVITY_PAUSED_UNTIL) || null} blacklist={blacklist}
            hours={hours} categories={[...byCategory].sort((a, b) => b[1] - a[1])
              .map(([category, minutes]) => ({ label: CATEGORY_LABEL[category as ActivityCategory] ?? "其他", minutes }))} />}
          <div id="energy"><EnergyCard status={energyStatus} phoneUrl={phoneUrl ?? null} hostSignals={machine} privateNetwork={!hosted} /></div>
          {machine && <AgentHistoryCard on={setting(AGENT_HISTORY_CONSENT) === "on"} summary={(() => { try { return JSON.parse(setting(AGENT_HISTORY_SUMMARY) ?? "null") as AgentHistorySummary | null; } catch { return null; } })()} />}
          {(machine || deviceLinked) && usualDay && <section className="st-card" aria-label="电脑前的一天">
            <header><h3>电脑前的一天</h3><small>近 {usualDay.days} 天按小时的平均活跃分钟；只记分钟，供访谈与画像了解作息，不用于排程</small></header>
            <div className="st-hours" role="img" aria-label="每小时平均活跃分钟">{usualDay.active.map((minutes, hour) =>
              <span key={hour} title={`${hour}:00–${hour + 1}:00 · 平均 ${minutes} 分钟，${Math.round(usualDay.present[hour]! * 100)}% 的日子在电脑前`}><i style={{ height: `${(minutes / 60) * 100}%` }} /></span>)}</div>
            <div className="st-hours-axis" aria-hidden="true"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div>
          </section>}
          {(machine || recordings.server) && <div id="recordings" className="st-section-cards">
            {machine && <RecordingCard overview={recordings} />}
            {recordings.server && <ServerRecordingCard server={recordings.server} done={recordings.done} />}
          </div>}
          {isLocalInstall() && <TelemetryCard on={setting(TELEMETRY_ENABLED_SETTING) !== "0"} />}
        </section>

        <section id="usage" className="st-section" aria-labelledby="st-usage"><h2 id="st-usage">用量与体检</h2>
          <div className="st-modules">
            <section className="st-card" aria-label="系统体检"><header><h3>系统体检</h3><small>每日从账本计算</small></header>
              <EffectivenessCard data={await timed("settings.effectiveness", () => memoForAsync(`effectiveness:${ctx.workspaceId}`, 5 * 60_000, () => loadEffectiveness(ctx)))} labels={lineLabels(ctx)} />
            </section>
            <section className="st-card" aria-label="模型额度"><header><h3>模型额度</h3><small>账号的剩余额度与重置时间</small></header>
              <QuotaCard signal={await timed("settings.quota", () => memoForAsync(`quota:${ctx.workspaceId}`, 60_000, () => readQuota(ctx)))} now={new Date()} timeZone={zone} />
            </section>
            <section className="st-card" aria-label="模型用量"><header><h3>模型用量</h3><small>近 {USAGE_DAYS} 天，悬停查看次数与耗时</small></header>
              <UsageCard summary={store.summarizeModelUsage(ctx.workspaceId, since)} daily={store.dailyModelUsage(ctx.workspaceId, since)} days={USAGE_DAYS} />
            </section>
          </div>
        </section>
      </div>
    </div>
  </SubpageShell>;
}
