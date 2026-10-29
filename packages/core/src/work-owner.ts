import { tFor, type Locale } from "./i18n";
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
  /** Designing, interpreting or planning the person's own work, or writing its core output: theirs even when the model handed it over. */
  | "design"
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
  /** For a step: the title of the task it belongs to. A step of graded work that touches the problems or the answers is the person's. */
  taskTitle?: string;
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
/** Acts that leave the machine or commit the person to someone. 「登录」 is apart: what sits behind a login is the person's to hand over. */
const ACTS = /发送|发出|寄出|寄给|发给|提交|上交|递交|交给(?!助手|系统|AI|Agent|agent)|投稿|发布|上传|发帖|发文|转发|回复(?:邮件|对方|评论|老师|导师|客户)|联系|致电|打电话|约见|预约|报名|签署|签约|付款|支付|汇款|转账|下单|购买|买入|卖出|申购|赎回|交易|删除|出席|参加|参与(?:会议|面试|比赛|考试|评审)|面试|答辩|演讲|上台|汇报|路演|向[^，。；,;]{0,10}(?:确认|询问|请教|了解|申请|索取|要)|问(?:助教|老师|导师|师兄|师姐|同事|客户|对方)|\b(?:send|submit|publish|post|upload|pay|sign|buy|sell|trade|attend|present|e-?mail)\b/i;
/**
 * The person's money records: compiling them is never asked of the person (2026-10-27, the owner: 「助手还要你上传交易记录太麻烦了，删掉，
 * 自动记录」). They come in by themselves (bookkeeping from mail, the phone, connected mailboxes); the assistant works from what is recorded
 * and marks what is missing. Moving money (下单, 转账 …) is still the person's.
 */
const MONEY_RECORDS = /账户(?:记录|资料|基线|明细|数据)?|账单|流水|对账单|持仓|余额|收支|交易(?:记录|明细|流水)|\b(?:transactions?|statements?|balances?|holdings)\b/i;
const MOVES_MONEY = /买入|卖出|下单|申购|赎回|付款|支付|汇款|转账|\b(?:buy|sell|trade|pay|transfer)\b/i;
export const isMoneyRecordWork = (text: string): boolean => isStaticArtifactWork(text) && MONEY_RECORDS.test(text) && !MOVES_MONEY.test(text);
const LOGIN = /登录|登入|\blog ?in\b|\bsign ?in\b/i;
/**
 * Changing a setting in the person's own app or account (「在 Progressive 应用中核对驾驶员并启用 Accident Response 功能」): it happens behind
 * their login, on their account, so it is theirs. The step was planned for the assistant on the real account (W-144). A list or a guide
 * about it (「整理应用内启用核对清单」) is a thing, not the act.
 */
const ACCOUNT_SETTING = /(?:启用|开启|开通|激活|停用|关闭|绑定|解绑|注销)[^，。；,;]{0,24}?(?:功能|服务|订阅|自动续费|账户|账号|权限|通知|两步验证|双重验证)|\b(?:enable|turn on|activate|deactivate|link|unlink)\b[^,.;]{0,30}?\b(?:feature|service|subscription|account|notifications?)\b/i;
const ABOUT_A_SETTING = /核对清单|清单|说明|步骤|教程|指南|截图|checklist|guide|instructions/i;
const DECISION = /选定|选出|挑选|(?<!题)选择(?!题)|决定|拍板|取舍|定夺|敲定|决策(?!底稿|表|模板|清单|记录|材料|资料|依据)|确定(?:方案|人选|方向|选题|策略|是否|哪|优先)|(?:确认|确定)[^，。；,;]{0,4}唯一|\b(?:decide|choose|pick|select)\b/i;
/** Graded work the person hands in (an exam is sat, not planned in steps): homework, problem sets, a lab report, a course project. */
const GRADED_TASK = /作业|习题|大作业|实验报告|课程项目|homework|\bhw\s?\d|assignment|problem set/i;
/** The parts of graded work that are the work itself: its problems, solutions, answers, proofs and code. */
const GRADED_PARTS = /题(?!型|库)|解答|答案|作答|求解|证明|推导|代码|程序|报告正文|\b(?:problems?|solutions?|answers?|proofs?|derivations?|code|report body)\b/i;
const GRADED = /作业|习题|小测|测验|考试|期中|期末|课程项目|大作业|实验报告|homework|\bhw\s?\d|quiz|exam|midterm|assignment/i;
const ANSWERS = /完成|作答|解答|答题|求解|做(?!好)|写|\b(?:solve|answer|complete)\b/i;
/** The person's own practice and learning (the verb, not a noun built on it: 「练习题」「复习提纲」「学习资料」 are things). */
const LEARN = /(?:复习|练习|学习|背诵|默写|刷题|做题|解题|自测|模拟考|演练|排练|训练|推导|证明|理解|掌握)(?!提纲|资料|材料|清单|范围|要点|题|册|集|数据|素材|笔记|计划|方案|记录|目标)|做[^，。；,;]{0,6}(?:真题|往年卷|习题|练习题|模拟题)|\b(?:practi[cs]e|rehearse|review for|study)\b/i;
/** Making the core output, designing, explaining, planning, analysing: what stops compiling words in a title from counting as compiling. */
const CORE = /写(?:作|出|下|成|一篇|论文|报告|初稿|第|方法|引言|讨论|结论|脚本|文案|稿|综述|代码|程序)|撰写|改写|重写|修改(?:论文|稿|文|方法|方案)|设计|论证|解释|分析|判断|评估|规划|计划(?!表)|制定(?:方案|计划|策略|规划|目标)|构思|创作|拍摄|录制|讲解|做实验|实验(?!数据|记录|参数|结果|报告|方案|设置|条件|材料|室)|实操|动手|搭建|实现|编写|开发|调试|访谈|面谈|沟通|谈判|反思|复盘|定稿|\b(?:design|write|draft the|analy[sz]e|plan|build|implement|interview)\b/i;
/** Making a static artefact from information that exists. */
const STATIC = /收集|汇集|搜集|采集|汇总|汇编|摘录|摘抄|盘点|清点|编目|归档|登记|下载|导出|检索|查找|查阅|搜索|整理(?!思路|想法|观点|心得|论证)|梳理(?:材料|资料|文献|清单|规则|要求|条款|课程|概念|知识点)|核对(?!答案)|对照表|列出|列清单|(?:建立|建|做|制作|编制|生成|形成)[^，。；,;]{0,24}(?:台账|清单|目录|索引|表格|对照表|汇总表|跟踪表|样本包|资料包|材料包|素材包|工具包|试用包|模板|时间线)|(?:获取|取得|拿到|获得|备齐)[^，。；,;]{0,8}(?:样本|材料|资料|数据|模板|文件|讲义|往年卷|真题|报告)|准备(?:材料|资料|模板|文件)|起草[^，。；,;]{0,10}(?:模板|清单|表格|大纲|提纲)|格式化|排版|转录|转写|标注|统计|制表|(?:按|依照|根据)[^，。；,;]{0,12}(?:方案|参数|配置|设定)[^，。；,;]{0,6}(?:跑|运行|计算|仿真|模拟)|跑通?(?:仿真|模拟|脚本|计算|回测)|(?:补|补充|补上|更新|扩充|完善|编)[^，。；,;]{0,10}(?:提纲|大纲|清单|目录|台账|索引|对照表|汇总表|公式表|速查表|术语表|时间线)|\b(?:collect|gather|compile|catalog(?:ue)?|inventory|download|transcribe|tabulate|summari[sz]e)\b/i;
/** Only reviewing what the assistant made, or writing the checklist an acceptance is judged by. */
const REVIEW_ONLY = /(?:验收|检查|核对|审阅|审核|复核|过目|查看|浏览|确认)[^，。；,;]{0,6}(?:助手|AI|Agent|agent|系统)[^，。；,;]{0,8}(?:产出|结果|整理|清单|材料|草稿|文件|成果)?|(?:验收|检查|核对|自查|审核)(?:清单|标准|要点|口径)|界定(?:范围|边界)|(?:定义|划定)(?:范围|边界)|\b(?:acceptance checklist|review the assistant)/i;
/** What only the person holds: what sits behind their login or in their own records, a screenshot, an export, a sentence of scope. */
const PERSON_HELD = /(?:当前|已有|已得|目前)的?(?:成绩|分数|得分)|账户|账号|后台|个人(?:数据|记录|信息|账单|资料)|本人(?:的|提供|持有)|自己的|我的|私人|私有|截图|导出|成绩单|已出成绩|已出的成绩|(?:成绩|分数)(?:记录|明细)|账单|流水|对账单|持仓|余额|工资|收支|体检|病历|化验|聊天记录|邮箱|收件箱|相册|手机里|口径/;
/** A fact the person gives in a sentence or a file: a scope, a format, a date, their own data. */
const DOCUMENTED_RULE = /评分|计分|大纲|(?:课程|项目|作业|考试|投稿|申请|格式|提交)[^，。；,;]{0,4}(?:要求|规定)|官方|规则|规范|章程|投稿要求|格式要求|申请要求|政策|条款|指南|syllabus|rubric|guideline/i;
const ASK_FACT =/^(?:确认|明确|确定|提供|告知|补充|填写|说明)[^，。；,;]{0,14}?(范围|口径|标准|要求|偏好|格式|版本|日期|时间|名单|信息|数据|账号|截图|导出|情况|现状|成绩|分数)|^(?:confirm|clarify|provide|specify|state|fill in)\b[^,.;]{0,30}?\b(scope|standard|requirements?|preferences?|format|version|date|time|list|information|data|account|screenshot|status|grades?|scores?)\b/i;

/**
 * Judging, interpreting and planning the person's own work (docs/work-split.md, the owner's examples of 2026-10-21: planning revision
 * from the rules and scores already gathered; deciding from the material which experiments to add, how, and with which AI tools).
 * Nobody can think it for them, so it is theirs whatever the model said. The noun forms (「规划书」「分析方法」「评估表」) are things.
 */
const DESIGN_THINK = /判断|论证|解释(?!器)|规划(?!书|文件|材料|资料)|(?<!按照?|依照|根据)计划(?!表|书|文件)|制定(?:方案|计划|策略|规划|目标|路线)|确定[^，。；,;]{0,8}(?:方案|思路|路线|做法|策略)|构思|分析(?!方法|框架|工具|模板)|评估(?!表|标准|模板)|反思|复盘|(?:补|加|做|练|复习|准备|改)哪些|(?:怎么|如何)(?:补|做|安排|准备|复习|练|改|写|设计)|\b(?:analy[sz]e|argue|interpret|evaluate)\b/i;
/** Making the person's core output: writing, designing, revising it — theirs unless what is made is production work (below). */
const DESIGN_MAKE = /设计(?!稿|图|规范|要求|模板)|撰写|写(?:作(?!规范|要求|指南|模板)|出|下|成|一篇|论文|报告|初稿|方法|引言|讨论|结论|综述|摘要)|改写|重写|修改(?:论文|稿|文|方法|方案)|定稿|\bdesign\b/i;
/** Production work the model may give to the assistant (「编写脚本」「做封面」): a thing made to a plan, not the person's thinking. */
const PRODUCTION = /脚本|文案|封面|海报|代码|程序|模板|幻灯|ppt|图表|配图|字幕|剪辑|排版|视频|音频|网页|落地页|表格|清单|提纲|大纲|台账|目录|索引/i;
/** Nouns built on core verbs: the name of a rule, a method or a form, not the act. */
const CORE_NOUNS = /(?:写作|分析|设计|评估|规划)(?:规范|要求|指南|模板|方法|框架|工具|标准|流程|格式)|(?:现有|已有)的?(?:实现|设计|功能)/g;
/** Material that already exists (「根据已汇集的规则」): read as a thing the work uses, not as compiling it again. */
const PAST_STATIC = /已(?:经)?(?:收集|汇集|搜集|汇总|整理|梳理|备齐|获取|取得|下载|归档|核对|摘录|准备)(?:好)?|(?:收集|汇集|整理|汇总|准备)好的/g;

/** A scenario a thing is checked against (「按季度账户复盘场景完成验收」) is not the person's data. */
const SCENARIO = /按[^，。；,;]{0,20}(?:场景|情形)/g;
// The act's verb goes, its noun stays: 「起草发布模板」 still makes a template.
const clean = (text: string) => text.replace(PURPOSE, "").replace(SCENARIO, "").replace(DRAFTING, "").replace(ACT_NOUNS, "$2");
/** Whether the work is the person's own thinking or core output: a design word that is the work's main verb (before any compiling word). */
function isDesignWork(lead: string): boolean {
  const text = lead.replace(PAST_STATIC, "");
  const think = DESIGN_THINK.exec(text);
  const make = DESIGN_MAKE.exec(text);
  const at = [think?.index, make && !PRODUCTION.test(text) ? make.index : undefined].filter((value): value is number => value !== undefined);
  if (!at.length) return false;
  const first = Math.min(...at);
  const compiling = STATIC.exec(text);
  return !compiling || first < compiling.index;
}
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
  // 「写作规范」「分析方法」 are things being compiled, not writing or analysing.
  const lead = clean(text).replace(CORE_NOUNS, "");
  return STATIC.test(lead) && !CORE.test(lead) && !LEARN.test(lead);
};
/** Whether this text is only reviewing the assistant's output, or writing an acceptance checklist: the gate's job, not a step. */
export const isReviewOnlyWork = (text: string): boolean => REVIEW_ONLY.test(text) && !CORE.test(text) && !LEARN.test(text);

/**
 * Corrects the owner the model gave a piece of work, by what the work produces. Reads a backplan item, a planned step (its executor as
 * the model's owner when it has no `owner`) or a stored work order (`payload.title`, `payload.owner`, `payload.question`).
 */
export function workOwner(item: WorkItemLike, locale?: Locale): WorkOwnerVerdict {
  const t = tFor(locale);
  const model = modelOwner(item);
  const lead = leadOf(item);
  const act = clean(`${lead} ${item.intent ?? ""}`);
  const leadText = clean(lead);
  const keep = (owner: WorkOwner, code: WorkOwnerCode, reason: string, ask?: string): WorkOwnerVerdict => owner === "ask"
    ? { owner, code, reason, question: questionOf(item, lead, ask, locale) } : { owner, code, reason };
  // What never goes to the assistant, whatever the model said.
  const staticWork = isStaticArtifactWork(lead);
  if (isMoneyRecordWork(lead)) return keep("assistant", "static_artifact", t("钱的记录自动来：助手用已记的账和邮箱里的账单做，缺的标为缺失，不问本人"));
  // The shared external words also name things (「邮件」「券商」「订单」); compiling from them is not acting on them, so for static work
  // only the acts themselves count.
  if (ACTS.test(act) || (!staticWork && stepLeavesMachine(act))) return keep("person", "external", t("要对外发出、提交、联系、出席或付款，只能本人做"));
  if (ACCOUNT_SETTING.test(leadText) && !ABOUT_A_SETTING.test(leadText)) return keep("person", "external", t("改的是本人账户或应用里的设置，只能本人登录后做"));
  if (DECISION.test(act)) return keep("person", "decision", t("有后果的选择由本人做"));
  if (GRADED.test(leadText) && ANSWERS.test(leadText) && !staticWork) return keep("person", "graded", t("带评分的作答由本人完成"));
  // A step of graded work (「整理最终解答」「标注首题约束」 in 作业 4): its problems and answers are the person's, whatever verb the step uses.
  if (item.taskTitle && GRADED_TASK.test(item.taskTitle) && GRADED_PARTS.test(leadText)) return keep("person", "graded", t("带评分的题目与解答由本人完成"));
  if (LEARN.test(leadText) && !staticWork) return keep("person", "person_skill", t("练习和学习只能本人做"));
  if (isDesignWork(leadText)) return keep("person", "design", t("设计、判断、规划本人的工作或写出核心产出，由本人做"));
  // What the person's time is not for.
  if (isReviewOnlyWork(leadText)) return keep("assistant", "review_only", t("只是验收助手产出或写验收清单：交给验收关卡，本人开始核心步骤时看一眼"));
  if (LOGIN.test(act)) return keep("ask", "needs_person_info", t("登录后的内容由本人上传文件或截图，助手接着做"),
    t("「{{lead}}」要用到登录后才能看到的内容：上传导出的文件或截图即可。", { lead }));
  const held = heldWord(act);
  if (staticWork) return held
    ? keep("ask", "needs_person_info", t("需要本人持有的数据或一句口径，问一句后由助手做"), t("「{{lead}}」要用到本人的{{held}}：上传文件或截图，或直接写在这里。", { lead, held }))
    : keep("assistant", "static_artifact", t("从已有信息产出的静态产物，由助手做"));
  const fact = ASK_FACT.exec(leadText);
  // A standard someone else wrote down (a course's grading, a venue's rules, a form's requirements) is read from the material, not asked.
  if (fact && !CORE.test(leadText) && DOCUMENTED_RULE.test(leadText)) return keep("assistant", "static_artifact", t("规则或标准写在材料里，由助手查出"));
  if (fact && !CORE.test(leadText)) return keep("ask", "needs_person_info", t("只需本人给一句信息，不占本人的任务时间"),
    t("「{{lead}}」：本人的{{what}}是什么？一两句即可。", { lead, what: fact[1] ?? fact[2] ?? t("说法") }));
  return keep(model, "model", model === "person" ? t("本人的核心工作") : model === "assistant" ? t("助手可完成") : t("需本人提供信息后由助手做"));
}

/** What of the person's the work needs, named by a noun when the text has one (「持仓明细」 rather than 「导出」). */
function heldWord(text: string): string | undefined {
  const words = [...text.matchAll(new RegExp(PERSON_HELD.source, "g"))].map((match) => match[0]);
  const vague = /^(?:导出|截图|本人的|本人提供|本人持有|自己的|我的|私人|私有|口径)$/;
  return words.find((word) => !vague.test(word)) ?? (words[0] ? "资料" : undefined); // i18n-ignore: a word of the work's own text
}

/** The model's own question when it gave one; else one made from what the work needs of the person (`ask`); else a plain one. */
function questionOf(item: WorkItemLike, lead: string, ask?: string, locale?: Locale): string {
  const payload = (item.payload ?? {}) as { question?: unknown };
  const own = typeof item.question === "string" && item.question.trim() ? item.question.trim()
    : typeof payload.question === "string" && payload.question.trim() ? payload.question.trim() : "";
  return (own || ask || tFor(locale)("「{{lead}}」需本人提供哪些信息或文件？", { lead })).slice(0, 200);
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

/**
 * Whether an order is the person's core work: its recorded owner, or for an order written before owners, what `workOwner` reads in it.
 * Only these serve a milestone (a milestone with nothing but preparation open is worked backwards again) and count as work being made.
 */
export function isPersonCoreOrder(order: { intent: string; payload?: unknown }): boolean {
  const owner = (order.payload as { owner?: unknown } | undefined)?.owner;
  return isWorkOwner(owner) ? owner === "person" : workOwner(order).owner === "person";
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
