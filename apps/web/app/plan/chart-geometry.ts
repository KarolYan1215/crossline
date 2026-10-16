/**
 * Geometry for the plan page's hand-drawn SVG charts: scales, ticks, bands and date positions. Pure, so the shapes are tested without
 * rendering anything.
 */

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
export const minuteLabel = (minutes: number) => minutes >= 60 ? `${minutes / 60} 时` : `${minutes} 分`;

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

/** The width of a label in Arial at `px`: CJK and full-width characters one em, digits and Latin about 0.58 em. */
export function textWidth(text: string, px = 12): number {
  let width = 0;
  for (const char of text) width += /[⺀-￯]/.test(char) ? px : /[A-Z]/.test(char) ? px * 0.68 : /\s/.test(char) ? px * 0.3 : px * 0.58;
  return Math.ceil(width);
}

/**
 * Labels beside points on one axis, packed into as few rows as keep them apart: each label starts at its point (or, where it would run
 * off the right edge, ends there) and takes the lowest row whose last label ends `gap` before it. Points are taken left to right.
 * Returns, per input index, the row and the label's left edge.
 */
export function packLabels(items: Array<{ x: number; width: number }>, plotWidth: number, gap = 10): Array<{ row: number; left: number }> {
  const order = items.map((item, index) => ({ ...item, index })).sort((a, b) => a.x - b.x || a.index - b.index);
  const rowEnds: number[] = [];
  const out: Array<{ row: number; left: number }> = items.map(() => ({ row: 0, left: 0 }));
  for (const item of order) {
    const left = Math.max(0, item.x - 4 + item.width > plotWidth ? item.x + 4 - item.width : item.x - 4);
    let row = rowEnds.findIndex((end) => end + gap <= left);
    if (row < 0) { row = rowEnds.length; rowEnds.push(0); }
    rowEnds[row] = left + item.width;
    out[item.index] = { row, left };
  }
  return out;
}

const DAY_MS = 86_400_000;
/**
 * Month ticks from `start` to `end` (YYYY-MM-DD): the first of each month inside the span, every month up to nine months and every
 * other one beyond; a label carries the year on the first tick and wherever the year turns (「2026年10月」, 「11月」, 「2027年1月」).
 */
export function monthTicks(start: string, end: string): Array<{ day: string; label: string }> {
  const span = (Date.parse(`${end}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / DAY_MS;
  const step = span > 270 ? 2 : 1;
  const ticks: Array<{ day: string; label: string }> = [];
  let year = Number(start.slice(0, 4)), month = Number(start.slice(5, 7));
  if (Number(start.slice(8, 10)) > 1) { month += 1; if (month > 12) { month = 1; year += 1; } }
  for (let guard = 0; guard < 40; guard += 1) {
    const day = `${year}-${String(month).padStart(2, "0")}-01`;
    if (day > end) break;
    const newYear = !ticks.length || ticks.at(-1)!.day.slice(0, 4) !== String(year);
    ticks.push({ day, label: newYear ? `${year}年${month}月` : `${month}月` });
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
export function scatterMargins(ticks: number[], px = 12): { left: number; right: number; top: number; bottom: number; titleBaseline: number } {
  const widths = ticks.map((tick) => textWidth(minuteLabel(tick), px));
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
