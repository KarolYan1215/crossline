import { AGENT_HISTORY_CONSENT, AGENT_HISTORY_SUMMARY, CATEGORY_LABEL, SLEEP_TRACKING_CONSENT, TELEMETRY_ENABLED_SETTING, type ActivityCategory, type AgentHistorySummary } from "@crossline/core";
import { assistantAvailable, categoryMode, isAutoHandoff, readCategories } from "@crossline/db";
import { SubpageShell } from "../subpage-shell";
import { LocalActivityToggle } from "./local-activity-toggle";
import { AgentHistoryCard } from "./agent-history-card";
import { TelemetryCard } from "./telemetry-card";
import { AutostartCard } from "./autostart-card";
import { autostartAvailable, readAutostart } from "../../lib/autostart";
import { isLocalInstall } from "../../lib/install-mode";
import { isEmailAuthConfigured } from "../../lib/auth";
import { PasswordCard } from "./password-card";
import { EnergyCard, type EnergyStatus } from "./energy-card";
import { HEALTH_TOKEN_SETTING, energyModel } from "../../lib/energy";
import { UsageCard } from "./usage-card";
import { QuotaCard } from "./quota-card";
import { readQuota } from "../../lib/quota";
import { NotifyLevel } from "./notify-level";
import { PhonePush } from "./phone-push";
import { EffectivenessCard } from "./effectiveness-card";
import { AutomationModule, type RecentTask } from "./automation";
import { BackgroundModule } from "./background-module";
import { backgroundOverview } from "../../lib/background";
import { SettingsNav } from "./settings-nav";
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
  ACTIVITY_BLACKLIST, ACTIVITY_DETAIL_CONSENT, ACTIVITY_PAUSED_UNTIL, effectiveSchedulePreferences, getStore, LOCAL_ACTIVITY_CONSENT, planToday, readAvailability, toZonedInstant
} from "../../lib/crossline";
import { requireSessionContext } from "../../lib/access-guard";
import { lineLabels } from "../../lib/lines";
import { interviewStatus } from "../../lib/interview-status";

export const dynamic = "force-dynamic";
const USAGE_DAYS = 7;
const SECTIONS = [["general", "通用"], ["notify", "时间与提醒"], ["automation", "自动化与助手"], ["background", "后台任务"], ["personal", "个性化"], ["skills", "Skill 库"], ["calendar", "日历与连接"],
  ["privacy", "隐私与屏幕活动"], ["usage", "用量与体检"]] as const;
const TONE: Record<string, RecentTask["tone"]> = { running: "info", needs_review: "warn", accepted: "ok", rejected: "neutral", blocked: "risk", stale: "neutral" };

/**
 * Everything configured rather than done, as modules under a left-hand index (a strip of tabs on a phone). When the person is free
 * and how the schedule is packed are set on the plan page, next to the schedule they change; what waits for a decision is on 待确认.
 */
export default async function SettingsPage() {
  const ctx = await requireSessionContext();
  const interview = interviewStatus(ctx);
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
  const assistant = loadAssistant(ctx);
  const states = readCategories(store, ctx.workspaceId);
  const host = process.env.CROSSLINE_TAILSCALE_HOSTNAME?.trim();
  const phoneUrl = process.env.CROSSLINE_DEPLOYMENT_MODE === "private" && host ? `https://${host}` : undefined;
  // 精力: what the model reads now, and from how many nights and reports (docs/one-input.md §5).
  const energy = energyModel(ctx, readAvailability(ctx));
  const fortnight = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const recentNights = energy.episodes.filter((episode) => episode.wakeAt >= fortnight);
  const energyStatus: EnergyStatus = { now: energy.predict(new Date().toISOString()),
    nights: { screen: recentNights.filter((episode) => episode.source === "screen").length, phone: recentNights.filter((episode) => episode.source !== "screen").length },
    reports: energy.calibration.reports, agreement: energy.calibration.agreement, phoneConnected: Boolean(store.getSetting(ctx.workspaceId, HEALTH_TOKEN_SETTING)),
    sleepTracking: store.getSetting(ctx.workspaceId, SLEEP_TRACKING_CONSENT) === "granted",
    inputRhythm: store.getSetting(ctx.workspaceId, "activity.inputRhythm") === "granted",
    camera: store.getSetting(ctx.workspaceId, "energy.camera") === "granted",
    signals: energy.covariates.map(({ id, label, evaluated, hitsWith, hitsWithout, enabled }) => ({ id, label, evaluated, hitsWith, hitsWithout, enabled })) };

  // This computer's own readings (folders, screen, idle stretches, coding agents' logs) are the machine owner's only.
  const machine = assistantAvailable(store, ctx.workspaceId);
  const autostart = autostartAvailable() ? await readAutostart() : undefined;

  return <SubpageShell active="设置" title="设置">
    <div className="st-layout">
      <SettingsNav sections={SECTIONS.map(([id, label]) => ({ id, label }))} />
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
              <header><h3>手机访问</h3><small>与电脑同一账本；本机需保持运行</small></header>
              {phoneUrl ? <>
                <div className="st-row"><span className="st-row-label">地址<small>手机连接同一私有网络后打开，添加到主屏幕</small></span><a href={phoneUrl}><b>{phoneUrl}</b></a></div>
                <PhonePush />
              </> : <p className="muted">手机访问未开启。</p>}
            </section>
            {autostart !== undefined && <AutostartCard on={autostart} />}
          </div>
        </section>

        <section id="notify" className="st-section" aria-labelledby="st-notify"><h2 id="st-notify">时间与提醒</h2>
          <div className="st-modules">
            <section className="st-card" aria-label="通知">
              <header><h3>通知</h3><small>工作块开始前 10 分钟、等待项到期日和截止前 2 天的提醒写在 Crossline 日历上</small></header>
              <NotifyLevel level={setting("notify.level") ?? "normal"} />
              <div className="st-row"><span className="st-row-label">可用时段、排程参数与重要性<small>在「计划」页设置，修改前预览影响</small></span>
                <a className="secondary-button" href="/plan#why">打开计划</a></div>
            </section>
          </div>
        </section>

        <section id="automation" className="st-section" aria-labelledby="st-automation"><h2 id="st-automation">自动化与助手</h2>
          {/* The shell assistant runs as this machine's user, so it works only for the machine owner's account (decided 2026-10-10). */}
          {!machine
            && <p className="muted">这台电脑上的助手只为电脑主人工作，这个账号的步骤都由本人完成；分析、拆分与规划照常在自己的模型连接上运行。</p>}
          <AutomationModule assistant={machine} paused={assistant.paused} permissionMode={permissionModeEnabled(ctx)} autoHandoff={isAutoHandoff(store, ctx.workspaceId)}
            categories={assistant.categories.map((item) => ({ category: item.category, label: item.label, explained: item.explained,
              mode: categoryMode(states[item.category]), cleanRuns: item.cleanRuns, runsToTrust: item.runsToTrust }))}
            recent={assistant.tasks.slice(0, 8).map((task) => ({ taskId: task.taskId, title: task.title, kind: assistant.categories.find((item) => item.category === task.category)?.label ?? "",
              status: agentTaskStatusLabel[task.status] ?? task.status, tone: TONE[task.status] ?? "neutral", day: task.requestedAt.slice(5, 10).replace("-", "/"),
              workOrderId: task.workOrderId }))} />
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

        <section id="calendar" className="st-section" aria-labelledby="st-calendar"><h2 id="st-calendar">日历与连接</h2>
          <CalendarModule ctx={ctx} />
          <ConnectionsSection />
        </section>

        <section id="privacy" className="st-section" aria-labelledby="st-privacy"><h2 id="st-privacy">隐私与屏幕活动</h2>
          {!machine && <p className="muted">屏幕活动、作息记录、键鼠节律和 Codex 使用记录读的是运行 Crossline 的那台电脑，只对它的主人开放。</p>}
          {machine && <LocalActivityToggle consent={consent} detail={detail} pausedUntil={setting(ACTIVITY_PAUSED_UNTIL) || null} blacklist={blacklist}
            hours={hours} categories={[...byCategory].sort((a, b) => b[1] - a[1])
              .map(([category, minutes]) => ({ label: CATEGORY_LABEL[category as ActivityCategory] ?? "其他", minutes }))} />}
          <EnergyCard status={energyStatus} phoneUrl={phoneUrl ?? null} hostSignals={machine} />
          {machine && <AgentHistoryCard on={setting(AGENT_HISTORY_CONSENT) === "on"} summary={(() => { try { return JSON.parse(setting(AGENT_HISTORY_SUMMARY) ?? "null") as AgentHistorySummary | null; } catch { return null; } })()} />}
          {isLocalInstall() && <TelemetryCard on={setting(TELEMETRY_ENABLED_SETTING) !== "0"} />}
        </section>

        <section id="usage" className="st-section" aria-labelledby="st-usage"><h2 id="st-usage">用量与体检</h2>
          <div className="st-modules">
            <section className="st-card" aria-label="系统体检"><header><h3>系统体检</h3><small>每日从账本计算</small></header>
              <EffectivenessCard data={await loadEffectiveness(ctx)} labels={lineLabels(ctx)} />
            </section>
            <section className="st-card" aria-label="模型额度"><header><h3>模型额度</h3><small>账号的剩余额度与重置时间</small></header>
              <QuotaCard signal={await readQuota(ctx)} now={new Date()} timeZone={zone} />
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
