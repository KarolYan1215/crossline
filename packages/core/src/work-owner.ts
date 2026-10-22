import { cleanTaskTitle } from "./task-title";
import { stepLeavesMachine } from "./workflows";

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
 * The model that writes the work gives `owner`; `workOwner` corrects it by what the work produces and the verbs it is made of, never by
 * the domain (an exam, a paper, a shop or a portfolio are all read the same way). Its heuristics only ever move work away from the
 * person; what it never lets the assistant take — sending, submitting, publishing, logging in, paying, graded answers, consequential
 * decisions, the person's own practice — goes back to the person whatever the model said.
 */
export type WorkOwner = "person" | "assistant" | "ask";
export const WORK_OWNERS: readonly WorkOwner[] = ["person", "assistant", "ask"];
export type WorkOwnerCode =
  /** Leaves the machine or commits the person: send, submit, publish, contact, attend, pay, sign, trade. */
  | "external"
  /** A consequential choice: choosing, deciding, settling a direction or a plan. */
  | "decision"
  /** The answers to graded work. */
  | "graded"
  /** The person's own practice or learning: nobody can practise for them. */
  | "person_skill"
  /** Only reviewing what the assistant made, or writing an acceptance checklist: the gate judges the assistant's output. */
  | "review_only"
  /** A static artefact that needs data behind the person's login, a screenshot, an export or a sentence of scope. */
  | "needs_person_info"
  /** A static artefact made from existing information. */
  | "static_artifact"
  /** None of the rules applies: the model's owner stands. */
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
const ACT_NOUNS = /(提交|投稿|发布|发送|上传|报名|汇报|答辩|演讲|面试|参加|联系|注册|签约|付款|支付|交易|路演|邮件|法律|删除|订单)(?:材料|资料|要求|规则|规范|方式|信息|条件|流程|清单|名单|模板|格式|表|稿|指南|入口|系统|字段|渠道|时间|日期|截止|日|记录|数据|明细|流水|条文|列表|人|者|包|版|计划|说明|准备|题|前|之前)/g;
/** Drafting a message is the assistant's (it is never sent by it); the send is a step of its own. */
const DRAFTING = /(?:起草|草拟|拟写|拟定|准备)[^，。；,;]{0,12}(?:邮件|消息|回复|帖子|文案|申请|信|草稿)/g;
/** A purpose clause says what the work is for, not what it does: 「整理对比表，供本人决定」 is compiling. */
const PURPOSE = /(?:供|以便|便于|用于|留待|好让|之后由?本人|再由本人|由本人|交由本人)[^，。；,;]*/g;
/** Acts that leave the machine or commit the person to someone. 「登录」 is apart: what sits behind a login is the person's to hand over. */
const ACTS = /发送|发出|寄出|寄给|发给|提交|上交|递交|交给(?!助手|系统|AI|Agent|agent)|投稿|发布|上传|发帖|发文|转发|回复(?:邮件|对方|评论|老师|导师|客户)|联系|致电|打电话|约见|预约|报名|签署|签约|付款|支付|汇款|转账|下单|购买|买入|卖出|申购|赎回|交易|删除|出席|参加|参与(?:会议|面试|比赛|考试|评审)|面试|答辩|演讲|上台|汇报|路演|向[^，。；,;]{0,10}(?:确认|询问|请教|了解|申请|索取|要)|问(?:助教|老师|导师|师兄|师姐|同事|客户|对方)|\b(?:send|submit|publish|post|upload|pay|sign|buy|sell|trade|attend|present|e-?mail)\b/i;
const LOGIN = /登录|登入|\blog ?in\b|\bsign ?in\b/i;
const DECISION = /选定|选出|挑选|(?<!题)选择(?!题)|决定|拍板|取舍|定夺|敲定|决策|确定(?:方案|人选|方向|选题|策略|是否|哪|优先)|\b(?:decide|choose|pick|select)\b/i;
const GRADED = /作业|习题|小测|测验|考试|期中|期末|课程项目|大作业|实验报告|homework|\bhw\s?\d|quiz|exam|midterm|assignment/i;
const ANSWERS = /完成|作答|解答|答题|求解|做(?!好)|写|\b(?:solve|answer|complete)\b/i;
/** The person's own practice and learning (the verb, not a noun built on it: 「练习题」「复习提纲」「学习资料」 are things). */
const LEARN = /(?:复习|练习|学习|背诵|默写|刷题|做题|解题|自测|模拟考|演练|排练|训练|推导|证明|理解|掌握)(?!提纲|资料|材料|清单|范围|要点|题|册|集|数据|素材|笔记|计划|方案|记录|目标)|做[^，。；,;]{0,6}(?:真题|往年卷|习题|练习题|模拟题)|\b(?:practi[cs]e|rehearse|review for|study)\b/i;
/** Making the core output, designing, explaining, planning, analysing: what stops compiling words in a title from counting as compiling. */
const CORE = /写(?:作|出|下|成|一篇|论文|报告|初稿|第|方法|引言|讨论|结论|脚本|文案|稿|综述|代码|程序)|撰写|改写|重写|修改(?:论文|稿|文|方法|方案)|设计|论证|解释|分析|判断|评估|规划|计划(?!表)|制定(?:方案|计划|策略|规划|目标)|构思|创作|拍摄|录制|讲解|做实验|实验(?!数据|记录|参数|结果|报告|方案|设置|条件|材料|室)|实操|动手|搭建|实现|编写|开发|调试|访谈|面谈|沟通|谈判|反思|复盘|定稿|\b(?:design|write|draft the|analy[sz]e|plan|build|implement|interview)\b/i;
/** Making a static artefact from information that exists. */
const STATIC = /收集|汇集|搜集|采集|汇总|汇编|摘录|摘抄|盘点|清点|编目|归档|登记|下载|检索|查找|查阅|搜索|整理(?!思路|想法|观点|心得|论证)|梳理(?:材料|资料|文献|清单|规则|要求|条款|课程|概念|知识点)|核对(?!答案)|对照表|列出|列清单|(?:建立|建|做|制作|编制|生成)[^，。；,;]{0,10}(?:台账|清单|目录|索引|表格|对照表|汇总表|样本包|资料包|材料包|模板|时间线)|(?:获取|取得|拿到|获得|备齐)[^，。；,;]{0,8}(?:样本|材料|资料|数据|模板|文件|讲义|往年卷|真题|报告)|准备(?:材料|资料|模板|文件)|起草[^，。；,;]{0,10}(?:模板|清单|表格|大纲|提纲)|格式化|排版|转录|转写|标注|统计|制表|(?:按|依照|根据)[^，。；,;]{0,12}(?:方案|参数|配置|设定)[^，。；,;]{0,6}(?:跑|运行|计算|仿真|模拟)|跑通?(?:仿真|模拟|脚本|计算|回测)|(?:补|补充|补上|更新|扩充|完善|编)[^，。；,;]{0,10}(?:提纲|大纲|清单|目录|台账|索引|对照表|汇总表|公式表|速查表|术语表|时间线)|\b(?:collect|gather|compile|catalog(?:ue)?|inventory|download|transcribe|tabulate|summari[sz]e)\b/i;
/** Only reviewing what the assistant made, or writing the checklist an acceptance is judged by. */
const REVIEW_ONLY = /(?:验收|检查|核对|审阅|审核|复核|过目|查看|浏览|确认)[^，。；,;]{0,6}(?:助手|AI|Agent|agent|系统)[^，。；,;]{0,8}(?:产出|结果|整理|清单|材料|草稿|文件|成果)?|(?:验收|检查|核对|自查|审核)(?:清单|标准|要点|口径)|界定(?:范围|边界)|(?:定义|划定)(?:范围|边界)|\b(?:acceptance checklist|review the assistant)/i;
/** What only the person holds: what sits behind their login or in their own records, a screenshot, an export, a sentence of scope. */
const PERSON_HELD = /账户|账号|后台|个人(?:数据|记录|信息|账单|资料)|本人(?:的|提供|持有)|自己的|我的|私人|私有|截图|导出|成绩单|已出成绩|已出的成绩|(?:成绩|分数)(?:记录|明细)|账单|流水|对账单|持仓|余额|工资|收支|体检|病历|化验|聊天记录|邮箱|收件箱|相册|手机里|口径/;
/** A fact the person gives in a sentence or a file: a scope, a format, a date, their own data. */
const ASK_FACT = /^(?:确认|明确|确定|提供|告知|补充|填写|说明)[^，。；,;]{0,14}(?:范围|口径|标准|要求|偏好|格式|版本|日期|时间|名单|信息|数据|账号|截图|导出|情况|现状|成绩|分数)/;

const clean = (text: string) => text.replace(PURPOSE, "").replace(DRAFTING, "").replace(ACT_NOUNS, "");
/** The work's name: the title, or the first clause of its description; the course code a title may lead with stays, it matches nothing. */
const leadOf = (item: WorkItemLike) => {
  const payload = (item.payload ?? {}) as { title?: unknown };
  const title = typeof item.title === "string" && item.title.trim() ? item.title.trim()
    : typeof payload.title === "string" && payload.title.trim() ? payload.title.trim() : cleanTaskTitle(item.intent ?? "");
  return title;
};
const modelOwner = (item: WorkItemLike): WorkOwner => {
  const payload = (item.payload ?? {}) as { owner?: unknown };
  if (isWorkOwner(item.owner)) return item.owner;
  if (isWorkOwner(payload.owner)) return payload.owner;
  if (item.executor === "agent") return "assistant";
  return "person";
};

/** Whether this text names a static artefact made from existing information (and nothing of the person's own making or learning). */
export const isStaticArtifactWork = (text: string): boolean => {
  const lead = clean(text);
  return STATIC.test(lead) && !CORE.test(lead) && !LEARN.test(lead);
};
/** Whether this text is only reviewing the assistant's output, or writing an acceptance checklist: the gate's job, not a step. */
export const isReviewOnlyWork = (text: string): boolean => REVIEW_ONLY.test(text) && !CORE.test(text) && !LEARN.test(text);

/**
 * Corrects the owner the model gave a piece of work, by what the work produces. Reads a backplan item, a planned step (its executor as
 * the model's owner when it has no `owner`) or a stored work order (`payload.title`, `payload.owner`, `payload.question`).
 */
export function workOwner(item: WorkItemLike): WorkOwnerVerdict {
  const model = modelOwner(item);
  const lead = leadOf(item);
  const act = clean(`${lead} ${item.intent ?? ""}`);
  const leadText = clean(lead);
  const keep = (owner: WorkOwner, code: WorkOwnerCode, reason: string): WorkOwnerVerdict => owner === "ask"
    ? { owner, code, reason, question: questionOf(item, lead) } : { owner, code, reason };
  // What never goes to the assistant, whatever the model said.
  const staticWork = isStaticArtifactWork(lead);
  // The shared external words also name things (「邮件」「券商」「订单」); compiling from them is not acting on them, so for static work
  // only the acts themselves count.
  if (ACTS.test(act) || (!staticWork && stepLeavesMachine(act))) return keep("person", "external", "要对外发出、提交、联系、出席或付款，只能本人做");
  if (DECISION.test(act)) return keep("person", "decision", "有后果的选择由本人做");
  if (GRADED.test(leadText) && ANSWERS.test(leadText) && !staticWork) return keep("person", "graded", "带评分的作答由本人完成");
  if (LEARN.test(leadText) && !staticWork) return keep("person", "person_skill", "练习和学习只能本人做");
  // What the person's time is not for.
  if (isReviewOnlyWork(leadText)) return keep("assistant", "review_only", "只是验收助手产出或写验收清单：交给验收关卡，本人开始核心步骤时看一眼");
  if (LOGIN.test(act)) return keep("ask", "needs_person_info", "登录后的内容由本人上传文件或截图，助手接着做");
  if (staticWork) return PERSON_HELD.test(act)
    ? keep("ask", "needs_person_info", "需要本人持有的数据或一句口径，问一句后由助手做")
    : keep("assistant", "static_artifact", "从已有信息产出的静态产物，由助手做");
  if (ASK_FACT.test(leadText) && !CORE.test(leadText)) return keep("ask", "needs_person_info", "只需本人给一句信息，不占本人的任务时间");
  return keep(model, "model", model === "person" ? "本人的核心工作" : model === "assistant" ? "助手可完成" : "需本人提供信息后由助手做");
}

function questionOf(item: WorkItemLike, lead: string): string {
  const payload = (item.payload ?? {}) as { question?: unknown };
  const own = typeof item.question === "string" && item.question.trim() ? item.question.trim()
    : typeof payload.question === "string" && payload.question.trim() ? payload.question.trim() : "";
  return (own || `「${lead}」需本人提供哪些信息或文件？`).slice(0, 200);
}

/**
 * Whether a work order belongs on the person's board (Today, 任务, the calendar, the proposals): work the backplanner gave to the
 * assistant or turned into a question carries `payload.owner` and stays off it. Orders written before owners existed have none and stay
 * on until the one-time reorganisation (docs/work-split.md §5) judges them with `workOwner`.
 */
export const onPersonsBoard = (order: { payload?: unknown }): boolean => {
  const owner = (order.payload as { owner?: unknown } | undefined)?.owner;
  return !isWorkOwner(owner) || owner === "person";
};

/** Readiness words: the material is gathered, the list exists, the sample pack is in hand. */
const READINESS = /汇集|收集|搜集|整理|准备|备齐|齐备|齐全|就绪|到位|备好|清单|目录|台账|索引|样本包|资料包|材料包|下载|归档|梳理|盘点|获取|取得|拿到|建立|建好|\b(?:collected|gathered|ready|inventory|prepared)\b/i;
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
