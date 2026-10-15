"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { adviceChanges, applyAdvice, type AvailabilityWindow, type EnergyAdvice } from "@crossline/core";
import type { ScheduleParams } from "@crossline/planner";
import { SegmentedControl, Slider } from "../ui/controls";
import { Tip } from "../ui/overlay";
import { Tag } from "../ui/tag";
import { ImpactCard } from "../task/impact";
import { usePlanImpact } from "./preview-context";
import { RhythmMini } from "./plan-stats-charts";
import { gridFromWindows, gridHours, windowsFromGrid, SLOTS, type WeekGrid } from "./week-grid";

const ORDER = [1, 2, 3, 4, 5, 6, 0];
const DAY_LABEL = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const BRUSH = [{ value: "3", label: "高精力" }, { value: "2", label: "中精力" }, { value: "1", label: "低精力" }, { value: "0", label: "擦除" }] as const;
const ENERGY_LABEL = ["不可用", "低精力", "中精力", "高精力"];
const clock = (slot: number) => `${String(Math.floor(slot / 2)).padStart(2, "0")}:${slot % 2 ? "30" : "00"}`;
const REVIEW_LABEL: Record<string, string> = { agreed: "研究复核：支持", adjusted: "研究复核：已微调", unverified: "研究复核：来源未核实", insufficient: "研究复核：记录不足",
  skipped: "未做研究复核" };

/**
 * 「时段与精力」 (decided 2026-10-15): the week as one 24-hour grid where each half hour the person is free carries its energy — high,
 * medium or low in three shades of one hue that no line uses — painted directly, beside eight weeks of timed work drawn under the same
 * pattern; while the grid differs from what is saved the rhythm is drawn twice, 「调整前」 and 「调整后」. This week's energy advice
 * (worker, weekly) is laid over the grid as a strip in the advised level's colour on every half hour it would change, with its reason
 * and sources; 批准 previews it across the schedule like any other change, 忽略 sets this advice aside.
 */
export function TimeEnergy({ windows, suggested, proposed, busy, statedWeekly, worked, advice }: {
  windows: AvailabilityWindow[]; suggested: AvailabilityWindow[]; proposed: { windows: AvailabilityWindow[]; why: string } | null; busy: number[][];
  statedWeekly: number | null; worked: number[][]; advice: { value: EnergyAdvice | null; dismissed: boolean };
}) {
  const saved = useMemo(() => gridFromWindows(windows), [windows]);
  const initial = useRef(JSON.stringify(saved));
  const [grid, setGrid] = useState<WeekGrid>(saved);
  const [brush, setBrush] = useState<(typeof BRUSH)[number]["value"]>("3");
  const [setAside, setSetAside] = useState(advice.dismissed);
  const painting = useRef(false);
  const impact = usePlanImpact();
  useEffect(() => {
    const stop = () => { painting.current = false; };
    window.addEventListener("pointerup", stop);
    return () => window.removeEventListener("pointerup", stop);
  }, []);
  const paint = (day: number, slot: number) => setGrid((current) => {
    if (current[day]![slot] === Number(brush)) return current;
    const next = current.map((row) => [...row]);
    next[day]![slot] = Number(brush);
    return next;
  });
  const dirty = JSON.stringify(grid) !== initial.current;
  const hours = gridHours(grid);
  const empty = !grid.some((row) => row.some(Boolean));
  const live = advice.value && "levels" in advice.value ? advice.value : null;
  const changes = live ? adviceChanges(live.levels, grid) : null;
  const overlay = Boolean(live && !setAside && changes && changes.cells > 0);
  const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
  const propose = (next: WeekGrid) => void impact.propose({ kind: "availability", windows: windowsFromGrid(next), timeZone: zone() });
  const dismiss = async () => {
    if (!live) return;
    setSetAside(true);
    await fetch("/api/plan/energy-advice", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "dismiss", id: live.id }) })
      .catch(() => undefined);
  };
  const workedTotal = worked.flat().reduce((sum, value) => sum + value, 0);
  return <section className="pl-card pl-time" id="time" aria-label="时段与精力">
    <header><h2>时段与精力</h2>
      <span className="pl-hours mono" title="刷涂的可用时段每周小时数，对比访谈中所述的每周投入">每周 {hours} h{statedWeekly !== null ? ` · 所述 ${statedWeekly} h` : ""}</span></header>
    <div className="pl-time-body">
      <div className="pl-week-editor">
        <div className="pl-toolbar">
          <SegmentedControl label="画笔" value={brush} onChange={setBrush} options={BRUSH.map((item) => ({ value: item.value, label: item.label }))} />
          {proposed && <button type="button" onClick={() => setGrid(gridFromWindows(proposed.windows))} title={proposed.why || "访谈按硬约束主线的规则提议的可用时段"}>采用访谈提议</button>}
          {suggested.length > 0 && <button type="button" onClick={() => setGrid(gridFromWindows(suggested))} title="按近两周屏幕活动推断的在场时段">采用活动建议</button>}
          {dirty && <button type="button" onClick={() => setGrid(JSON.parse(initial.current) as WeekGrid)}>还原</button>}
          <button type="button" className="primary-button" disabled={!dirty || empty || impact.busy} onClick={() => propose(grid)}>
            {impact.busy ? "计算中…" : "预览影响"}</button>
        </div>
        <div className="pl-grid-scroll">
          <table className="pl-grid" aria-label="每周可用时段" onPointerLeave={() => { painting.current = false; }}>
            <thead><tr><th /><th colSpan={SLOTS} className="pl-axis-cell" scope="colgroup">
              <div className="pl-hour-axis" aria-hidden="true">{Array.from({ length: 13 }, (_, index) => index * 2).map((hour) =>
                <span key={hour} style={{ left: `${(hour / 24) * 100}%` }} data-edge={hour === 0 ? "start" : hour === 24 ? "end" : undefined}>{hour}</span>)}</div>
            </th></tr></thead>
            <tbody>{ORDER.map((day) => <tr key={day}><th scope="row">{DAY_LABEL[day]}</th>
              {grid[day]!.map((value, slot) => {
                const advised = overlay && value && live!.levels[day]![slot] && live!.levels[day]![slot] !== value ? live!.levels[day]![slot] : undefined;
                return <td key={slot} data-level={value} data-busy={busy[day]?.[slot] ? true : undefined} data-advice={advised}
                  title={`${DAY_LABEL[day]} ${clock(slot)}–${clock(slot + 1)} · ${ENERGY_LABEL[value]}${advised ? ` · 本周建议${ENERGY_LABEL[advised]}` : ""}${busy[day]?.[slot] ? ` · 日历占用 ${busy[day]![slot]} 次` : ""}`}
                  onPointerDown={(event) => { event.preventDefault(); painting.current = true; paint(day, slot); }}
                  onPointerEnter={() => painting.current && paint(day, slot)} />;
              })}
            </tr>)}</tbody>
          </table>
        </div>
        <div className="pl-legend"><span><span className="pl-key" data-k="l3" />高精力</span><span><span className="pl-key" data-k="l2" />中精力</span>
          <span><span className="pl-key" data-k="l1" />低精力</span><span><span className="pl-key" data-k="l0" />不可用</span><span><span className="pl-key" data-k="busy" />未来两周日历占用</span>
          {overlay && <span><span className="pl-key" data-k="advice" />底部色条：本周建议的精力</span>}</div>
        {live && !setAside && <Advice advice={live} changes={changes!} busy={impact.busy}
          onApprove={() => { const next = applyAdvice(grid, live.levels); setGrid(next); propose(next); }} onDismiss={() => void dismiss()} />}
        {advice.value && "insufficient" in advice.value && <p className="pl-chart-foot">本周精力建议：{advice.value.insufficient}。</p>}
        {impact.error && <p role="status">{impact.error}</p>}
        {impact.pending && <ImpactCard impact={impact.pending.impact} busy={impact.busy} onApply={() => void impact.apply()} onCancel={impact.cancel} />}
      </div>
      <div className="pl-compare" aria-label="近 8 周实际节律">
        <h3>近 8 周实际节律</h3>
        <div className="pl-compare-row">
          {dirty ? <><RhythmMini worked={worked} pattern={saved} title="调整前" /><RhythmMini worked={worked} pattern={grid} title="调整后" /></>
            : <RhythmMini worked={worked} pattern={grid} title="现状" />}
        </div>
        <p className="pl-legend"><span><span className="pl-key" data-k="heat" />计时分钟（越深越多）</span><span><span className="pl-key" data-k="lvbar" />色条为该小时的精力设置</span>
          {!workedTotal && <span>尚无计时记录</span>}</p>
      </div>
    </div>
  </section>;
}

/** The advice's footing in one line, and 「偏薄」 when it rests on less than a week of nights or fewer than four reports (decided 2026-10-15:
 * said, not a reason to refuse 批准). */
export function evidenceLine(evidence: { nights?: number; reports?: number }): string {
  const nights = evidence.nights ?? 0, reports = evidence.reports ?? 0;
  const thin = nights < 7 || reports < 4;
  return `依据：${reports} 次自评、${nights ? `${nights} 晚睡眠记录` : "无睡眠记录"}${thin ? "，依据偏薄" : ""}`;
}

function Advice({ advice, changes, busy, onApprove, onDismiss }: { advice: Extract<EnergyAdvice, { levels: number[][] }>; changes: { cells: number; raised: number; lowered: number };
  busy: boolean; onApprove: () => void; onDismiss: () => void }) {
  const reviewed = advice.review.state === "agreed" || advice.review.state === "adjusted";
  return <div className="pl-advice" role="note" aria-label="本周精力建议">
    <div className="pl-advice-head"><b>本周建议</b><small className="mono">{advice.computedAt.slice(5, 10).replace("-", "/")}</small>
      <Tag tone={reviewed ? "info" : "neutral"}>{REVIEW_LABEL[advice.review.state] ?? ""}</Tag>
      <Tip content={<span className="pl-basis">{advice.basis.map((line) => <span key={line}>{line}</span>)}
        {advice.review.findings.map((finding) => <span key={finding.claim} className="gen">{finding.claim}</span>)}</span>}>
        <button type="button" className="pl-imp-basis">依据</button>
      </Tip></div>
    <p className={reviewed ? "gen" : undefined}>{advice.summary}</p>
    <p className="pl-advice-basis">{evidenceLine(advice.evidence)}</p>
    <p className="pl-advice-count">{changes.cells
      ? <>改动 <b className="mono">{changes.cells / 2}</b> 小时：调高 {changes.raised / 2} h，调低 {changes.lowered / 2} h</> : "与当前设置一致"}</p>
    {advice.sources.length > 0 && <p className="pl-advice-sources">{advice.sources.map((source) =>
      <a key={source.id} href={source.url} target="_blank" rel="noreferrer noopener" title={source.url}>{source.title}</a>)}</p>}
    {changes.cells > 0 && <div className="pl-toolbar">
      <button type="button" className="primary-button" disabled={busy} onClick={onApprove}>批准建议并预览</button>
      <button type="button" onClick={onDismiss}>忽略</button>
    </div>}
  </div>;
}

/**
 * What the ordering rests on, as the page shows it (decided 2026-10-15): each line's long-term goal. A milestone's importance is the
 * agent's call, changed on that milestone's card; a task's due day on its task card.
 */
export function LongTermGoals({ goals, shares }: { goals: Array<{ line: string; label: string; goal: string | null }>; shares: Record<string, number> }) {
  return <section className="pl-card pl-goals" aria-label="排程依据">
    <header><h2>排程依据</h2><small>各主线的长期目标；里程碑的重要性在里程碑卡上调整</small></header>
    <ul>{goals.map((item) => <li key={item.line} data-line={item.line}>
      <b>{item.label}</b>
      <span data-user-text>{item.goal ?? "尚未选定长期目标"}</span>
      {shares[item.line] ? <small className="mono" title="每周至少得到的可用时间份额">份额 {shares[item.line]}%</small> : null}
    </li>)}</ul>
  </section>;
}

/**
 * The rarely used settings in one fold (decided 2026-10-15): how a day is packed, each line's share, and the scheduler's own ordering,
 * read-only. The schedule status links here (`#why`) when something was not placed, so following that link opens it.
 */
export function AdvancedSettings({ params, presets, shares, labels, lineOrder, children }: { params: ScheduleParams; presets: { buffered: ScheduleParams; asap: ScheduleParams };
  shares: { effective: Record<string, number>; custom: boolean }; labels: Record<string, string>; lineOrder: string[]; children: ReactNode }) {
  const fold = useRef<HTMLDetailsElement | null>(null);
  useEffect(() => {
    const follow = () => { if (window.location.hash === "#why" && fold.current) fold.current.open = true; };
    follow();
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);
  return <details className="fold advanced pl-advanced" id="why" ref={fold}>
    <summary>高级：排程参数、主线份额与排程顺序</summary>
    <div className="pl-advanced-body">
      <ParamsPanel params={params} presets={presets} />
      <SharesPanel shares={shares} labels={labels} lineOrder={lineOrder} />
      <div className="pl-why"><h3>排程顺序</h3>
        <small className="pl-chart-foot">排序规则：优先档 → 重要性 → 截止日。只读；截止日在任务卡上修改。</small>
        {children}
      </div>
    </div>
  </details>;
}

/**
 * Each line's share of the week (decided 2026-10-10): a soft floor the scheduler meets before ordering by deadline tier, so a line
 * whose milestones are far off still gets its hours. Starts from what the person said in the interview; previewed like any change.
 */
function SharesPanel({ shares, labels, lineOrder }: { shares: { effective: Record<string, number>; custom: boolean }; labels: Record<string, string>; lineOrder: string[] }) {
  const [draft, setDraft] = useState(shares.effective);
  const impact = usePlanImpact();
  const total = lineOrder.reduce((sum, line) => sum + (draft[line] ?? 0), 0);
  const changed = lineOrder.some((line) => (draft[line] ?? 0) !== (shares.effective[line] ?? 0));
  return <div className="pl-params pl-shares">
    <h3>主线份额</h3>
    <small className="pl-chart-foot">{shares.custom ? "本人设定。" : "来自访谈中所述的投入比例。"}每条主线一周至少得到这一份可用时间；有截止的工作仍然优先。</small>
    {lineOrder.map((line) => <div key={line} className="pl-param" data-line={line}>
      <span>{labels[line] ?? line}</span>
      <Slider label={`${labels[line] ?? line}的份额`} min={0} max={100} step={5} format={(value) => `${value}%`} value={draft[line] ?? 0}
        onChange={(value) => setDraft({ ...draft, [line]: value })} />
    </div>)}
    {total > 100 && <p role="status">合计 {total}%，超过 100%。</p>}
    <div className="pl-toolbar">
      {changed && <button type="button" onClick={() => setDraft(shares.effective)}>还原</button>}
      <button type="button" className="primary-button" disabled={!changed || total > 100 || impact.busy}
        onClick={() => void impact.propose({ kind: "shares", shares: draft })}>{impact.busy ? "计算中…" : "预览影响"}</button>
    </div>
    {impact.error && <p role="status">{impact.error}</p>}
    {impact.pending && <ImpactCard impact={impact.pending.impact} busy={impact.busy} onApply={() => void impact.apply()}
      onCancel={() => { impact.cancel(); setDraft(shares.effective); }} />}
  </div>;
}

const PARAM_ROWS = [
  { key: "gapMinutes", label: "任务间隔", min: 0, max: 30, step: 5, format: (v: number) => `${v} 分` },
  { key: "maxDailyShare", label: "每日最高占用", min: 50, max: 100, step: 5, format: (v: number) => `${v}%` },
  { key: "focusCapMinutes", label: "单段专注上限", min: 0, max: 180, step: 15, format: (v: number) => v ? `${v} 分` : "不限" },
  { key: "deadlineBufferDays", label: "截止前缓冲", min: 0, max: 5, step: 1, format: (v: number) => `${v} 天` }
] as const;
const toSlider = (params: ScheduleParams, key: keyof ScheduleParams) => key === "maxDailyShare" ? Math.round(params[key] * 100) : params[key];
const fromSlider = (key: keyof ScheduleParams, value: number) => key === "maxDailyShare" ? value / 100 : value;
const same = (a: ScheduleParams, b: ScheduleParams) => JSON.stringify(a) === JSON.stringify(b);

/** How a day is packed: two presets and the four numbers behind them. */
function ParamsPanel({ params, presets }: { params: ScheduleParams; presets: { buffered: ScheduleParams; asap: ScheduleParams } }) {
  const [draft, setDraft] = useState(params);
  const impact = usePlanImpact();
  const preset = same(draft, presets.buffered) ? "buffered" : same(draft, presets.asap) ? "asap" : "custom";
  return <div className="pl-params">
    <h3>排程参数</h3>
    <SegmentedControl label="预设" value={preset} onChange={(value) => value !== "custom" && setDraft(presets[value])}
      options={[{ value: "buffered", label: "留缓冲" }, { value: "asap", label: "尽早完成" }, { value: "custom", label: "自定义" }]} />
    {PARAM_ROWS.map((row) => <div key={row.key} className="pl-param">
      <span>{row.label}</span>
      <Slider label={row.label} min={row.min} max={row.max} step={row.step} format={row.format} value={toSlider(draft, row.key)}
        onChange={(value) => setDraft({ ...draft, [row.key]: fromSlider(row.key, value) })} />
    </div>)}
    <div className="pl-toolbar">
      {!same(draft, params) && <button type="button" onClick={() => setDraft(params)}>还原</button>}
      <button type="button" className="primary-button" disabled={same(draft, params) || impact.busy}
        onClick={() => void impact.propose({ kind: "params", params: draft })}>{impact.busy ? "计算中…" : "预览影响"}</button>
    </div>
    {impact.error && <p role="status">{impact.error}</p>}
    {impact.pending && <ImpactCard impact={impact.pending.impact} busy={impact.busy} onApply={() => void impact.apply()}
      onCancel={() => { impact.cancel(); setDraft(params); }} />}
  </div>;
}
