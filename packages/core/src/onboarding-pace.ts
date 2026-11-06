import type { AvailabilityWindow } from "./availability";
import { joinList, monthDay, tFor, type Locale } from "./i18n";
import { locateQuote } from "./sentences";
import { depthPace, type OnboardingDepth } from "./onboarding-depth";
import { DEEP_STAGES, INTERVIEW_FLOW_STAGES, ONBOARDING_STAGES, type InterviewFlow, type OnboardingStage, type TurnInsight, type TurnProgress, type TurnQuestion } from "./onboarding-turn-schema";

/**
 * What keeps the interview moving and gives something back at every part (2026-10-19, the owner's decisions after testers lost patience):
 * the interview's own progress record, the observation card of the deep stages, a short abstract of what the ledger holds, and what the
 * week looks like — the capacity a person has against what is fixed and due, and a draft of the week once the start standard stands.
 */

/** The parts of the main interview, in order. `details` is gone from it except in the thorough tier (line interviews still use it). */
export const INTERVIEW_PARTS: OnboardingStage[] = ["orientation", "lines", "situation", "compass", "energy"];
/**
 * The parts of a flow's main interview, in order (`v2` puts the profile module first, docs/profile-and-agent-kit.md §四); the thorough
 * tier ends with the details part (onboarding-depth.ts).
 */
export const interviewParts = (flow: InterviewFlow = "v1", depth?: OnboardingDepth): OnboardingStage[] => {
  const parts = flow === "v1" ? INTERVIEW_PARTS : INTERVIEW_FLOW_STAGES[flow].filter((stage) => stage !== "details");
  return depthPace(depth).detailsPart ? [...parts, "details"] : parts;
};
export const PART_LABEL: Record<OnboardingStage, string> = {
  narrative: "经历", orientation: "开场", lines: "主线", situation: "处境", compass: "指南针", energy: "能量", details: "细节"
};
/** The three deep stages every flow has: 「准」 in each confirms the portrait (the life story's observation is welcome, not required). */
const CONFIRMING_STAGES: OnboardingStage[] = ["situation", "compass", "energy"];

/** Where the person's ratings of observations are kept: `{ "<session>#<round seq>": { verdict, stage, at, text } }`. */
export const ONBOARDING_INSIGHTS = "onboarding.insights";
export type InsightVerdict = "fits" | "off";
export type InsightRatings = Record<string, { verdict: InsightVerdict; stage: string; at: string; text?: string }>;
export function readInsightRatings(raw: string | null | undefined): InsightRatings {
  try {
    const value = JSON.parse(raw ?? "{}") as InsightRatings;
    return value && typeof value === "object" ? value : {};
  } catch { return {}; }
}
/** Whether the person said 「准」 to an observation in each of the three deep stages: it stands for confirming the portrait piece by piece. */
export function portraitConfirmedByInsights(ratings: InsightRatings): boolean {
  const fits = new Set(Object.values(ratings).filter((rating) => rating.verdict === "fits").map((rating) => rating.stage));
  return CONFIRMING_STAGES.every((stage) => fits.has(stage));
}

/**
 * An observation is kept only when it is what it claims to be: in a deep stage, with text, resting on at least two of the person's replies
 * (different ones), each quote found in the reply it names. Anything else is dropped, never repaired: a round is not held up for it.
 */
export function checkInsight(insight: TurnInsight | undefined, replies: Record<string, string>, stage: string | undefined): TurnInsight | undefined {
  const text = insight?.text?.trim() ?? "";
  if (!text || !DEEP_STAGES.has(stage as OnboardingStage)) return undefined;
  const refs = (insight?.refs ?? []).filter((ref) => typeof ref?.replyId === "string" && typeof ref.quote === "string" && ref.quote.trim()
    && ref.replyId in replies && Boolean(locateQuote(replies[ref.replyId]!, ref.quote)));
  if (refs.length < 2 || new Set(refs.map((ref) => ref.replyId)).size < 2) return undefined;
  return { text, refs: refs.slice(0, 3).map((ref) => ({ replyId: ref.replyId, quote: ref.quote.trim() })) };
}

/** The progress record as stored; anything malformed reads as none (an older round, or a model that left it out). */
export function readTurnProgress(raw: unknown): TurnProgress | undefined {
  const value = raw as Partial<TurnProgress> | undefined;
  if (!value || typeof value !== "object" || !(ONBOARDING_STAGES as readonly string[]).includes(String(value.part))) return undefined;
  const list = (items: unknown) => Array.isArray(items) ? items.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).slice(0, 8) : [];
  return { part: value.part as OnboardingStage, covered: list(value.covered), open: list(value.open), partDone: value.partDone === true,
    next: typeof value.next === "string" ? value.next.slice(0, 160) : "" };
}

/**
 * How far the main interview is, for the screen: the part (1-based of `interviewParts(flow, depth)`), its label, and how much of it is
 * clear. The one count every part indicator shows (the bar above the conversation and the right column, W-186). The part is the round's
 * `stage` — what the app paces and offers cards by — and the model's own progress record counts only while it is about that part: the
 * 2026-11-03 walkthrough had the bar at 「第 2/6 部分 · 指南针」 and the right column at the progress record's 「主线」, part 6 of 6.
 */
export function progressView(progress: TurnProgress | undefined, stage: string, flow: InterviewFlow = "v1", depth?: OnboardingDepth,
  earlier: string[] = []): { index: number; total: number; label: string; clear: number; of: number; next: string; reached: number } {
  const parts = interviewParts(flow, depth);
  const part = (ONBOARDING_STAGES as readonly string[]).includes(stage) ? stage as OnboardingStage : progress?.part ?? (stage as OnboardingStage);
  const at = parts.indexOf(part);
  const index = at < 0 ? (part === "details" ? parts.length : 1) : at + 1;
  const own = progress?.part === part ? progress : undefined;
  const clear = own?.covered.length ?? 0, of = clear + (own?.open.length ?? 0);
  // The furthest part any round got to: a round that goes back to an earlier part for one open item is a question asked again, not the
  // interview starting over (W-235: 「第 6/6 部分 · 还剩约 5 分钟」 became 「第 2/6 部分 · 还剩约 25 分钟」 one round later).
  const reached = Math.max(index, ...earlier.map((one) => parts.indexOf(one as OnboardingStage) + 1));
  return { index, total: parts.length, label: PART_LABEL[part] ?? "定向", clear: own?.partDone ? Math.max(clear, of) : clear,
    of: own?.partDone ? Math.max(clear, of) : of, next: progress?.next ?? "", reached };
}

/** The progress record as the lines the next round starts from (for the dialogue model, not shown). */
/* i18n-ignore-start */
export function progressLines(progress: TurnProgress | undefined, flow: InterviewFlow = "v1", depth?: OnboardingDepth): string[] {
  if (!progress) return [];
  const parts = interviewParts(flow, depth);
  return [`上轮判断：第 ${Math.max(1, parts.indexOf(progress.part) + 1)}/${parts.length} 部分「${PART_LABEL[progress.part]}」${progress.partDone ? "已完成" : "未完成"}`,
    ...(progress.covered.length ? [`已谈清：${progress.covered.join("；")}`] : []),
    ...(progress.open.length ? [`未谈：${progress.open.join("；")}`] : []),
    ...(progress.next ? [`下一步：${progress.next}`] : [])];
}

/**
 * What the ledger holds, in at most `ABSTRACT_MAX` lines for the dialogue (2026-10-19: the full fact list, the whole question ledger and
 * forty recorded lines were handed over every round). Built by code from what the extraction already wrote; no model call.
 */
export const ABSTRACT_MAX = 15;
export type AbstractInput = {
  lines: Array<{ id: string; label: string; description: string; goal: string }>;
  projects: Array<{ id: string; identityId: string; name: string; deadline: string }>;
  weeklyHours: { hours: number; source: string } | null;
  fixedCount: number;
  profile: { problem?: string; workView?: string; trueNorth?: string; flow?: string[]; anchor?: string };
  filesRead: number;
  recent: string[];
};
const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
export function interviewAbstract(input: AbstractInput): string[] {
  const out: string[] = [];
  for (const line of input.lines) {
    const projects = input.projects.filter((project) => project.identityId === line.id).slice(0, 3)
      .map((project) => `${project.name}（${project.deadline || "截止未知"}）`);
    out.push(`${line.label}：${line.description ? cut(line.description, 40) : "尚无描述"}${line.goal ? `；长期目标：${cut(line.goal, 30)}` : ""}${projects.length ? `；项目：${projects.join("、")}` : "；尚无当前项目"}`);
  }
  out.push(input.weeklyHours ? `每周可用约 ${Math.round(input.weeklyHours.hours)} 小时（${input.weeklyHours.source}）；固定安排 ${input.fixedCount} 项` : `每周可用时间未知；固定安排 ${input.fixedCount} 项`);
  if (input.filesRead) out.push(`已读文件 ${input.filesRead} 份`);
  const profile = input.profile;
  if (profile.problem) out.push(`处境：${cut(profile.problem, 60)}`);
  if (profile.workView || profile.trueNorth) out.push(`指南针：${cut(profile.trueNorth || profile.workView || "", 60)}`);
  if (profile.flow?.length || profile.anchor) out.push(`能量：${cut([...(profile.flow ?? []).slice(0, 2), profile.anchor ?? ""].filter(Boolean).join("；"), 60)}`);
  for (const line of input.recent) { if (out.length >= ABSTRACT_MAX) break; out.push(`刚记下：${cut(line, 70)}`); }
  return out.slice(0, ABSTRACT_MAX);
}

/** Lines of the fixed schedule handed to the dialogue at most. */
export const FIXED_SCHEDULE_MAX = 24;
const WEEKDAY_NAME = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
/**
 * The weekly fixed arrangements as the dialogue reads them each round: one line per weekday a meeting falls on, with that meeting's own
 * time (「周二 14:00–16:30 ECE 548」), Monday first. A class meeting twice a week is two lines, so no sentence of the model's has to
 * merge two meetings into one day-and-time (W-183: 「周二 14:00–16:30」 and 「周四 09:00」 were told back as 「周二、周四上午的课」).
 * `weekdays` count from Sunday = 0, as the date batch writes them.
 */
export function fixedScheduleLines(items: Array<{ title: string; weekdays: number[]; startTime: string; endTime: string }>): string[] {
  const rows = items.flatMap((item) => [...new Set(item.weekdays)].filter((day) => day >= 0 && day <= 6)
    .map((day) => ({ day, start: item.startTime, end: item.endTime, title: item.title.trim() })));
  const seen = new Set<string>();
  return rows.sort((a, b) => (a.day + 6) % 7 - (b.day + 6) % 7 || a.start.localeCompare(b.start) || a.title.localeCompare(b.title))
    .map((row) => `${WEEKDAY_NAME[row.day]} ${row.start}–${row.end} ${row.title || "固定安排"}`)
    .filter((line) => !seen.has(line) && Boolean(seen.add(line))).slice(0, FIXED_SCHEDULE_MAX);
}
/* i18n-ignore-end */

const minutesOf = (time: string) => { const [h, m] = time.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };
const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
/** One weekly busy span: `weekday` 0–6 with Sunday at 0, as availability windows use. */
export type BusySpan = { weekday: number; start: string; end: string };
type Span = [number, number];
/** The parts of [start, end) not covered by any busy span, smallest first. */
function subtract(window: Span, busy: Span[]): Span[] {
  let free: Span[] = [window];
  for (const [bs, be] of busy) free = free.flatMap(([s, e]) => (be <= s || bs >= e ? [[s, e] as Span] : [[s, Math.min(bs, e)] as Span, [Math.max(be, s), e] as Span])
    .filter(([a, b]) => b - a > 0));
  return free;
}
/** Each weekday's free spans: the person's windows minus what is fixed, spans under 15 minutes dropped. */
export function freeSpans(windows: AvailabilityWindow[], busy: BusySpan[]): Map<number, Span[]> {
  const days = new Map<number, Span[]>();
  for (let weekday = 0; weekday < 7; weekday += 1) {
    const taken = busy.filter((span) => span.weekday === weekday).map((span) => [minutesOf(span.start), minutesOf(span.end)] as Span);
    const spans = windows.filter((window) => window.days.includes(weekday))
      .flatMap((window) => subtract([minutesOf(window.start), minutesOf(window.end)], taken)).filter(([s, e]) => e - s >= 15)
      .sort((a, b) => a[0] - b[0]);
    days.set(weekday, spans);
  }
  return days;
}

/**
 * The capacity conflict (容量冲突提示), shown once the lines are known: the hours the person has, what the fixed schedule takes of them,
 * what is left, and deadlines that fall close together in the next four weeks. Plain sentences, computed; nothing here is a model's guess.
 */
export type WeekCapacity = {
  available: number; fixed: number; free: number; deadlines: number;
  crunches: Array<{ from: string; to: string; titles: string[] }>;
  perLine: Array<{ lineId: string; label: string; hours: number }>;
  notes: string[];
};
export function capacityConflict(input: {
  windows: AvailabilityWindow[]; busy: BusySpan[]; deadlines: Array<{ date: string; title: string }>; today: string;
  lines: Array<{ id: string; label: string; weight: number }>;
  /** The language of `notes`, which the interview page shows. */
  locale?: Locale | undefined;
}): WeekCapacity {
  const t = tFor(input.locale);
  const hours = (spans: Span[]) => spans.reduce((sum, [s, e]) => sum + (e - s), 0) / 60;
  const available = input.windows.reduce((sum, window) => sum + window.days.length * Math.max(0, minutesOf(window.end) - minutesOf(window.start)), 0) / 60;
  const free = [...freeSpans(input.windows, input.busy).values()].reduce((sum, spans) => sum + hours(spans), 0);
  const fixed = Math.max(0, available - free);
  const horizon = new Date(Date.parse(`${input.today}T00:00:00Z`) + 28 * 86_400_000).toISOString().slice(0, 10);
  const due = input.deadlines.filter((item) => item.date >= input.today && item.date <= horizon).sort((a, b) => a.date.localeCompare(b.date));
  // Two or more deadlines within three days of each other, merged into one stretch.
  const crunches: WeekCapacity["crunches"] = [];
  for (let index = 0; index < due.length; index += 1) {
    const group = due.filter((item) => item.date >= due[index]!.date && Date.parse(item.date) - Date.parse(due[index]!.date) <= 2 * 86_400_000);
    if (group.length < 2) continue;
    const last = crunches.at(-1);
    if (last && group[0]!.date <= last.to) { last.to = group.at(-1)!.date; last.titles = [...new Set([...last.titles, ...group.map((item) => item.title)])]; }
    else crunches.push({ from: group[0]!.date, to: group.at(-1)!.date, titles: group.map((item) => item.title) });
  }
  const total = input.lines.reduce((sum, line) => sum + Math.max(0, line.weight), 0);
  const perLine = total > 0 ? input.lines.map((line) => ({ lineId: line.id, label: line.label, hours: Math.round((free * Math.max(0, line.weight)) / total) })) : [];
  const en = input.locale === "en";
  // 「10 月 17 日」 as the Chinese has always read; "Oct 17" in English.
  const day = (date: string) => en ? monthDay(input.locale, date) : `${Number(date.slice(5, 7))} 月 ${Number(date.slice(8, 10))} 日`; // i18n-ignore
  const list = (items: string[]) => en ? joinList(input.locale, items) : items.join("、");
  const notes = [t("每周可用约 {{available}} 小时，固定安排占其中 {{fixed}} 小时，剩约 {{free}} 小时给 {{count}} 条主线。",
    { available: Math.round(available), fixed: Math.round(fixed), free: Math.round(free), count: input.lines.length })];
  if (perLine.length > 1) notes.push(t("按现在的主次，大致是{{split}}。", { split: list(perLine.map((line) => t("{{label}} {{hours}} 小时", { label: line.label, hours: line.hours }))) }));
  if (due.length) notes.push(t("未来四周有 {{count}} 个截止。", { count: due.length }));
  for (const crunch of crunches.slice(0, 2)) {
    const titles = list(crunch.titles.slice(0, 3));
    notes.push(crunch.to !== crunch.from
      ? t("{{from}}到 {{to}}有 {{count}} 个截止挤在一起：{{titles}}。", { from: day(crunch.from), to: day(crunch.to), count: crunch.titles.length, titles })
      : t("{{from}}有 {{count}} 个截止挤在一起：{{titles}}。", { from: day(crunch.from), count: crunch.titles.length, titles }));
  }
  if (free < 5 * Math.max(1, input.lines.length)) notes.push(t("每条主线每周不到 5 小时。"));
  return { available, fixed, free, deadlines: due.length, crunches, perLine, notes };
}

/**
 * The week's skeleton draft (本周骨架草稿), once the start standard stands: each day's free time handed to the lines in proportion to
 * their weight, in the day's order, in blocks of at least 30 minutes. A draft to look at; the scheduler places real work later.
 */
export type SkeletonBlock = { weekday: number; start: string; end: string; lineId: string };
export function skeletonDraft(windows: AvailabilityWindow[], busy: BusySpan[], lines: Array<{ id: string; weight: number }>): SkeletonBlock[] {
  const weighted = lines.filter((line) => line.weight > 0);
  const total = weighted.reduce((sum, line) => sum + line.weight, 0);
  if (!total) return [];
  const spans = freeSpans(windows, busy);
  const freeTotal = [...spans.values()].flat().reduce((sum, [s, e]) => sum + (e - s), 0);
  // Minutes each line is owed over the week; handed out day by day, the line furthest behind its share first.
  const owed = new Map(weighted.map((line) => [line.id, (freeTotal * line.weight) / total]));
  const given = new Map(weighted.map((line) => [line.id, 0]));
  const blocks: SkeletonBlock[] = [];
  for (const weekday of [1, 2, 3, 4, 5, 6, 0]) {
    for (const [s, e] of spans.get(weekday) ?? []) {
      let at = s;
      while (e - at >= 30) {
        const line = [...weighted].sort((a, b) => (given.get(a.id)! - owed.get(a.id)!) - (given.get(b.id)! - owed.get(b.id)!))[0]!;
        const room = Math.max(30, Math.min(e - at, Math.round((owed.get(line.id)! - given.get(line.id)!) / 30) * 30, 180));
        const end = Math.min(e, at + room);
        const last = blocks.at(-1);
        if (last && last.weekday === weekday && last.lineId === line.id && last.end === clock(at)) last.end = clock(end);
        else blocks.push({ weekday, start: clock(at), end: clock(end), lineId: line.id });
        given.set(line.id, given.get(line.id)! + (end - at));
        at = end;
      }
    }
  }
  return blocks;
}

/**
 * A line's weight in the week when the person has not set shares: the base line (rank 1) counts double, the rest once — what the opening
 * card's order says, and nothing more.
 */
export function lineWeights(lines: Array<{ id: string; rank: number | null }>, shares: Record<string, number> | null): Array<{ id: string; weight: number }> {
  if (shares && lines.some((line) => (shares[line.id] ?? 0) > 0)) return lines.map((line) => ({ id: line.id, weight: shares[line.id] ?? 0 }));
  return lines.map((line) => ({ id: line.id, weight: line.rank === 1 ? 2 : 1 }));
}

/** What a round that still asks but holds no question asks, by stage: open, in the interview's own voice. */
export const OPEN_QUESTION: Record<OnboardingStage, string> = {
  narrative: "说一件你这几年做过、现在想起来还挺得意的事？小事也行。",
  orientation: "还有哪条主线、哪份材料没提到？",
  lines: "哪条主线你最想先说清楚：现在在做什么、想做成什么样？",
  situation: "说说你现在的处境：这几周最占你精力、最让你担心的是什么？",
  compass: "做这些事，你最终想得到什么？",
  energy: "一天里什么时候状态最好，什么事最耗你？",
  details: "还有哪个项目的截止日、交付物或验收方式没说清楚？"
};

/**
 * The open question for a round that still asks and holds nothing to answer: the worker adds it when a round is stored, the interview page
 * when its own screen (files the app asks about, facts recorded since) left a stored round empty.
 *
 * `askable` says whether a question may still be put to the person (the question ledger's word: not once answered, not a third time).
 * The stage's own question comes first; one that may not be asked gives way to the next stage's, in `OPEN_QUESTION`'s order and round
 * again (W-184: 「做这些事，你最终想得到什么？」 was answered and asked again word for word the next round, because this question is the app's
 * own and the ledger's repeat check only reads the model's). When every one has been used, the stage's own stands.
 */
export function openStageQuestion(stage: string | undefined, locale?: Locale, askable: (text: string) => boolean = () => true): TurnQuestion {
  const at = (stage && stage in OPEN_QUESTION ? stage : "situation") as OnboardingStage;
  const t = tFor(locale);
  const stages = Object.keys(OPEN_QUESTION) as OnboardingStage[];
  const from = stages.indexOf(at);
  const pick = [...stages.slice(from), ...stages.slice(0, from)].find((name) => askable(t(OPEN_QUESTION[name]))) ?? at;
  return { id: `open-${pick}`, text: t(OPEN_QUESTION[pick]), kind: "free", allowOther: true, identityId: "", projectId: "", options: [] };
}

/**
 * The app's own terms, put back into everyday words wherever the interview says them to the person (2026-10-31: 「硬约束」 and 「定语候选」
 * reached people word for word). Only exact terms with one meaning: the dialogue is told not to use them, and this is the backstop.
 */
const INTERNAL_TERMS: Array<[RegExp, string]> = [
  [/候选定语|定语候选/g, "候选词"], [/定语/g, "形容词"], [/硬约束/g, "固定安排"], [/开始标准/g, "开始前要定的几件事"], [/检查清单/g, "要问的事"]
];
/** Text a round left out (an option with no detail, 2026-10-31 walkthrough C) passes through as it is. */
export const plainTerms = <T extends string | undefined>(text: T): T =>
  typeof text === "string" ? INTERNAL_TERMS.reduce((out, [pattern, word]) => out.replace(pattern, word), text as string) as T : text;

/** A round with the app's own terms put into everyday words: the reply, every question and option, and what the progress says next. */
export function withPlainTerms<T extends { reply: string; questions: TurnQuestion[]; progress?: TurnProgress }>(round: T): T {
  return {
    ...round,
    reply: plainTerms(round.reply),
    questions: round.questions.map((question) => ({ ...question, text: plainTerms(question.text),
      options: question.options.map((option) => ({ ...option, label: plainTerms(option.label), detail: plainTerms(option.detail) })) })),
    ...(round.progress ? { progress: { ...round.progress, next: plainTerms(round.progress.next) } } : {})
  };
}