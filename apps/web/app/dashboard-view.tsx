import { ArrowUpRight, CircleDot, Clock3 } from "lucide-react";
import { OfflineCaptureForm, OfflineReplay } from "./offline-command-forms";
import { AnalogClock } from "./analog-clock";
import { EnergyProbe } from "./energy-probe";
import { LocalActivityConsent } from "./local-activity-consent";
import { SignOutButton } from "./sign-out-button";

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
  identities: Array<{ id: string; label: string; accent: string; completedCount: number; activeMilestone: string; taskCount: number }>;
  upcoming: Array<{ id: string; title: string; startsAt: string; identityId: string }>;
  localActivityAsked: boolean;
  lastNight:
    | { state: "none" }
    | { state: "ran"; proposals: number }
    | { state: "skipped"; reason: string };
  milestonePulse: Array<{ id: string; identity: string; title: string; evidence: string }>;
};

// Never a bare number: an estimate without its provenance is indistinguishable from a measurement.
const estimateSourceLabel: Record<string, string> = {
  llm_prior: "先验", identity_prior: "先验", legacy_task: "遗留任务", personal_history: "个人历史"
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

const nav = [
  ["Today", "/"], ["Plan", "/plan"], ["Milestones", "/milestones"], ["Workbench", "/workbench"],
  ["Approvals", "/approvals"], ["Review", "/review"], ["Connections", "/connectors"]
] as const;

export function DashboardView({ data }: { data: DashboardData }) {
  const identityLabel = (id: string) => data.identities.find((item) => item.id === id)?.label ?? (id === "capacity" ? "容量策略" : id);
  const action = (item: DashboardAction | undefined, label: string) => <article className="alt-action">
    <header><span>{label}</span><ArrowUpRight size={13} aria-hidden="true" /></header>
    {item ? <><h3>{item.title}</h3><p>{item.reason}</p><small>{identityLabel(item.identityId)} · {estimateLabel(item.estimate)}</small></> : <p>暂无可执行项</p>}
  </article>;

  return <main className="page"><OfflineReplay workspaceId={data.workspaceId} />
    <header className="running-head">
      <a className="wordmark" href="/">CROSSLINE<sup>01</sup></a>
      <nav aria-label="主导航">{nav.map(([label, href]) => <a className={label === "Today" ? "active" : ""} href={href} key={label}>{label}</a>)}</nav>
      <div className="system-state"><CircleDot size={11} aria-hidden="true" /><span>LOCAL</span><SignOutButton /></div>
    </header>

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

    <section className="capture-line" aria-labelledby="capture-title">
      <div><span className="mono-label">INBOX / 00</span><h2 id="capture-title">快速收集</h2></div>
      <OfflineCaptureForm ownerId={data.principalId} workspaceId={data.workspaceId} />
    </section>

    <section className="today-grid">
      <article className="hero-action">
        <header><span>01 / NEXT ACTION · 下一行动</span><span>INPUTS {data.primary?.inputsReady ? "READY" : "CHECK"}</span></header>
        {data.primary ? <>
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
          <a className="primary-button" href={`/workbench#work-order-${data.primary.id}`}>前往作业台执行并提交证据</a>
        </> : <p>先收集一项真实工作，系统会拆解并等待计划批准。</p>}
      </article>

      <aside className="action-margin">
        {data.higherPriority && action(data.higherPriority, "HIGHER PRIORITY · 更高优先级")}
        {action(data.lowEnergy, "LOW ENERGY · 低精力备选")}
        {action(data.shortGap, "SHORT GAP · 短空档备选")}
      </aside>
    </section>

    <section className="lower-grid">
      <div className="timeline-list">
        <header><span>02 / TODAY'S LINE</span><a href="/plan">OPEN PLAN →</a></header>
        {data.upcoming.map((item) => <article key={item.id}><time>{item.startsAt}</time><span className={`line-symbol ${item.identityId}`} /><div><strong>{item.title}</strong><small>{identityLabel(item.identityId)}</small></div></article>)}
      </div>
      <div className="milestone-pulse">
        <header><span>03 / MILESTONE PULSE</span><a href="/milestones">OPEN MAP →</a></header>
        {(data.milestonePulse.length ? data.milestonePulse : data.identities.slice(0, 4).map((item) => ({ id: item.id, identity: item.label, title: item.activeMilestone, evidence: `${item.taskCount} active` }))).map((item) => <article key={item.id}><span>{item.identity}</span><strong>{item.title}</strong><small>{item.evidence}</small></article>)}
      </div>
    </section>
  </main>;
}
