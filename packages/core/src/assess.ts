import { TYPE_AXES, typeFromScores, type PortraitType, type TypeAxisId } from "./portrait-type";

/**
 * The public quick test (docs/energy-and-ecosystem.md §7, docs/beta-launch.md, decided 2026-10-14; questions redesigned 2026-10-24):
 * thirty-six situations on the four typing dimensions, a short Munich ChronoType Questionnaire and a three-minute psychomotor vigilance
 * test, all scored here as pure functions so the static `apps/assess` site computes everything in the browser — no ledger, no model, no
 * account. Every module this file imports must stay pure.
 */

/**
 * One question of the quick test (redesigned 2026-10-24 with the owner): a situation from one area of life (`scene`) with two options,
 * one per pole, answered on `PAIR_SCALE` from 1 (clearly `a`) to 5 (clearly `b`). `a` describes the left pole unless `aRight`. Both
 * options are ones a reasonable person picks, so neither side reads as lazy or behind. `ai` marks the option that hands the work to AI and
 * says it in a few words (「写初稿」); leaning that way puts the phrase on the poster's 「AI 替你干的」 line (`aiDoes`).
 */
export type QuizItem = { id: string; axis: TypeAxisId; scene: string; text: string; a: string; b: string; aRight: boolean; ai?: { side: "a" | "b"; does: string } };

const pair = (id: string, axis: TypeAxisId, scene: string, text: string, a: string, b: string, aRight: boolean, ai?: QuizItem["ai"]): QuizItem =>
  ({ id, axis, scene, text, a, b, aRight, ...(ai ? { ai } : {}) });

/**
 * Nine situations per dimension across writing, research, code, visuals, video, learning, planning, people, money and daily life,
 * ordered so neighbours never share a dimension, with the right pole on `a` and on `b` about equally often.
 */
export const QUIZ_ITEMS: QuizItem[] = [
  pair("q1", "collab", "写作", "写一篇长文", "先自己列好提纲，每一节交给 AI 写", "从第一句起就和 AI 一句一句改着写", false, { side: "a", does: "写初稿" }),
  pair("q2", "purpose", "学习", "学一种新的统计方法", "让 AI 出题考你，自己推一遍", "让 AI 直接把分析跑出来", true, { side: "b", does: "跑分析" }),
  pair("q3", "build", "编程", "搭一个个人网站", "先画好每个页面的结构", "先让 AI 生成一版，看着改", false, { side: "b", does: "搭网站" }),
  pair("q4", "lines", "时间", "AI 帮你每周省出 5 个小时", "投回主业，把它做得更深", "开一条新的副线", false),
  pair("q5", "collab", "编程", "写一段处理表格的小脚本", "打开编辑器的 AI 补全，边写边接受建议", "先把需求描述清楚，等 AI 给出完整代码", true, { side: "b", does: "写代码" }),
  pair("q6", "purpose", "阅读", "读一份英文合同", "要一份中文要点就够了", "让 AI 逐条解释，下次自己能看懂", false, { side: "a", does: "读合同" }),
  pair("q7", "build", "自动化", "搭一个自动化流程（比如每周自动整理邮件）", "先拿现成模板跑起来，坏了再修", "先把每一步写清楚", true),
  pair("q8", "lines", "副业", "朋友约你一起做个副业", "先答应，反正有 AI 撑着", "只有和主业相关才加入", true),
  pair("q9", "collab", "视觉", "做一张活动海报", "自己定好构图，只让 AI 生成素材", "让 AI 连出 20 版，挑一版再接着让它改", false, { side: "b", does: "出图" }),
  pair("q10", "purpose", "编程", "AI 写的代码跑通了", "读懂每一行再用", "直接用", true),
  pair("q11", "build", "旅行", "第一次出国旅行", "出发前定好预算和每天的安排", "订好机票，到了再随时问 AI", false, { side: "b", does: "做攻略" }),
  pair("q12", "lines", "对话", "翻翻你和 AI 的对话记录", "大多围着同一件事", "什么话题都有", false),
  pair("q13", "collab", "沟通", "准备一场重要的谈判", "让 AI 扮演对方，从头到尾陪你对练", "自己写好要点，最后让 AI 挑漏洞", true),
  pair("q14", "purpose", "理财", "做下个季度的预算", "要一张填好的表", "要它的计算逻辑，自己调参数", false, { side: "a", does: "做预算" }),
  pair("q15", "build", "视频", "拍一期视频", "先拍一堆素材，让 AI 帮你剪出故事", "先写好分镜脚本", true, { side: "a", does: "剪视频" }),
  pair("q16", "lines", "身份", "介绍自己的时候", "一串斜杠", "一个头衔就够了", true),
  pair("q17", "collab", "沟通", "回一封很难回的邮件", "自己写好，再让 AI 润色", "把来信丢给 AI，和它一起商量怎么回", false),
  pair("q18", "purpose", "写作", "写一条小红书文案", "让 AI 讲清楚哪一版为什么好", "让 AI 出 5 版，挑一版发", true, { side: "b", does: "写文案" }),
  pair("q19", "build", "工具", "试一个新出的 AI 工具", "先看教程和评测", "直接上手乱点", false),
  pair("q20", "lines", "学习", "刷到一个很火的新领域", "先收藏，等主业忙完再看", "当晚就让 AI 带你入门", false, { side: "b", does: "带我入门" }),
  pair("q21", "collab", "调研", "调研一个完全陌生的行业", "和 AI 边聊边追问，问到哪算哪", "列好问题清单，让 AI 分头查完给你一份报告", true, { side: "b", does: "查资料" }),
  pair("q22", "purpose", "求职", "准备一场面试", "让 AI 给出标准答案，背下来", "让 AI 当面试官，答完逐条点评", false, { side: "a", does: "备面试" }),
  pair("q23", "build", "副业", "开始一个副业", "先发一条试试水，看反馈再说", "先写一页计划，定好目标", true),
  pair("q24", "lines", "未来", "设想三年以后", "同时经营几个分量相近的方向", "在一个方向上走得很深", true),
  pair("q25", "collab", "视频", "剪一条视频", "自己剪完，让 AI 配字幕、起标题、做封面", "素材全丢进去，和 AI 一来一回调节奏", false, { side: "a", does: "做字幕封面" }),
  pair("q26", "purpose", "学习", "遇到一个看不懂的概念", "顺着问到底，直到能讲给别人听", "让 AI 一句话解释完，继续干活", true),
  pair("q27", "build", "写作", "写一份报告或论文", "先定好结构和论点", "先把想到的全写出来，再整理", false),
  pair("q28", "lines", "收藏", "你的收藏夹", "几乎都和一件事有关", "五花八门", false),
  pair("q29", "collab", "旅行", "安排一次旅行", "每天都和 AI 商量第二天去哪", "自己定好大框架，酒店和路线交给 AI 填", true, { side: "b", does: "排行程" }),
  pair("q30", "purpose", "时间", "AI 帮你省出一小时", "马上去做下一件事", "用来琢磨 AI 刚才是怎么做的", false),
  pair("q31", "build", "理财", "开始理财", "先小额买一点，边看边学", "先定好配置比例和规则", true),
  pair("q32", "lines", "取舍", "两件事撞在一起时", "经常难以取舍，两边都想要", "总有一件明显更重要", true),
  pair("q33", "collab", "对话", "你和 AI 的对话记录，更像哪一种", "一个个独立的小任务，问完就关", "少数几个很长的对话，来回聊了几十轮", false),
  pair("q34", "purpose", "未来", "一年以后，你更希望", "自己会的东西越来越多", "AI 替你干的活越来越多", true),
  pair("q35", "build", "计划", "新的一周开始了", "周日晚上排好每天做什么", "每天早上看情况再定", false),
  pair("q36", "lines", "团队", "如果明天起你有一支 AI 团队", "全员冲一个项目", "每条线各派几个", false)
];

/** The five answers to a situation, 1 (clearly the first option) to 5 (clearly the second). */
export const PAIR_SCALE = ["明显更像 A", "偏 A", "两者差不多", "偏 B", "明显更像 B"] as const;

const toHundred = (mean: number) => ((mean - 1) / 4) * 100;
/** An answer turned towards the right pole: 1 = clearly left, 5 = clearly right. */
const towardsRight = (item: QuizItem, answer: number) => (item.aRight ? 6 - answer : answer);

/**
 * The dimension scores (0 = left pole, 100 = right pole) from an answer of 1–5 to every question: the mean of a dimension's nine answers,
 * each turned towards the right pole, mapped to 0–100. A dimension that lands exactly on 50 goes to the side more answers leaned to, else
 * the left, and is shown as 49 or 51. Throws `QUIZ_INCOMPLETE` when a question is unanswered or an answer is not 1–5.
 */
export function quizResult(answers: Record<string, number>): { scores: Record<TypeAxisId, number> } {
  const missing = QUIZ_ITEMS.filter((item) => ![1, 2, 3, 4, 5].includes(answers[item.id] ?? 0));
  if (missing.length) throw new Error(`QUIZ_INCOMPLETE: ${missing.map((item) => item.id).join(",")}`);
  const scores = {} as Record<TypeAxisId, number>;
  for (const axis of TYPE_AXES) {
    const values = QUIZ_ITEMS.filter((item) => item.axis === axis.id).map((item) => towardsRight(item, answers[item.id]!));
    let score = Math.round(toHundred(values.reduce((sum, value) => sum + value, 0) / values.length));
    if (score === 50) score = values.filter((value) => value > 3).length > values.filter((value) => value < 3).length ? 51 : 49;
    scores[axis.id] = score;
  }
  return { scores };
}

/** The dimension scores alone (`quizResult`). */
export const quizScores = (answers: Record<string, number>): Record<TypeAxisId, number> => quizResult(answers).scores;

/** The quick test's type: the same sixteen names as the portrait. */
export const quizType = (answers: Record<string, number>): PortraitType => typeFromScores(quizScores(answers));

/**
 * The poster's 「AI 替你干的」 line: the work of the questions where the person leaned towards handing it to AI, most decided first, at
 * most `limit`, each phrase once. Empty when they leaned towards doing it themselves everywhere.
 */
export function aiDoes(answers: Record<string, number>, limit = 3): string[] {
  const leaning = QUIZ_ITEMS.flatMap((item) => {
    const answer = answers[item.id];
    if (!item.ai || !answer) return [];
    const lean = item.ai.side === "a" ? 3 - answer : answer - 3;
    return lean > 0 ? [{ does: item.ai.does, lean, order: QUIZ_ITEMS.indexOf(item) }] : [];
  }).sort((x, y) => y.lean - x.lean || x.order - y.order);
  return [...new Set(leaning.map((entry) => entry.does))].slice(0, limit);
}

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
export { TYPE_AXES, TYPE_GROUPS, TYPE_TABLE, typeFromScores } from "./portrait-type";
/** The quick test ↔ app link contract (`assess-link.ts`): reached as `@crossline/core/assess` or `@crossline/core`, so no new subpath. */
export * from "./assess-link";
