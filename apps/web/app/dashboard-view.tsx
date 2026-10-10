import type { CSSProperties } from "react";
import { OfflineReplay } from "./offline-command-forms";
import { Conversation } from "./chat/conversation";
import { AskStack } from "./ask-list";
import type { Ask } from "@crossline/core";
import { AnalogClock } from "./analog-clock";
import { EnergyProbe } from "./energy-probe";
import type { TaskDetail, MilestoneDetail } from "../lib/task-detail";
import { AppShell } from "./app-shell";
import { TaskCard, type TaskSlot } from "./task/task-card";
import { CalendarPanel } from "./timeline/calendar-panel";
import type { CalendarData } from "./plan/plan-view";

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
  capacity: {
    level: "low" | "medium" | "high" | "uncalibrated";
    confidence?: "low" | "medium" | "high";
    observationCount: number;
    basis: Array<"self_report" | "execution_history" | "local_activity">;
    blockers: Array<{ code: string; message: string }>;
  };
  energyLearning?: { status: "rule_only" | "personal_unvalidated" | "personal_calibrated";
    count: number; predictedCorrect: number; baselineCorrect: number };
  primary?: DashboardAction;
  higherPriority?: DashboardAction;
  lowEnergy?: DashboardAction;
  shortGap?: DashboardAction;
  care: Array<{ title: string; minimumMinutes: number }>;
  /** Read straight off real acceptances, no grace period: today with nothing accepted yet is a real 0. */
  progress: { streakDays: number; weekCount: number };
  todayCapacity: { availableMinutes: number; committedMinutes: number };
  /** Things the person is waiting for whose expected day has come: each asks 「到了吗？」. Absent on old data. */
  /** The system's open questions, most urgent first (`lib/asks.ts`); 「…到了吗？」 is one of them. */
  asks?: Ask[];
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
  /** Present only when the person agreed to the detailed screen record; a reading, with its reasons, never a verdict. */
  workState?: { state: string; label: string; confidence: "low" | "medium" | "high"; reasons: string[] };
};

const basisLabel = { self_report: "自评", execution_history: "执行记录", local_activity: "本机活动" } as const;
const capacityLevelLabel = { low: "低", medium: "中", high: "高" } as const;

// The label must name what the reading came from. Calling every observation a self-report was wrong
// as soon as activity days started counting towards the same total.
const capacityLabel = (capacity: DashboardData["capacity"]) =>
  capacity.level === "uncalibrated"
    ? "精力未标定"
    : `精力 ${capacityLevelLabel[capacity.level]} · 依据 ${capacity.basis.map((item) => basisLabel[item]).join(" + ")} · ${capacity.observationCount} 次观测`;

export function DashboardView({ data }: { data: DashboardData }) {
  const primaryDetail = data.primary ? data.taskDetailById.get(data.primary.id) : undefined;
  const alternatives = ([[data.higherPriority, "更高优先级"], [data.lowEnergy, "低精力备选"], [data.shortGap, "短空档备选"]] as const)
    .flatMap(([item, label]) => { const detail = item && item.id !== data.primary?.id ? data.taskDetailById.get(item.id) : undefined; return detail ? [[label, detail] as const] : []; })
    .filter(([, detail], index, list) => list.findIndex(([, other]) => other.id === detail.id) === index);

  const load = data.todayCapacity.availableMinutes > 0
    ? Math.min(100, Math.round(data.todayCapacity.committedMinutes / data.todayCapacity.availableMinutes * 100))
    : data.todayCapacity.committedMinutes > 0 ? 100 : 0;

  const hasSeed = [data.primary, ...data.upcoming].some((item) => item && data.taskDetailById.get(item.id)?.seeded);

  return <>
    <OfflineReplay workspaceId={data.workspaceId} />
    <AppShell active="今日">
      <section className="day-head" aria-label="今天">
        <AnalogClock nowIso={data.nowIso} timeZone={data.timeZone} fixed={data.clockPinned} />
        <div className="day-title"><h1>{data.dateLabel} 日 <small>{data.monthLabel}</small></h1><span>{data.nowLabel}</span></div>
        <dl className="day-stats">
          <div><dt>精力</dt><dd>{capacityLabel(data.capacity)}</dd></div>
          <div><dt>今天可用 / 待办</dt><dd>{data.todayCapacity.availableMinutes} / {data.todayCapacity.committedMinutes} 分钟
            <span className="time-bar" aria-hidden="true"><span className="time-bar-fill" style={{ "--pct": `${load}%` } as CSSProperties} /></span></dd></div>
          {data.workState && <div data-testid="work-state"><dt>此刻状态</dt><dd title={data.workState.reasons.join(" ")}>{data.workState.label}
            <small> · {{ low: "把握低", medium: "把握中", high: "把握高" }[data.workState.confidence]}</small></dd></div>}
          <div><dt>本周完成</dt><dd>{data.progress.weekCount} 件</dd></div>
        </dl>
        <div className="day-energy"><span>精力自评</span><EnergyProbe /></div>
      </section>
      {/* 「需要至少 14 天本机活动观测…」 is a note about the system's own calibration, not something to act on today. */}
      {data.capacity.blockers.filter((blocker) => blocker.code !== "BASELINE_INSUFFICIENT")
        .map((blocker) => <p key={blocker.code} className="capacity-blocker">{blocker.message}</p>)}
      {hasSeed && <p role="note" className="seed-notice">下面有系统预置的示例作业（用来演示流程），不需要的可以直接丢弃。</p>}
      {data.capacity.level === "low" && <div className="rest-prompt">
        <p>当前精力低：建议留 10 分钟休息。休息后重新自评，系统会重排今天的建议；高负荷任务暂不视为已准备好。</p>
        <EnergyProbe context="after_rest" />
      </div>}

      <AskStack initial={data.asks ?? []} moreHref="/approvals#asks" />

      <section className="panel capture-line" aria-labelledby="capture-title">
        <header><h2 id="capture-title">输入</h2><small>收集、修改、回答、提问，先确认再生效</small></header>
        <Conversation variant="inline" />
      </section>

      <section className={`today-grid${alternatives.length ? "" : " today-grid-single"}`} aria-label="下一步">
        <div className="today-next">
          <h2 className="section-label">下一步</h2>
          {primaryDetail ? <TaskCard variant="hero" detail={primaryDetail} reason={data.primary!.reason} slot={data.slotById?.get(primaryDetail.id)} />
            : <p className="panel today-empty">{data.awaitingApproval
              ? <><b className="mono">{data.awaitingApproval}</b> 项提案待批准，批准后在此推荐下一步。 <a href="/approvals#proposals">前往批准</a></>
              : "暂无可执行任务。收集一项工作后，系统完成拆解与排程。"}</p>}
        </div>
        {alternatives.length > 0 && <div className="today-alts">{alternatives.map(([label, detail]) => <div key={detail.id}>
          <h3 className="section-label">{label}</h3>
          <TaskCard detail={detail} slot={data.slotById?.get(detail.id)} />
        </div>)}</div>}
      </section>

      {data.calendar && <section className="panel" aria-label="今天的时间轴">
        <header><h2>今天的时间轴</h2><a href="/plan">打开计划 →</a></header>
        <CalendarPanel items={data.calendar.items} deadlines={data.calendar.deadlines} today={data.calendar.today} nowIso={data.calendar.nowIso}
          timeZone={data.calendar.timeZone} labels={data.calendar.labels} quietByWeekday={data.calendar.quietByWeekday} proposals={data.calendar.proposals} />
      </section>}

      <section className="lines-strip" aria-label="各主线现在在哪">
        {data.identities.map((line) => <a key={line.id} className="panel line-card" data-line={line.id} href="/milestones">
          <header><h3>{line.label}</h3><small>{line.taskCount} 项进行中</small></header>
          <p>{line.activeMilestone}</p>
          <span className="flow-progress" aria-hidden="true"><i style={{ width: `${line.pct}%` }} /></span>
        </a>)}
      </section>

      {data.care.length > 0 && <section className="care-band" aria-label="健康容量策略">
        <dl>{data.care.map((item) => <div key={item.title}><dt>{item.title}</dt><dd>最低 {item.minimumMinutes} 分钟</dd></div>)}</dl>
      </section>}
    </AppShell>
  </>;
}
