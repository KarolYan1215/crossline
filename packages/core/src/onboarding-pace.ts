import type { AvailabilityWindow } from "./availability";
import { joinList, monthDay, tFor, type Locale } from "./i18n";
import { locateQuote } from "./sentences";
import { INTERVIEW_FLOW_STAGES, ONBOARDING_STAGES, isWebUrl, type InterviewFlow, type OnboardingStage, type TurnInsight, type TurnProgress } from "./onboarding-turn-schema";

/**
 * What keeps the interview moving and gives something back at every part (2026-10-19, the owner's decisions after testers lost patience):
 * the interview's own progress record, the observation card of the deep stages, a short abstract of what the ledger holds, and what the
 * week looks like — the capacity a person has against what is fixed and due, and a draft of the week once the start standard stands.
 */

/** The parts of the main interview, in order. `details` is not one of them (line interviews still use it). */
export const INTERVIEW_PARTS: OnboardingStage[] = ["orientation", "lines", "situation", "compass", "energy"];
/** The parts of a flow's main interview, in order (`v2` puts the profile module first, docs/profile-and-agent-kit.md §四). */
export const interviewParts = (flow: InterviewFlow = "v1"): OnboardingStage[] =>
  flow === "v1" ? INTERVIEW_PARTS : INTERVIEW_FLOW_STAGES[flow].filter((stage) => stage !== "details");
export const PART_LABEL: Record<OnboardingStage, string> = {
  narrative: "经历", orientation: "开场", lines: "主线", situation: "处境", compass: "指南针", energy: "能量", details: "细节"
};
/** The three deep stages every flow has: 「准」 in each confirms the portrait (the life story's observation is welcome, not required). */
const CONFIRMING_STAGES: OnboardingStage[] = ["situation", "compass", "energy"];

/**
 * Where the person's ratings of observations are kept: `{ "<session>#<round seq>": { verdict, stage, at, text } }`. Under the points
 * rules (2026-11-12) a rating also names the hypothesis it rated, the point it made, and the hypothesis as it was (to take it back), and
 * 「部分对」 keeps the person's correction.
 */
export const ONBOARDING_INSIGHTS = "onboarding.insights";
export type InsightVerdict = "fits" | "off" | "partial";
export type InsightRatings = Record<string, { verdict: InsightVerdict; stage: string; at: string; text?: string; correction?: string;
  hypothesisId?: string; pointId?: string; prior?: { status: "open" | "supported" | "refuted" | "undecided"; rated?: "fits" | "off" | "partial" } }>;
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
 * An observation is kept only when it is what it claims to be (contract A, 2026-11-12): text, a falsifier (「如果……，这条就不准」), and at
 * least one of the person's replies quoted, each quote found in the reply it names; outside data only with a web URL. Any part of the main
 * interview may give one (a line's own interview, `details`, does not). Anything else is dropped, never repaired: a round is not held up for it.
 * The quotes come from at least two different replies (the owner, 2026-11-12): an observation connects things the person said. Of the
 * replay's cards judged 「不准」, most read one answer for what it lacked (「你还举不出一件」).
 * `minReplies` is 1 only for a card on an uncertain hypothesis the log offered resting on one reply (`cardCandidates`).
 */
export function checkInsight(insight: TurnInsight | undefined, replies: Record<string, string>, stage: string | undefined, minReplies = 2): TurnInsight | undefined {
  const text = insight?.text?.trim() ?? "";
  const falsifier = insight?.falsifier?.trim() ?? "";
  if (!text || !falsifier || stage === "details" || !(ONBOARDING_STAGES as readonly string[]).includes(stage ?? "")) return undefined;
  const refs = (insight?.refs ?? []).filter((ref) => typeof ref?.replyId === "string" && typeof ref.quote === "string" && ref.quote.trim()
    && ref.replyId in replies && Boolean(locateQuote(replies[ref.replyId]!, ref.quote)));
  if (!refs.length || refs.length < (insight?.refs ?? []).length || new Set(refs.map((ref) => ref.replyId)).size < minReplies) return undefined;
  const external = (insight?.external ?? []).filter((item) => typeof item?.text === "string" && item.text.trim() && isWebUrl(item.url))
    .slice(0, 3).map((item) => ({ text: item.text.trim(), url: item.url.trim() }));
  return { text, refs: refs.slice(0, 4).map((ref) => ({ replyId: ref.replyId, quote: ref.quote.trim() })), ...(external.length ? { external } : {}), falsifier };
}

/** The help lines the onboarding Skill's 安全 section gives: a round whose reply carries one is answering a disclosure of self-harm. */
const SAFETY_LINES = ["12356", "82951332"];
export const handlesDisclosure = (text: string): boolean => SAFETY_LINES.some((line) => text.includes(line));

/**
 * Words in the person's own reply that name self-harm: high precision on purpose, a floor under the model's own `safety` mark (2026-11-14
 * audit: the round was recognised only by the hotline numbers in the model's reply, so a reply that left them out was not handled at all).
 * Matching ones send the round back to the model when its reply is not the safety reply.
 */
const SELF_HARM = /自杀|轻生|自残|自伤|割腕|不想活|活不下去|结束(自己的)?生命|寻死|suicid|kill myself|end my life|self[- ]harm|hurt myself|want to die|don'?t want to live/iu; // i18n-ignore: matched against the reply
export const mentionsSelfHarm = (text: string): boolean => SELF_HARM.test(text);

/** A stored round that answered a disclosure: the model marked it, or its reply carries the help lines. */
export const safetyRound = (content: { safety?: unknown; reply?: unknown } | undefined): boolean =>
  content?.safety === true || handlesDisclosure(String(content?.reply ?? ""));

/**
 * The replies a disclosure of self-harm sits in: the one a round answered with the help lines, and the person's answer to that round's
 * check. The Skill says such a disclosure is never portrait material, and the model still built three observation cards on it and
 * offered 「情绪上又来一次大三上那样」 as an option (replay 8), and put a card beside the safety check itself (replay 9, 2026-11-14).
 * An observation quoting one of these replies is dropped, and the round that handles a disclosure shows none.
 */
export function disclosureReplies(messages: ReadonlyArray<{ role: string; seq: number; content: unknown }>): Set<string> {
  const ids = new Set<string>();
  messages.forEach((message, index) => {
    if (message.role !== "assistant" || !safetyRound(message.content as { safety?: unknown; reply?: unknown })) return;
    for (let at = index - 1; at >= 0; at -= 1) if (messages[at]!.role === "user") { ids.add(`reply-${messages[at]!.seq}`); break; }
    const answer = messages.slice(index + 1).find((item) => item.role === "user");
    if (answer) ids.add(`reply-${answer.seq}`);
  });
  return ids;
}

/**
 * What every model is shown in place of a reply a disclosure sits in (2026-11-15, docs/onboarding-agent-session.md 「敏感披露」): never
 * the person's words. Replay 15's card retold the disclosure in other words three rounds later, which a check on the cited reply ids
 * could not see: the words were still in the hypotheses' and the extraction's input, so they came back.
 */
export const DISCLOSURE_PLACEHOLDER = "（本人在这条回复里谈到一段艰难时期。原文不给模型看，整场不复述。）"; // i18n-ignore: model-facing

type ConversationMessage = { role: string; seq: number; content: unknown };
const replyTextOf = (message: ConversationMessage) => String((message.content as { text?: unknown } | undefined)?.text ?? "");

/**
 * The replies whose words no model reads again: `disclosureReplies`, and a reply naming self-harm (`mentionsSelfHarm`) that no round has
 * answered yet, or whose round answered it as a disclosure. The extraction reads a reply beside the round that answers it, so a reply is
 * held back before its round says what it was; one the dialogue judged to be about someone else or a topic (`safety: false`) is read.
 */
export function sensitiveReplies(messages: ReadonlyArray<ConversationMessage>): Set<string> {
  const ids = disclosureReplies(messages);
  messages.forEach((message, index) => {
    if (message.role !== "user" || !mentionsSelfHarm(replyTextOf(message))) return;
    const round = messages.slice(index + 1).find((item) => item.role === "assistant");
    if (!round || safetyRound(round.content as { safety?: unknown; reply?: unknown })) ids.add(`reply-${message.seq}`);
  });
  return ids;
}

/** What a rebuilt thread is shown of a round that answered a disclosure: its reply spoke to the disclosure, so it goes too. */
export const SAFETY_ROUND_PLACEHOLDER = "（这一轮按「安全」一节回应了本人。）"; // i18n-ignore: model-facing

/**
 * The conversation with the replies in `hidden` (`reply-N`) replaced by `DISCLOSURE_PLACEHOLDER`, and the reply of every round that
 * answered a disclosure by `SAFETY_ROUND_PLACEHOLDER`.
 */
export function withoutDisclosures<T extends ConversationMessage>(messages: readonly T[], hidden: ReadonlySet<string>): T[] {
  return messages.map((message) => {
    if (message.role === "user" && hidden.has(`reply-${message.seq}`)) return { ...message, content: { ...(message.content as object), text: DISCLOSURE_PLACEHOLDER } };
    if (message.role === "assistant" && safetyRound(message.content as { safety?: unknown; reply?: unknown }))
      return { ...message, content: { ...(message.content as object), reply: SAFETY_ROUND_PLACEHOLDER } };
    return message;
  });
}

/** The person's consent to talk about what a hard time taught them: not asked, asked and waiting, yes or no (asked once a whole interview). */
export type LessonConsent = "unasked" | "asked" | "yes" | "no";
/** The one question that asks it, written by the app (the model only decides when, `askLesson`). */
/**
 * What the 「好，往下」 button under a round's `next` sends, on a line of its own (2026-11-15): the person took the step the dialogue
 * proposed. A reply without it went its own way, which the next round is told (`nextTaken`).
 */
export const NEXT_ACCEPTED = "好，往下。"; // i18n-ignore: the reply line the button sends; matched by `nextTaken`
/** Whether the person took the proposed step: a line of the reply is the button's own (in either language), and nothing else. */
export function nextTaken(reply: string): boolean {
  return reply.split("\n").some((line) => /^\s*(?:好，?往下|go on)[。.!！]?\s*$/iu.test(line));
}

export const LESSON_QUESTION = {
  id: "lesson-consent", kind: "single" as const, allowOther: false, identityId: "", projectId: "",
  // i18n-ignore-start: shown in the interview's language (Chinese only so far, like the profile cards)
  text: "你之前提到过一段很难的时期。如果你愿意，可以聊聊那段时间之前有什么先兆、什么帮到了你，这能帮我以后在你压力大时早点留意。不想聊也完全没关系。",
  options: [{ id: "yes", label: "可以聊聊", detail: "" }, { id: "no", label: "先不聊", detail: "" }]
  // i18n-ignore-end
};
/** The person's answer to `LESSON_QUESTION` in their reply (`【题干】选择：…`): no answer, or anything but 「可以聊聊」, is a no. */
export function lessonAnswer(reply: string): "yes" | "no" {
  const at = reply.indexOf(`【${LESSON_QUESTION.text}】`);
  if (at < 0) return "no";
  const line = reply.slice(at + LESSON_QUESTION.text.length + 2).split("\n")[0] ?? "";
  return line.includes(LESSON_QUESTION.options[0]!.label) && !line.includes(LESSON_QUESTION.options[1]!.label) ? "yes" : "no";
}

/**
 * The person's own words in a reply: what they typed under an answer (after 「补充：」 or 「Added:」) and lines outside the answer format.
 * The 【question】 and the picked labels are the interviewer's and the app's words, not the person's.
 */
export function ownWords(reply: string): string[] {
  return reply.split("\n").flatMap((line) => {
    const said = line.trim();
    if (!said) return [];
    if (!/^[【[]/u.test(said)) return [said];
    const typed = (/补充：(.*)$/u.exec(said)?.[1] ?? /(?:^|\s|\.)\s*Added: (.*)$/u.exec(said)?.[1] ?? "").trim();
    return typed ? [typed] : [];
  });
}

/**
 * What a text is compared with for echoes of a disclosure (`disclosureEchoes`): the person's own words in the hidden replies, and in a
 * reply that names self-harm only those lines. A reply that only follows a safety round counts by its self-harm lines alone; the rest of
 * it is the talk going on. Replay 16 (2026-11-16) sent rounds back for 「自己安排」 from a schedule answer in the same reply and for the
 * app's own 「成为怎样的」: five of y's twelve rounds in one run.
 */
export function disclosureWords(messages: ReadonlyArray<ConversationMessage>, hidden: ReadonlySet<string>): string[] {
  return messages.flatMap((message, index) => {
    if (message.role !== "user" || !hidden.has(`reply-${message.seq}`)) return [];
    const lines = ownWords(replyTextOf(message));
    const harm = lines.filter(mentionsSelfHarm);
    if (harm.length) return harm;
    const before = messages.slice(0, index).reverse().find((item) => item.role === "assistant");
    return before && safetyRound(before.content as { safety?: unknown; reply?: unknown }) ? [] : lines;
  });
}

/** The interviewer's own words — its replies, questions and options — which are never the person's disclosure; a safety round's reply is left out. */
export function interviewerWords(messages: ReadonlyArray<ConversationMessage>): string[] {
  return messages.filter((message) => message.role === "assistant").flatMap((message) => {
    const content = message.content as { reply?: unknown; safety?: unknown; questions?: Array<{ text?: unknown; options?: Array<{ label?: unknown }> }> } | undefined;
    const questions = (content?.questions ?? []).flatMap((question) => [String(question.text ?? ""), ...(question.options ?? []).map((option) => String(option.label ?? ""))]);
    return safetyRound(content) ? questions : [String(content?.reply ?? ""), ...questions];
  });
}

const HAN_RUN = /\p{Script=Han}+/gu;
/**
 * The runs of at least `size` Chinese characters a text shares with a disclosure, leaving out every run the conversation's other replies
 * also hold (their ordinary words: 「那段时间」 said about a job is not the disclosure). An English disclosure is compared by four words.
 */
export function disclosureEchoes(text: string, disclosures: readonly string[], ordinary: readonly string[], size = 4): string[] {
  const grams = (value: string): Set<string> => {
    const out = new Set<string>();
    for (const run of value.match(HAN_RUN) ?? []) for (let at = 0; at + size <= run.length; at += 1) out.add(run.slice(at, at + size));
    const words = value.toLowerCase().match(/[a-z']+/gu) ?? [];
    for (let at = 0; at + 4 <= words.length; at += 1) out.add(words.slice(at, at + 4).join(" "));
    return out;
  };
  const common = new Set(ordinary.flatMap((value) => [...grams(value)]));
  const disclosed = new Set(disclosures.flatMap((value) => [...grams(value)]));
  const shared = (gram: string) => disclosed.has(gram) && !common.has(gram);
  // Overlapping runs reported once, as the stretch of the text they cover together.
  const spans: string[] = [];
  for (const run of text.match(HAN_RUN) ?? []) {
    const covered = new Array<boolean>(run.length).fill(false);
    for (let at = 0; at + size <= run.length; at += 1) if (shared(run.slice(at, at + size))) covered.fill(true, at, at + size);
    for (let at = 0; at < run.length;) {
      if (!covered[at]) { at += 1; continue; }
      let end = at;
      while (end < run.length && covered[end]) end += 1;
      spans.push(run.slice(at, end));
      at = end;
    }
  }
  const words = text.toLowerCase().match(/[a-z']+/gu) ?? [];
  for (let at = 0; at + 4 <= words.length; at += 1) { const gram = words.slice(at, at + 4).join(" "); if (shared(gram)) spans.push(gram); }
  return [...new Set(spans)].slice(0, 3);
}

/** The progress record as stored; anything malformed reads as none (an older round, or a model that left it out). */
export function readTurnProgress(raw: unknown): TurnProgress | undefined {
  const value = raw as Partial<TurnProgress> | undefined;
  if (!value || typeof value !== "object" || !(ONBOARDING_STAGES as readonly string[]).includes(String(value.part))) return undefined;
  const list = (items: unknown) => Array.isArray(items) ? items.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).slice(0, 8) : [];
  const said = list(value.said);
  return { part: value.part as OnboardingStage, covered: list(value.covered), open: list(value.open), partDone: value.partDone === true,
    next: typeof value.next === "string" ? value.next.slice(0, 160) : "", ...(said.length ? { said } : {}) };
}

/**
 * How far the main interview is, for the screen: the part (1-based of `interviewParts(flow)`), its label, and how much of it is
 * clear. The one count every part indicator shows (the bar above the conversation and the right column, W-186). The part is the round's
 * `stage` — what the app paces and offers cards by — and the model's own progress record counts only while it is about that part: the
 * 2026-11-03 walkthrough had the bar at 「第 2/6 部分 · 指南针」 and the right column at the progress record's 「主线」, part 6 of 6.
 */
export function progressView(progress: TurnProgress | undefined, stage: string, flow: InterviewFlow = "v1",
  earlier: string[] = []): { index: number; total: number; label: string; clear: number; of: number; reached: number } {
  const parts = interviewParts(flow);
  const part = (ONBOARDING_STAGES as readonly string[]).includes(stage) ? stage as OnboardingStage : progress?.part ?? (stage as OnboardingStage);
  const at = parts.indexOf(part);
  const index = at < 0 ? (part === "details" ? parts.length : 1) : at + 1;
  const own = progress?.part === part ? progress : undefined;
  const clear = own?.covered.length ?? 0, of = clear + (own?.open.length ?? 0);
  // The furthest part any round got to: a round that goes back to an earlier part for one open item is a question asked again, not the
  // interview starting over (W-235: 「第 6/6 部分 · 还剩约 5 分钟」 became 「第 2/6 部分 · 还剩约 25 分钟」 one round later).
  const reached = Math.max(index, ...earlier.map((one) => parts.indexOf(one as OnboardingStage) + 1));
  return { index, total: parts.length, label: PART_LABEL[part] ?? "定向", clear: own?.partDone ? Math.max(clear, of) : clear,
    of: own?.partDone ? Math.max(clear, of) : of, reached };
}

/** The progress record as the lines the next round starts from (for the dialogue model, not shown). */
/* i18n-ignore-start */
export function progressLines(progress: TurnProgress | undefined, flow: InterviewFlow = "v1"): string[] {
  if (!progress) return [];
  const parts = interviewParts(flow);
  return [`上轮判断：第 ${Math.max(1, parts.indexOf(progress.part) + 1)}/${parts.length} 部分「${PART_LABEL[progress.part]}」${progress.partDone ? "已完成" : "未完成"}`,
    ...(progress.covered.length ? [`已谈清：${progress.covered.join("；")}`] : []),
    ...(progress.open.length ? [`未谈：${progress.open.join("；")}`] : []),
    ...(progress.next ? [`下一步：${progress.next}`] : []),
    ...(progress.said?.length ? [`已经对本人说过的张力：${progress.said.join("；")}`] : [])];
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
/**
 * The deadlines the week counts, from the projects' timelines: each dated item named with its project unless its title already says it,
 * and the project's own deadline unless one of its items falls on that day. Before, a research project's 12-01 deadline was counted twice
 * (as its item and as the project's deadline, 「MoS₂ 存内计算研究 MoS₂ 存内计算第一阶段器件仿真提交导师、MoS₂ 存内计算研究」), and a
 * course's 「2026-11-21 23:59（作业 5）」 read as just 「ECE 555」 (2026-11-06 walkthrough, W-240).
 */
export function timelineDeadlines(timeline: Array<{ name: string; deadline: string; items: Array<{ date: string; title: string }> }>): Array<{ date: string; title: string }> {
  const named = (name: string, title: string) => {
    const core = name.replace(/\s*(研究|项目|课程)$/u, ""); // i18n-ignore: the project's own name, matched in the title's words
    return (title.includes(name) || (core.length >= 2 && title.includes(core)) ? title : `${name} ${title}`).slice(0, 40);
  };
  return timeline.flatMap((project) => {
    const items = project.items.map((item) => ({ date: item.date, title: named(project.name, item.title) }));
    const due = /^\d{4}-\d{2}-\d{2}/.test(project.deadline) ? project.deadline.slice(0, 10) : "";
    if (!due || items.some((item) => item.date.slice(0, 10) === due)) return items;
    const what = project.deadline.match(/[（(]([^）)]+)[）)]/u)?.[1]?.trim();
    return [...items, { date: due, title: what ? named(project.name, what) : project.name.slice(0, 40) }];
  });
}

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

