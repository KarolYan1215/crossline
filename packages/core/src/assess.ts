import { TYPE_AXES, typeFromScores, type PortraitType, type TypeAxisId } from "./portrait-type";

/**
 * The public quick test (docs/energy-and-ecosystem.md §7, docs/beta-launch.md, decided 2026-10-14): thirty-two questions on the four typing dimensions, a short
 * Munich ChronoType Questionnaire and a three-minute psychomotor vigilance test, all scored here as pure functions so the static
 * `apps/assess` site computes everything in the browser — no ledger, no model, no account. Every module this file imports must stay pure.
 */

/**
 * One question of the quick test (redesigned 2026-10-17, docs/assess-redesign.md): a statement measuring one pole on its own (`pole`),
 * answered on `LIKERT`, or a situation with two options, one per pole (`pair`), answered on `PAIR_SCALE` from 1 (clearly `a`) to 5
 * (clearly `b`). `a` describes the left pole unless `aRight`.
 */
export type QuizItem =
  | { id: string; axis: TypeAxisId; kind: "pole"; pole: "left" | "right"; text: string }
  | { id: string; axis: TypeAxisId; kind: "pair"; text: string; a: string; b: string; aRight: boolean };

const pole = (id: string, axis: TypeAxisId, side: "left" | "right", text: string): QuizItem => ({ id, axis, kind: "pole", pole: side, text });
const pair = (id: string, axis: TypeAxisId, text: string, a: string, b: string, aRight = false): QuizItem => ({ id, axis, kind: "pair", text, a, b, aRight });

/**
 * Eight questions per dimension: three statements for each pole, measured independently (two high poles and two low ones are both
 * possible and both shown), and two situations that make the person choose. Ordered so neighbours never share a dimension, and a
 * situation comes every few statements. Every statement is positively worded and asks about one behaviour or preference.
 */
export const QUIZ_ITEMS: QuizItem[] = [
  pole("q1", "concentration", "left", "我的时间和精力，大部分投在一件最重要的事上。"),
  pole("q2", "orientation", "left", "我会反复打磨已经掌握的方法，让它越来越高效。"),
  pole("q3", "boundary", "left", "我会给不同的事安排固定、分开的时间段。"),
  pole("q4", "pacing", "left", "我每周在主要的事上投入的时间大致稳定。"),
  pole("q5", "concentration", "right", "我同时在推进两件以上分量相近的事，如学业、工作、副业或创作。"),
  pole("q6", "orientation", "right", "我经常主动尝试自己从没做过的领域或方法。"),
  pole("q7", "boundary", "right", "一天里在几件不同的事之间来回切换，我也能很快进入状态。"),
  pole("q8", "pacing", "right", "我常在一段时间里高强度投入，之后明显放松一阵。"),
  pair("q9", "concentration", "回顾过去半年，你的投入更接近哪一种？", "大部分时间集中在一件事上", "时间分配给几件分量相近的事"),
  pair("q10", "orientation", "有一段空闲的时间，你更可能用来做什么？", "去尝试一个全新的方向", "把擅长的事再推进一步", true),
  pole("q11", "boundary", "left", "做一件事的时候，我不希望被另一件事的消息打断。"),
  pole("q12", "pacing", "left", "我习惯每天推进一点，而不是攒到一起做。"),
  pole("q13", "concentration", "left", "其他事和主线冲突时，我通常先保证主线。"),
  pole("q14", "orientation", "left", "一件事做出成效后，我会沿着同样的路继续加码。"),
  pole("q15", "boundary", "right", "我会有意把一件事的成果或人脉用到另一件事上。"),
  pole("q16", "pacing", "right", "截止日期临近时，我的效率最高。"),
  pair("q17", "boundary", "你理想的一周安排更接近哪一种？", "几件事穿插进行，随时切换", "每件事有各自固定的时段", true),
  pair("q18", "pacing", "完成一个需要一个月的项目，你更常见的做法是？", "每天推进一部分", "集中几段时间完成大部分"),
  pole("q19", "concentration", "right", "少了正在做的任何一条线，我都会觉得自己不完整。"),
  pole("q20", "orientation", "right", "即使成功的可能不明，我也愿意花时间做新的尝试。"),
  pole("q21", "boundary", "left", "我倾向于让不同领域的人和事互不交叉。"),
  pole("q22", "pacing", "left", "截止日期前，我的工作量和平时相差不大。"),
  pole("q23", "concentration", "left", "我有一件事明显比其他事都重要。"),
  pole("q24", "orientation", "left", "选择下一步时，我优先考虑能用上现有积累的机会。"),
  pair("q25", "concentration", "设想未来三年理想的状态，你更倾向于？", "同时经营几个分量相近的方向", "在一个方向上走得很深", true),
  pair("q26", "orientation", "面前有两个机会，你更可能选择？", "回报较确定、用得上现有能力的", "回报不确定、但能进入新领域的"),
  pole("q27", "boundary", "right", "做一件事时想到另一件事的点子，我会马上记下或处理。"),
  pole("q28", "pacing", "right", "状态好的时候，我会连续投入很长时间。"),
  pole("q29", "concentration", "right", "我会有意识地把时间分给几件同样重要的事，而不是只押在一件上。"),
  pole("q30", "orientation", "right", "一件事做熟练之后，我会开始寻找新的方向。"),
  pair("q31", "boundary", "你在不同领域认识的人，更接近哪一种？", "分属不同圈子，很少交叉", "经常互相介绍，交织在一起"),
  pair("q32", "pacing", "回顾你的投入曲线，更接近哪一种？", "起伏明显，有高峰也有低谷", "比较平稳", true)
];

/** The five Likert answers to a statement, 1 to 5. */
export const LIKERT = ["非常不同意", "不同意", "说不准", "同意", "非常同意"] as const;
/** The five answers to a situation, 1 (clearly the first option) to 5 (clearly the second). */
export const PAIR_SCALE = ["明显更像 A", "偏 A", "两者差不多", "偏 B", "明显更像 B"] as const;

/** Each pole's own score, 0–100, from its three statements alone. */
export type PoleScores = Record<TypeAxisId, { left: number; right: number }>;

/** A pole at or above this is strong, at or below `POLE_LOW` weak: both strong (or both weak) is said on the result, not hidden. */
export const POLE_HIGH = 75;
export const POLE_LOW = 25;
/** 「两端都强」, 「两端都弱」, or nothing. */
export const poleBalance = (poles: { left: number; right: number }): "both_high" | "both_low" | null =>
  poles.left >= POLE_HIGH && poles.right >= POLE_HIGH ? "both_high" : poles.left <= POLE_LOW && poles.right <= POLE_LOW ? "both_low" : null;

const toHundred = (mean: number) => ((mean - 1) / 4) * 100;

/**
 * The poles and the dimension scores from an answer of 1–5 to every question. Each pole is the mean of its three statements mapped to
 * 0–100. A dimension's score (0 = left pole, 100 = right pole) weighs the six statements and the two situations by count: three quarters
 * from the difference of the poles (50 + (right − left) / 2), one quarter from the situations' mean towards the right. A dimension that
 * lands exactly on 50 is decided by the situations, then by the poles, then left: it is shown as 49 or 51. Throws `QUIZ_INCOMPLETE` when
 * a question is unanswered or an answer is not 1–5.
 */
export function quizResult(answers: Record<string, number>): { scores: Record<TypeAxisId, number>; poles: PoleScores } {
  const missing = QUIZ_ITEMS.filter((item) => ![1, 2, 3, 4, 5].includes(answers[item.id] ?? 0));
  if (missing.length) throw new Error(`QUIZ_INCOMPLETE: ${missing.map((item) => item.id).join(",")}`);
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const scores = {} as Record<TypeAxisId, number>;
  const poles = {} as PoleScores;
  for (const axis of TYPE_AXES) {
    const items = QUIZ_ITEMS.filter((item) => item.axis === axis.id);
    const side = (which: "left" | "right") => toHundred(mean(items.filter((item) => item.kind === "pole" && item.pole === which).map((item) => answers[item.id]!)));
    const left = side("left"), right = side("right");
    const situations = toHundred(mean(items.flatMap((item) => item.kind === "pair" ? [item.aRight ? 6 - answers[item.id]! : answers[item.id]!] : [])));
    let score = Math.round(0.75 * (50 + (right - left) / 2) + 0.25 * situations);
    if (score === 50) score = situations !== 50 ? (situations > 50 ? 51 : 49) : right > left ? 51 : 49;
    scores[axis.id] = score;
    poles[axis.id] = { left: Math.round(left), right: Math.round(right) };
  }
  return { scores, poles };
}

/** The dimension scores alone (`quizResult`). */
export const quizScores = (answers: Record<string, number>): Record<TypeAxisId, number> => quizResult(answers).scores;

/** The quick test's type: the same sixteen names as the portrait. */
export const quizType = (answers: Record<string, number>): PortraitType => typeFromScores(quizScores(answers));

/** "HH:MM" as decimal hours, or NaN. */
export function clockHours(clock: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(clock.trim());
  if (!match) return Number.NaN;
  const hours = Number(match[1]), minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? hours + minutes / 60 : Number.NaN;
}
const wrap24 = (hours: number) => ((hours % 24) + 24) % 24;
/** The shorter signed way round the clock from `from` to `to`, in (−12, 12]. */
const signedClock = (from: number, to: number) => { const d = wrap24(to - from); return d > 12 ? d - 24 : d; };

export type MctqLiteInput = {
  /** Workdays a week, 0–7. */
  workdays: number;
  work: { sleep: string; wake: string };
  /** `alarm`: an alarm on free days too, which makes the corrected mid-sleep unknowable. */
  free: { sleep: string; wake: string; alarm?: boolean };
};
export type Chronotype = "early" | "intermediate" | "late";
export type MctqLiteResult = {
  /** Sleep duration on workdays, free days and the weekly average, hours. */
  sdWork: number; sdFree: number; sdWeek: number;
  /** Mid-sleep on workdays and free days, local clock hours 0–24. */
  msw: number; msf: number;
  /** Mid-sleep on free days corrected for sleep debt from the workdays; null with an alarm on free days. */
  msfSc: number | null;
  /** Social jetlag: MSF − MSW the shorter way round the clock (positive = later on free days), and its absolute value. */
  sjlRel: number; sjl: number;
  chronotype: Chronotype | null;
};

/**
 * The short MCTQ, computed as the ropensci `mctq` package does (Roenneberg et al. 2003; 2012): sleep onset and wake give the sleep
 * duration and the mid-sleep for workdays and free days; MSF_sc = MSF − (SD_f − SD_week)/2 when free-day sleep is longer than workday
 * sleep, else MSF, and unknown with an alarm on free days; social jetlag is MSF − MSW. This version asks for sleep onset directly, not
 * bedtime plus latency. The chronotype bands (before 3:00 early, from 5:00 late, on MSF_sc) are a reading convention, not a norm.
 * Throws `MCTQ_INVALID` on a malformed clock or workday count.
 */
export function mctqLite(input: MctqLiteInput): MctqLiteResult {
  const times = [input.work.sleep, input.work.wake, input.free.sleep, input.free.wake].map(clockHours);
  if (times.some(Number.isNaN) || !Number.isInteger(input.workdays) || input.workdays < 0 || input.workdays > 7) throw new Error("MCTQ_INVALID");
  const [soW, seW, soF, seF] = times as [number, number, number, number];
  const sdWork = wrap24(seW - soW), sdFree = wrap24(seF - soF);
  const freeDays = 7 - input.workdays;
  const sdWeek = (sdWork * input.workdays + sdFree * freeDays) / 7;
  const msw = wrap24(soW + sdWork / 2), msf = wrap24(soF + sdFree / 2);
  const msfSc = input.free.alarm ? null : sdFree <= sdWork ? msf : wrap24(msf - (sdFree - sdWeek) / 2);
  const sjlRel = signedClock(msw, msf);
  // A mid-sleep after noon is a night sleeper's very late one, read on the night's side of the clock.
  const night = msfSc === null ? null : msfSc > 12 ? msfSc - 24 : msfSc;
  return { sdWork, sdFree, sdWeek, msw, msf, msfSc, sjlRel, sjl: Math.abs(sjlRel),
    chronotype: night === null ? null : night < 3 ? "early" : night < 5 ? "intermediate" : "late" };
}
export const CHRONOTYPE_LABEL: Record<Chronotype, string> = { early: "偏早型", intermediate: "中间型", late: "偏晚型" };

/**
 * PVT-B, the three-minute brief psychomotor vigilance test (Basner, Mollicone & Dinges 2011, Acta Astronautica 69:949–959): a stimulus
 * after a random 2–5 s, a response under 100 ms or before the stimulus is a false start, one of 355 ms or more (or none) a lapse.
 * No percentile is computed: the validation paper reports its rested baseline only in figures, without a mean and standard deviation to
 * read off, so there is no published norm to compare a result with (checked 2026-10-14).
 */
export const PVT_DURATION_MS = 180_000;
export const PVT_ISI_MS = { min: 2_000, max: 5_000 } as const;
export const PVT_LAPSE_MS = 355;
export const PVT_FALSE_START_MS = 100;
/** A stimulus nobody answered is ended (and counted a lapse) after this long. */
export const PVT_TIMEOUT_MS = 30_000;
/** The wait before the next stimulus, from a uniform draw in [0, 1). */
export const pvtIsi = (draw: number) => Math.round(PVT_ISI_MS.min + draw * (PVT_ISI_MS.max - PVT_ISI_MS.min));

/** One stimulus: the reaction time in ms, or null when it timed out. */
export type PvtTrial = { rtMs: number | null };
export type PvtSummary = {
  stimuli: number;
  /** Responses of at least 100 ms. */
  valid: number;
  medianRt: number | null;
  /** Mean response speed, 1000/RT per second over valid responses — the metric most sensitive to sleep loss. */
  meanSpeed: number | null;
  /** Valid responses of 355 ms or more, plus timeouts. */
  lapses: number;
  /** Responses under 100 ms plus taps with no stimulus. */
  falseStarts: number;
  /** Enough valid responses (20) for the median to mean something. */
  reliable: boolean;
};

export function pvtSummary(trials: PvtTrial[], prematureTaps = 0): PvtSummary {
  const rts = trials.flatMap((trial) => trial.rtMs !== null && trial.rtMs >= PVT_FALSE_START_MS ? [trial.rtMs] : []);
  const fast = trials.filter((trial) => trial.rtMs !== null && trial.rtMs < PVT_FALSE_START_MS).length;
  const sorted = [...rts].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  const medianRt = sorted.length ? Math.round(sorted.length % 2 ? sorted[Math.floor(mid)]! : (sorted[mid - 1]! + sorted[mid]!) / 2) : null;
  const meanSpeed = rts.length ? Math.round((rts.reduce((sum, rt) => sum + 1000 / rt, 0) / rts.length) * 100) / 100 : null;
  return { stimuli: trials.length, valid: rts.length, medianRt, meanSpeed,
    lapses: rts.filter((rt) => rt >= PVT_LAPSE_MS).length + trials.filter((trial) => trial.rtMs === null).length,
    falseStarts: fast + prematureTaps, reliable: rts.length >= 20 };
}
export type { PortraitType, TypeAxisId } from "./portrait-type";
/** The type tables, for the public app, which may import only this module and the other pure subpaths. */
export { LEGACY_TYPE_CODE, TYPE_AXES, TYPE_GROUPS, TYPE_TABLE, typeFromScores } from "./portrait-type";
/** The quick test ↔ app link contract (`assess-link.ts`): reached as `@crossline/core/assess` or `@crossline/core`, so no new subpath. */
export * from "./assess-link";
