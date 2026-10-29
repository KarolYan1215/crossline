"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { adviceChanges, applyAdvice, type AvailabilityWindow, type EnergyAdvice } from "@crossline/core";
import type { ScheduleParams } from "@crossline/planner";
import { Copy, Eye, ListOrdered, Undo2 } from "lucide-react";
import { SegmentedControl, Slider } from "../ui/controls";
import { Sheet, Tip } from "../ui/overlay";
import { LineTag, Tag } from "../ui/tag";
import { ICON } from "../ui/icon-button";
import { ImpactCard } from "../task/impact";
import { usePlanImpact } from "./preview-context";
import { RhythmMini } from "./plan-stats-charts";
import { copyToWeekdays, gridFromWindows, gridHours, windowsFromGrid, SLOTS, type WeekGrid } from "./week-grid";
import { useLocale, useT } from "../locale-context";
import { tFor, weekdayShort, type Locale, type Translate } from "../../lib/i18n";

const ORDER = [1, 2, 3, 4, 5, 6, 0];
/** The labels below are keys, translated where shown. */
const BRUSH = [{ value: "3", label: "高精力" }, { value: "2", label: "中精力" }, { value: "1", label: "低精力" }, { value: "0", label: "擦除" }] as const;
const ENERGY_LABEL = ["不可用", "低精力", "中精力", "高精力"];
const clock = (slot: number) => `${String(Math.floor(slot / 2)).padStart(2, "0")}:${slot % 2 ? "30" : "00"}`;
/** Kept in Chinese (they are the keys); translated where shown. */
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
  const t = useT();
  const locale = useLocale();
  const [grid, setGrid] = useState<WeekGrid>(saved);
  const [brush, setBrush] = useState<(typeof BRUSH)[number]["value"]>("3");
  const [setAside, setSetAside] = useState(advice.dismissed);
  const painting = useRef(false);
  // The day last painted, which 「复制到工作日」 copies (Monday until something is painted).
  const [lastDay, setLastDay] = useState(1);
  const impact = usePlanImpact();
  useEffect(() => {
    const stop = () => { painting.current = false; };
    window.addEventListener("pointerup", stop);
    return () => window.removeEventListener("pointerup", stop);
  }, []);
  const paint = (day: number, slot: number) => { setLastDay(day); setGrid((current) => {
    if (current[day]![slot] === Number(brush)) return current;
    const next = current.map((row) => [...row]);
    next[day]![slot] = Number(brush);
    return next;
  }); };
  const copied = copyToWeekdays(grid, lastDay);
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
  return <section className="pl-card pl-time" id="time" aria-label={t("时段与精力")}>
    <header><h2 className="ds-serif">{t("时段与精力")}</h2>
      <span className="pl-hours mono" title={t("刷涂的可用时段每周小时数，对比访谈中所述的每周投入")}>{t("每周 {{n}} h", { n: hours })}{statedWeekly !== null ? ` · ${t("所述 {{n}} h", { n: statedWeekly })}` : ""}</span>
      <small className="pl-time-hint">{t("按住拖动刷涂；改完先预览影响，点「应用」才生效")}</small></header>
    <div className="pl-time-body">
      <div className="pl-week-editor">
        <div className="pl-toolbar">
          <SegmentedControl label={t("画笔")} value={brush} onChange={setBrush} options={BRUSH.map((item) => ({ value: item.value, label: t(item.label) }))} />
          <button type="button" className="pl-tool" disabled={copied === grid} onClick={() => setGrid(copied)}
            title={t("把{{day}}的时段复制到周一至周五（周末不变）", { day: weekdayShort(locale, lastDay) })}><Copy {...ICON} />{t("复制到工作日")}</button>
          {proposed && <button type="button" className="pl-tool" onClick={() => setGrid(gridFromWindows(proposed.windows))} title={proposed.why || t("访谈按硬约束主线的规则提议的可用时段")}>
            <Undo2 {...ICON} />{t("采用访谈提议")}</button>}
          {suggested.length > 0 && <button type="button" className="pl-tool" onClick={() => setGrid(gridFromWindows(suggested))} title={t("按近两周屏幕活动推断的在场时段")}>{t("采用活动建议")}</button>}
          {dirty && <button type="button" className="pl-tool" onClick={() => setGrid(JSON.parse(initial.current) as WeekGrid)}>{t("还原")}</button>}
          <button type="button" className="primary-button pl-preview-button" disabled={!dirty || empty || impact.busy} onClick={() => propose(grid)}>
            <Eye {...ICON} />{impact.busy ? t("计算中…") : t("预览影响")}</button>
        </div>
        <div className="pl-grid-scroll">
          <table className="pl-grid" aria-label={t("每周可用时段")} onPointerLeave={() => { painting.current = false; }}>
            <thead><tr><th /><th colSpan={SLOTS} className="pl-axis-cell" scope="colgroup">
              <div className="pl-hour-axis" aria-hidden="true">{Array.from({ length: 13 }, (_, index) => index * 2).map((hour) =>
                <span key={hour} style={{ left: `${(hour / 24) * 100}%` }} data-edge={hour === 0 ? "start" : hour === 24 ? "end" : undefined}>{hour}</span>)}</div>
            </th></tr></thead>
            <tbody>{ORDER.map((day) => <tr key={day}><th scope="row">{weekdayShort(locale, day)}</th>
              {grid[day]!.map((value, slot) => {
                const advised = overlay && value && live!.levels[day]![slot] && live!.levels[day]![slot] !== value ? live!.levels[day]![slot] : undefined;
                return <td key={slot} data-level={value} data-busy={busy[day]?.[slot] ? true : undefined} data-advice={advised}
                  title={`${weekdayShort(locale, day)} ${clock(slot)}–${clock(slot + 1)} · ${t(ENERGY_LABEL[value]!)}${advised ? ` · ${t("本周建议{{level}}", { level: t(ENERGY_LABEL[advised]!) })}` : ""}${busy[day]?.[slot] ? ` · ${t("日历占用 {{count}} 次", { count: busy[day]![slot] })}` : ""}`}
                  onPointerDown={(event) => { event.preventDefault(); painting.current = true; paint(day, slot); }}
                  onPointerEnter={() => painting.current && paint(day, slot)} />;
              })}
            </tr>)}</tbody>
          </table>
        </div>
        <div className="pl-legend"><span><span className="pl-key" data-k="l3" />{t("高精力")}</span><span><span className="pl-key" data-k="l2" />{t("中精力")}</span>
          <span><span className="pl-key" data-k="l1" />{t("低精力")}</span><span><span className="pl-key" data-k="l0" />{t("不可用")}</span><span><span className="pl-key" data-k="busy" />{t("未来两周日历占用")}</span>
          {overlay && <span><span className="pl-key" data-k="advice" />{t("底部色条：本周建议的精力")}</span>}</div>
        {live && !setAside && <Advice advice={live} changes={changes!} busy={impact.busy}
          onApprove={() => { const next = applyAdvice(grid, live.levels); setGrid(next); propose(next); }} onDismiss={() => void dismiss()} />}
        {advice.value && "insufficient" in advice.value && <p className="pl-chart-foot">{t("本周精力建议：{{text}}。", { text: advice.value.insufficient })}</p>}
        {impact.error && <p role="status">{impact.error}</p>}
        {impact.pending && <ImpactCard impact={impact.pending.impact} busy={impact.busy} onApply={() => void impact.apply()} onCancel={impact.cancel} />}
      </div>
      <div className="pl-compare" aria-label={t("近 8 周实际节律")}>
        <h3>{t("近 8 周实际节律")}</h3>
        <div className="pl-compare-row">
          {dirty ? <><RhythmMini worked={worked} pattern={saved} title={t("调整前")} /><RhythmMini worked={worked} pattern={grid} title={t("调整后")} /></>
            : <RhythmMini worked={worked} pattern={grid} title={t("现状")} />}
        </div>
        <p className="pl-legend"><span><span className="pl-key" data-k="heat" />{t("计时分钟（越深越多）")}</span><span><span className="pl-key" data-k="lvbar" />{t("色条为该小时的精力设置")}</span>
          {!workedTotal && <span>{t("尚无计时记录")}</span>}</p>
      </div>
    </div>
  </section>;
}

/** The advice's footing in one line, and 「偏薄」 when it rests on less than a week of nights or fewer than four reports (decided 2026-10-15:
 * said, not a reason to refuse 批准). */
export function evidenceLine(evidence: { nights?: number; reports?: number }, locale?: Locale): string {
  const t = tFor(locale);
  const nights = evidence.nights ?? 0, reports = evidence.reports ?? 0;
  const thin = nights < 7 || reports < 4;
  const sleep = nights ? t("{{count}} 晚睡眠记录", { count: nights }) : t("无睡眠记录");
  return `${t("依据：{{count}} 次自评、{{sleep}}", { count: reports, sleep })}${thin ? t("，依据偏薄") : ""}`;
}

function Advice({ advice, changes, busy, onApprove, onDismiss }: { advice: Extract<EnergyAdvice, { levels: number[][] }>; changes: { cells: number; raised: number; lowered: number };
  busy: boolean; onApprove: () => void; onDismiss: () => void }) {
  const t = useT();
  const locale = useLocale();
  const reviewed = advice.review.state === "agreed" || advice.review.state === "adjusted";
  return <div className="pl-advice" role="note" aria-label={t("本周精力建议")}>
    <div className="pl-advice-head"><b>{t("本周建议")}</b><small className="mono">{advice.computedAt.slice(5, 10).replace("-", "/")}</small>
      <Tag tone={reviewed ? "info" : "neutral"}>{REVIEW_LABEL[advice.review.state] ? t(REVIEW_LABEL[advice.review.state]!) : ""}</Tag>
      <Tip content={<span className="pl-basis">{advice.basis.map((line) => <span key={line}>{line}</span>)}
        {advice.review.findings.map((finding) => <span key={finding.claim} className="gen">{finding.claim}</span>)}</span>}>
        <button type="button" className="pl-imp-basis">{t("依据")}</button>
      </Tip></div>
    <p className={reviewed ? "gen" : undefined}>{advice.summary}</p>
    <p className="pl-advice-basis">{evidenceLine(advice.evidence, locale)}</p>
    <p className="pl-advice-count">{changes.cells
      ? t("改动 {{n}} 小时：调高 {{raised}} h，调低 {{lowered}} h", { n: changes.cells / 2, raised: changes.raised / 2, lowered: changes.lowered / 2 }) : t("与当前设置一致")}</p>
    {advice.sources.length > 0 && <p className="pl-advice-sources">{advice.sources.map((source) =>
      <a key={source.id} href={source.url} target="_blank" rel="noreferrer noopener" title={source.url}>{source.title}</a>)}</p>}
    {changes.cells > 0 && <div className="pl-toolbar">
      <button type="button" className="primary-button" disabled={busy} onClick={onApprove}>{t("批准建议并预览")}</button>
      <button type="button" onClick={onDismiss}>{t("忽略")}</button>
    </div>}
  </div>;
}

/**
 * Each line's share of the week (decided 2026-10-10; out of the advanced fold on 2026-10-28): a soft floor the scheduler meets before
 * ordering by deadline tier, so a line whose milestones are far off still gets its hours. Starts from what the person said in the
 * interview; previewed like any change. Each line's long-term goal is the name's hover text (it is edited on 主线).
 */
export function SharesCard({ shares, labels, lineOrder, goals }: { shares: { effective: Record<string, number>; custom: boolean }; labels: Record<string, string>;
  lineOrder: string[]; goals: Array<{ line: string; goal: string | null }> }) {
  const t = useT();
  const [draft, setDraft] = useState(shares.effective);
  const impact = usePlanImpact();
  const total = lineOrder.reduce((sum, line) => sum + (draft[line] ?? 0), 0);
  const changed = lineOrder.some((line) => (draft[line] ?? 0) !== (shares.effective[line] ?? 0));
  const goalOf = new Map(goals.map((item) => [item.line, item.goal]));
  return <section className="pl-card pl-params pl-shares" aria-labelledby="pl-shares-card">
    <header><h2 id="pl-shares-card" className="ds-serif">{t("主线份额")}</h2><small>{t("截止优先，其余按份额分配")}</small>
      <span className="pl-head-actions">
        {changed && <button type="button" className="pl-tool" onClick={() => setDraft(shares.effective)}>{t("还原")}</button>}
        <button type="button" className="pl-tool" disabled={!changed || total > 100 || impact.busy}
          onClick={() => void impact.propose({ kind: "shares", shares: draft })}><Eye {...ICON} />{impact.busy ? t("计算中…") : t("预览影响")}</button>
      </span></header>
    <small className="pl-chart-foot">{shares.custom ? t("本人设定。") : t("来自访谈中所述的投入比例。")}{t("每条主线一周至少得到这一份可用时间；有截止的工作仍然优先。")}</small>
    {lineOrder.map((line) => <div key={line} className="pl-param" data-line={line}>
      <LineTag line={line} title={goalOf.get(line) ?? t("尚未选定长期目标")}>{labels[line] ?? line}</LineTag>
      <Slider label={t("{{line}}的份额", { line: labels[line] ?? line })} min={0} max={100} step={5} format={(value) => `${value}%`} value={draft[line] ?? 0}
        onChange={(value) => setDraft({ ...draft, [line]: value })} />
    </div>)}
    {total > 100 && <p role="status">{t("合计 {{n}}%，超过 100%。", { n: total })}</p>}
    {impact.error && <p role="status">{impact.error}</p>}
    {impact.pending && <ImpactCard impact={impact.pending.impact} busy={impact.busy} onApply={() => void impact.apply()}
      onCancel={() => { impact.cancel(); setDraft(shares.effective); }} />}
  </section>;
}

/**
 * 「高级」 (2026-10-28: out of its fold, as the draft has it): how a day is packed, with the scheduler's own ordering a click away (the
 * read-only ranking table in a sheet, `children`) and the written explanation below it (`explain`). 「排程依据说明」 in the head links here.
 */
export function AdvancedCard({ params, presets, children, explain }: { params: ScheduleParams; presets: { buffered: ScheduleParams; asap: ScheduleParams };
  children: ReactNode; explain: ReactNode }) {
  const t = useT();
  return <section className="pl-card pl-advanced" id="advanced" aria-labelledby="pl-advanced-title">
    <header><h2 id="pl-advanced-title" className="ds-serif">{t("高级")}</h2><small>{t("打包参数与排程顺序")}</small></header>
    <ParamsPanel params={params} presets={presets} />
    <div className="pl-toolbar">
      <Sheet title={t("排程顺序")} side="right" trigger={<button type="button" className="pl-tool"><ListOrdered {...ICON} />{t("排程顺序表")}</button>}>
        <small className="pl-chart-foot">{t("排序规则：优先档 → 重要性 → 截止日。只读；截止日在任务卡上修改。")}</small>
        {children}
      </Sheet>
    </div>
    {explain}
  </section>;
}

/** The labels are keys; `format` writes the value in the page's language. */
const PARAM_ROWS = [
  { key: "gapMinutes", label: "任务间隔", min: 0, max: 30, step: 5, format: (v: number, t: Translate) => t("{{n}} 分", { n: v }) },
  { key: "maxDailyShare", label: "每日最高占用", min: 50, max: 100, step: 5, format: (v: number) => `${v}%` },
  { key: "focusCapMinutes", label: "单段专注上限", min: 0, max: 180, step: 15, format: (v: number, t: Translate) => v ? t("{{n}} 分", { n: v }) : t("不限") },
  { key: "deadlineBufferDays", label: "截止前缓冲", min: 0, max: 5, step: 1, format: (v: number, t: Translate) => t("{{count}} 天", { count: v }) }
] as const;
const toSlider = (params: ScheduleParams, key: keyof ScheduleParams) => key === "maxDailyShare" ? Math.round(params[key] * 100) : params[key];
const fromSlider = (key: keyof ScheduleParams, value: number) => key === "maxDailyShare" ? value / 100 : value;
const same = (a: ScheduleParams, b: ScheduleParams) => JSON.stringify(a) === JSON.stringify(b);

/** How a day is packed: two presets and the four numbers behind them. */
function ParamsPanel({ params, presets }: { params: ScheduleParams; presets: { buffered: ScheduleParams; asap: ScheduleParams } }) {
  const t = useT();
  const [draft, setDraft] = useState(params);
  const impact = usePlanImpact();
  const preset = same(draft, presets.buffered) ? "buffered" : same(draft, presets.asap) ? "asap" : "custom";
  return <div className="pl-params">
    <div className="pl-toolbar">
      <SegmentedControl label={t("预设")} value={preset} onChange={(value) => value !== "custom" && setDraft(presets[value])}
        options={[{ value: "buffered", label: t("留缓冲") }, { value: "asap", label: t("尽早完成") }, { value: "custom", label: t("自定义") }]} />
      {!same(draft, params) && <button type="button" className="pl-tool" onClick={() => setDraft(params)}>{t("还原")}</button>}
      <button type="button" className="pl-tool" disabled={same(draft, params) || impact.busy}
        onClick={() => void impact.propose({ kind: "params", params: draft })}><Eye {...ICON} />{impact.busy ? t("计算中…") : t("预览影响")}</button>
    </div>
    <div className="pl-param-grid">{PARAM_ROWS.map((row) => <div key={row.key} className="pl-param pl-param-box">
      <span>{t(row.label)}</span>
      <Slider label={t(row.label)} min={row.min} max={row.max} step={row.step} format={(value) => row.format(value, t)} value={toSlider(draft, row.key)}
        onChange={(value) => setDraft({ ...draft, [row.key]: fromSlider(row.key, value) })} />
    </div>)}</div>
    {impact.error && <p role="status">{impact.error}</p>}
    {impact.pending && <ImpactCard impact={impact.pending.impact} busy={impact.busy} onApply={() => void impact.apply()}
      onCancel={() => { impact.cancel(); setDraft(params); }} />}
  </div>;
}
