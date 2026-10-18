"use client";

import { useEffect, useState } from "react";
import { SCHWARTZ_VALUES } from "@crossline/core";
import { ValuesRadar } from "../portrait/portrait-charts";
import { FlywheelPreview, type Link } from "./flywheel-preview";
import type { OnboardingState } from "./onboarding-types";
import type { ProjectTimeline, WeekSkeleton } from "../../lib/onboarding-board";

/**
 * The interview's right column (docs/onboarding-v3.md, decided 2026-10-14): what the answers are building, one picture per stage — the
 * lines, the week, the compass, energy, the projects on a time axis, and at the end the whole structure drawn from the person's own
 * content. The current stage's picture is shown; earlier ones stay one click away. Above it, the start standard as a ring and the time
 * left, so the person always knows how far they are.
 */
export type StageKey = "lines" | "week" | "compass" | "energy" | "projects" | "structure";
const VIEWS: Array<{ key: StageKey; label: string }> = [
  { key: "lines", label: "主线" }, { key: "week", label: "一周" }, { key: "compass", label: "指南针" },
  { key: "energy", label: "能量" }, { key: "projects", label: "项目" }, { key: "structure", label: "全貌" }
];
/** Which picture each interview stage builds. */
export function viewForStage(stage: string, complete: boolean): StageKey {
  if (complete) return "structure";
  return ({ orientation: "lines", lines: "lines", situation: "week", compass: "compass", energy: "energy", details: "projects" } as Record<string, StageKey>)[stage] ?? "lines";
}

/** Rough minutes to the start standard and to the end, from what is still open: honest enough to plan a sitting, never a promise. */
export function minutesLeft(state: Pick<OnboardingState, "readyToStart" | "startMissing">, stage: string): { label: string; minutes: number } {
  // A start item is per line and most are settled by one answer, several to a round: about 2.5 minutes each, never more than half an hour.
  if (!state.readyToStart) return { label: "开始使用前约", minutes: Math.max(3, Math.min(30, Math.ceil(state.startMissing.length * 2.5))) };
  const order = ["orientation", "lines", "situation", "compass", "energy", "details"];
  const left = Math.max(1, order.length - Math.max(0, order.indexOf(stage)));
  return { label: "画像访谈还剩约", minutes: left * 5 };
}

export function StageView({ state, stage, complete, onChanged }: {
  state: OnboardingState; stage: string; complete: boolean; onChanged: () => void;
}) {
  const current = viewForStage(stage, complete);
  const [shown, setShown] = useState<StageKey>(current);
  // A new stage brings its picture forward; a picture the person opened stays until the stage moves on.
  useEffect(() => setShown(current), [current]);
  const reached = VIEWS.findIndex((view) => view.key === current);
  const total = state.startTotal;
  const done = Math.max(0, total - state.startMissing.length);
  const left = minutesLeft(state, stage);
  // A long-term goal is adopted in the left column, not answered in the conversation: its missing item links there (W-8).
  const missing = state.startMissing.map((item) => ({ label: item.label, href: item.id.startsWith("line_goal:") ? "#ob-goals" : "" }));
  return <aside className="ob-stage" aria-label="正在成形">
    <section className="ob-ring-row" aria-label="开始使用的进度">
      <Ring done={state.readyToStart ? Math.max(1, total) : done} total={Math.max(1, total)} />
      <div>
        <b>{state.readyToStart ? "可以开始使用" : total ? `开始使用前还差 ${state.startMissing.length} 项` : "先回答中间的第一组问题"}</b>
        {complete ? <small>访谈已完成</small> : total > 0 && <small>{left.label} {left.minutes} 分钟</small>}
        {!state.readyToStart && missing.length > 0 && <ul className="ob-ring-missing">{missing.slice(0, 3).map(({ label, href }) => <li key={label}>{href ? <a href={href}>{label}（在左栏采用）</a> : label}</li>)}
          {missing.length > 3 && <li>等 {missing.length - 3} 项</li>}</ul>}
        {state.readyToStart && <a className="ob-btn ob-primary" href="/">开始使用</a>}
      </div>
    </section>
    <nav className="ob-stage-tabs" aria-label="各阶段的图">
      {VIEWS.map((view, index) => <button key={view.key} type="button" aria-current={shown === view.key || undefined}
        // The week is there from the start once a calendar or a file has put something in it.
        disabled={index > reached && !(view.key === "week" && (state.week.calendar.length > 0 || state.week.fixed.length > 0))}
        onClick={() => setShown(view.key)}>{view.label}</button>)}
    </nav>
    <div className="ob-stage-body">
      {shown === "lines" && <LinesView state={state} onChanged={onChanged} />}
      {shown === "week" && <WeekView week={state.week} />}
      {shown === "compass" && <CompassView profile={state.profile} />}
      {shown === "energy" && <EnergyView profile={state.profile} />}
      {shown === "projects" && <ProjectsView timeline={state.timeline} lines={state.lines} />}
      {shown === "structure" && <StructureView state={state} />}
    </div>
  </aside>;
}

/** The start items done, as an arc: they are per line, so a count of segments would be unreadable for four lines. */
function Ring({ done, total }: { done: number; total: number }) {
  const r = 26, c = 2 * Math.PI * r, share = Math.min(1, done / total);
  return <svg className="ob-ring" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label={`开始使用的 ${total} 项已完成 ${done} 项`}>
    <circle cx="32" cy="32" r={r} fill="none" strokeWidth="7" className="ob-ring-off" />
    <circle cx="32" cy="32" r={r} fill="none" strokeWidth="7" className="ob-ring-on" strokeDasharray={`${share * c} ${c}`} transform="rotate(-90 32 32)" />
    <text x="32" y="37" textAnchor="middle" className="ob-ring-text">{Math.round(share * 100)}%</text>
  </svg>;
}

async function post(body: Record<string, unknown>): Promise<boolean> {
  const response = await fetch("/api/profile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => undefined);
  return Boolean(response?.ok);
}

function LinesView({ state, onChanged }: { state: OnboardingState; onChanged: () => void }) {
  const change = async (body: Record<string, unknown>) => { if (await post(body)) onChanged(); };
  const linkBody = (link: Link) => ({ identityId: link.from, projectId: "", slot: link.slot });
  return <div className="ob-view">
    <FlywheelPreview identities={state.identities} lines={state.lines} facts={state.facts}
      onConfirm={(link) => void change({ action: "confirm_fact", ...linkBody(link) })}
      onRemove={(link) => void change({ action: "remove_fact", ...linkBody(link) })} />
    <ul className="ob-line-notes">{state.lines.map((line) => <li key={line.id} data-line={line.id}>
      <b>{line.label}</b><small>{line.hard ? "固定日程" : line.rank === 1 ? "底座" : line.rank ? `第 ${line.rank}` : "并行"}</small>
      {state.lineProfiles[line.id]?.description ? <span className="gen">{state.lineProfiles[line.id]!.description}</span> : <span className="ob-muted">访谈中补全</span>}
    </li>)}</ul>
  </div>;
}

const DAYS = ["一", "二", "三", "四", "五", "六", "日"];
const dayIndex = (weekday: number) => (weekday + 6) % 7; // 0 = Sunday in the data, Monday first on screen.
const minutes = (time: string) => { const [h, m] = time.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };

/** The week as it stands: working hours by energy, and the fixed arrangements over them (dashed while still waiting for confirmation). */
export function WeekView({ week }: { week: WeekSkeleton }) {
  const from = 6 * 60, to = 24 * 60, height = 300, top = 18, left = 26, column = 36;
  const y = (time: string) => top + ((Math.min(to, Math.max(from, minutes(time))) - from) / (to - from)) * height;
  const hours = week.windows.reduce((sum, window) => sum + window.days.length * Math.max(0, minutes(window.end) - minutes(window.start)), 0) / 60;
  return <div className="ob-view">
    <svg className="ob-week" viewBox={`0 0 ${left + column * 7 + 4} ${top + height + 6}`} role="img"
      aria-label={`一周骨架：可用约 ${Math.round(hours)} 小时，固定安排 ${week.fixed.length} 项，日历日程 ${week.calendar.length} 项`}>
      {DAYS.map((day, index) => <text key={day} x={left + index * column + column / 2} y={12} textAnchor="middle" className="ob-axis">{day}</text>)}
      {[6, 9, 12, 15, 18, 21, 24].map((hour) => <g key={hour}>
        <line x1={left} x2={left + column * 7} y1={y(`${hour}:00`)} y2={y(`${hour}:00`)} className="ob-grid" />
        <text x={left - 4} y={y(`${hour}:00`) + 4} textAnchor="end" className="ob-axis">{hour}</text>
      </g>)}
      {week.windows.flatMap((window, w) => window.days.map((day) => <rect key={`${w}-${day}`} x={left + dayIndex(day) * column + 2} width={column - 4}
        y={y(window.start)} height={Math.max(2, y(window.end) - y(window.start))} className="ob-window" data-energy={window.energy}>
        <title>{`周${DAYS[dayIndex(day)]} ${window.start}–${window.end} 可用（精力${window.energy === "high" ? "高" : window.energy === "low" ? "低" : "中"}）`}</title></rect>))}
      {week.calendar.map((event, index) => <rect key={`cal-${index}`} x={left + dayIndex(event.weekday) * column + 4} width={column - 8}
        y={y(event.start)} height={Math.max(3, y(event.end) - y(event.start))} className="ob-calendar">
        <title>{`${event.title} · 周${DAYS[dayIndex(event.weekday)]} ${event.start}–${event.end}（${event.source}）`}</title></rect>)}
      {week.fixed.flatMap((item) => item.weekdays.map((day) => <rect key={`${item.id}-${day}`} x={left + dayIndex(day) * column + 6} width={column - 12}
        y={y(item.start)} height={Math.max(3, y(item.end) - y(item.start))} className="ob-fixed" data-status={item.status}>
        <title>{`${item.title} · 周${DAYS[dayIndex(day)]} ${item.start}–${item.end}${item.status === "pending" ? "（待确认）" : ""}`}</title></rect>))}
    </svg>
    <p className="ob-legend"><span className="ob-key" data-k="high" />精力高 <span className="ob-key" data-k="medium" />中 <span className="ob-key" data-k="low" />低
      <span className="ob-key" data-k="fixed" />固定安排 <span className="ob-key" data-k="pending" />待确认
      {week.calendar.length > 0 && <><span className="ob-key" data-k="calendar" />日历</>}</p>
    <p className="ob-muted">{week.source === "default" ? "还不知道可用时间，先按默认的每周 39 小时画；说出工作时间后会更新。"
      : `每周可用约 ${Math.round(hours)} 小时${week.source === "interview" ? "（访谈提议，可在计划页修改）" : week.source === "stated_hours" ? "（按说过的每周小时数推算）" : ""}。`}</p>
  </div>;
}

function CompassView({ profile }: { profile: OnboardingState["profile"] }) {
  const scored = new Map((profile?.values ?? []).map((item) => [item.value, item.score]));
  const values = SCHWARTZ_VALUES.map((value) => ({ name: value.name, score: scored.get(value.name) ?? 0, evidence: value.means }));
  return <div className="ob-view">
    {scored.size >= 3 ? <ValuesRadar values={values} size={300} /> : <p className="ob-placeholder">谈到为什么工作、什么让人生值得之后，这里画出十种价值取向的轮廓。</p>}
    <dl className="ob-compass">
      {profile?.workView && <div><dt>工作观</dt><dd className="gen">{profile.workView}</dd></div>}
      {profile?.lifeView && <div><dt>人生观</dt><dd className="gen">{profile.lifeView}</dd></div>}
      {profile?.trueNorth && <div><dt>正北</dt><dd className="gen">{profile.trueNorth}</dd></div>}
    </dl>
  </div>;
}

/** Activities on the skill × love plane, numbered, filled when they charge and hollow when they drain; names in the list under it. */
function EnergyView({ profile }: { profile: OnboardingState["profile"] }) {
  const map = profile?.energyMap ?? [];
  if (!map.length) return <div className="ob-view"><p className="ob-placeholder">说出哪些事让人忘了时间、哪些做完很累之后，这里把它们放到「擅长 × 热爱」的平面上。</p></div>;
  const size = 260, pad = 22, cell = (size - pad * 2) / 2;
  const placed = map.map((item, index) => {
    const column = item.skill === "high" ? 1 : 0, row = item.love === "high" ? 0 : 1;
    const inCell = map.slice(0, index).filter((other) => other.skill === item.skill && other.love === item.love).length;
    return { ...item, number: index + 1, x: pad + column * cell + 22 + (inCell % 4) * 26, y: pad + row * cell + 26 + Math.floor(inCell / 4) * 26 };
  });
  return <div className="ob-view">
    <svg className="ob-energy-plane" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="擅长与热爱的能量地图">
      <rect x={pad + cell} y={pad} width={cell} height={cell} className="ob-quad-best" />
      <rect x={pad} y={pad} width={cell * 2} height={cell * 2} className="ob-frame" />
      <line x1={pad + cell} x2={pad + cell} y1={pad} y2={pad + cell * 2} className="ob-grid" />
      <line x1={pad} x2={pad + cell * 2} y1={pad + cell} y2={pad + cell} className="ob-grid" />
      <text x={size - pad} y={size - 6} textAnchor="end" className="ob-axis">擅长 →</text>
      <text x={4} y={14} className="ob-axis">热爱 ↑</text>
      {placed.map((item) => <g key={item.number}>
        <circle cx={item.x} cy={item.y} r="10" className="ob-dot" data-charge={item.charge}><title>{item.activity}</title></circle>
        <text x={item.x} y={item.y + 4} textAnchor="middle" className="ob-dot-n" data-charge={item.charge}>{item.number}</text>
      </g>)}
    </svg>
    <ol className="ob-energy-list">{placed.map((item) => <li key={item.number}><b>{item.number}</b><span className="gen">{item.activity}</span>
      <small>{item.charge === "charge" ? "充电" : "耗电"}</small></li>)}</ol>
    {(profile?.flow.length ?? 0) > 0 && <p className="ob-muted">心流时刻：<span className="gen">{profile!.flow.join("；")}</span></p>}
  </div>;
}

/** Each project's dated items on one axis from today, hollow while still waiting for confirmation; undated deadlines said in words. */
function ProjectsView({ timeline, lines }: { timeline: ProjectTimeline; lines: OnboardingState["lines"] }) {
  if (!timeline.length) return <div className="ob-view"><p className="ob-placeholder">说出每条主线正在做的项目和截止日后，这里把它们排到一条时间轴上。</p></div>;
  const today = new Date().toISOString().slice(0, 10);
  const last = timeline.flatMap((project) => project.items.map((item) => item.date)).sort().at(-1) ?? today;
  const span = Math.max(56, (Date.parse(last) - Date.parse(today)) / 86_400_000 + 7);
  const width = 300, left = 4, row = 34;
  const x = (date: string) => left + ((Date.parse(date) - Date.parse(today)) / 86_400_000 / span) * (width - left * 2);
  const months = Array.from({ length: Math.ceil(span / 30) + 1 }, (_, index) => { const day = new Date(Date.parse(today) + index * 30 * 86_400_000); return day.toISOString().slice(0, 10); })
    .filter((date) => x(date) < width - 20);
  return <div className="ob-view">
    <svg className="ob-timeline" viewBox={`0 0 ${width} ${timeline.length * row + 26}`} role="img" aria-label="项目与截止的时间轴">
      {months.map((date) => <g key={date}><line x1={x(date)} x2={x(date)} y1={14} y2={timeline.length * row + 20} className="ob-grid" />
        <text x={x(date) + 2} y={10} className="ob-axis">{Number(date.slice(5, 7))}/{Number(date.slice(8))}</text></g>)}
      {timeline.map((project, index) => <g key={project.id} data-line={project.identityId}>
        <line x1={left} x2={width - left} y1={index * row + 32} y2={index * row + 32} className="ob-track" />
        {project.items.map((item) => <rect key={item.id} x={x(item.date) - 5} y={index * row + 27} width="10" height="10" transform={`rotate(45 ${x(item.date)} ${index * row + 32})`}
          className="ob-milestone" data-status={item.status}><title>{`${item.title} · ${item.date}${item.status === "pending" ? "（待确认）" : ""}`}</title></rect>)}
      </g>)}
    </svg>
    <ul className="ob-project-rows">{timeline.map((project) => <li key={project.id} data-line={project.identityId}>
      <b>{project.name}</b><small>{lines.find((line) => line.id === project.identityId)?.label ?? ""}
        {project.noDeadline ? " · 没有截止" : project.deadline ? ` · 截止：${project.deadline}` : project.items.length ? ` · ${project.items.length} 个日期` : " · 截止待问"}</small>
    </li>)}</ul>
  </div>;
}

/**
 * The six levels the plan is built from, drawn with the person's own content (decided 2026-10-14: shown at the end, not explained up
 * front): lines → long-term goals → projects → the tasks, steps and schedule that come after milestones are designed.
 */
function StructureView({ state }: { state: OnboardingState }) {
  const levels: Array<{ label: string; items: string[]; note?: string }> = [
    { label: "主线", items: state.lines.map((line) => line.label) },
    { label: "长期目标", items: state.lines.flatMap((line) => line.goals.slice(0, 1)), note: "在左侧为每条主线采用" },
    { label: "项目与里程碑", items: state.timeline.map((project) => project.name), note: "里程碑由访谈内容倒推设计" },
    { label: "任务", items: [], note: "批准里程碑后拆出" },
    { label: "步骤", items: [], note: "每个任务拆成可排程的步骤" },
    { label: "日程", items: [], note: "步骤排进一周的日历" }
  ];
  return <div className="ob-view">
    <ol className="ob-structure">{levels.map((level, index) => <li key={level.label} style={{ ["--depth" as string]: index }}>
      <b>{level.label}</b>
      {level.items.length ? <span>{level.items.slice(0, 4).join("、")}{level.items.length > 4 ? ` 等 ${level.items.length} 项` : ""}</span>
        : <span className="ob-muted">{level.note}</span>}
    </li>)}</ol>
    <a className="ob-btn" href="/portrait">查看画像报告</a>
  </div>;
}
