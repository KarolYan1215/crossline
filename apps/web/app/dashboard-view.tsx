import { OfflineReplay } from "./offline-command-forms";
import { Conversation } from "./chat/conversation";
import type { Ask } from "@crossline/core";
import type { AskPreviews } from "./asks/types";
import { EnergyCard } from "./energy-capsule";
import { EnergyProbe } from "./energy-probe";
import type { TaskDetail, MilestoneDetail } from "../lib/task-detail";
import { AppShell } from "./app-shell";
import type { TaskSlot } from "./task/task-card";
import { CalendarPanel } from "./timeline/calendar-panel";
import { ScheduleSummary } from "./schedule-summary";
import type { FinerSplitNote, ScheduleChange } from "../lib/crossline";
import type { CalendarData } from "./plan/plan-view";
import { FlywheelGraph } from "./flywheel/flywheel-graph";
import type { Reminder } from "../lib/reminders";
import { DayHead } from "./today/day-head";
import { NeedsCard } from "./today/needs-card";
import type { CapacityLine } from "../lib/measured-capacity";
import { OverviewCard } from "./today/overview-card";
import { weekLoad } from "./today/week-load";
import type { Suggestion } from "./timeline/quick-actions";
import "./today/today.css";
import type { FlywheelGraphData } from "./flywheel/graph-model";
import { tFor, type Locale, type Translate } from "../lib/i18n";

export type DashboardAction = {
  id: string;
  title: string;
  identityId: string;
  estimate: { p25Minutes: number; p50Minutes: number; p85Minutes: number; confidence: "low" | "medium" | "high"; source: string; observationCount: number };
  energy?: "low" | "medium" | "high";
  reason: string;
  milestone: string;
  inputsReady: boolean;
};

export type DashboardData = {
  /** The page's language (docs/i18n.md); Chinese when absent. */
  locale?: Locale;
  principalId: string;
  workspaceId: string;
  nowLabel: string;
  /** The instant every number in the day head is read from, so the dial cannot drift from the label. */
  nowIso: string;
  timeZone: string;
  /** True under `CROSSLINE_FIXED_NOW`: the dial then holds still and drops its second hand. */
  clockPinned: boolean;
  dateLabel: string;
  monthLabel: string;
  /** Proposals the system has made that wait for the person; with nothing recommendable yet, Today says so instead of asking for more input. */
  awaitingApproval?: number;
  /** A proposal due within a week, still waiting for the person: unapproved work is not scheduled, so Today names it (W-31). */
  urgentProposal?: { id: string; title: string; due: string };
  milestones?: { drafts: number; any: boolean; firstDrafts: "none" | "running" | "stalled"; backplanning?: number };
  capacity: {
    level: "low" | "medium" | "high" | "uncalibrated";
    confidence?: "low" | "medium" | "high";
    observationCount: number;
    basis: Array<"self_report" | "execution_history" | "local_activity">;
    blockers: Array<{ code: string; message: string }>;
  };
  /** The energy model's reading of now, with its basis; the person's own fresh word, when there is one, stands above it. */
  energyEstimate?: { level: "low" | "medium" | "high"; confidence: "low" | "medium" | "high"; basis: string[];
    capacity?: { multiplier: number; basis: string[] }; selfReport?: "low" | "medium" | "high";
    /** The same model read every half hour of today (06:00–24:00, minutes after midnight) with its cut points; absent without a known last sleep. */
    curve?: { points: Array<{ minute: number; alertness: number }>; low: number; high: number; nowMinute: number } };
  energyLearning?: { status: "rule_only" | "personal_unvalidated" | "personal_calibrated";
    count: number; predictedCorrect: number; baselineCorrect: number };
  primary?: DashboardAction;
  higherPriority?: DashboardAction;
  lowEnergy?: DashboardAction;
  shortGap?: DashboardAction;
  care: Array<{ title: string; minimumMinutes: number }>;
  /** Read straight off real acceptances, no grace period: today with nothing accepted yet is a real 0. */
  progress: { streakDays: number; weekCount: number };
  todayCapacity: { availableMinutes: number; committedMinutes: number; basis?: CapacityLine & { statedWeekly: number } };
  /** Things the person is waiting for whose expected day has come: each asks 「到了吗？」. Absent on old data. */
  /** The system's open questions, most urgent first (`lib/asks.ts`); 「…到了吗？」 is one of them. */
  asks?: Ask[];
  /** What an ask's preview opens in place (`asks/previews.ts`), keyed by ask id. */
  askPreviews?: AskPreviews;
  /** What other pages flag that is not an ask, one line each (`lib/reminders.ts`). */
  reminders?: Reminder[];
  flywheel: Array<{ id: string; fromTitle: string; toTitle: string; kindLabel: string; explanation: string | null; pending: boolean }>;
  identities: Array<{ id: string; label: string; accent: string; completedCount: number; activeMilestone: string; taskCount: number; totalCount: number; pct: number }>;
  flywheelStrip: {
    nodes: Array<{ id: string; identityId: string; title: string; latestSignal: string }>;
    edges: Array<{ from: string; to: string; count: number; pending: boolean; kindLabel: string }>;
  };
  /** `time` is the scheduler's real `HH:mm–HH:mm` for today, present only when it actually placed this order. */
  upcoming: Array<{ id: string; title: string; status: string; identityId: string; time?: string; milestoneTitle?: string }>;
  milestonePulse: Array<{ id: string; identity: string; title: string; evidence: string }>;
  /** One batched read behind every preview drawer on this page, computed once in `page.tsx`. */
  taskDetailById: Map<string, TaskDetail>;
  milestoneDetailById: Map<string, MilestoneDetail>;
  /** Each task's next block on the calendar. */
  slotById?: Map<string, TaskSlot>;
  /** What the day timeline draws. Absent in tests that only care about the cards. */
  calendar?: CalendarData;
  /** What the last calendar change moved, for the line above the timeline (`readChangeSummary`). */
  scheduleChanges?: ScheduleChange[];
  /** Steps split again after two days of not getting done (`readFinerSplits`), said in the same place. */
  finerSplits?: FinerSplitNote[];
  /** The tasks behind the coming week's blocks, for the panel beside the day (a plain object: it crosses to the client). */
  calendarDetails?: Record<string, TaskDetail>;
  /** The flywheel graph: lines, live milestones and the relations between them (`lib/flywheel-graph.ts`). */
  flywheelGraph?: FlywheelGraphData;
  /** Present only when the person agreed to the detailed screen record; a reading, with its reasons, never a verdict. */
  workState?: { state: string; label: string; confidence: "low" | "medium" | "high"; reasons: string[] };
};

const basisLabel = { self_report: "自评", execution_history: "执行记录", local_activity: "本机活动" } as const;
/** 「10/24」 from an ISO day. */
const shortDay = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;

/** A translated sentence with one value set in bold: translated with a marker in the value's place (one sentence, one key), split there. */
const MARK = "\u0000";
function boldAt(text: string, value: string) {
  const [before = "", after = ""] = text.split(MARK);
  return <>{before}<b className="mono">{value}</b>{after}</>;
}
const capacityLevelLabel = { low: "低", medium: "中", high: "高" } as const;

// The label must name what the reading came from. Calling every observation a self-report was wrong
// as soon as activity days started counting towards the same total.
const capacityLabel = (capacity: DashboardData["capacity"], t: Translate) =>
  capacity.level === "uncalibrated"
    ? t("精力未标定")
    : t("精力 {{level}} · 依据 {{basis}} · {{count}} 次观测", { level: t(capacityLevelLabel[capacity.level]),
      basis: capacity.basis.map((item) => t(basisLabel[item])).join(" + "), count: capacity.observationCount });

/**
 * Today (redesigned 2026-10-28 after the owner's reference: the calendar in the middle, cards on the right). The head band carries the
 * date, the clock and the week; the main column the day / week / month calendar with its day panel and, under it, the one input box; the
 * right column the day's energy, four numbers, and one list of what needs the person. The flywheel graph is folded at the foot. On a
 * narrow screen the order is head, what needs the person, calendar, energy and numbers, input (today.css).
 */
export function DashboardView({ data }: { data: DashboardData }) {
  const t = tFor(data.locale);
  // The next step and its alternatives (2026-10-29): the calendar's next block is the next step; what is recommended without a block
  // today is listed beside it in the day panel, each with the words that say why.
  const suggestions: Suggestion[] = ([[data.primary, "下一步"], [data.higherPriority, "更高优先级"], [data.lowEnergy, "低精力备选"], [data.shortGap, "短空档备选"]] as const)
    .flatMap(([item, label]) => { const detail = item ? data.taskDetailById.get(item.id) : undefined;
      return detail ? [{ id: detail.id, title: detail.title, label, reason: item!.reason, line: detail.identityId }] : []; })
    .filter((item, index, list) => list.findIndex((other) => other.id === item.id) === index);

  const hasSeed = [data.primary, ...data.upcoming].some((item) => item && data.taskDetailById.get(item.id)?.seeded);
  const today = data.calendar?.today ?? data.nowIso.slice(0, 10);
  const week = weekLoad(data.calendar?.items ?? [], data.calendar?.deadlines ?? [], today, data.calendar?.quietByWeekday);
  const graph = data.flywheelGraph;

  // What to say when no work is put forward: which step comes next (drafts, backplanning, the interview).
  const empty = data.awaitingApproval
    ? <><b className="mono">{data.awaitingApproval}</b> {t("项提案待批准，批准后在此推荐下一步。", { count: data.awaitingApproval })} <a href="/approvals#proposals">{t("前往批准")}</a></>
    : data.milestones?.drafts
      ? <><b className="mono">{data.milestones.drafts}</b> {t("个里程碑草稿待批准；批准后系统从它们倒推任务并排进日历。", { count: data.milestones.drafts })} <a href="/milestones">{t("前往主线")}</a></>
      : data.milestones?.backplanning
        ? boldAt(t("系统正在从已批准的 {{n}} 个里程碑倒推任务（每个几分钟），出来的任务会排进日历并显示在这里。也可以先在输入框写下手头要做的事。", { n: MARK, count: data.milestones.backplanning }), String(data.milestones.backplanning))
        : data.milestones?.firstDrafts === "running"
          ? t("系统正在按访谈为每条主线设计里程碑草稿（每条主线几分钟），好了会出现在「主线」页等待批准。也可以先在输入框写下手头要做的事。")
          : data.milestones?.firstDrafts === "stalled"
            ? <>{t("里程碑草稿没有生成。到「主线」页点「让 AI 重新提议草稿」再试一次。")} <a href="/milestones">{t("前往主线")}</a></>
            : data.milestones && !data.milestones.any
              ? <>{t("访谈结束（或停下 20 分钟）后，系统按访谈为每条主线设计里程碑草稿，批准后倒推出任务。想现在就设计，在")} <a href="/onboarding">{t("访谈页")}</a> {t("点「设计里程碑草稿」。")}</>
              : t("暂无可执行任务。收集一项工作后，系统完成拆解与排程。");
  const notes = data.urgentProposal && <p className="today-proposal-note nd-note" role="note">{boldAt(t("「{{title}}」{{due}} 截止，还在等本人批准；批准后才会排进日历。", { title: data.urgentProposal.title, due: MARK }), shortDay(data.urgentProposal.due))} <a href="/approvals#proposals">{t("去批准")}</a></p>;

  return <>
    <OfflineReplay workspaceId={data.workspaceId} />
    <AppShell active={"今日"} className="page today-page">
      <DayHead nowIso={data.nowIso} timeZone={data.timeZone} fixed={data.clockPinned} dateLabel={data.dateLabel} monthLabel={data.monthLabel}
        today={today} week={week} />

      <div className="td-grid">
        <div className="td-main">
          {data.calendar && <section className="td-card td-cal today-timeline" id="today-timeline" aria-label={t("今天的时间轴")}>
            <header className="td-card-head"><h2 className="ds-serif">{t("日历")}</h2><a href="/plan">{t("打开计划 →")}</a></header>
            <ScheduleSummary changes={data.scheduleChanges ?? []} splits={data.finerSplits ?? []} />
            <CalendarPanel items={data.calendar.items} deadlines={data.calendar.deadlines} today={data.calendar.today} nowIso={data.calendar.nowIso}
              timeZone={data.calendar.timeZone} labels={data.calendar.labels} quietByWeekday={data.calendar.quietByWeekday} proposals={data.calendar.proposals}
              taskDetails={data.calendarDetails} suggestions={suggestions} emptyNote={empty} />
            {/* Only on the example ledger: one line, out of the way (scenarios.md §4.12). */}
            {hasSeed && <p role="note" className="seed-notice td-seed">{t("下面有系统预置的示例作业（用来演示流程），不需要的可以直接丢弃。")}</p>}
          </section>}
          <section className="td-card td-input capture-line" aria-labelledby="capture-title">
            <header className="td-card-head"><h2 id="capture-title" className="ds-serif">{t("输入")}</h2><small>{t("收集、修改、回答、提问，先确认再生效")}</small></header>
            <Conversation variant="inline" />
          </section>
        </div>

        <div className="td-side">
          <EnergyCard estimate={data.energyEstimate} fallback={capacityLabel(data.capacity, t)}>
            {data.workState && <p className="energy-basis" data-testid="work-state" title={data.workState.reasons.join(" ")}>{t("此刻状态：{{label}}", { label: data.workState.label })}
              <small> · {t({ low: "把握低", medium: "把握中", high: "把握高" }[data.workState.confidence])}</small></p>}
            {/* 「需要至少 14 天本机活动观测…」 is a note about the system's own calibration, not something to act on today. */}
            {data.capacity.blockers.filter((blocker) => blocker.code !== "BASELINE_INSUFFICIENT")
              .map((blocker) => <p key={blocker.code} className="capacity-blocker">{blocker.message}</p>)}
            {data.capacity.level === "low" && <div className="rest-prompt">
              <p>{t("当前精力低：建议留 10 分钟休息。休息后重新自评，系统会重排今天的建议；高负荷任务暂不视为已准备好。")}</p>
              <EnergyProbe context="after_rest" />
            </div>}
            {data.care.length > 0 && <dl className="care-band" aria-label={t("健康容量策略")}>{data.care.map((item) =>
              <div key={item.title}><dt>{item.title}</dt><dd>{t("最低 {{minutes}} 分钟", { minutes: item.minimumMinutes })}</dd></div>)}</dl>}
          </EnergyCard>
          <OverviewCard availableMinutes={data.todayCapacity.availableMinutes} committedMinutes={data.todayCapacity.committedMinutes} weekCount={data.progress.weekCount} {...(data.todayCapacity.basis ? { basis: data.todayCapacity.basis } : {})} />
          <NeedsCard asks={data.asks ?? []} reminders={data.reminders ?? []} labels={data.calendar?.labels ?? {}} today={today} notes={notes} />
        </div>
      </div>

      {/* An advanced fold (copy-audit): the graph is there for whoever opens it. */}
      {graph && <details className="td-card td-fold advanced">
        <summary><h2 id="flywheel-title" className="ds-serif">{t("飞轮图谱")}</h2><small>{t("{{lines}} 条主线 · {{approved}} 条已批准关系 · {{candidates}} 条候选", {
          lines: graph.lines.length, approved: graph.relations.filter((relation) => relation.status === "approved").length,
          candidates: graph.relations.filter((relation) => relation.status === "candidate").length })}</small></summary>
        <section aria-label={t("飞轮图谱")}>
          <p className="td-fold-link"><a href="/milestones">{t("打开主线 →")}</a></p>
          <FlywheelGraph data={graph} />
        </section>
      </details>}
    </AppShell>
  </>;
}
