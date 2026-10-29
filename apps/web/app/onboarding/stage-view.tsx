"use client";

import { useEffect, useState } from "react";
import { Check, Circle } from "lucide-react";
import { SCHWARTZ_VALUES } from "@crossline/core";
import { ValuesRadar } from "../portrait/portrait-charts";
import { FlywheelPreview, type Link } from "./flywheel-preview";
import { StartConfirm } from "./start-confirm";
import type { OnboardingState } from "./onboarding-types";
import type { ProjectTimeline, WeekSkeleton } from "../../lib/onboarding-board";
import type { SkeletonBlock } from "@crossline/core";
import { tFor, weekdayShort, type Locale } from "../../lib/i18n";
import { useLocale, useT } from "../locale-context";

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
export function viewForStage(stage: string, complete: boolean, ready = false): StageKey {
  if (complete) return "structure";
  // Once the start standard stands the week's draft is the payoff: it comes forward until the deep parts begin.
  if (ready && (stage === "orientation" || stage === "lines")) return "week";
  return ({ orientation: "lines", lines: "lines", situation: "week", compass: "compass", energy: "energy", details: "projects" } as Record<string, StageKey>)[stage] ?? "lines";
}

/** Rough minutes to the start standard and to the end, from what is still open: honest enough to plan a sitting, never a promise. */
export function minutesLeft(state: Pick<OnboardingState, "readyToStart" | "startMissing">, stage: string): { label: string; minutes: number } {
  // A start item is per line and most are settled by one answer, several to a round: about 2.5 minutes each, never more than half an hour.
  if (!state.readyToStart) return { label: "开始使用前约", minutes: Math.max(3, Math.min(30, Math.ceil(state.startMissing.length * 2.5))) };
  const order = ["orientation", "lines", "situation", "compass", "energy"];
  const left = Math.max(1, order.length - Math.max(0, order.indexOf(stage)));
  return { label: "画像访谈还剩约", minutes: left * 5 };
}

/** Codes that mean no model can run for this account yet: the conversation already says so in the same words, under the reply. */
const NO_MODEL = new Set(["MODEL_SPONSOR_PENDING", "MODEL_SPONSOR_BUDGET", "RUNTIME_UNCONNECTED", "MODEL_NOT_ADMITTED", "MODEL_CAPABILITY_MISSING"]);

/** What the background extraction is doing, in a line, or nothing when it is caught up. */
export function organizingNote(organizing: OnboardingState["organizing"], locale?: Locale): string {
  const t = tFor(locale);
  if (!organizing || (!organizing.replies && !organizing.files)) return "";
  // 「系统会自动重试；访谈可以继续」 beside a round that could not run either was wrong on both counts (live beta, 2026-10-19).
  if (organizing.failing && NO_MODEL.has(organizing.failing.code)) return "";
  if (organizing.failing) return t("刚才的回答还没整理进记录，系统会自动重试；访谈可以继续。");
  return organizing.files && !organizing.replies ? t("正在整理 {{count}} 份材料…", { count: organizing.files }) : t("正在整理刚才的回答…");
}

export function StageView({ state, stage, complete, onChanged }: {
  state: OnboardingState; stage: string; complete: boolean; onChanged: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const current = viewForStage(stage, complete, state.readyToStart);
  const [shown, setShown] = useState<StageKey>(current);
  // A new stage brings its picture forward; a picture the person opened stays until the stage moves on.
  useEffect(() => setShown(current), [current]);
  const reached = VIEWS.findIndex((view) => view.key === current);
  const total = state.startTotal;
  const left = minutesLeft(state, stage);
  // A long-term goal is adopted in the left column, not answered in the conversation: its missing item links there (W-8).
  const missing = state.startMissing.map((item) => ({ label: item.label, href: item.id.startsWith("line_goal:") ? "#ob-goals" : "" }));
  const progress = state.progress;
  const organizing = organizingNote(state.organizing, locale);
  // The start items by kind (they are per line): one row each, done when every line's is, the open ones named under it.
  const groups = START_GROUPS.map((group) => {
    const items = (state.startItems ?? []).filter((item) => item.id.split(":")[0] === group.prefix);
    return { ...group, items, open: missing.filter((item) => state.startItems ? items.some((one) => one.label === item.label) : false) };
  }).filter((group) => group.items.length > 0);
  // A state read before the items were sent lists what is missing as before.
  const loose = state.startItems ? [] : missing;
  return <aside className="ob-stage" aria-label={t("正在成形")}>
    {/* The start standard only (2026-10-28): the old ring read 100% beside the time the rest of the interview still takes. */}
    <section className="ob-start" aria-label={t("开始使用的进度")}>
      <header>
        <b>{state.readyToStart ? t("可以开始使用") : total ? t("开始使用前还差 {{count}} 项", { count: state.startMissing.length }) : t("先回答中间的第一组问题")}</b>
        {!state.readyToStart && total > 0 && <small>{t("约 {{minutes}} 分钟", { minutes: left.minutes })}</small>}
      </header>
      {organizing && <small className="ob-organizing" role="status">{organizing}</small>}
      {groups.length > 0 && <ul className="ob-start-list">{groups.map((group) => { const open = group.items.some((item) => !item.done);
        return <li key={group.prefix} data-done={!open || undefined}>
          {open ? <Circle size={15} strokeWidth={1.75} aria-hidden="true" /> : <Check size={15} strokeWidth={2} aria-hidden="true" />}
          <span>{t(group.label)}{open && group.open.length > 0 && <small>{group.open.slice(0, 3).map(({ label, href }) =>
            href ? <a key={label} href={href}>{t("{{label}}（在左栏采用）", { label: t(label) })}</a> : <span key={label}>{t(label)}</span>)}
            {group.open.length > 3 && <span>{t("等 {{count}} 项", { count: group.open.length - 3 })}</span>}</small>}</span>
        </li>; })}</ul>}
      {!state.readyToStart && loose.length > 0 && <ul className="ob-ring-missing">{loose.slice(0, 3).map(({ label, href }) => <li key={label}>{href ? <a href={href}>{t("{{label}}（在左栏采用）", { label: t(label) })}</a> : t(label)}</li>)}
        {loose.length > 3 && <li>{t("等 {{count}} 项", { count: loose.length - 3 })}</li>}</ul>}
      {/* The first time, the person looks over what the plan will rest on before every page opens; after that it is a plain link. */}
      {state.readyToStart && (state.startConfirmed === false && state.startSummary ? <StartConfirm summary={state.startSummary} />
        : <a className="ob-btn ob-primary" href="/">{t("开始使用")}</a>)}
      {/* Two ways on from here, said once: the button looked like the end of the interview (2026-10-18 walkthrough). */}
      {state.readyToStart && !complete && <small className="ob-ring-next">{t("现在就能排日程；接着答完剩下几轮会拿到画像报告。先去用的话，剩下的问题会出现在待确认里，随时回来接着答。")}</small>}
    </section>
    {/* The portrait's own progress, apart from the start standard; confirming the portrait is done on the portrait page (scenarios.md §3-10). */}
    {!state.focusLine && <section className="ob-portrait-progress" aria-label={t("画像进度")}>
      <b>{t("画像进度")}</b>
      {progress && <small>{complete ? t("访谈已完成") : progress.of
        ? t("第 {{index}}/{{total}} 部分 · {{label}} · 已谈清 {{clear}}/{{of}}", { index: progress.index, total: progress.total, label: t(progress.label), clear: progress.clear, of: progress.of })
        : t("第 {{index}}/{{total}} 部分 · {{label}}", { index: progress.index, total: progress.total, label: t(progress.label) })}</small>}
      {!complete && progress?.next && <small>{t("接下来：")}<span className="gen">{progress.next}</span></small>}
      {state.readyToStart && !complete && <small>{t("{{label}} {{minutes}} 分钟", { label: t(left.label), minutes: left.minutes })}</small>}
      {state.portraitState?.written
        ? state.portraitState.confirmed ? <a href="/portrait">{t("画像已确认符合本人 · 查看画像 →")}</a>
          : <a href="/portrait#pt-s-type">{t("画像已写好，去画像页确认是否符合 →")}</a>
        : <small>{t("写完后在画像页确认是否符合")}</small>}
    </section>}
    <section className="ob-stage-views">
    <nav className="ob-stage-tabs" aria-label={t("各阶段的图")}>
      {VIEWS.map((view, index) => <button key={view.key} type="button" aria-current={shown === view.key || undefined}
        // The week is there from the start once a calendar or a file has put something in it.
        disabled={index > reached && !(view.key === "week" && (state.week.calendar.length > 0 || state.week.fixed.length > 0))}
        onClick={() => setShown(view.key)}>{t(view.label, { context: "view" })}</button>)}
    </nav>
    <div className="ob-stage-body">
      {/* The capacity conflict, once the lines are known: hours, what the fixed schedule takes, deadlines that crowd together. */}
      {(shown === "lines" || shown === "week") && stage !== "orientation" && state.capacity && <CapacityNote capacity={state.capacity} />}
      {shown === "lines" && <LinesView state={state} onChanged={onChanged} />}
      {shown === "week" && <WeekView week={state.week} draft={state.skeleton ?? []} lines={state.lines} />}
      {shown === "compass" && <CompassView profile={state.profile} />}
      {shown === "energy" && <EnergyView profile={state.profile} />}
      {shown === "projects" && <ProjectsView timeline={state.timeline} lines={state.lines} />}
      {shown === "structure" && <StructureView state={state} />}
    </div>
    </section>
  </aside>;
}

/** The five kinds of start item (`interviewChecklist`, `start: true`), by the prefix of their ids. */
const START_GROUPS = [
  { prefix: "line_desc", label: "每条主线的描述" }, { prefix: "line_goal", label: "长期目标（本人选定）" }, { prefix: "hard_schedule", label: "固定日程" },
  { prefix: "availability", label: "每周可用时间" }, { prefix: "line_project", label: "每条主线的当前项目与截止" }
];

async function post(body: Record<string, unknown>): Promise<boolean> {
  const response = await fetch("/api/profile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => undefined);
  return Boolean(response?.ok);
}

function LinesView({ state, onChanged }: { state: OnboardingState; onChanged: () => void }) {
  const t = useT();
  const change = async (body: Record<string, unknown>) => { if (await post(body)) onChanged(); };
  const linkBody = (link: Link) => ({ identityId: link.from, projectId: "", slot: link.slot });
  return <div className="ob-view">
    <FlywheelPreview identities={state.identities} lines={state.lines} facts={state.facts}
      onConfirm={(link) => void change({ action: "confirm_fact", ...linkBody(link) })}
      onRemove={(link) => void change({ action: "remove_fact", ...linkBody(link) })} />
    <ul className="ob-line-notes">{state.lines.map((line) => <li key={line.id} data-line={line.id}>
      <b>{line.label}</b><small>{line.hard ? t("固定日程") : line.rank === 1 ? t("底座") : line.rank ? t("第 {{rank}}", { rank: line.rank }) : t("并行")}</small>
      {state.lineProfiles[line.id]?.description ? <span className="gen">{state.lineProfiles[line.id]!.description}</span> : <span className="ob-muted">{t("访谈中补全")}</span>}
    </li>)}</ul>
  </div>;
}

/** Monday first: 1..6, 0 as weekday numbers. */
const DAYS = [1, 2, 3, 4, 5, 6, 0];
/** Colours for lines without a colour of their own (a line the person named), so the draft still tells them apart. */
const DRAFT_PALETTE = ["#2f6f8f", "#8a5a2b", "#5b6b2e", "#7a3f6e", "#3f5f7a"];

/** The capacity conflict in plain sentences (`capacityConflict`), computed from the ledger. */
function CapacityNote({ capacity }: { capacity: import("@crossline/core").WeekCapacity }) {
  const t = useT();
  return <section className="ob-capacity" aria-label={t("容量")}>
    <b>{t("你的一周")}</b>
    <ul>{capacity.notes.map((note) => <li key={note}>{note}</li>)}</ul>
  </section>;
}
const dayIndex = (weekday: number) => (weekday + 6) % 7; // 0 = Sunday in the data, Monday first on screen.
const minutes = (time: string) => { const [h, m] = time.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };

/** The week as it stands: working hours by energy, and the fixed arrangements over them (dashed while still waiting for confirmation). */
export function WeekView({ week, draft = [], lines = [] }: { week: WeekSkeleton; draft?: SkeletonBlock[]; lines?: OnboardingState["lines"] }) {
  const t = useT();
  const locale = useLocale();
  // 「一」 … 「日」 over the columns in Chinese, "Mon" … "Sun" in English; 「周三」 / "Wed" in the tooltips.
  const head = (index: number) => locale === "en" ? weekdayShort(locale, DAYS[index]!) : weekdayShort(locale, DAYS[index]!).slice(1);
  const dayName = (weekday: number) => weekdayShort(locale, weekday);
  const energy = (level: string) => t(level === "high" ? "高" : level === "low" ? "低" : "中", { context: "level" });
  const from = 6 * 60, to = 24 * 60, height = 300, top = 18, left = 26, column = 36;
  const y = (time: string) => top + ((Math.min(to, Math.max(from, minutes(time))) - from) / (to - from)) * height;
  const hours = week.windows.reduce((sum, window) => sum + window.days.length * Math.max(0, minutes(window.end) - minutes(window.start)), 0) / 60;
  return <div className="ob-view">
    <svg className="ob-week" viewBox={`0 0 ${left + column * 7 + 4} ${top + height + 6}`} role="img"
      aria-label={t("一周骨架：可用约 {{hours}} 小时，固定安排 {{fixed}} 项，日历日程 {{calendar}} 项", { hours: Math.round(hours), fixed: week.fixed.length, calendar: week.calendar.length })}>
      {DAYS.map((weekday, index) => <text key={weekday} x={left + index * column + column / 2} y={12} textAnchor="middle" className="ob-axis">{head(index)}</text>)}
      {[6, 9, 12, 15, 18, 21, 24].map((hour) => <g key={hour}>
        <line x1={left} x2={left + column * 7} y1={y(`${hour}:00`)} y2={y(`${hour}:00`)} className="ob-grid" />
        <text x={left - 4} y={y(`${hour}:00`) + 4} textAnchor="end" className="ob-axis">{hour}</text>
      </g>)}
      {week.windows.flatMap((window, w) => window.days.map((day) => <rect key={`${w}-${day}`} x={left + dayIndex(day) * column + 2} width={column - 4}
        y={y(window.start)} height={Math.max(2, y(window.end) - y(window.start))} className="ob-window" data-energy={window.energy}>
        <title>{t("{{day}} {{start}}–{{end}} 可用（精力{{energy}}）", { day: dayName(day), start: window.start, end: window.end, energy: energy(window.energy) })}</title></rect>))}
      {draft.map((block, index) => <rect key={`draft-${index}`} x={left + dayIndex(block.weekday) * column + 3} width={column - 6}
        y={y(block.start)} height={Math.max(2, y(block.end) - y(block.start))} className="ob-draft" data-line={block.lineId}
        style={{ fill: `var(--lc, ${DRAFT_PALETTE[Math.max(0, lines.findIndex((line) => line.id === block.lineId)) % DRAFT_PALETTE.length]})` }}>
        <title>{t("{{line}} · {{day}} {{start}}–{{end}}（草稿）", { line: lines.find((line) => line.id === block.lineId)?.label ?? "", day: dayName(block.weekday), start: block.start, end: block.end })}</title></rect>)}
      {week.calendar.map((event, index) => <rect key={`cal-${index}`} x={left + dayIndex(event.weekday) * column + 4} width={column - 8}
        y={y(event.start)} height={Math.max(3, y(event.end) - y(event.start))} className="ob-calendar">
        <title>{t("{{title}} · {{day}} {{start}}–{{end}}（{{source}}）", { title: event.title, day: dayName(event.weekday), start: event.start, end: event.end, source: event.source })}</title></rect>)}
      {week.fixed.flatMap((item) => item.weekdays.map((day) => <rect key={`${item.id}-${day}`} x={left + dayIndex(day) * column + 6} width={column - 12}
        y={y(item.start)} height={Math.max(3, y(item.end) - y(item.start))} className="ob-fixed" data-status={item.status}>
        <title>{item.status === "pending" ? t("{{title}} · {{day}} {{start}}–{{end}}（待确认）", { title: item.title, day: dayName(day), start: item.start, end: item.end })
          : t("{{title}} · {{day}} {{start}}–{{end}}", { title: item.title, day: dayName(day), start: item.start, end: item.end })}</title></rect>))}
    </svg>
    <p className="ob-legend"><span className="ob-key" data-k="high" />{t("精力高")} <span className="ob-key" data-k="medium" />{t("中", { context: "legend" })} <span className="ob-key" data-k="low" />{t("低", { context: "legend" })}
      <span className="ob-key" data-k="fixed" />{t("固定安排")} <span className="ob-key" data-k="pending" />{t("待确认", { context: "pending" })}
      {week.calendar.length > 0 && <><span className="ob-key" data-k="calendar" />{t("日历")}</>}</p>
    {draft.length > 0 && <div className="ob-draft-note"><b>{t("本周骨架草稿")}</b>
      <ul>{lines.map((line, index) => { const hours = draft.filter((block) => block.lineId === line.id)
        .reduce((sum, block) => sum + minutes(block.end) - minutes(block.start), 0) / 60;
        return hours > 0 ? <li key={line.id} data-line={line.id}><span className="ob-key" style={{ background: `var(--lc, ${DRAFT_PALETTE[index % DRAFT_PALETTE.length]})` }} />{t("{{line}} 约 {{hours}} 小时", { line: line.label, hours: Math.round(hours) })}</li> : null; })}</ul>
      <small className="ob-muted">{t("按主线主次分配空闲时间的草稿；开始使用后，排程按真实任务和截止安排。")}</small></div>}
    <p className="ob-muted">{week.source === "default" ? t("还不知道可用时间，先按默认的每周 39 小时画；说出工作时间后会更新。")
      : week.source === "interview" ? t("每周可用约 {{hours}} 小时（访谈提议，可在计划页修改）。", { hours: Math.round(hours) })
      : week.source === "stated_hours" ? t("每周可用约 {{hours}} 小时（按说过的每周小时数推算）。", { hours: Math.round(hours) })
      : t("每周可用约 {{hours}} 小时。", { hours: Math.round(hours) })}</p>
  </div>;
}

function CompassView({ profile }: { profile: OnboardingState["profile"] }) {
  const t = useT();
  const scored = new Map((profile?.values ?? []).map((item) => [item.value, item.score]));
  const values = SCHWARTZ_VALUES.map((value) => ({ name: value.name, score: scored.get(value.name) ?? 0, evidence: t(value.means) }));
  return <div className="ob-view">
    {scored.size >= 3 ? <ValuesRadar values={values} size={300} /> : <p className="ob-placeholder">{t("谈到为什么工作、什么让人生值得之后，这里画出十种价值取向的轮廓。")}</p>}
    <dl className="ob-compass">
      {profile?.workView && <div><dt>{t("工作观")}</dt><dd className="gen">{profile.workView}</dd></div>}
      {profile?.lifeView && <div><dt>{t("人生观")}</dt><dd className="gen">{profile.lifeView}</dd></div>}
      {profile?.trueNorth && <div><dt>{t("正北")}</dt><dd className="gen">{profile.trueNorth}</dd></div>}
    </dl>
  </div>;
}

/** Activities on the skill × love plane, numbered, filled when they charge and hollow when they drain; names in the list under it. */
function EnergyView({ profile }: { profile: OnboardingState["profile"] }) {
  const t = useT();
  const map = profile?.energyMap ?? [];
  if (!map.length) return <div className="ob-view"><p className="ob-placeholder">{t("说出哪些事让人忘了时间、哪些做完很累之后，这里把它们放到「擅长 × 热爱」的平面上。")}</p></div>;
  const size = 260, pad = 22, cell = (size - pad * 2) / 2;
  const placed = map.map((item, index) => {
    const column = item.skill === "high" ? 1 : 0, row = item.love === "high" ? 0 : 1;
    const inCell = map.slice(0, index).filter((other) => other.skill === item.skill && other.love === item.love).length;
    return { ...item, number: index + 1, x: pad + column * cell + 22 + (inCell % 4) * 26, y: pad + row * cell + 26 + Math.floor(inCell / 4) * 26 };
  });
  return <div className="ob-view">
    <svg className="ob-energy-plane" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={t("擅长与热爱的能量地图")}>
      <rect x={pad + cell} y={pad} width={cell} height={cell} className="ob-quad-best" />
      <rect x={pad} y={pad} width={cell * 2} height={cell * 2} className="ob-frame" />
      <line x1={pad + cell} x2={pad + cell} y1={pad} y2={pad + cell * 2} className="ob-grid" />
      <line x1={pad} x2={pad + cell * 2} y1={pad + cell} y2={pad + cell} className="ob-grid" />
      <text x={size - pad} y={size - 6} textAnchor="end" className="ob-axis">{t("擅长 →")}</text>
      <text x={4} y={14} className="ob-axis">{t("热爱 ↑")}</text>
      {placed.map((item) => <g key={item.number}>
        <circle cx={item.x} cy={item.y} r="10" className="ob-dot" data-charge={item.charge}><title>{item.activity}</title></circle>
        <text x={item.x} y={item.y + 4} textAnchor="middle" className="ob-dot-n" data-charge={item.charge}>{item.number}</text>
      </g>)}
    </svg>
    <ol className="ob-energy-list">{placed.map((item) => <li key={item.number}><b>{item.number}</b><span className="gen">{item.activity}</span>
      <small>{item.charge === "charge" ? t("充电") : t("耗电")}</small></li>)}</ol>
    {(profile?.flow.length ?? 0) > 0 && <p className="ob-muted">{t("心流时刻：")}<span className="gen">{profile!.flow.join(t("；"))}</span></p>}
  </div>;
}

/** Each project's dated items on one axis from today, hollow while still waiting for confirmation; undated deadlines said in words. */
function ProjectsView({ timeline, lines }: { timeline: ProjectTimeline; lines: OnboardingState["lines"] }) {
  const t = useT();
  if (!timeline.length) return <div className="ob-view"><p className="ob-placeholder">{t("说出每条主线正在做的项目和截止日后，这里把它们排到一条时间轴上。")}</p></div>;
  const today = new Date().toISOString().slice(0, 10);
  const last = timeline.flatMap((project) => project.items.map((item) => item.date)).sort().at(-1) ?? today;
  const span = Math.max(56, (Date.parse(last) - Date.parse(today)) / 86_400_000 + 7);
  const width = 300, left = 4, row = 34;
  const x = (date: string) => left + ((Date.parse(date) - Date.parse(today)) / 86_400_000 / span) * (width - left * 2);
  const months = Array.from({ length: Math.ceil(span / 30) + 1 }, (_, index) => { const day = new Date(Date.parse(today) + index * 30 * 86_400_000); return day.toISOString().slice(0, 10); })
    .filter((date) => x(date) < width - 20);
  return <div className="ob-view">
    <svg className="ob-timeline" viewBox={`0 0 ${width} ${timeline.length * row + 26}`} role="img" aria-label={t("项目与截止的时间轴")}>
      {months.map((date) => <g key={date}><line x1={x(date)} x2={x(date)} y1={14} y2={timeline.length * row + 20} className="ob-grid" />
        <text x={x(date) + 2} y={10} className="ob-axis">{Number(date.slice(5, 7))}/{Number(date.slice(8))}</text></g>)}
      {timeline.map((project, index) => <g key={project.id} data-line={project.identityId}>
        <line x1={left} x2={width - left} y1={index * row + 32} y2={index * row + 32} className="ob-track" />
        {project.items.map((item) => <rect key={item.id} x={x(item.date) - 5} y={index * row + 27} width="10" height="10" transform={`rotate(45 ${x(item.date)} ${index * row + 32})`}
          className="ob-milestone" data-status={item.status}><title>{item.status === "pending" ? t("{{title}} · {{date}}（待确认）", { title: item.title, date: item.date }) : `${item.title} · ${item.date}`}</title></rect>)}
      </g>)}
    </svg>
    <ul className="ob-project-rows">{timeline.map((project) => <li key={project.id} data-line={project.identityId}>
      <b>{project.name}</b><small>{lines.find((line) => line.id === project.identityId)?.label ?? ""}
        {project.noDeadline ? t(" · 没有截止") : project.deadline ? t(" · 截止：{{day}}", { day: project.deadline }) : project.items.length ? t(" · {{count}} 个日期", { count: project.items.length }) : t(" · 截止待问")}</small>
    </li>)}</ul>
  </div>;
}

/**
 * The six levels the plan is built from, drawn with the person's own content (decided 2026-10-14: shown at the end, not explained up
 * front): lines → long-term goals → projects → the tasks, steps and schedule that come after milestones are designed.
 */
function StructureView({ state }: { state: OnboardingState }) {
  const t = useT();
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
      <b>{t(level.label, { context: "level" })}</b>
      {level.items.length ? <span>{level.items.slice(0, 4).join(t("、"))}{level.items.length > 4 ? t(" 等 {{count}} 项", { count: level.items.length }) : ""}</span>
        : <span className="ob-muted">{level.note ? t(level.note) : null}</span>}
    </li>)}</ol>
    <a className="ob-btn" href="/portrait">{t("查看画像报告")}</a>
  </div>;
}
