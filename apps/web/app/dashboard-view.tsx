import type { CSSProperties } from "react";
import { OfflineCaptureForm, OfflineReplay } from "./offline-command-forms";
import { AskList } from "./ask-list";
import type { Ask } from "@crossline/core";
import { BatchCaptureForm } from "./batch-capture-form";
import { AnalogClock } from "./analog-clock";
import { EnergyProbe } from "./energy-probe";
import { LocalActivityConsent } from "./local-activity-consent";
import { TaskPreview } from "./task-preview";
import type { TaskDetail, MilestoneDetail } from "../lib/task-detail";
import { AppShell } from "./app-shell";
import { ExecutionActions } from "./execution-actions";
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
  localActivityAsked: boolean;
  /** True when minutes-only collection was agreed to but the detailed level never asked about. */
  activityDetailUpgrade?: boolean;
  lastNight:
    | { state: "none" }
    | { state: "ran"; proposals: number }
    | { state: "skipped"; reason: string };
  milestonePulse: Array<{ id: string; identity: string; title: string; evidence: string }>;
  /** One batched read behind every preview drawer on this page, computed once in `page.tsx`. */
  taskDetailById: Map<string, TaskDetail>;
  milestoneDetailById: Map<string, MilestoneDetail>;
  /** What the day timeline draws. Absent in tests that only care about the cards. */
  calendar?: CalendarData;
  /** Present only when the person agreed to the detailed screen record; a reading, with its reasons, never a verdict. */
  workState?: { state: string; label: string; confidence: "low" | "medium" | "high"; reasons: string[] };
};

// Never a bare number: an estimate without its provenance is indistinguishable from a measurement.
const estimateSourceLabel: Record<string, string> = {
  llm_prior: "先验", identity_prior: "先验", legacy_task: "遗留任务", personal_history: "个人历史", manual: "人工填写"
};
const estimateConfidenceLabel = { low: "低", medium: "中", high: "高" } as const;
const estimateLabel = (estimate: DashboardAction["estimate"]) =>
  estimate.observationCount === 0
    ? `${estimate.p25Minutes}–${estimate.p85Minutes}m · 先验（0 次观测）`
    : `${estimate.p25Minutes}–${estimate.p85Minutes}m · ${estimateSourceLabel[estimate.source] ?? estimate.source}`
      + ` · ${estimate.observationCount} 次观测 · 置信${estimateConfidenceLabel[estimate.confidence]}`;

const basisLabel = { self_report: "自评", execution_history: "执行记录", local_activity: "本机活动" } as const;
const capacityLevelLabel = { low: "低", medium: "中", high: "高" } as const;
const energyLabel: Record<string, string> = { low: "低", medium: "中", high: "高" };

// The label must name what the reading came from. Calling every observation a self-report was wrong
// as soon as activity days started counting towards the same total.
const capacityLabel = (capacity: DashboardData["capacity"]) =>
  capacity.level === "uncalibrated"
    ? "精力未标定"
    : `精力 ${capacityLevelLabel[capacity.level]} · 依据 ${capacity.basis.map((item) => basisLabel[item]).join(" + ")} · ${capacity.observationCount} 次观测`;

export function DashboardView({ data }: { data: DashboardData }) {
  const identityLabel = (id: string) => data.identities.find((item) => item.id === id)?.label ?? (id === "capacity" ? "容量策略" : id);
  // The whole card is a real `<a>` to its detail page, and a small corner button opens the same detail as a
  // quick peek without leaving Today: two separate triggers instead of one click trying to be both.
  const inlineActions = (item: DashboardAction) => {
    const detail = data.taskDetailById.get(item.id);
    return detail
      ? <ExecutionActions workOrderId={detail.id} intent={detail.intent} state={detail.state} paused={detail.paused}
          ownerId={detail.ownerId} workspaceId={detail.workspaceId} evidenceChecklist={detail.evidenceChecklist} estimateP50={detail.estimate.p50Minutes} {...(detail.suggestedMinutes ? { suggestedMinutes: detail.suggestedMinutes } : {})}
          showEnergyProbe={false} />
      : <a className="primary-button" href={`/workbench/${encodeURIComponent(item.id)}`}>前往任务详情执行并提交证据</a>;
  };

  const load = data.todayCapacity.availableMinutes > 0
    ? Math.min(100, Math.round(data.todayCapacity.committedMinutes / data.todayCapacity.availableMinutes * 100))
    : data.todayCapacity.committedMinutes > 0 ? 100 : 0;

  const alt = (item: DashboardAction | undefined, label: string) => <article className="panel alt-action" data-line={item?.identityId}>
    <header><h3>{label}</h3>{item && <span className="tag">{identityLabel(item.identityId)}</span>}</header>
    {item ? <>
      <a className="card-cover-link" href={`/workbench/${encodeURIComponent(item.id)}`} aria-label={item.title} />
      <TaskPreview detail={data.taskDetailById.get(item.id)} />
      <h4>{item.title}</h4>
      <p className="card-milestone">→ {item.milestone}</p>
      <small>{estimateLabel(item.estimate)}</small>
      {inlineActions(item)}</> : <p className="muted">暂无可执行项</p>}
  </article>;

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
          <div><dt>本周完成</dt><dd>{data.progress.weekCount} 件 · 连续 {data.progress.streakDays} 天</dd></div>
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

      <AskList initial={data.asks ?? []} visible={3} moreHref="/approvals#asks" />

      <section className="panel capture-line" aria-labelledby="capture-title">
        <header><h2 id="capture-title">快速收集</h2><small>写下来就行，系统会自己分类、估时</small></header>
        <OfflineCaptureForm ownerId={data.principalId} workspaceId={data.workspaceId} />
        <BatchCaptureForm ownerId={data.principalId} workspaceId={data.workspaceId} />
      </section>

      <section className="today-grid" aria-label="下一步">
        <article className="hero-action panel" data-line={data.primary?.identityId}>
          <header><h2>下一步</h2>{data.primary && <span className="tag">{identityLabel(data.primary.identityId)}</span>}
            <small>输入{data.primary?.inputsReady ? "就绪" : "待检查"}</small></header>
          {data.primary ? <>
            <TaskPreview detail={data.taskDetailById.get(data.primary.id)} />
            <h3 className="hero-title">{data.primary.title}</h3>
            <p>{data.primary.reason}</p>
            <p className="hero-meta">
              <span>窗口 {estimateLabel(data.primary.estimate)}</span>
              <span>所需精力 {energyLabel[data.primary.energy ?? ""] ?? "未声明"}</span>
              <span>里程碑 {data.primary.milestone}</span>
              <a className="hero-detail-link" href={`/workbench/${encodeURIComponent(data.primary.id)}`}>完整详情 →</a>
            </p>
            {inlineActions(data.primary)}
          </> : data.awaitingApproval
            ? <p>有 {data.awaitingApproval} 个方案在等你批准，批准后这里会推荐下一步。<a href="/approvals#proposals">去批准 →</a></p>
            : <p>先收集一项真实工作，系统会拆解并等待计划批准。</p>}
        </article>
        <div className="grid-auto alt-grid">
          {data.higherPriority && alt(data.higherPriority, "更高优先级")}
          {alt(data.lowEnergy, "低精力备选")}
          {alt(data.shortGap, "短空档备选")}
        </div>
      </section>

      {data.calendar && <section className="panel" aria-label="今天的时间轴">
        <header><h2>今天的时间轴</h2><a href="/plan">打开计划 →</a></header>
        <CalendarPanel items={data.calendar.items} deadlines={data.calendar.deadlines} today={data.calendar.today} nowIso={data.calendar.nowIso}
          timeZone={data.calendar.timeZone} labels={data.calendar.labels} quietByWeekday={data.calendar.quietByWeekday} />
      </section>}

      <section className="lines-strip" aria-label="各主线现在在哪">
        {data.identities.map((line) => <a key={line.id} className="panel line-card" data-line={line.id} href="/milestones">
          <header><h3>{line.label}</h3><small>{line.taskCount} 项进行中</small></header>
          <p>{line.activeMilestone}</p>
          <span className="flow-progress" aria-hidden="true"><i style={{ width: `${line.pct}%` }} /></span>
        </a>)}
      </section>

      <section className="care-band" aria-label="健康容量策略">
        {data.care.length > 0 && <dl>{data.care.map((item) => <div key={item.title}><dt>{item.title}</dt><dd>最低 {item.minimumMinutes} 分钟</dd></div>)}</dl>}
        {/* Asked once here; the later upgrade offer and the nightly run's status live in 设置, not on the page you plan your day on. */}
        <LocalActivityConsent asked={data.localActivityAsked} upgrade={false} />
      </section>
    </AppShell>
  </>;
}
