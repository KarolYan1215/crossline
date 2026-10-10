"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AvailabilityWindow } from "@crossline/core";
import type { ScheduleParams } from "@crossline/planner";
import { SegmentedControl, Slider } from "../ui/controls";
import { ImpactCard } from "../task/impact";
import { usePlanImpact } from "./preview-context";
import { gridFromWindows, gridHours, windowsFromGrid, SLOTS, type WeekGrid } from "./week-grid";

type Tab = "week" | "params" | "why";

/**
 * The schedule's settings at the foot of the plan page (decided 2026-10-10), as three tabs: when the person is free, how a day is
 * packed, and 「排程依据」 — the scheduler's own ordering, where each milestone's importance slider now lives. Every change is previewed
 * against the real schedule before it is applied, and the charts above show it while the preview is open.
 */
export function TimeControls({ windows, suggested, proposed, busy, params, presets, statedWeekly, ranking, openWhy, shares, labels, lineOrder }: {
  windows: AvailabilityWindow[]; suggested: AvailabilityWindow[]; proposed?: { windows: AvailabilityWindow[]; why: string } | null; busy: number[][]; params: ScheduleParams;
  presets: { buffered: ScheduleParams; asap: ScheduleParams }; statedWeekly: number | null;
  shares: { effective: Record<string, number>; custom: boolean }; labels: Record<string, string>; lineOrder: string[];
  /** The 「排程依据」 tab's content (the ranking table and the written explanation). */ ranking: ReactNode;
  /** Opens on 「排程依据」 (the schedule status links there when something was not placed). */ openWhy?: boolean;
}) {
  const [tab, setTab] = useState<Tab>(openWhy ? "why" : "week");
  // The schedule status above links to #why: following it opens the tab.
  useEffect(() => {
    const follow = () => { if (window.location.hash === "#why") setTab("why"); };
    follow();
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);
  return <section className="pl-card pl-controls" id="time" aria-label="排程设置">
    <header><h2>排程设置</h2>
      <SegmentedControl label="设置项" value={tab} onChange={setTab} options={[{ value: "week", label: "可用时段" },
        { value: "params", label: "排程参数" }, { value: "why", label: "排程依据" }]} /></header>
    <span id="why" className="pl-anchor" />
    {tab === "week" && <WeekEditor windows={windows} suggested={suggested} proposed={proposed ?? null} busy={busy} statedWeekly={statedWeekly} />}
    {tab === "params" && <><ParamsPanel params={params} presets={presets} /><SharesPanel shares={shares} labels={labels} lineOrder={lineOrder} /></>}
    {tab === "why" && <div className="pl-why">
      <small className="pl-chart-foot">排序规则：优先档 → 重要性 → 截止日。调整重要性或截止日时先预览对排程的影响。</small>
      {ranking}
    </div>}
  </section>;
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

const ORDER = [1, 2, 3, 4, 5, 6, 0];
const DAY_LABEL = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const BRUSH = [{ value: "3", label: "高精力" }, { value: "2", label: "中精力" }, { value: "1", label: "低精力" }, { value: "0", label: "擦除" }] as const;
const ENERGY_LABEL = ["不可用", "低精力", "中精力", "高精力"];
const clock = (slot: number) => `${String(Math.floor(slot / 2)).padStart(2, "0")}:${slot % 2 ? "30" : "00"}`;

/** The week painted on a grid: pick an energy, drag over half hours. Calendar commitments of the next two weeks show through as dots. */
function WeekEditor({ windows, suggested, proposed, busy, statedWeekly }: { windows: AvailabilityWindow[]; suggested: AvailabilityWindow[];
  proposed: { windows: AvailabilityWindow[]; why: string } | null; busy: number[][]; statedWeekly: number | null }) {
  const initial = useRef(JSON.stringify(gridFromWindows(windows)));
  const [grid, setGrid] = useState<WeekGrid>(() => gridFromWindows(windows));
  const [brush, setBrush] = useState<(typeof BRUSH)[number]["value"]>("3");
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
  return <div className="pl-week-editor">
    <div className="pl-toolbar">
      <SegmentedControl label="画笔" value={brush} onChange={setBrush} options={BRUSH.map((item) => ({ value: item.value, label: item.label }))} />
      <span className="pl-hours mono" title="刷涂的可用时段每周小时数，对比访谈中所述的每周投入">每周 {hours} h{statedWeekly !== null ? ` · 所述 ${statedWeekly} h` : ""}</span>
      {proposed && <button type="button" onClick={() => setGrid(gridFromWindows(proposed.windows))} title={proposed.why || "访谈按硬约束主线的规则提议的可用时段"}>采用访谈提议</button>}
      {suggested.length > 0 && <button type="button" onClick={() => setGrid(gridFromWindows(suggested))} title="按近两周屏幕活动推断的在场时段">采用活动建议</button>}
      {dirty && <button type="button" onClick={() => setGrid(JSON.parse(initial.current) as WeekGrid)}>还原</button>}
      <button type="button" className="primary-button" disabled={!dirty || empty || impact.busy}
        onClick={() => void impact.propose({ kind: "availability", windows: windowsFromGrid(grid), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })}>
        {impact.busy ? "计算中…" : "预览影响"}</button>
    </div>
    <div className="pl-grid-scroll">
      <table className="pl-grid" aria-label="每周可用时段" onPointerLeave={() => { painting.current = false; }}>
        <thead><tr><th />{Array.from({ length: SLOTS }, (_, slot) => <th key={slot} scope="col">{slot % 4 === 0 ? slot / 2 : ""}</th>)}</tr></thead>
        <tbody>{ORDER.map((day) => <tr key={day}><th scope="row">{DAY_LABEL[day]}</th>
          {grid[day]!.map((value, slot) => <td key={slot} data-level={value} data-busy={busy[day]?.[slot] ? true : undefined}
            title={`${DAY_LABEL[day]} ${clock(slot)}–${clock(slot + 1)} · ${ENERGY_LABEL[value]}${busy[day]?.[slot] ? ` · 日历占用 ${busy[day]![slot]} 次` : ""}`}
            onPointerDown={(event) => { event.preventDefault(); painting.current = true; paint(day, slot); }}
            onPointerEnter={() => painting.current && paint(day, slot)} />)}
        </tr>)}</tbody>
      </table>
    </div>
    <p className="pl-legend"><span className="pl-key" data-k="l3" />高精力　<span className="pl-key" data-k="l2" />中精力　<span className="pl-key" data-k="l1" />低精力　<span className="pl-key" data-k="busy" />未来两周日历占用</p>
    {impact.error && <p role="status">{impact.error}</p>}
    {impact.pending && <ImpactCard impact={impact.pending.impact} busy={impact.busy} onApply={() => void impact.apply()} onCancel={impact.cancel} />}
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
