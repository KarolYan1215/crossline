import "server-only";
import { clashSentence, feasibilityNow, quotedRange, tFor, type AccessContext, type AskOption, type CalendarClash, type Feasibility, type Locale } from "@crossline/core";
import { cachedFeasibilityContext, prepDaysOf, type StoredOpportunity } from "@crossline/db";
import { getStore } from "./crossline";
import { scheduleEvent } from "./event-scheduling";

/**
 * The offer card's time and place (docs/opportunity-agent.md §17.6–17.7, track ②): each open opportunity judged on read with
 * `feasibilityNow` from the caches the worker keeps (geocodes, visas) and the plan's blocks (`schedule.workBlocks`), so a page never waits
 * on the network. An infeasible one is not shown; a clash with a fixed arrangement is explained and, once the person agrees to move it,
 * how is asked; the answer is a `schedule.` setting, so it is undone like any answer.
 */
export const FIXED_ADJUSTMENTS_SETTING = "schedule.fixedAdjustments";
export type FixedAdjustment = { opportunityId: string; blockIds: string[]; titles: string[]; how: "agreed" | "move" | "skip" | "self" | "note";
  toDay?: string | undefined; note?: string | undefined; at: string };

export function readFixedAdjustments(ctx: AccessContext): FixedAdjustment[] {
  try { const parsed = JSON.parse(getStore().getSetting(ctx.workspaceId, FIXED_ADJUSTMENTS_SETTING) ?? "[]") as FixedAdjustment[]; return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}

export function judgeOpportunity(ctx: AccessContext, row: StoredOpportunity, now: Date, locale: Locale): Feasibility {
  const store = getStore();
  return feasibilityNow(row, cachedFeasibilityContext(store, ctx.workspaceId, { now, prepDays: prepDaysOf(store, ctx.workspaceId, row), locale }));
}

const MODE_LABEL = { walk: "步行", transit: "公共交通", drive: "开车", rail: "火车", flight: "飞机" } as const;
const COST_LABEL = { low: "低", medium: "中", high: "高" } as const;

/** The card's lines: how it is held and where, the journey, the visa (verified or not) and each clash in words. */
export function spaceLines(row: StoredOpportunity, verdict: Feasibility, locale: Locale): string[] {
  const t = tFor(locale);
  if (verdict.state === "infeasible") return [];
  const place = row.place;
  const out: string[] = [];
  if (place && place.mode !== "unknown") {
    const where = [place.city, place.country].filter(Boolean).join(locale === "en" ? ", " : "，");
    out.push(place.mode === "online" ? t("线上举行。") : place.mode === "hybrid"
      ? t("线上与现场均可{{where}}。", { where: where ? t("（现场：{{where}}）", { where }) : "" })
      : t("现场举行{{where}}。", { where: where ? t("：{{where}}", { where }) : "" }));
  }
  if (verdict.place?.city) out.push(t("本人那天在：{{city}}。", { city: verdict.place.city }));
  const travel = verdict.travel;
  if (travel && place?.mode !== "online") {
    out.push(t("路上：约 {{km}} 公里，{{mode}}单程约 {{minutes}} 分钟{{days}}，花费{{cost}}。", { km: Math.round(travel.km), mode: t(MODE_LABEL[travel.mode]),
      minutes: travel.minutesOneWay, days: travel.travelDays ? t("，提前 {{days}} 天出发", { days: travel.travelDays }) : "",
      cost: t(COST_LABEL[travel.costTier ?? "low"]) }));
  }
  const visa = verdict.visa;
  if (visa) {
    out.push(visa.needed === false ? t("签证：不需要（已核实）。")
      : visa.verified ? t("签证：需要，约 {{days}} 天（已按官方页面核实）。", { days: visa.leadDays })
      : t("签证：可能需要，按 {{days}} 天预留（未核实）。", { days: visa.leadDays }));
  }
  if (verdict.state === "conflict") for (const clash of verdict.clashes) out.push(`${clashSentence(clash, locale)}${locale === "en" ? "." : "。"}`);
  return out;
}

const fixedOf = (verdict: Feasibility): CalendarClash[] => verdict.state === "conflict" ? verdict.clashes.filter((clash) => clash.fixed) : [];

/**
 * The options a fixed clash adds (§17.7): first 「我同意调整固定安排」; once agreed, how — to which day, skip it once, the person swaps or
 * asks for leave themselves, or one sentence. Nothing is moved on anyone's calendar: the answer is kept, and the person's own steps stay theirs.
 */
export function clashOptions(ctx: AccessContext, row: StoredOpportunity, verdict: Feasibility, locale: Locale): AskOption[] {
  const fixed = fixedOf(verdict);
  if (!fixed.length) return [];
  const t = tFor(locale);
  const mine = readFixedAdjustments(ctx).filter((item) => item.opportunityId === row.id);
  if (mine.some((item) => item.how !== "agreed")) return [];
  if (!mine.length) return [{ id: "adjust", label: t("我同意调整固定安排"), detail: t("之后再选怎么调整：改到哪天、跳过一次、本人去调换或请假") }];
  return [
    { id: "adjust_move", label: t("改到另一天"), fields: [{ id: "day", label: t("改到哪天"), kind: "date", required: true }] },
    { id: "adjust_skip", label: t("这次跳过") },
    { id: "adjust_self", label: t("本人去调换或请假"), detail: t("由本人联系，系统不代发") },
    { id: "adjust_note", label: t("用一句话说"), fields: [{ id: "note", label: t("怎么调整"), kind: "text", required: true }] }
  ];
}

/** Records an agreement or how to adjust; undone with the answer (a `schedule.` setting). */
export function answerClash(ctx: AccessContext, row: StoredOpportunity, verdict: Feasibility, optionId: string, values: Record<string, string>, now: Date)
  : { ok: true } | { ok: false; code: string } {
  const fixed = fixedOf(verdict);
  if (!fixed.length) return { ok: false, code: "OPPORTUNITY_NO_FIXED_CLASH" };
  const hows: Record<string, FixedAdjustment["how"]> = { adjust: "agreed", adjust_move: "move", adjust_skip: "skip", adjust_self: "self", adjust_note: "note" };
  const how = hows[optionId];
  if (!how) return { ok: false, code: "ASK_OPTION_UNKNOWN" };
  if (how === "move" && !/^\d{4}-\d{2}-\d{2}$/.test(values.day ?? "")) return { ok: false, code: "OPPORTUNITY_ADJUST_DAY_REQUIRED" };
  if (how === "note" && !values.note?.trim()) return { ok: false, code: "OPPORTUNITY_ADJUST_NOTE_REQUIRED" };
  // One entry per opportunity: the agreement, then replaced by how.
  const others = readFixedAdjustments(ctx).filter((item) => item.opportunityId !== row.id);
  const entry: FixedAdjustment = { opportunityId: row.id, blockIds: fixed.map((clash) => clash.blockId), titles: fixed.map((clash) => clash.title), how,
    ...(how === "move" ? { toDay: values.day } : {}), ...(how === "note" ? { note: values.note!.trim().slice(0, 200) } : {}), at: now.toISOString() };
  getStore().setSetting(ctx.workspaceId, FIXED_ADJUSTMENTS_SETTING, JSON.stringify([...others, entry].slice(-100)));
  return { ok: true };
}

/**
 * Registering or adding to the plan puts the event's own hours on the plan as busy time (an input event), so the scheduler moves the work
 * blocks it lands on (§17.7, movable clashes). Only when the page gave a day and a clock range; otherwise nothing is guessed.
 */
export async function holdEventTime(ctx: AccessContext, row: StoredOpportunity, now: Date): Promise<void> {
  const start = row.startsAt;
  const range = start ? quotedRange(start.quote) : undefined;
  if (!start || !range || !/^\d{4}-\d{2}-\d{2}$/.test(start.day)) return;
  const minutes = (Number(range.end.slice(0, 2)) * 60 + Number(range.end.slice(3, 5))) - (Number(range.start.slice(0, 2)) * 60 + Number(range.start.slice(3, 5)));
  await scheduleEvent(ctx, { title: row.title.slice(0, 120), lineId: row.lineId, date: start.day, weekdays: [], startTime: range.start, endTime: range.end, until: "",
    minutes, ...(row.place?.city ? { location: row.place.city } : {}) }, now).catch(() => undefined);
}
