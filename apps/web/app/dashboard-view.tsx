import type { CSSProperties } from "react";
import type { AccessContext } from "@crossline/core";
import { ArrowUpRight, CircleDot, Clock3 } from "lucide-react";
import { OfflineCaptureForm, OfflineReplay } from "./offline-command-forms";
import { BatchCaptureForm } from "./batch-capture-form";
import { AnalogClock } from "./analog-clock";
import { EnergyProbe } from "./energy-probe";
import { LocalActivityConsent } from "./local-activity-consent";
import { FlywheelStrip } from "./identity-flywheel";
import { TaskPreview, MilestonePreview } from "./task-preview";
import { SignOutButton } from "./sign-out-button";
import { NAV_ITEMS } from "./nav-items";
import { BottomNav } from "./bottom-nav";

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
  flywheel: Array<{ id: string; fromTitle: string; toTitle: string; kindLabel: string; explanation: string | null; pending: boolean }>;
  identities: Array<{ id: string; label: string; accent: string; completedCount: number; activeMilestone: string; taskCount: number; totalCount: number; pct: number }>;
  /** Milestone-centric nodes + edges behind the homepage's flywheel strip — every milestone touched by a
   * real, LLM-judged relation (approved or still-candidate), ordered by recency, connected by the actual
   * relations between them. Not limited to today's active work. */
  flywheelStrip: {
    nodes: Array<{ id: string; identityId: string; title: string; latestSignal: string }>;
    edges: Array<{ from: string; to: string; count: number; pending: boolean; kindLabel: string }>;
  };
  /** `time` is the scheduler's real `HH:mm–HH:mm` for today, present only when it actually placed this
   * order; absent means genuinely not yet scheduled, which `status` then says in words rather than
   * leaving a blank clock reading that looks like a bug. */
  upcoming: Array<{ id: string; title: string; status: string; identityId: string; time?: string; milestoneTitle?: string }>;
  localActivityAsked: boolean;
  lastNight:
    | { state: "none" }
    | { state: "ran"; proposals: number }
    | { state: "skipped"; reason: string };
  milestonePulse: Array<{ id: string; identity: string; title: string; evidence: string }>;
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

export function DashboardView({ ctx, data }: { ctx: AccessContext; data: DashboardData }) {
  const identityLabel = (id: string) => data.identities.find((item) => item.id === id)?.label ?? (id === "capacity" ? "容量策略" : id);
  // The whole card is a real `<a>` to its detail page — bookmarkable, works with no JS — and a small
  // corner button opens the same detail as a quick-peek drawer without leaving Today. Two separate
  // triggers instead of one click trying to decide between "navigate" and "preview".
  const action = (item: DashboardAction | undefined, label: string) => <article className="alt-action">
    <header><span>{label}</span><ArrowUpRight size={13} aria-hidden="true" /></header>
    {item ? <><a className="card-cover-link" href={`/workbench/${encodeURIComponent(item.id)}`} aria-label={item.title} />
      <TaskPreview ctx={ctx} workOrderId={item.id} />
      <h3>{item.title}</h3>
      {/* The milestone this card feeds sits on the card itself — a separate MILESTONE PULSE list further
          down used to be the only place that answered "what is this for", which meant leaving the card
          to find out. */}
      <p className="card-milestone">→ {item.milestone}</p>
      <p>{item.reason}</p><small>{identityLabel(item.identityId)} · {estimateLabel(item.estimate)}</small></> : <p>暂无可执行项</p>}
  </article>;

  return <main className="page"><OfflineReplay workspaceId={data.workspaceId} />
    <header className="running-head">
      <a className="wordmark" href="/">CROSSLINE<sup>01</sup></a>
      <nav aria-label="主导航">{NAV_ITEMS.map((item) => <a className={item.label === "Today" ? "active" : ""} href={item.href} key={item.label}>{item.label}</a>)}</nav>
      <div className="system-state"><CircleDot size={11} aria-hidden="true" /><span>LOCAL</span><SignOutButton /></div>
    </header>
    <BottomNav active="Today" />

    <section className="day-head">
      <AnalogClock nowIso={data.nowIso} timeZone={data.timeZone} fixed={data.clockPinned} />
      <div><span className="mono-label">TODAY / {data.monthLabel}</span><div className="day-number">{data.dateLabel}</div></div>
      <div className="now-state"><Clock3 size={14} aria-hidden="true" /><span>{data.nowLabel}</span><strong>{capacityLabel(data.capacity)}</strong>
        {data.capacity.blockers.map((blocker) => <em key={blocker.code} className="capacity-blocker">{blocker.message}</em>)}
        {data.energyLearning && <em className="capacity-blocker">{data.energyLearning.status === "personal_calibrated"
          ? `个人已校准 · ${data.energyLearning.count} 次前瞻记录`
          : `精力转移采用可解释规则 · ${data.energyLearning.count} 次前瞻记录，尚未证明优于静态基线`}</em>}
      </div>
    </section>

    {/* Task list first: the day-head is orientation, this is the thing the person came here to do —
        it used to sit after two care-bands and a capture form, four sections of reading before it. */}
    <section className="today-grid">
      <article className="hero-action">
        <header><span>01 / NEXT ACTION · 下一行动</span><span>INPUTS {data.primary?.inputsReady ? "READY" : "CHECK"}</span></header>
        {data.primary ? <>
          <TaskPreview ctx={ctx} workOrderId={data.primary.id} />
          <div className={`identity-glyph ${data.primary.identityId}`} aria-hidden="true" />
          <h1>{data.primary.title}</h1>
          <p>{data.primary.reason}</p>
          <dl>
            <div><dt>WINDOW</dt><dd>{estimateLabel(data.primary.estimate)}</dd></div>
            {/* This is the energy the work itself asks for, not the reading in the header — two different
                things both labelled ENERGY read as the app contradicting itself. */}
            <div><dt>NEEDS · 所需精力</dt><dd>{energyLabel[data.primary.energy ?? ""] ?? "未声明"}</dd></div>
            <div><dt>MILESTONE</dt><dd>{data.primary.milestone}</dd></div>
          </dl>
          {/* The real task detail page now embeds the same start/pause/complete controls Workbench's own
              card has, so this goes straight there instead of an anchor-jump into the Workbench list. */}
          <a className="primary-button" href={`/workbench/${encodeURIComponent(data.primary.id)}`}>前往任务详情执行并提交证据</a>
        </> : <p>先收集一项真实工作，系统会拆解并等待计划批准。</p>}
      </article>

      <aside className="action-margin">
        {data.higherPriority && action(data.higherPriority, "HIGHER PRIORITY · 更高优先级")}
        {action(data.lowEnergy, "LOW ENERGY · 低精力备选")}
        {action(data.shortGap, "SHORT GAP · 短空档备选")}
      </aside>
    </section>

    {/* Today's own weekly-pattern capacity read against what is already on the books — not the
        calendar-adjusted multi-week forecast Plan owns, just a same-day gut check next to the task
        that just asked for a window. */}
    <section className="care-band" aria-label="今天的执行时间安排">
      <strong>TODAY LOAD</strong>
      <dl>
        <div><dt>今天可用（周模式）</dt><dd>{data.todayCapacity.availableMinutes} 分钟</dd></div>
        <div><dt>待办合计（p50 先验）</dt><dd>{data.todayCapacity.committedMinutes} 分钟</dd></div>
        <div>
          <dt>占用比例</dt>
          <dd><div className="time-bar"><div className="time-bar-fill" style={{
            "--pct": `${data.todayCapacity.availableMinutes > 0
              ? Math.min(100, Math.round(data.todayCapacity.committedMinutes / data.todayCapacity.availableMinutes * 100))
              : data.todayCapacity.committedMinutes > 0 ? 100 : 0}%`
          } as CSSProperties} /></div></dd>
        </div>
      </dl>
    </section>

    {/* What the star map only ever shows as an edge and a one-word kind label — the plain-English
        "doing A moves B forward" for whatever milestones today's actionable work already sits under. */}
    {data.flywheel.length > 0 && <section className="milestone-pulse" aria-label="跨主线关系">
      <header><span>FLYWHEEL · 跨主线支持</span><a href="/milestones">OPEN MAP →</a></header>
      {data.flywheel.map((item) => <article key={item.id}>
        <span>{item.kindLabel}</span>
        <strong>{item.fromTitle} → {item.toTitle}</strong>
        <small>{item.explanation ?? "尚未写明关系依据"}{item.pending ? " · 待周复盘确认" : ""}</small>
      </article>)}
    </section>}

    <section className="care-band" aria-label="健康容量策略">
      <strong>CARE / CAPACITY</strong>
      <dl>{data.care.length ? data.care.map((item) => <div key={item.title}><dt>{item.title}</dt><dd>最低 {item.minimumMinutes} 分钟</dd></div>)
        : <div><dt>容量承诺</dt><dd>未设置 · 在 Workbench 记录后显示</dd></div>}
        <div><dt>ENERGY CHECK</dt><dd><EnergyProbe /></dd></div></dl>
      <LocalActivityConsent asked={data.localActivityAsked} />
      {data.capacity.level === "low" && <div className="rest-prompt">
        <p>当前精力低：建议留 10 分钟休息。休息后重新自评，系统会重排今天的建议；高负荷任务暂不视为已准备好。</p>
        <EnergyProbe context="after_rest" />
      </div>}
      {data.lastNight.state !== "none" && <p className="last-night">
        {data.lastNight.state === "ran"
          ? `昨夜扩展 · 产出 ${data.lastNight.proposals} 条候选`
          : `昨夜未运行 · ${data.lastNight.reason}`}
      </p>}
    </section>

    {/* Two weeks of real work used to leave zero trace on this page — the count lived only on Review.
        Plain counts, no streak-protection nudge: a day with nothing accepted reads as a real 0. */}
    <section className="care-band" aria-label="完成节奏">
      <strong>PROGRESS</strong>
      <dl>
        <div><dt>本周完成</dt><dd>{data.progress.weekCount} 件</dd></div>
        <div><dt>连续天数</dt><dd>{data.progress.streakDays} 天</dd></div>
      </dl>
    </section>

    {/* A horizontally-scrolling strip of milestones touched by a real, LLM-judged relation — not
        per-identity percentages, per the redesign: nodes are milestones, ordered by recency so newly
        active ones sit at the right edge, connected by desaturated flow arrows instead of the earlier
        saturated-fill diagram. Grounded in the same `milestone_relations` the star map already reads. */}
    <section className="identity-pulse" aria-label="跨主线飞轮长条">
      <header><span>04 / FLYWHEEL STRIP · 跨主线流向</span><a href="/milestones">OPEN MAP →</a></header>
      <FlywheelStrip identities={data.identities} nodes={data.flywheelStrip.nodes} edges={data.flywheelStrip.edges} />
    </section>

    <section className="capture-line" aria-labelledby="capture-title">
      <div><span className="mono-label">INBOX / 00</span><h2 id="capture-title">快速收集</h2></div>
      <OfflineCaptureForm ownerId={data.principalId} workspaceId={data.workspaceId} />
      <BatchCaptureForm ownerId={data.principalId} workspaceId={data.workspaceId} />
    </section>

    <section className="lower-grid">
      <div className="timeline-list">
        <header><span>02 / TODAY'S LINE</span><a href="/plan">OPEN PLAN →</a></header>
        {/* Only a real work order has a detail page to link to — an unclassified capture (identityId
            "unclassified") has no milestone, materials or execution yet, so it stays plain text here
            rather than linking to a detail page that would just say "not found". */}
        {data.upcoming.map((item) => <article key={item.id}>
          {item.identityId !== "unclassified" && <>
            <a className="card-cover-link" href={`/workbench/${encodeURIComponent(item.id)}`} aria-label={item.title} />
            <TaskPreview ctx={ctx} workOrderId={item.id} />
          </>}
          <time className={item.time ? "time-precise" : "time-vague"}>{item.time ?? "—"}</time>
          <span className={`line-symbol ${item.identityId}`} />
          <div>
            <strong>{item.title}</strong>
            {item.milestoneTitle && <span className="card-milestone">→ {item.milestoneTitle}</span>}
            <small>{identityLabel(item.identityId)} · {item.status}</small>
          </div>
        </article>)}
      </div>
      <div className="milestone-pulse">
        <header><span>03 / MILESTONE PULSE</span><a href="/milestones">OPEN MAP →</a></header>
        {/* Real `milestonePulse` rows carry a real milestone id; the identity-based fallback (shown only
            when nothing has any pulse yet) has nothing to link to — `activeMilestone` there is a title
            string, not an id — so it stays plain text. */}
        {(data.milestonePulse.length
          ? data.milestonePulse.map((item) => ({ ...item, linkable: true }))
          : data.identities.slice(0, 4).map((item) => ({ id: item.id, identity: item.label, title: item.activeMilestone, evidence: `${item.taskCount} active`, linkable: false }))
        ).map((item) => <article key={item.id}>
          {item.linkable && <>
            <a className="card-cover-link" href={`/milestones/${encodeURIComponent(item.id)}`} aria-label={item.title} />
            <MilestonePreview ctx={ctx} milestoneId={item.id} />
          </>}
          <span>{item.identity}</span><strong>{item.title}</strong><small>{item.evidence}</small>
        </article>)}
      </div>
    </section>
  </main>;
}
