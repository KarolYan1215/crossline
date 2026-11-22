import { tFor, type Locale } from "./i18n";
import { cleanTaskTitle } from "./task-title";

/**
 * Who does a piece of work (docs/work-split.md, the person's decision of 2026-10-21): the person's time goes only to what grows them or
 * is really theirs; what the assistant can make from information that exists, it makes; what needs one thing only the person holds
 * becomes a short question, after which the assistant goes on.
 *
 * - `person` — the value is in the person's own cognition, skill, judgement or relationships: learning and practice, the core output,
 *   designing and explaining, a consequential choice, and the acts only they can do (sending, attending, submitting, logging in, paying).
 * - `assistant` — a static artefact made from existing information: collecting, compiling, sorting, summarising, excerpting, checking
 *   against a list, an inventory, a ledger, a template, a calculation or simulation run on a plan the person gave.
 * - `ask` — the same, but it needs something only the person holds (data behind their login, a screenshot, an export, one sentence of
 *   scope): one short question, then the assistant does the rest.
 *
 * The model that writes the work gives `owner` (the backplanner, the step planner; their Skills say how to judge it). Since 2026-11-22
 * code no longer re-reads the wording to second-guess it (the regex chain that moved 「整理…」 to the assistant and 「规划…」 to the person
 * is gone): the model's owner stands, and code keeps one floor — an act that leaves the machine or commits the person to someone
 * (sending, submitting, publishing, contacting, attending, paying, signing, trading) is the person's whatever the model said.
 */
export type WorkOwner = "person" | "assistant" | "ask";
export const WORK_OWNERS: readonly WorkOwner[] = ["person", "assistant", "ask"];
export type WorkOwnerCode =
  /** Leaves the machine or commits the person: send, submit, publish, contact, attend, pay, sign, trade. The one floor code keeps. */
  | "external"
  /** A question to the person (the model's `ask`, or a request for a fact folded into the item). */
  | "needs_person_info"
  /** The model's owner stands. */
  | "model";
export type WorkOwnerVerdict = { owner: WorkOwner; reason: string; code: WorkOwnerCode;
  /** For `ask`: the one question put to the person (the model's, else one made from the work's name). */
  question?: string };

/** What `workOwner` reads: a backplan item, a planned step, or a stored work order (title, intent and payload). */
export type WorkItemLike = {
  title?: string; intent?: string; owner?: string; question?: string;
  /** A step's executor, read as the model's owner when `owner` is absent. */
  executor?: string;
  payload?: unknown;
};

export const isWorkOwner = (value: unknown): value is WorkOwner => typeof value === "string" && (WORK_OWNERS as readonly string[]).includes(value);

/** Verbs whose noun compounds name a document, a rule or a day rather than the act (「提交要求」「报名材料」「交易记录」「联系人」). */
const ACT_NOUNS = /(提交|投稿|发布|发送|上传|报名|汇报|答辩|演讲|面试|参加|联系|注册|签约|付款|支付|交易|路演|邮件|法律|删除|订单)(材料|资料|要求|规则|规范|方式|信息|条件|流程|清单|名单|模板|格式|表|稿|指南|入口|系统|字段|渠道|时间|日期|截止|日|记录|数据|明细|流水|条文|列表|凭证|人|者|包|版|计划|说明|准备|题|前|之前)/g;
/** Drafting a message is the assistant's (it is never sent by it); the send is a step of its own. */
const DRAFTING = /(?:起草|草拟|拟写|拟定|准备)[^，。；,;]{0,12}(?:邮件|消息|回复|帖子|文案|申请|信|草稿)/g;
/** A purpose clause says what the work is for, not what it does: 「整理对比表，供本人决定」 is compiling. */
const PURPOSE = /(?:供|以便|便于|用于|留待|好让|之后由?本人|再由本人|由本人|交由本人)[^，。；,;]*/g;
/** Acts that leave the machine or commit the person to someone: the floor no model answer moves. */
const ACTS = /发送|发出|寄出|寄给|发给|提交|上交|递交|交给(?!助手|系统|AI|Agent|agent)|投稿|发布|上传|发帖|发文|转发|回复(?:邮件|对方|评论|老师|导师|客户)|联系|致电|打电话|约见|预约|报名|签署|签约|付款|支付|汇款|转账|下单|购买|买入|卖出|申购|赎回|交易|删除|出席|参加|参与(?:会议|面试|比赛|考试|评审)|面试|答辩|演讲|上台|汇报|路演|向[^，。；,;]{0,10}(?:确认|询问|请教|了解|申请|索取|要)|问(?:助教|老师|导师|师兄|师姐|同事|客户|对方)|\b(?:send|submit|publish|post|upload|pay|sign|buy|sell|trade|attend|present|e-?mail)\b/i;
// The act's verb goes, its noun stays: 「起草发布模板」 still makes a template.
const clean = (text: string) => text.replace(PURPOSE, "").replace(DRAFTING, "").replace(ACT_NOUNS, "$2");

/** Whether the text names an act that leaves the machine or commits the person (the floor `workOwner` keeps). */
export const isExternalAct = (text: string): boolean => ACTS.test(clean(text));

/** The work's name: the title, or the first clause of its description. */
const leadOf = (item: WorkItemLike) => {
  const payload = (item.payload ?? {}) as { title?: unknown };
  return typeof item.title === "string" && item.title.trim() ? item.title.trim()
    : typeof payload.title === "string" && payload.title.trim() ? payload.title.trim() : cleanTaskTitle(item.intent ?? "");
};
const modelOwner = (item: WorkItemLike): WorkOwner => {
  const payload = (item.payload ?? {}) as { owner?: unknown };
  if (isWorkOwner(item.owner)) return item.owner;
  if (isWorkOwner(payload.owner)) return payload.owner;
  if (item.executor === "agent") return "assistant";
  return "person";
};

/**
 * The owner of a piece of work: the model's, except that an external act is the person's. Reads a backplan item, a planned step (its
 * executor as the model's owner when it has no `owner`) or a stored work order (`payload.title`, `payload.owner`, `payload.question`).
 * Work written before owners existed has none and is the person's.
 */
export function workOwner(item: WorkItemLike, locale?: Locale): WorkOwnerVerdict {
  const t = tFor(locale);
  const model = modelOwner(item);
  const lead = leadOf(item);
  if (model !== "person" && isExternalAct(`${lead} ${item.intent ?? ""}`))
    return { owner: "person", code: "external", reason: t("要对外发出、提交、联系、出席或付款，只能本人做") };
  if (model === "ask") return { owner: "ask", code: "model", reason: t("需本人提供信息后由助手做"), question: questionOf(item, lead, locale) };
  return { owner: model, code: "model", reason: model === "person" ? t("本人的核心工作") : t("助手可完成") };
}

/** The model's own question when it gave one; else a plain one made from the work's name. */
function questionOf(item: WorkItemLike, lead: string, locale?: Locale): string {
  const payload = (item.payload ?? {}) as { question?: unknown };
  const own = typeof item.question === "string" && item.question.trim() ? item.question.trim()
    : typeof payload.question === "string" && payload.question.trim() ? payload.question.trim() : "";
  return (own || tFor(locale)("「{{lead}}」需本人提供哪些信息或文件？", { lead })).slice(0, 200);
}

/**
 * Whether a work order belongs on the person's board (Today, 任务, the calendar, the proposals): work the backplanner gave to the
 * assistant or turned into a question carries `payload.owner` and stays off it. Orders written before owners existed have none and stay
 * on.
 */
export const onPersonsBoard = (order: { payload?: unknown }): boolean => {
  const owner = (order.payload as { owner?: unknown } | undefined)?.owner;
  return !isWorkOwner(owner) || owner === "person";
};

/**
 * Whether an order is the person's core work: its recorded owner (an order written before owners is the person's, as it is on the board).
 * Only these serve a milestone (a milestone with nothing but preparation open is worked backwards again) and count as work being made.
 */
export function isPersonCoreOrder(order: { intent: string; payload?: unknown }): boolean {
  return workOwner(order).owner === "person";
}

/** The order an assistant item or a question prepares (`payload.prepares`), "" when it serves none. */
export const preparesOf = (order: { payload?: unknown }): string => {
  const value = (order.payload as { prepares?: unknown } | undefined)?.prepares;
  return typeof value === "string" ? value : "";
};

/** Readiness words: the material is gathered, the list exists, the sample pack is in hand. */
const READINESS = /汇集|收集|搜集|汇总|整理|准备|形成|(?:跟踪|对照|汇总|统计)表|覆盖(?:全部|所有|两门|各)|备齐|齐备|齐全|就绪|到位|备好|清单|目录|台账|索引|样本包|资料包|材料包|下载|归档|梳理|盘点|获取|取得|拿到|建立|建好|\b(?:collected|gathered|ready|inventory|prepared)\b/i;
/** What only the person's own work produces: a result, a score, a hand-in, a capability, someone's answer, a number moved. */
const PERSON_RESULT = /成绩|分数|得分|通过|提交|交出|投出|投稿|发表|发布|上线|面试|答复|回复|录用|签约|用户|销量|收入|增长|粉丝|播放|阅读量|反馈|试用|做出|写出|写完|初稿|定稿|实现|跑通|复现|掌握|独立|能在|测试|实验结果|结论|决定|选定|练习|做完|完成[^，。；,;]{0,8}(?:题|卷|练习|实验|测|稿|版|论文|报告|作品|视频|演示)/;
/**
 * Whether a milestone criterion is only about material being ready (「往年卷与规则已汇集」「样本包已取得」): a statement of readiness
 * with no result of the person's own. A threshold (a number reached) is never preparation.
 */
export function isPreparationOnlyCriterion(criterion: { statement?: string; measure?: { kind?: string } }): boolean {
  const text = String(criterion.statement ?? "");
  if (criterion.measure?.kind === "threshold") return false;
  return READINESS.test(text) && !PERSON_RESULT.test(text);
}

/** Identifying, listing or locating words: 「考核缺口已可按 A- 分数线识别」 is readiness to act, not a result of the person's own. */
const IDENTIFIED = /识别|定位|找出|列出|厘清|摸清|查明/;
/**
 * Whether an approved milestone is only preparation (docs/work-split.md §5): it has criteria, and every one is a readiness statement —
 * material gathered, a list built, a gap identified. Its work is the assistant's; its risk is carried by the milestone it prepares.
 */
export function isPreparationOnlyMilestone(milestone: { successCriteria?: Array<{ statement?: string; measure?: { kind?: string } }> }): boolean {
  const criteria = milestone.successCriteria ?? [];
  // 「分数线」「评分规则」 name a rule to identify against, not a score reached.
  const rules = (text: string) => text.replace(/(?:分数|成绩|评分|得分)(?:线|规则|组成|构成|标准|权重|要求)/g, "");
  return criteria.length > 0 && criteria.every((criterion) => isPreparationOnlyCriterion({ ...criterion, statement: rules(String(criterion.statement ?? "")) })
    || (criterion.measure?.kind !== "threshold" && IDENTIFIED.test(String(criterion.statement ?? "")) && !PERSON_RESULT.test(rules(String(criterion.statement ?? "")))));
}
