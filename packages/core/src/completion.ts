import type { SuccessCriterion } from "./index";

/**
 * Pressing 完成 is acceptance (the owner's decision of 2026-10-15). 「ECE 555 作业 2」 marked done is done: nothing asks again, nothing
 * waits for a gate, no evidence is required. The milestone gate is left for what the person did not do themselves (the assistant's
 * delivered work); the person's own completion goes straight to `accepted`.
 *
 * Some work's result is not known when it is finished, and for that — and only that — the 小帮手 asks later, at an idle moment
 * (`outcome_check` in `nudges.ts`): how it went, or when the score or result comes out. Three kinds:
 * - `result_pending`: somebody else judges it later — an exam sat, a paper submitted, an interview, a competition: the score is the point;
 * - `quality`: the quality of what was made is hard to read off it (a draft, a design, a piece of content);
 * - `exploration`: research or exploring with no definite product.
 * Everything else — handing in, finishing homework, sending, attending, filing, looking something up, solving and practising — is
 * `self_evident`: done when the person says so.
 */
export type CompletionMode = "self_evident" | "needs_assessment";
export type AssessmentReason = "result_pending" | "quality" | "exploration";
export type CompletionRule = {
  mode: CompletionMode;
  reason?: AssessmentReason;
  /** One line on why, for the record and the card. */
  why: string;
  /** What the 小帮手 asks afterwards (needs_assessment only). */
  question?: string;
  /** How long after completion it is first asked: a score needs a day at least; how it went can be asked the same day. */
  askAfterHours?: number;
  /** Who decided: the person at approval or on the task, the model that wrote the task, or the old title rules. */
  by: "person" | "model" | "rule";
};

/**
 * How the model that wrote a task (capture analysis, backplanner, step planner) says its completion is taken, read from what the task
 * is rather than from words in its title (the owner's direction of 2026-10-15: 「Hult Prize 第一轮」 names no exam yet waits for the
 * judges). Strict-mode shape: every field present, "" for none.
 */
export type ModelCompletion = { mode: CompletionMode; reason: AssessmentReason | ""; why: string; question: string; askAfterHours: number };
/** The `completion` field each of those schemas carries. Not named `*_SCHEMA`: it is a part, not a Skill's whole answer. */
export const COMPLETION_FIELD = { type: "object", additionalProperties: false, required: ["mode", "reason", "why", "question", "askAfterHours"],
  properties: {
    mode: { type: "string", enum: ["self_evident", "needs_assessment"] },
    reason: { type: "string", enum: ["result_pending", "quality", "exploration", ""] },
    why: { type: "string", minLength: 1, maxLength: 300 },
    question: { type: "string", maxLength: 300 },
    askAfterHours: { type: "number", minimum: 0 }
  } } as const;

const REASONS: readonly AssessmentReason[] = ["result_pending", "quality", "exploration"];
const DEFAULT_HOURS: Record<AssessmentReason, number> = { result_pending: 24, quality: 2, exploration: 2 };
/** A model's `completion` made usable, or undefined when it is missing or malformed (a task written before the field existed). */
export function readModelCompletion(value: unknown): ModelCompletion | undefined {
  const raw = value as Partial<Record<keyof ModelCompletion, unknown>> | undefined;
  if (!raw || typeof raw !== "object" || (raw.mode !== "self_evident" && raw.mode !== "needs_assessment")) return undefined;
  const text = (field: unknown) => typeof field === "string" ? field.trim().slice(0, 300) : "";
  if (raw.mode === "self_evident") return { mode: "self_evident", reason: "", why: text(raw.why) || "交付即完成", question: "", askAfterHours: 0 };
  const reason = REASONS.includes(raw.reason as AssessmentReason) ? raw.reason as AssessmentReason : "quality";
  const hours = Number(raw.askAfterHours);
  return { mode: "needs_assessment", reason, why: text(raw.why), question: text(raw.question),
    askAfterHours: Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24 * 30) : DEFAULT_HOURS[reason] };
}

type OrderLike = { intent: string; payload?: unknown };
type PayloadLike = { title?: string; completionMode?: CompletionMode; completion?: unknown; evidenceContract?: Array<{ kind?: string; description?: string }> };

const askFor = (reason: AssessmentReason, title: string) => reason === "result_pending" ? `${quote(title)}的成绩或结果出来了吗？`
  : reason === "exploration" ? `${quote(title)}有哪些收获，完成得怎么样？` : `${quote(title)}完成得怎么样？`;

// Fallback for tasks written before the models judged completion (no `payload.completion`); a new task never reaches these rules.
/** Something sat or submitted for somebody else's judgement. */
const JUDGED_EVENT = /(考试|测验|小测|期中|期末|面试|答辩|投稿|竞赛|比赛|路演|评审|quiz|exam|midterm|final|interview|pitch|submission to)/i;
/** Work towards such an event, not the event: preparing for an exam is not sitting it. */
const TOWARDS = /(复习|准备|整理|汇集|汇总|确认|询问|练习|模拟|提纲|材料|范围|题型|规则|台账|成绩记录|当前成绩|报名)/;
/** Done when said: handing in, finishing homework, sending, attending, filing, looking up. */
const SELF_EVIDENT = /(提交|交付|上交|作业|发送|发出|寄出|发邮件|参加|出席|上课|听讲|报名|缴费|付款|预约|预订|注册|安装|下载|打印|归档|整理|汇集|汇总|导出|取得|获取|确认|询问|联系|登记|填写|盘点|配置|部署|复习|练习|解题|做题|推导)/;
const EXPLORATION = /(探索|调研|研究|尝试|摸索|熟悉|了解|学习|阅读|读完|explore|research|investigate)/i;
const QUALITY = /(撰写|起草|写作|写出|设计|制作|剪辑|拍摄|录制|方案|提纲|论文|报告|稿|笔记|视频|文章|内容包|deck|pitch)/i;

const quote = (title: string) => `「${title.slice(0, 40)}」`;

/**
 * How a task's completion is taken; `completionMode` is its one-word form. In order: the person's own choice (`payload.completionMode`,
 * at approval or on the task) > the judgement of the model that wrote the task (`payload.completion`) > the title rules below, which
 * only old tasks without a model judgement still reach.
 */
export function completionRule(order: OrderLike): CompletionRule {
  const payload = (order.payload ?? {}) as PayloadLike;
  const title = (payload.title ?? "").trim() || order.intent.trim();
  const text = `${title} ${order.intent}`;
  const model = readModelCompletion(payload.completion);
  if (payload.completionMode === "self_evident") return { mode: "self_evident", why: "本人选定：点完成即验收", by: "person" };
  if (payload.completionMode === "needs_assessment") {
    // The model's reason (a score to come, quality, exploration) still says what to ask; the person only chose to be asked.
    const reason = model?.mode === "needs_assessment" ? model.reason as AssessmentReason : "quality";
    return { mode: "needs_assessment", reason, why: "本人选定：完成后再问结果", question: model?.question || askFor(reason, title),
      askAfterHours: model?.mode === "needs_assessment" ? model.askAfterHours : DEFAULT_HOURS[reason], by: "person" };
  }
  if (model?.mode === "self_evident") return { mode: "self_evident", why: model.why, by: "model" };
  if (model) {
    const reason = model.reason as AssessmentReason;
    return { mode: "needs_assessment", reason, why: model.why || "完成后再问结果", question: model.question || askFor(reason, title), askAfterHours: model.askAfterHours, by: "model" };
  }
  if (JUDGED_EVENT.test(title) && !TOWARDS.test(title))
    return { mode: "needs_assessment", reason: "result_pending", why: "结果由别人之后评定（成绩、录用、评审意见）",
      question: askFor("result_pending", title), askAfterHours: 24, by: "rule" };
  if (SELF_EVIDENT.test(title)) return { mode: "self_evident", why: "交付本身就是完成：点完成即验收", by: "rule" };
  if (EXPLORATION.test(text)) return { mode: "needs_assessment", reason: "exploration", why: "探索类工作没有明确产物，完成程度要问本人",
    question: askFor("exploration", title), askAfterHours: 2, by: "rule" };
  if (QUALITY.test(title)) return { mode: "needs_assessment", reason: "quality", why: "产出的质量难以直接判断",
    question: askFor("quality", title), askAfterHours: 2, by: "rule" };
  return { mode: "self_evident", why: "点完成即验收", by: "rule" };
}

export function completionMode(order: OrderLike): CompletionMode {
  return completionRule(order).mode;
}

/** How the person says it went, at completion or when asked afterwards. */
export type OutcomeLevel = "smooth" | "barely" | "gaps";
export const OUTCOME_LEVELS: ReadonlyArray<{ id: OutcomeLevel; label: string }> = [
  { id: "smooth", label: "顺利" }, { id: "barely", label: "勉强" }, { id: "gaps", label: "有遗漏" }
];
export type CompletionOutcome = { level: OutcomeLevel; note: string };
/** The optional 「完成情况」 a completion may carry; anything malformed is no outcome. */
export function readCompletionOutcome(value: unknown): CompletionOutcome | undefined {
  const raw = value as { level?: unknown; note?: unknown } | undefined;
  if (!raw || typeof raw !== "object" || !OUTCOME_LEVELS.some((item) => item.id === raw.level)) return undefined;
  return { level: raw.level as OutcomeLevel, note: typeof raw.note === "string" ? raw.note.trim().slice(0, 300) : "" };
}

/**
 * A reported score read against the bound milestone's threshold: only when the milestone has exactly one threshold criterion, since a
 * single number cannot be matched to one of several. 「92/100」 reads 92; 「46/50」 reads 92 when the line is a percentage.
 */
export function outcomeCriteriaVerdict(criteria: readonly SuccessCriterion[], score: string): Array<{ criterionId: string; met: "met" | "unmet"; observed: string }> {
  const thresholds = criteria.filter((criterion) => criterion.measure.kind === "threshold");
  if (thresholds.length !== 1) return [];
  const criterion = thresholds[0]!;
  const measure = criterion.measure as Extract<SuccessCriterion["measure"], { kind: "threshold" }>;
  const match = score.match(/(-?\d+(?:\.\d+)?)\s*(?:\/\s*(\d+(?:\.\d+)?))?/);
  if (!match) return [];
  let value = Number(match[1]);
  const outOf = match[2] ? Number(match[2]) : undefined;
  if (outOf && outOf !== 100 && /%|百分/.test(measure.unit)) value = Math.round((value / outOf) * 1000) / 10;
  if (!Number.isFinite(value)) return [];
  const met = measure.comparator === "gte" ? value >= measure.value : value <= measure.value;
  return [{ criterionId: criterion.id, met: met ? "met" : "unmet", observed: `本人报告：${score.trim().slice(0, 60)}` }];
}

/**
 * The acceptance standard in the person's words: the evidence contract as it reads on a card or an ask, fixed when the task is approved
 * (`acceptanceStandard` on the payload). Judging afterwards uses this standard only and adds none of its own.
 */
export function acceptanceStandardLines(contract: ReadonlyArray<{ description?: string; required?: boolean }> | undefined): string[] {
  return (contract ?? []).map((item) => ({ line: (item.description ?? "").trim(), optional: item.required === false }))
    .filter((item) => item.line).map((item) => `${item.line}${item.optional ? "（可选）" : ""}`);
}
