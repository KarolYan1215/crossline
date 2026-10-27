/**
 * Geometry for the plan page's hand-drawn SVG charts: scales, ticks, bands and date positions. Pure, so the shapes are tested without
 * rendering anything.
 */

import { tFor, type Locale } from "../../lib/i18n";
import { monthLabel } from "../timeline/format";

const DAY = 86_400_000;

/** Hours with one decimal, from minutes: 「4.5」. */
export const hours = (minutes: number) => Math.round((minutes / 60) * 10) / 10;
/** 「10/7」 from 2026-10-07. */
export const md = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;

/** Round tick values from zero up to at least `max`, at most `count` + 1 of them, on a 1–2–5 step. */
export function linearTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((factor) => factor * magnitude).find((value) => value >= raw) ?? 10 * magnitude;
  const ticks: number[] = [];
  for (let value = 0; value < max + step * 0.999; value += step) ticks.push(Math.round(value * 1e6) / 1e6);
  return ticks;
}

/** A linear map from [0, domainMax] to [rangeFrom, rangeTo]; the range may run downwards (an SVG y axis). */
export const linear = (domainMax: number, rangeFrom: number, rangeTo: number) =>
  (value: number) => rangeFrom + (Math.max(0, value) / Math.max(1e-9, domainMax)) * (rangeTo - rangeFrom);

/** A log map from [min, max] to [rangeFrom, rangeTo]; values are clamped into the domain. */
export function logScale(min: number, max: number, rangeFrom: number, rangeTo: number) {
  const lo = Math.log(min), hi = Math.log(Math.max(max, min * 1.0001));
  return (value: number) => rangeFrom + ((Math.log(Math.min(max, Math.max(min, value))) - lo) / (hi - lo)) * (rangeTo - rangeFrom);
}

/** Minute ticks a person reads at a glance (5 分 … 8 时), the ones inside [min, max]. */
const MINUTE_TICKS = [5, 10, 15, 30, 60, 120, 240, 480, 960];
export function logDomain(values: number[]): { min: number; max: number; ticks: number[] } {
  const positive = values.filter((value) => value > 0);
  const low = positive.length ? Math.min(...positive) : 15, high = positive.length ? Math.max(...positive) : 120;
  const min = [...MINUTE_TICKS].reverse().find((tick) => tick <= low * 0.9) ?? 5;
  const max = MINUTE_TICKS.find((tick) => tick >= high * 1.1) ?? 960;
  return { min, max: Math.max(max, min * 4), ticks: MINUTE_TICKS.filter((tick) => tick >= min && tick <= Math.max(max, min * 4)) };
}
/** 「30 分」, 「2 时」 / "30 min", "2 h". */
export const minuteLabel = (minutes: number, locale?: Locale) =>
  minutes >= 60 ? tFor(locale)("{{n}} 时", { n: minutes / 60 }) : tFor(locale)("{{n}} 分", { n: minutes });

/** `count` equal bands across `width`, each with a centred bar of `fill` of the band. */
export function bands(count: number, width: number, fill = 0.62) {
  const band = width / Math.max(1, count);
  const bar = Math.max(2, band * fill);
  return { band, bar, x: (index: number) => index * band + (band - bar) / 2, centre: (index: number) => index * band + band / 2 };
}

/** Label every n-th band so labels `minPx` wide never overlap. */
export const labelEvery = (band: number, minPx: number) => Math.max(1, Math.ceil(minPx / Math.max(1, band)));

/**
 * Where a day sits on an axis that starts at `start` and spans `spanDays`, as a share 0–1 (the start of the day). Days outside the axis
 * are clamped to its edge and say which side they fell off, so a deadline after the horizon is drawn at the edge, marked as beyond it.
 */
export function dayAt(day: string, start: string, spanDays: number): { at: number; clipped: "before" | "after" | null } {
  const offset = (Date.parse(`${day}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / DAY;
  if (offset < 0) return { at: 0, clipped: "before" };
  if (offset > spanDays) return { at: 1, clipped: "after" };
  return { at: offset / spanDays, clipped: null };
}

/** Axis ticks for a span of days: weekly up to 8 weeks, fortnightly up to 16, otherwise every four weeks. */
export function dayTicks(start: string, spanDays: number): string[] {
  const step = spanDays <= 56 ? 7 : spanDays <= 112 ? 14 : 28;
  const ticks: string[] = [];
  for (let offset = 0; offset <= spanDays; offset += step) ticks.push(new Date(Date.parse(`${start}T12:00:00Z`) + offset * DAY).toISOString().slice(0, 10));
  return ticks;
}

/** A level 0–4 for a heatmap cell, from its minutes against the busiest cell (0 = none). */
export const heatLevel = (minutes: number, max: number) => minutes <= 0 || max <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((minutes / max) * 4)));

/**
 * The width of a label in Arial at `px`: CJK and full-width characters one em, digits and Latin about 0.58 em. Curly quotes, dashes and
 * the ellipsis count as one em too: Arial draws them narrower, but a CJK fallback font draws them full width, and a label measured short
 * runs into its neighbour.
 */
export function textWidth(text: string, px = 12): number {
  let width = 0;
  for (const char of text) width += /[⺀-￯‐-‧]/.test(char) ? px : /[A-Z]/.test(char) ? px * 0.68 : /\s/.test(char) ? px * 0.3 : px * 0.58;
  return Math.ceil(width);
}

/** `text` cut short with 「…」 so it measures at most `max` (whole when it fits; empty when not even one character and the ellipsis fit). */
export function fitText(text: string, max: number, px = 12): string {
  if (textWidth(text, px) <= max) return text;
  const chars = [...text];
  for (let keep = chars.length - 1; keep > 0; keep -= 1) {
    const cut = `${chars.slice(0, keep).join("").trimEnd()}…`;
    if (textWidth(cut, px) <= max) return cut;
  }
  return "";
}

/**
 * The milestone axis's name lanes (decided 2026-10-21, after names on the real account were drawn on top of one another and leader lines
 * ran through them): lanes stack above the axis, lane 0 nearest; a name in lane k hangs from a leader at its marker that rises through
 * lanes 0…k-1. `AXIS_LABEL` is the vertical arithmetic shared by the chart and the tests.
 */
export const AXIS_LABEL = {
  /** Distance between lanes; a 12px line with room to spare. */ laneH: 16,
  /** Baseline of lane 0 above the axis. */ firstBaseline: 13,
  /** A label's box around its baseline: CJK ascent, and the descent. */ ascent: 11, descent: 3,
  /** The marker's half-size on the axis (radius 5.5): nothing may come lower than this above the axis. */ marker: 6,
  /** Horizontal gap kept between two names, and between a name and a leader passing beside it. */ gap: 8, leaderGap: 2,
  /** The shortest a cut name may be: three characters and the ellipsis; two read as nothing. */ minWidth: 52
} as const;
export const axisLabelBaseline = (axisY: number, lane: number) => axisY - AXIS_LABEL.firstBaseline - lane * AXIS_LABEL.laneH;
/** A placed name's box (x, y, width, height) on an axis at `axisY`. */
export const axisLabelBox = (label: AxisLabel, axisY: number) => {
  const baseline = axisLabelBaseline(axisY, label.lane);
  return { x: label.left, y: baseline - AXIS_LABEL.ascent, w: label.width, h: AXIS_LABEL.ascent + AXIS_LABEL.descent };
};
/** A placed name's leader: from just above its marker up to the bottom of its box. */
export const axisLabelLeader = (x: number, label: AxisLabel, axisY: number) =>
  ({ x, y1: axisY - AXIS_LABEL.marker, y2: axisLabelBaseline(axisY, label.lane) + AXIS_LABEL.descent });

export type AxisLabel = { lane: number; left: number; width: number; text: string; anchor: "start" | "end" };

/**
 * Names beside markers on one axis, such that no two names touch and no leader crosses a name (pure; tested on crowded data). Markers are
 * taken right to left, so that in a cluster the later marker's name sits lowest and the earlier ones climb over its leader, a staircase;
 * taken left to right, the first long name blocked every leader after it. Each name starts at its marker (or, where the plot ends too
 * soon, ends at it), is cut short with 「…」 where it would run into what is already placed (a name in its lane, or a leader rising
 * through it), and takes the lowest lane where it keeps a set length of itself (or all), else the lane where it keeps the most, never
 * less than `minWidth`. Whether a name should climb for its length or stay low and leave the lanes above to its neighbours depends on
 * them, so the pass runs once per length in `LANE_LENGTHS` and the layout naming the most markers (then showing the most text) is kept. A
 * name with no lane is left out (`null`): its marker stays, and its full name is shown on hover and focus. Returns, per input index, the
 * lane, the box's left edge and width, and the text to draw.
 */
export function layoutAxisLabels(items: Array<{ x: number; text: string }>, bounds: { left: number; right: number },
  options: { lanes?: number; px?: number } = {}): Array<AxisLabel | null> {
  const score = (layout: Array<AxisLabel | null>) => layout.reduce((sum, label) => sum + (label ? 10_000 + label.width : 0), 0);
  return LANE_LENGTHS.map((enough) => axisLabelPass(items, bounds, options.lanes ?? 3, options.px ?? 12, enough))
    .reduce((best, layout) => score(layout) > score(best) ? layout : best);
}
/** The lengths a name may stop climbing at (∞ = only when whole), tried in turn by `layoutAxisLabels`. */
const LANE_LENGTHS = [Infinity, 120, 80, 64, AXIS_LABEL.minWidth];

function axisLabelPass(items: Array<{ x: number; text: string }>, bounds: { left: number; right: number }, lanes: number, px: number, enough: number): Array<AxisLabel | null> {
  const { gap, leaderGap, minWidth } = AXIS_LABEL;
  type Spot = { lane: number; left: number; right: number; anchor: "start" | "end" };
  type Placed = Spot & { index: number; x: number };
  const placed: Placed[] = [];
  const order = items.map((item, index) => ({ ...item, index, full: textWidth(item.text, px) })).sort((a, b) => b.x - a.x || b.index - a.index);
  for (const item of order) {
    const need = Math.min(item.full, minWidth);
    const found: Spot[] = [];
    for (let lane = 0; lane < lanes; lane += 1) {
      // The own leader rises through the lanes below: no name there may cover the marker.
      if (placed.some((other) => other.lane < lane && other.left - leaderGap < item.x && other.right + leaderGap > item.x)) continue;
      // What a name in this lane must keep clear of, and by how much: names in the lane, and leaders from higher lanes passing through it.
      const obstacles = placed.flatMap((other): Array<[number, number, number]> => other.lane === lane ? [[other.left, other.right, gap]]
        : other.lane > lane ? [[other.x, other.x, leaderGap]] : []);
      const start = Math.max(bounds.left, item.x - 2);
      if (!obstacles.some(([from, to, keep]) => from < start + 1 && to > start - keep)) {
        const width = Math.min(item.full, bounds.right - start, ...obstacles.filter(([from]) => from >= start + 1).map(([from, , keep]) => from - keep - start));
        if (width >= need) found.push({ lane, left: start, right: start + width, anchor: "start" });
      }
      if (bounds.right - start < item.full) {
        // Ending at the marker, for a name the plot's right edge would cut short.
        const end = Math.min(bounds.right, item.x + 2);
        if (!obstacles.some(([from, to, keep]) => from < end + keep && to > end - 1)) {
          const width = Math.min(item.full, end - bounds.left, ...obstacles.filter(([, to]) => to <= end - 1).map(([, to, keep]) => end - keep - to));
          if (width >= need) found.push({ lane, left: end - width, right: end, anchor: "end" });
        }
      }
    }
    const width = (spot: Spot) => spot.right - spot.left;
    // The lowest lane that keeps the name whole or long enough to read; else wherever it keeps the most.
    const best = found.find((spot) => width(spot) >= Math.min(item.full, enough))
      ?? found.reduce<Spot | undefined>((most, spot) => !most || width(spot) > width(most) ? spot : most, undefined);
    if (best) placed.push({ index: item.index, x: item.x, ...best });
  }
  const out: Array<AxisLabel | null> = items.map(() => null);
  for (const entry of placed) {
    const text = fitText(items[entry.index]!.text, entry.right - entry.left, px);
    if (!text) continue;
    const width = textWidth(text, px);
    out[entry.index] = { lane: entry.lane, text, width, anchor: entry.anchor, left: entry.anchor === "end" ? entry.right - width : entry.left };
  }
  return out;
}

const DAY_MS = 86_400_000;
/**
 * Month ticks from `start` to `end` (YYYY-MM-DD): the first of each month inside the span, every month up to nine months and every
 * other one beyond; a label carries the year on the first tick and wherever the year turns (「2026年10月」, 「11月」, 「2027年1月」).
 */
export function monthTicks(start: string, end: string, locale?: Locale): Array<{ day: string; label: string }> {
  const span = (Date.parse(`${end}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / DAY_MS;
  const step = span > 270 ? 2 : 1;
  const ticks: Array<{ day: string; label: string }> = [];
  let year = Number(start.slice(0, 4)), month = Number(start.slice(5, 7));
  if (Number(start.slice(8, 10)) > 1) { month += 1; if (month > 12) { month = 1; year += 1; } }
  for (let guard = 0; guard < 40; guard += 1) {
    const day = `${year}-${String(month).padStart(2, "0")}-01`;
    if (day > end) break;
    const newYear = !ticks.length || ticks.at(-1)!.day.slice(0, 4) !== String(year);
    ticks.push({ day, label: monthLabel(locale, year, month, newYear) });
    month += step;
    while (month > 12) { month -= 12; year += 1; }
  }
  return ticks;
}

/**
 * The margins of the square estimate-vs-actual chart, from its tick labels (12px): the y axis's title 「实际」 sits in a band above the
 * plot so the top tick's label never runs into it, the left margin holds the widest y label, and the right margin is half the last x
 * label so that label, centred on the last tick, is not cut off at the edge. `titleBaseline` is where 「实际」 is drawn.
 */
export function scatterMargins(ticks: number[], px = 12, locale?: Locale): { left: number; right: number; top: number; bottom: number; titleBaseline: number } {
  const widths = ticks.map((tick) => textWidth(minuteLabel(tick, locale), px));
  const titleBaseline = px;
  return {
    left: Math.max(40, Math.max(0, ...widths) + 8),
    right: Math.max(6, Math.ceil((widths.at(-1) ?? 0) / 2) + 2),
    // The top tick's label is centred on the plot's top edge: half a line above it, plus a gap, clears the title's line.
    top: titleBaseline + Math.ceil(px * 0.3) + Math.ceil(px / 2) + 4,
    bottom: 28,
    titleBaseline
  };
}
