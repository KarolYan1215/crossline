/**
 * Whether a piece of work leaves this machine or commits the person to someone: sending, submitting, publishing, contacting, attending,
 * paying, signing, trading, deleting.
 *
 * Since 2026-11-25 (docs/plans/harness-1125.md §1) that is the model's call: every Skill that writes work gives each item a required
 * boolean `external` (`EXTERNAL_FIELD`), stored as `payload.external`. The word list below is the one list left (it merged
 * `work-owner.ts`'s `ACTS` and the old `EXTERNAL_ACTION_PATTERN` with the extra upload/pay words of `workflows.ts`), and it no longer
 * decides for work that carries the field: it reads work written before the field (`readExternal` with no model value), and otherwise
 * only detects a disagreement — the model said not external, the words say external — which is recorded (`disputed`) and the model's
 * answer stands.
 *
 * It is matched against what the work *is* (its title, intent and the person's own part), never against a serialized payload: that used
 * to catch the word "file" in a contract's `kind` and "order" in the phrase "work order", so nothing at all qualified.
 */

/** The `external` field the work-writing Skills carry (strict mode: required on every item). Not `*_SCHEMA`: it is a part. */
export const EXTERNAL_FIELD = { type: "boolean" } as const;

/** Verbs whose noun compounds name a document, a rule or a day rather than the act (「提交要求」「报名材料」「交易记录」「联系人」). */
const ACT_NOUNS = /(提交|投稿|发布|发送|上传|报名|汇报|答辩|演讲|面试|参加|联系|注册|签约|付款|支付|交易|路演|邮件|法律|删除|订单)(材料|资料|要求|规则|规范|方式|信息|条件|流程|清单|名单|模板|格式|表|稿|指南|入口|系统|字段|渠道|时间|日期|截止|日|记录|数据|明细|流水|条文|列表|凭证|人|者|包|版|计划|说明|准备|题|前|之前)/g;
/** Drafting a message is the assistant's (it is never sent by it); the send is a step of its own. */
const DRAFTING = /(?:起草|草拟|拟写|拟定|准备)[^，。；,;]{0,12}(?:邮件|消息|回复|帖子|文案|申请|信|草稿)/g;
/** A purpose clause says what the work is for, not what it does: 「整理对比表，供本人决定」 is compiling. */
const PURPOSE = /(?:供|以便|便于|用于|留待|好让|之后由?本人|再由本人|由本人|交由本人)[^，。；,;]*/g;
/** Acts that leave the machine or commit the person to someone, and the objects that only such an act touches (法律, 产权, 券商). */
/* i18n-ignore-start: a pattern read against what a model wrote */
export const EXTERNAL_ACTION_PATTERN = new RegExp([
  "发送|发出|寄出|寄给|发给|提交|上交|递交|交给(?!助手|系统|AI|Agent|agent)|投稿|发布|上传|发帖|发文|转发|回复(?:邮件|对方|评论|老师|导师|客户)",
  "联系|致电|打电话|约见|预约|报名|签署|签约|付款|支付|汇款|转账|下单|购买|买入|卖出|出售|申购|赎回|交易|删除|订单|券商|产权|财产|法律|邮件",
  "出席|参加|参与(?:会议|面试|比赛|考试|评审)|面试|答辩|演讲|上台|汇报|路演",
  "向[^，。；,;]{0,10}(?:确认|询问|请教|了解|申请|索取|要)|问(?:助教|老师|导师|师兄|师姐|同事|客户|对方)",
  "\\b(?:send|sends|sending|sent|submit|submits|submitted|submitting|submission|publish|publishes|published|publishing|post|posting|upload|pay"
    + "|sign|signs|signing|buy|buying|sell|selling|purchase|purchases|purchased|purchasing|trade|trades|trading|transfer|transfers|transferring"
    + "|delete|deletes|deleting|attend|present|legal|brokerage|broker|message|messages|messaging|e-?mail|e-?mails|emailing|emailed)\\b"
].join("|"), "i");
/* i18n-ignore-end */
// The act's verb goes, its noun stays: 「起草发布模板」 still makes a template.
const clean = (text: string) => text.replace(PURPOSE, "").replace(DRAFTING, "").replace(ACT_NOUNS, "$2");

/** Whether the words name an act that leaves the machine or commits the person (the one word list; see the file comment). */
export function mentionsExternalAction(...texts: Array<string | undefined>): boolean {
  return EXTERNAL_ACTION_PATTERN.test(clean(texts.filter(Boolean).join(" ")));
}

/**
 * Whether the work is external: the model's `external` when the work carries one, else the word list (work written before the field).
 * `disputed`: the model said not external while the words say it is — the model's answer stands and the caller records the disagreement
 * (the worker's `owner-disputes` telemetry), so a recorded case can become a replay fixture.
 */
export type ExternalReading = { external: boolean; by: "model" | "words"; disputed: boolean };
export function readExternal(model: unknown, ...texts: Array<string | undefined>): ExternalReading {
  const words = mentionsExternalAction(...texts);
  if (typeof model !== "boolean") return { external: words, by: "words", disputed: false };
  return { external: model, by: "model", disputed: !model && words };
}

/** The model's `external` on a work item or a stored work order (top level first, then `payload.external`); undefined when absent. */
export const externalOf = (item: { external?: unknown; payload?: unknown }): boolean | undefined => {
  if (typeof item.external === "boolean") return item.external;
  const value = (item.payload as { external?: unknown } | undefined)?.external;
  return typeof value === "boolean" ? value : undefined;
};
