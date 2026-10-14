import { TYPE_AXES, typeFromScores, type PortraitType, type TypeAxisId } from "./portrait-type";

/**
 * The public quick test (docs/energy-and-ecosystem.md §7, decided 2026-10-14): sixteen statements for the four typing axes, a short
 * Munich ChronoType Questionnaire and a three-minute psychomotor vigilance test, all scored here as pure functions so the static
 * `apps/assess` site computes everything in the browser — no ledger, no model, no account. Every module this file imports must stay pure.
 */

/** A statement on one axis. Agreeing points to the axis's right pole, or to its left pole when `reverse`. */
export type QuizItem = { id: string; axis: TypeAxisId; text: string; reverse: boolean };

/** Four statements per axis, two keyed to each pole, interleaved so neighbours never share an axis. */
export const QUIZ_ITEMS: QuizItem[] = [
  { id: "q1", axis: "scope", text: "我常把一个领域里学到的东西，用到另一个完全不同的领域。", reverse: false },
  { id: "q2", axis: "basis", text: "做重要决定前，我一定要先看到数据或证据。", reverse: true },
  { id: "q3", axis: "output", text: "做出一个能用的东西，比让很多人知道它更让我满足。", reverse: true },
  { id: "q4", axis: "rhythm", text: "开始一件事之前，我习惯先列好计划和时间表。", reverse: true },
  { id: "q5", axis: "scope", text: "我宁愿在一件事上做到顶尖，也不愿样样都懂一点。", reverse: true },
  { id: "q6", axis: "basis", text: "我常凭直觉判断一件事值不值得做，事后多半是对的。", reverse: false },
  { id: "q7", axis: "output", text: "把想法讲给别人听、看到别人被说服，让我很有成就感。", reverse: false },
  { id: "q8", axis: "rhythm", text: "我更喜欢边做边调整，而不是事先定好每一步。", reverse: false },
  { id: "q9", axis: "scope", text: "同时推进几件不相关的事，比只做一件事更让我有劲。", reverse: false },
  { id: "q10", axis: "basis", text: "没有经过验证的想法，我不太愿意投入时间。", reverse: true },
  { id: "q11", axis: "output", text: "我享受独自把东西一点点做出来的过程。", reverse: true },
  { id: "q12", axis: "rhythm", text: "计划被打乱会让我明显不舒服。", reverse: true },
  { id: "q13", axis: "scope", text: "新方向再有意思，我也会先把手头这一件做深。", reverse: true },
  { id: "q14", axis: "basis", text: "打动我的往往是一个远景，而不是眼前的数字。", reverse: false },
  { id: "q15", axis: "output", text: "我会花不少时间写作、演讲或在网上分享。", reverse: false },
  { id: "q16", axis: "rhythm", text: "临时冒出来的机会，我通常会马上抓住。", reverse: false }
];

/** The five Likert answers, 1 to 5. */
export const LIKERT = ["非常不同意", "不同意", "说不准", "同意", "非常同意"] as const;

/**
 * Axis scores 0–100 (0 = left pole, 100 = right pole) from an answer of 1–5 to every statement: each answer is keyed towards the right
 * pole (a reversed statement as 6 − answer), the axis mean of 1–5 is mapped to 0–100. Throws `QUIZ_INCOMPLETE` when a statement is
 * unanswered or an answer is not 1–5.
 */
export function quizScores(answers: Record<string, number>): Record<TypeAxisId, number> {
  const missing = QUIZ_ITEMS.filter((item) => ![1, 2, 3, 4, 5].includes(answers[item.id] ?? 0));
  if (missing.length) throw new Error(`QUIZ_INCOMPLETE: ${missing.map((item) => item.id).join(",")}`);
  return Object.fromEntries(TYPE_AXES.map((axis) => {
    const keyed = QUIZ_ITEMS.filter((item) => item.axis === axis.id).map((item) => item.reverse ? 6 - answers[item.id]! : answers[item.id]!);
    const mean = keyed.reduce((sum, value) => sum + value, 0) / keyed.length;
    return [axis.id, Math.round(((mean - 1) / 4) * 100)];
  })) as Record<TypeAxisId, number>;
}

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
