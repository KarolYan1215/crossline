"use client";

import { useEffect, useRef, useState } from "react";
import type { AvailabilityWindow, ImportancePreset } from "@crossline/core";
import type { ScheduleParams } from "@crossline/planner";
import { SegmentedControl, Slider } from "../ui/controls";
import { LineTag } from "../ui/tag";
import { Tip } from "../ui/overlay";
import { ImpactCard, useImpact } from "../task/impact";
import { gridFromWindows, gridHours, windowsFromGrid, SLOTS, type WeekGrid } from "./week-grid";

type Tab = "week" | "params" | "importance";
export type ImportanceRow = { id: string; title: string; line: string; weight: number; custom: boolean; preset: ImportancePreset };

/**
 * The three things the person sets for the schedule, in one place (they used to be in three): when they are free, how a day is packed,
 * and how much each milestone matters. Every change is previewed against the real schedule before it is applied.
 */
export function TimeControls({ windows, suggested, busy, params, presets, importance, labels, plannedHours }: {
  windows: AvailabilityWindow[]; suggested: AvailabilityWindow[]; busy: number[][]; params: ScheduleParams;
  presets: { buffered: ScheduleParams; asap: ScheduleParams }; importance: ImportanceRow[]; labels: Record<string, string>; plannedHours: number;
}) {
  const [tab, setTab] = useState<Tab>("week");
  return <section className="pl-card pl-controls" id="time" aria-label="时间与容量">
    <header><h2>时间与容量</h2>
      <SegmentedControl label="设置项" value={tab} onChange={setTab} options={[{ value: "week", label: "可用时段" },
        { value: "params", label: "排程参数" }, { value: "importance", label: "重要性" }]} /></header>
    {tab === "week" && <WeekEditor windows={windows} suggested={suggested} busy={busy} plannedHours={plannedHours} />}
    {tab === "params" && <ParamsPanel params={params} presets={presets} />}
    {tab === "importance" && <ImportancePanel rows={importance} labels={labels} />}
  </section>;
}

const ORDER = [1, 2, 3, 4, 5, 6, 0];
const DAY_LABEL = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const BRUSH = [{ value: "3", label: "高精力" }, { value: "2", label: "中精力" }, { value: "1", label: "低精力" }, { value: "0", label: "擦除" }] as const;
const ENERGY_LABEL = ["不可用", "低精力", "中精力", "高精力"];
const clock = (slot: number) => `${String(Math.floor(slot / 2)).padStart(2, "0")}:${slot % 2 ? "30" : "00"}`;

/** The week painted on a grid: pick an energy, drag over half hours. Calendar commitments of the next two weeks show through as dots. */
function WeekEditor({ windows, suggested, busy, plannedHours }: { windows: AvailabilityWindow[]; suggested: AvailabilityWindow[]; busy: number[][]; plannedHours: number }) {
  const initial = useRef(JSON.stringify(gridFromWindows(windows)));
  const [grid, setGrid] = useState<WeekGrid>(() => gridFromWindows(windows));
  const [brush, setBrush] = useState<(typeof BRUSH)[number]["value"]>("3");
  const painting = useRef(false);
  const impact = useImpact();
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
      <span className="pl-hours mono" title="可用时段每周小时数，对比未来 7 天已排入的小时数">每周 {hours} h · 已排 {plannedHours} h</span>
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
  const impact = useImpact();
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

/** Each approved milestone's importance on a 0–100 slider, the system's preset as a tick, the reasons for the preset on hover. */
function ImportancePanel({ rows, labels }: { rows: ImportanceRow[]; labels: Record<string, string> }) {
  const [values, setValues] = useState(() => Object.fromEntries(rows.map((row) => [row.id, row.weight])));
  const [active, setActive] = useState<string | null>(null);
  const impact = useImpact();
  if (!rows.length) return <p className="muted">尚无已批准的里程碑。</p>;
  const propose = (id: string, weight: number) => { setActive(id); void impact.propose({ kind: "weight", milestoneId: id, weight }); };
  return <div className="pl-importance">
    {rows.map((row) => <div key={row.id} className="pl-imp-row" data-line={row.line}>
      <span className="pl-imp-title"><LineTag line={row.line}>{labels[row.line] ?? row.line}</LineTag><b title={row.title}>{row.title}</b></span>
      <Slider label={`${row.title} 重要性`} value={values[row.id] ?? row.weight} preset={row.preset.weight}
        onChange={(value) => setValues({ ...values, [row.id]: value })}
        onCommit={(value) => value !== row.weight && propose(row.id, value)} />
      <Tip content={<span className="pl-basis">{row.preset.basis.map((item) => <span key={item.key}><b>{item.label} {item.points >= 0 ? "+" : ""}{item.points}</b>{item.detail}</span>)}
        <span><b>系统预设 {row.preset.weight}</b></span></span>}>
        <button type="button" className="pl-imp-basis" aria-label={`${row.title} 预设依据`}>{row.custom ? "已调整" : "预设"}</button>
      </Tip>
      {row.custom && row.weight !== row.preset.weight && <button type="button" className="pl-imp-reset" disabled={impact.busy}
        onClick={() => { setValues({ ...values, [row.id]: row.preset.weight }); propose(row.id, row.preset.weight); }}>恢复预设</button>}
      {active === row.id && impact.pending && <ImpactCard impact={impact.pending.impact} busy={impact.busy} onApply={() => void impact.apply()}
        onCancel={() => { impact.cancel(); setActive(null); setValues({ ...values, [row.id]: row.weight }); }} />}
    </div>)}
    {impact.error && <p role="status">{impact.error}</p>}
  </div>;
}
