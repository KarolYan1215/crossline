import type { BackplanStep } from "./backplan-schema";
import type { PlannedStep } from "./steps";
import { tFor, type Locale } from "./i18n";

/**
 * Getting a fact from someone is a step, not a task (the owner's decision of 2026-10-15). 「确认 ECE 548 期中考查范围」 and 「ECE 555 确认课程
 * 项目要求」 were whole tasks — scheduled, timed, judged — when each is one email to a teaching assistant.
 *
 * What marks such work (the traits, as re-stated for the task-design rules):
 * 1. **Purpose**: to obtain one fact, file or confirmation that somebody else holds or decides — an exam's scope, a rubric, a format rule,
 *    a version, a date. Nothing is produced beyond the answer.
 * 2. **Product**: a message (an email, a chat line) and the other side's reply. The assistant can draft the message; sending it is an
 *    external act and stays the person's.
 * 3. **The person's own time is at most 15 minutes**: check the draft and send it, or look the fact up in their own account.
 * 4. **It unblocks other work**: some task waits for the answer, and that is the task it serves.
 *
 * Such work is planned as a step of the task it serves (usually its first): an assistant's preparation step drafts the message
 * (recipient, subject, body; never sent) and the person's step checks and sends it. A standalone one already on the board is folded into
 * the task it serves by the daily merge (`apps/worker/src/dedupe.ts`).
 */
export type InfoRequestKind =
  /** Somebody else holds or decides the answer: a message to them, drafted by the assistant and sent by the person. */
  | "ask_person"
  /** The fact sits in a document, a site or the person's own account: looked up, nobody is asked. */
  | "look_up";
export type InfoRequest = { kind: InfoRequestKind; what: string; who: string };
export type InfoRequestTraits = { match: boolean; request: InfoRequest | null; reasons: string[] };

/** The person's part of a request: checking the drafted message and sending it. */
export const INFO_REQUEST_PERSON_MINUTES = 15;
/**
 * Above this usual length a task is more than a message, whatever its wording. Generous on purpose: a standalone request still carries
 * the backplanner's 30-minute task floor (and 45 is common on the real board), though the person's real part is a quarter of an hour.
 */
export const INFO_REQUEST_MAX_TASK_MINUTES = 60;

/** Leading verbs of getting or confirming a fact. */
const CONFIRM_VERB = /^(?:[A-Z]{2,5}\s?\d{2,4}\s*)?(确认|核实|澄清|弄清|问清|查明|查清|明确|取得|获取|索取|拿到|询问|咨询|请教|征询|请示|confirm|verify|clarify|obtain|ask|check with|double-check|find out|look up|request|get)/i;
/** Verbs that are asking somebody, wherever they stand. */
const ASK_VERB = /(向.{1,10}(确认|询问|了解|索取|核实|问)|询问|问清|问一下|请教|咨询|征询|请示|发邮件|写邮件|邮件询问|联系.{0,8}(确认|询问)|check with|ask (the|a|my|your)|ask \w+ (about|for|whether|if)|(email|e-mail|message|write to|reach out to) (the|a|my|your)|contact .{1,20} (to confirm|about))/i;
/** What is obtained: a fact somebody else holds or decides. */
const FACT_OBJECT = /(范围|标准|细则|规则|要求|说明|格式|规范|题型|权重|分值|截止|时间|日期|安排|版本|规格|配置|参数|结构|政策|流程|名单|地点|方式|口径|结单|账单|记录|rubric|scope|format|deadline|due date|date|time|schedule|requirement|criteria|rule|instruction|policy|version|guideline|spec|weight|parameter|configuration|structure|process|location|venue|statement|syllabus|template|coverage)/i;
/** Facts that a person decides (course staff, a reviewer, an organiser): the request is a message to them. */
const DECIDED_BY_PERSON = /(考试|考查|测验|小测|期中|期末|评分|打分|细则|题型|权重|分值|评审|答辩|课程项目|作业要求|会议时间|面试|rubric|exam|grading|\b(midterm|final|quiz|test|review|defen[cs]e|course project|assignment|homework|meeting time|interview|marking)s?\b)/i;
const PERSON = /(老师|教授|助教|\bTA\b|导师|师兄|师姐|同学|课程组|教务|编辑|审稿人|客户|合作方|对方|instructor|professor|advisor|editor|reviewer|teaching assistant|teacher|lecturer|supervisor|classmate|client|organi[sz]er|coordinator|registrar)/i;
const COURSE = /([A-Z]{2,5}\s?\d{3}|课程|考试|作业|小测|期中|期末|\b([Cc]ourse|[Ee]xam|[Hh]omework|[Aa]ssignment|[Qq]uiz|[Mm]idterm|[Ff]inal)s?\b)/;
/** Real work in the title or intent: the task is more than a message, even when it also confirms something. */
const PRODUCES = /(完成|撰写|起草|写出|写完|推导|复习|练习|解题|做题|制作|开发|编写|搭建|仿真|实验|测量|剪辑|拍摄|录制|定稿|实现|熟悉|学习|建立|编制|汇集|汇总|整理|盘点|设计|\b(complete|finish|write|draft|derive|revise|practi[cs]e|solve|make|build|develop|implement|code|simulate|experiment|measure|edit|film|record|finali[sz]e|learn|study|design|compile|summari[sz]e|organi[sz]e)\b)/i;

/**
 * Whether a task (or a step) is a request for a fact, and which kind. Title-first: the analysis' and backplanner's intents describe a
 * request as 「形成…清单」, which is the answer written down, not work.
 */
export function infoRequestTraits(item: { title: string; intent?: string; p50Minutes?: number; locale?: Locale }): InfoRequestTraits {
  const t = tFor(item.locale);
  const title = item.title.trim();
  const intent = (item.intent ?? "").trim();
  const reasons: string[] = [];
  const asks = ASK_VERB.test(title);
  const confirms = CONFIRM_VERB.test(title);
  if (!asks && !confirms) return { match: false, request: null, reasons: [t("标题不是获取或确认某个信息")] };
  if (!asks && !FACT_OBJECT.test(title)) return { match: false, request: null, reasons: [t("确认的不是一项事实（范围、标准、要求、版本、时间等）")] };
  // Production in the title (「确认并撰写…」) or in the intent beyond writing the answer down (「…并定稿评审材料清单」).
  // Only the verb goes: 「ECE 555 确认课程项目要求」 keeps its course in what is asked.
  const verb = (title.match(CONFIRM_VERB) ?? title.match(ASK_VERB))?.[1] ?? "";
  const rest = (verb ? title.replace(verb, "") : title).replace(/\s{2,}/g, " ").trim();
  if (PRODUCES.test(rest) || /并.{0,6}(定稿|撰写|完成|实现|制作|搭建|推导)|\band (then )?(finali[sz]e|write|complete|implement|make|build|derive)\b/i.test(intent))
    return { match: false, request: null, reasons: [t("除了获取信息，还要产出别的东西")] };
  if (item.p50Minutes !== undefined && item.p50Minutes > INFO_REQUEST_MAX_TASK_MINUTES)
    return { match: false, request: null, reasons: [t("通常耗时 {{minutes}} 分钟，超过一封邮件的量", { minutes: item.p50Minutes })] };
  reasons.push(asks ? t("目的是向某人询问") : t("目的是确认一项事实"));
  const who = (title.match(PERSON) ?? intent.match(PERSON))?.[1] ?? "";
  const personDecides = asks || Boolean(who) || DECIDED_BY_PERSON.test(title) || (COURSE.test(title) && /(要求|标准|范围|说明)|\b(requirement|criteria|scope|instruction|guideline)/i.test(title));
  const kind: InfoRequestKind = personDecides ? "ask_person" : "look_up";
  reasons.push(kind === "ask_person" ? t("答案由别人掌握或决定：起草一封邮件，本人检查后发送") : t("答案在文件、网页或本人账户里：查到即可"));
  const what = rest.replace(/^[\s：:，,]+/, "").trim() || title;
  return { match: true, request: { kind, what, who: who || (kind === "ask_person" && COURSE.test(title) ? t("助教或任课老师") : "") }, reasons };
}

export const isInfoRequest = (item: { title: string; intent?: string; p50Minutes?: number }) => infoRequestTraits(item).match;

/**
 * The step pair a request becomes inside the task it serves: the assistant drafts the message (recipient, subject, body; never sends
 * it, not on the calendar), and the person checks and sends it — sending is an external act. A lookup is one step of the person's.
 * `ids` must be unused in the plan; `dependsOn` is what the first of them waits for (usually nothing).
 */
export function infoRequestSteps(request: InfoRequest, ids: { draft: string; send: string }, dependsOn: string[] = [], locale?: Locale): PlannedStep[] {
  const t = tFor(locale);
  const subject = request.what.slice(0, 60);
  // 「向助教确认 ECE 555 要求」: a space only before Latin text, which Chinese leaves out and English always has.
  const spaced = (text: string) => locale === "en" || /^[A-Za-z0-9]/.test(text) ? ` ${text}` : text;
  const who = request.who || t("相关人");
  const send: PlannedStep = request.kind === "ask_person" ? {
    id: ids.send, role: "contact", title: t("向{{who}}确认{{subject}}", { who, subject: spaced(subject) }).slice(0, 120),
    deliverable: t("已发出的邮件与对方的答复"), doneCriterion: t("邮件已发出；收到答复后把答复记入任务材料"),
    share: 0.05, estimate: { p25Minutes: 5, p50Minutes: 10, p85Minutes: INFO_REQUEST_PERSON_MINUTES },
    dependsOn: [ids.draft], notBefore: "", dueBy: "", schedulable: true, executor: "human", tickOutcome: "", covers: [],
    why: t("这项信息由对方掌握，后续步骤要用到；发送属于对外动作，由本人检查后发出"),
    firstAction: t("打开助手起草的邮件，核对收件人和正文后发送")
  } : {
    id: ids.send, role: "handle", title: t("查明{{subject}}", { subject: spaced(subject) }).slice(0, 120), deliverable: t("查到的信息，记入任务材料"),
    doneCriterion: t("信息已查到并记入任务材料"), share: 0.05, estimate: { p25Minutes: 5, p50Minutes: 10, p85Minutes: INFO_REQUEST_PERSON_MINUTES },
    dependsOn, notBefore: "", dueBy: "", schedulable: true, executor: "human", tickOutcome: "", covers: [],
    why: t("后续步骤要用到这项信息"), firstAction: t("打开存有「{{subject}}」的页面或账户", { subject: subject.slice(0, 30) })
  };
  if (request.kind !== "ask_person") return [send];
  const draft: PlannedStep = {
    id: ids.draft, role: "prepare", title: t("起草给{{who}}的邮件：确认{{subject}}", { who, subject: spaced(subject) }).slice(0, 120),
    deliverable: t("邮件草稿（收件人、主题、正文），不发送"), doneCriterion: t("草稿写明收件人、主题和要确认的每一点"),
    share: 0.02, estimate: { p25Minutes: 5, p50Minutes: 5, p85Minutes: 10 }, dependsOn, notBefore: "", dueBy: "",
    schedulable: false, executor: "agent", tickOutcome: "", covers: [], why: t("起草是准备工作，由助手完成，本人只需检查后发送"), firstAction: ""
  };
  return [draft, send];
}

/**
 * The backplanner's answer with every request that some other task needs folded into that task (its first dependent in order): the
 * request becomes that task's first step instead of a task of its own. A request nothing depends on is left alone — the daily merge
 * looks for the task it serves among what is already on the board. The task absorbing it waits for whatever the request waited for,
 * takes over what the request `acquires`, and grows by the person's quarter of an hour; every other dependent waits for the absorbing task.
 */
export function foldInfoRequests(steps: BackplanStep[]): { steps: Array<BackplanStep & { infoRequests?: InfoRequest[] }>; folded: Array<{ title: string; into: string }> } {
  const out: Array<BackplanStep & { infoRequests?: InfoRequest[] }> = steps.map((step) => ({ ...step, dependsOn: [...step.dependsOn] }));
  const folded: Array<{ title: string; into: string }> = [];
  for (const step of steps) {
    const traits = infoRequestTraits({ title: step.title, intent: step.intent, p50Minutes: step.estimate.p50Minutes });
    if (!traits.match || step.produces) continue;
    const dependents = out.filter((other) => other.dependsOn.includes(step.id));
    const into = dependents[0];
    if (!into) continue;
    const index = out.findIndex((item) => item.id === step.id);
    out.splice(index, 1);
    into.dependsOn = [...new Set([...into.dependsOn.filter((id) => id !== step.id), ...step.dependsOn])];
    into.infoRequests = [...(into.infoRequests ?? []), traits.request!];
    if (!into.acquires && step.acquires) into.acquires = step.acquires;
    into.uses = [...new Set([...into.uses, ...step.uses])];
    into.estimate = { p25Minutes: into.estimate.p25Minutes + 5, p50Minutes: into.estimate.p50Minutes + 10,
      p85Minutes: into.estimate.p85Minutes + INFO_REQUEST_PERSON_MINUTES };
    for (const other of dependents.slice(1)) other.dependsOn = [...new Set([...other.dependsOn.filter((id) => id !== step.id), into.id])];
    folded.push({ title: step.title, into: into.id });
  }
  return { steps: out, folded };
}
