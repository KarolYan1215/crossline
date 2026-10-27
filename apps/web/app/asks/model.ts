import { ASK_QUADRANTS, askQuadrant, type Ask, type AskKind, type AskQuadrant } from "@crossline/core";
import { tFor, type Locale } from "../../lib/i18n";
import { shortDate } from "../task/format";

/**
 * What the 待确认 page and Today's stack need to say about an ask beyond what the ask itself carries: what happens once it is
 * answered, what happens if nobody answers, and where the thing it is about can be opened. Pure, so the card can be tested without a
 * browser and the wording stays in one place.
 */

/** Per kind, the effect of an answer and of silence, in the app's own terms (read off `lib/asks.ts`'s handlers). Chinese keys, translated on the way out. */
const OUTCOMES: Record<AskKind, { answered: string; unanswered: string }> = {
  backplan_input: { answered: "重新倒推该里程碑的步骤，或撤回尚未开始的自动步骤。", unanswered: "该里程碑没有新的自动步骤，排程只含已有工作。" },
  waiting_due: { answered: "到了：依赖它的工作排进日历；推迟：到新日期再问。", unanswered: "依赖它的工作继续留在日历之外。" },
  capture_blocked: { answered: "按补充的说明重新分析，生成任务提案。", unanswered: "这条收集保持未分析，不进入排程。" },
  materials_blocked: { answered: "重新准备材料，或不等材料直接开始。", unanswered: "任务停在准备材料阶段，不会开始。" },
  gate_insufficient: { answered: "重新排上补做，补交后重新判定。", unanswered: "任务保持未通过，不计入里程碑进度。" },
  gate_failed: { answered: "重新运行验收判定。", unanswered: "已提交的证据保持待判定。" },
  evidence_manual: { answered: "任务记为已验收。", unanswered: "任务停在待验收。" },
  milestone_risk: { answered: "按所选方式调整时间、截止或标准；接受风险后 7 天内不再问。", unanswered: "排程不变，预测完成日仍贴近或晚于截止。" },
  agent_blocked: { answered: "任务转为本人处理，或带着补充的信息重试。", unanswered: "助手的这部分工作保持中断。" },
  calendar_publish_failed: { answered: "重新写入 Crossline 日历。", unanswered: "Crossline 日历停在上次写入的排程。" },
  calendar_sync_failed: { answered: "在设置中恢复日历连接。", unanswered: "排程继续使用最后一次读到的日程。" },
  codex_signed_out: { answered: "重新登录后，后台分析与准备恢复。", unanswered: "需要模型的后台工作保持暂停。" },
  missed_block: { answered: "按所选方式顺延、改期、补记或归档。", unanswered: "已按顺延处理，截止前的余量可能变小。" },
  source_project: { answered: "文件归入所选项目，其中的日程与截止带上项目名。", unanswered: "文件中的日程保持无项目名。" },
  calendar_line_unclear: { answered: "该日程按所选主线着色，同名日程相同。", unanswered: "该日程保持无色。" },
  interview_open: { answered: "回到访谈继续下一轮。", unanswered: "长期目标与里程碑草稿按现有信息设计。" },
  interview_question: { answered: "本轮问题答完后一并交给访谈，进入下一轮。", unanswered: "访谈停在本轮，下一轮不会开始。" },
  event_propose: { answered: "写入 Crossline 日历，提前 10 分钟提醒。", unanswered: "日历中不出现该日程；排程照样避开这段时间。" },
  step_question: { answered: "任务的步骤按回答重新安排。", unanswered: "步骤保持现有安排。" },
  relation_check: { answered: "记录这条飞轮关系是否兑现，计入兑现率。", unanswered: "这条关系的兑现情况不计入。" },
  background_paused: { answered: "查看额度；恢复后自动补上，排程与提醒一直照常。", unanswered: "排程、日历与提醒照常；分析与拆步骤等额度恢复后自动补上。" },
  locked_conflict: { answered: "挪开锁定块，或保留两件事的重叠。", unanswered: "锁定块与新日程继续重叠。" },
  outcome_check: { answered: "完成情况或结果记入任务与里程碑进度；说了出结果的日期就到那天再问。", unanswered: "任务保持已验收，完成情况不计入里程碑进度。" },
  progress_check: { answered: "这一步的进度按回答记下，排程按剩下的部分安排。", unanswered: "进度保持原样，不影响别的事。" },
  milestone_risk_review: { answered: "接受则它的任务提前 1–2 天排完；也可调整截止或降低标准。", unanswered: "排程不变，不为这项风险提前。" },
  prep_question: { answered: "助手按回答把这项准备做完，结果放进要用它的任务的「已备好」。", unanswered: "这项准备不开始；要用它的任务照常排，开始时材料可能不全。" },
  milestone_overdue: { answered: "补做则截止不变、剩下的工作照常排；改日期则按新截止排；放弃则里程碑和未开始的任务归档。", unanswered: "截止停在已过的日期，剩下的工作按已过期排。" }
};

/** What an answer does and what silence does. An option's own detail is preferred over the kind's sentence when it is the recommended one. */
export function askOutcome(ask: Pick<Ask, "kind" | "options">, locale?: Locale): { answered: string; unanswered: string } {
  const t = tFor(locale);
  const fallback = OUTCOMES[ask.kind] ?? { answered: "按所选处理。", unanswered: "相关工作保持现状。" };
  const recommended = ask.options.find((option) => option.recommended && !option.href && option.detail);
  // The option's label and detail were written by the server in the page's language; only the frame is said here.
  return { answered: recommended ? t("推荐「{{label}}」：{{detail}}", { label: recommended.label, detail: recommended.detail }) : t(fallback.answered),
    unanswered: t(fallback.unanswered) };
}

export type AskSource = { label: string; href: string };

const WORK_ORDER_KINDS = new Set<AskKind>(["materials_blocked", "gate_insufficient", "gate_failed", "evidence_manual", "missed_block", "locked_conflict", "step_question"]);
const MILESTONE_KINDS = new Set<AskKind>(["backplan_input", "milestone_risk", "milestone_risk_review", "milestone_overdue"]);

/**
 * The first 「…」 or 《…》 in a title — or, in an English title, the first “…” or "…" — the name of the thing the ask is about. Titles are
 * written by `lib/asks.ts` in the page's language and quote the names in them.
 */
export function quotedName(title: string): string | undefined {
  return /[「《][^」》]+[」》]|“[^”]+”|"[^"]+"/.exec(title)?.[0];
}

/**
 * Where the thing an ask is about can be opened: the task, the milestone, the file, the interview. An option that already links to the
 * same page is not repeated, and the preview's own link is left to the preview.
 */
export function askSources(ask: Pick<Ask, "kind" | "entityId" | "title" | "options" | "preview">, locale?: Locale): AskSource[] {
  const t = tFor(locale);
  const quoted = quotedName(ask.title);
  // 「任务「X」」 / "Task “X”": the name follows the word, with a space in English.
  const named = (word: string) => quoted ? `${t(word)}${locale === "en" ? " " : ""}${quoted}` : t(word);
  const id = encodeURIComponent(ask.entityId);
  const sources: AskSource[] = [];
  if (WORK_ORDER_KINDS.has(ask.kind)) sources.push({ label: ask.kind === "step_question" ? t("任务") : named("任务"), href: `/workbench/${id}` });
  // A folded card (`entityId: "batch"`, several milestones) has no one milestone to open; its preview links the page.
  if (MILESTONE_KINDS.has(ask.kind) && ask.entityId !== "batch") sources.push({ label: named("里程碑"), href: `/milestones?open=${id}` });
  if (ask.kind === "source_project") sources.push({ label: named("文件"), href: `/api/source-documents/${id}/file` });
  if (ask.kind === "capture_blocked") sources.push({ label: t("收集"), href: "/workbench" });
  if (ask.kind === "interview_question") sources.push({ label: t("访谈"), href: "/onboarding" });
  if (ask.kind === "relation_check") sources.push({ label: t("飞轮关系"), href: "/milestones" });
  const taken = new Set([...ask.options.map((option) => option.href).filter(Boolean), ask.preview?.href]);
  return sources.filter((source) => !taken.has(source.href));
}

/** One card per id: the ledger can raise the same question twice (two file dates with one TBD item), and two cards for one answer mislead. */
export function uniqueAsks(asks: Ask[]): Ask[] {
  const seen = new Set<string>();
  return asks.filter((ask) => !seen.has(ask.id) && Boolean(seen.add(ask.id)));
}

/** The asks of each quadrant, in the order they came (already ranked by urgency and importance). */
export function byQuadrant(asks: Ask[]): Record<AskQuadrant, Ask[]> {
  const groups = Object.fromEntries(ASK_QUADRANTS.map((quadrant) => [quadrant, [] as Ask[]])) as Record<AskQuadrant, Ask[]>;
  for (const ask of asks) groups[askQuadrant(ask)].push(ask);
  return groups;
}

/**
 * The request body for `POST /api/asks/answer`. A single option also goes as `optionId`, which the route has always taken; `seconds` is
 * how long the card was on screen (`useVisibleSeconds`).
 */
export function answerBody(askId: string, optionIds: string[], values: Record<string, string>, note: string, seconds?: number): Record<string, unknown> {
  const text = note.trim();
  return { askId, optionIds, ...(optionIds.length === 1 ? { optionId: optionIds[0] } : {}), values, ...(text ? { note: text } : {}),
    ...(seconds === undefined ? {} : { seconds }) };
}

/** The person's words for a refused answer. */
export function answerProblem(code: string | undefined, locale?: Locale): string {
  const t = tFor(locale);
  switch (code) {
    case "ASK_FIELD_REQUIRED": return t("还有必填项未填写");
    case "ASK_FIELD_DATE_INVALID": return t("日期格式不对");
    case "ASK_FIELD_TOO_LONG": return t("内容过长");
    case "ASK_SINGLE_CHOICE": return t("这一题只能选一项");
    case "ASK_NOTE_NOT_TAKEN": return t("这一题需要从选项中选择");
    case "ASK_OPTION_UNKNOWN": return t("先选一项");
    case "ASK_NOT_FOUND": return t("这条已经处理过了");
    default: return t("未保存，请重试");
  }
}

/**
 * The days the decisions that can wait come into the week, counted per day over the coming weeks, for the small chart on 待确认.
 * Days before `today` count on `today`; beyond `days` they are folded into the last bar.
 */
export function entryHistogram(entries: string[], today: string, days = 28): Array<{ day: string; count: number }> {
  const start = Date.parse(`${today}T12:00:00Z`);
  const bars = Array.from({ length: days }, (_, index) => ({ day: new Date(start + index * 86_400_000).toISOString().slice(0, 10), count: 0 }));
  for (const entry of entries) {
    const offset = Math.round((Date.parse(`${entry}T12:00:00Z`) - start) / 86_400_000);
    if (Number.isNaN(offset)) continue;
    bars[Math.max(0, Math.min(days - 1, offset))]!.count += 1;
  }
  return bars;
}

/** 「10/17」 / "Oct 17". */
export const shortDay = (day: string, locale?: Locale) => shortDate(locale, day);

/** How many rows of a folded card are shown before 「另有 N 个」. */
export const ASK_ITEMS_SHOWN = 5;

/** A folded card's rows: the first few, and how many more there are (none once expanded). */
export function itemsShown<T>(items: T[], expanded: boolean, limit = ASK_ITEMS_SHOWN): { shown: T[]; more: number } {
  if (expanded || items.length <= limit) return { shown: items, more: 0 };
  return { shown: items.slice(0, limit), more: items.length - limit };
}
