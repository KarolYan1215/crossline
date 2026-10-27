import { CHRONOTYPE_LABEL, ENERGY_CATEGORIES, SCHWARTZ_VALUES, TYPE_AXES, TYPE_GROUPS, TYPE_TABLE, type EnergyRhythm, type PortraitReport } from "@crossline/core";
import { INTERFACE_SERIF_STRINGS } from "../ui/serif-strings";
import { tFor, type Locale } from "../../lib/i18n";

/**
 * The poster's layout as pure functions (decided 2026-10-12, after the real report's render: percentages over captions, labels on top of
 * each other, two advice dots on one spot). Kept apart from the React so each rule is tested.
 */

/**
 * One typing axis as a bar on a track (percent of the track's width): it grows from the middle towards the pole the person leans to, so
 * 「单线主导 94% 多线并行」 cannot be read backwards; a lean of two thirds or more carries its percentage inside the bar, a weaker one beside its end.
 */
export function axisBar(score: number): { side: "left" | "right"; percent: number; from: number; width: number; inside: boolean } {
  const right = score >= 50;
  const percent = right ? score : 100 - score;
  return { side: right ? "right" : "left", percent, from: right ? 50 : score, width: Math.abs(score - 50), inside: percent >= 66 };
}

/**
 * Dots that land on the same spot are spread round it at fixed angles, far enough apart (2r + 2 between centres) never to touch; dots
 * that are merely close are then pushed apart along the line between them until none are nearer than that. Far dots never move.
 */
export function dodgeMatrix<T extends { x: number; y: number }>(points: T[], r: number): T[] {
  const out = spreadSameSpot(points, r);
  const gap = 2 * r + 2;
  for (let round = 0; round < 60; round += 1) {
    let moved = false;
    for (let a = 0; a < out.length; a += 1) for (let b = a + 1; b < out.length; b += 1) {
      const one = out[a]!, two = out[b]!;
      const distance = Math.hypot(two.x - one.x, two.y - one.y);
      if (distance >= gap || distance === 0) continue;
      const push = (gap - distance) / 2 + 0.01, dx = (two.x - one.x) / distance, dy = (two.y - one.y) / distance;
      out[a] = { ...one, x: one.x - dx * push, y: one.y - dy * push };
      out[b] = { ...two, x: two.x + dx * push, y: two.y + dy * push };
      moved = true;
    }
    if (!moved) break;
  }
  return out;
}

function spreadSameSpot<T extends { x: number; y: number }>(points: T[], r: number): T[] {
  const groups = new Map<string, number[]>();
  points.forEach((point, index) => { const key = `${Math.round(point.x)}:${Math.round(point.y)}`; groups.set(key, [...(groups.get(key) ?? []), index]); });
  const out = [...points];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    // The chord between neighbours on a circle of radius R is 2R·sin(π/n); R is chosen so it is the required distance.
    const radius = (r + 1) / Math.sin(Math.PI / members.length) + 0.01;
    members.forEach((index, position) => {
      const angle = -Math.PI / 2 + (position / members.length) * Math.PI * 2;
      const point = points[index]!;
      out[index] = { ...point, x: point.x + Math.cos(angle) * radius, y: point.y + Math.sin(angle) * radius };
    });
  }
  return out;
}

/** The legend group for activities an older report left without a category. */
export const UNCATEGORISED = "未分类";

export type EnergyLegendEntry = PortraitReport["energy"]["map"][number] & { number: number };
/**
 * The energy map's numbering: grouped by the six fixed categories (an older report's uncategorised activities last), the most loved and
 * skilled first within a group, numbered once so the dot and its legend line carry the same number.
 */
export function energyLegend(map: PortraitReport["energy"]["map"]): Array<{ category: string; entries: EnergyLegendEntry[] }> {
  // The categories are stored values (Chinese in both languages); they are translated where the legend is drawn.
  const order = [...ENERGY_CATEGORIES as readonly string[], UNCATEGORISED];
  const categoryOf = (item: PortraitReport["energy"]["map"][number]) => (item.category && order.includes(item.category) ? item.category : UNCATEGORISED);
  const sum = (item: PortraitReport["energy"]["map"][number]) => (item.loveScore ?? 0) + (item.skillScore ?? 0);
  let number = 0;
  return order.map((category) => ({ category, entries: map.filter((item) => categoryOf(item) === category).sort((a, b) => sum(b) - sum(a))
    .map((item) => ({ ...item, number: (number += 1) })) })).filter((group) => group.entries.length);
}

/** The values in the radar's order when they are exactly Schwartz's ten; otherwise none, and no radar is drawn. */
export function radarValues(values: NonNullable<PortraitReport["compass"]["values"]> | undefined): NonNullable<PortraitReport["compass"]["values"]> | null {
  if (!values || values.length !== SCHWARTZ_VALUES.length) return null;
  const ordered = SCHWARTZ_VALUES.map((value) => values.find((item) => item.name === value.name));
  return ordered.every(Boolean) ? ordered as NonNullable<PortraitReport["compass"]["values"]> : null;
}

/** 9.5 → "9:30"; hours past midnight wrap. */
export const hourClock = (hours: number) => { const m = ((Math.round(hours * 60) % 1440) + 1440) % 1440; return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`; };

/**
 * The 「精力节律」 page's four readings under the curve, each with what it rests on; a reading the record cannot give yet says what it
 * needs instead of a number. Social jetlag keeps its sign: positive is later on free days.
 */
export function rhythmStats(rhythm: EnergyRhythm, locale?: Locale): Array<{ title: string; value: string; detail: string }> {
  const t = tFor(locale);
  const chrono = rhythm.chronotype;
  const sjl = chrono ? Math.round(chrono.sjlRel * 10) / 10 : null;
  const pending = t("待定");
  const twoEach = t("需要工作日与休息日各两晚睡眠记录");
  return [
    { title: t("最佳时段"), value: `${hourClock(rhythm.peak.start)}–${hourClock(rhythm.peak.end)}`, detail: t("模型曲线最高的连续 3 小时") },
    chrono?.chronotype ? { title: t("早晚型"), value: t(CHRONOTYPE_LABEL[chrono.chronotype]), detail: t("休息日校正睡眠中点 {{time}}", { time: hourClock(chrono.msfSc!) }) }
      : { title: t("早晚型"), value: pending, detail: twoEach },
    sjl === null ? { title: t("社会时差"), value: pending, detail: twoEach }
      : { title: t("社会时差"), value: t("{{hours}} 小时", { hours: `${sjl > 0 ? "+" : ""}${sjl.toFixed(1)}` }),
        detail: sjl === 0 ? t("休息日与工作日睡眠中点相同") : sjl > 0 ? t("休息日睡眠中点比工作日晚") : t("休息日睡眠中点比工作日早") },
    rhythm.debt.nights >= 3 ? { title: t("睡眠债"), value: rhythm.debt.perNight > 0 ? t("每晚少 {{hours}} 小时", { hours: rhythm.debt.perNight.toFixed(1) }) : t("无"),
      detail: t("近两周 {{nights}} 晚加权，最近一晚占 15%", { nights: rhythm.debt.nights }) }
      : { title: t("睡眠债"), value: pending, detail: t("需要至少 3 晚睡眠记录") }
  ];
}

/** Section titles of the report, shared half first. Hard-coded, so they may be set in the poster's serif. */
export const POSTER_SECTION_TITLES = ["精力节律", "价值与能量", "主线飞轮", "言行对照", "真问题", "指南针、能量与主线", "言行落差与锚", "现况洞察与可行建议", "Crossline 下一步"] as const;
export const POSTER_LABEL_TITLES = ["核心词", "价值核心", "建议底座", "身份"] as const;

/**
 * Every character the poster sets in its serif (`.pt-serif`): only strings written in code — type codes, the sixteen names, the group
 * names, the Schwartz values, section and label titles, and the login and interview headings that share the style (`ui/serif-strings.ts`)
 * — plus digits, so the self-hosted subset (`scripts/poster-font-subset.ts`) can be small and complete. Text a model or the person
 * wrote never uses it.
 */
export function posterSerifText(): string {
  const strings = [
    ...TYPE_AXES.flatMap((axis) => [axis.left.letter, axis.right.letter, axis.left.label, axis.right.label]),
    ...Object.values(TYPE_TABLE).flatMap((type) => [type.name, `「${type.quote}」`]), ...Object.values(TYPE_GROUPS).map((group) => group.name),
    ...SCHWARTZ_VALUES.map((value) => value.name), ...POSTER_SECTION_TITLES, ...POSTER_LABEL_TITLES, ...INTERFACE_SERIF_STRINGS, "0123456789%· "
  ];
  return [...new Set(strings.join(""))].sort().join("");
}
