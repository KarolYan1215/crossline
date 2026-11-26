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
 *
 * Which work is such a request is the model's call (2026-11-22): the Skills that write work (capture analysis, the backplanner) say so in
 * `request` — `{ kind, who, fact }`, `kind` "none" for ordinary work — following the traits above. The title regexes that used to guess it
 * are gone. What code keeps is the boundary: the assistant only drafts, the send is the person's (`infoRequestSteps`, and the analysis
 * validator refuses an automation part that sends).
 */
export type InfoRequestKind =
  /** Somebody else holds or decides the answer: a message to them, drafted by the assistant and sent by the person. */
  | "ask_person"
  /** The fact sits in a document, a site or the person's own account: looked up, nobody is asked. */
  | "look_up";
export type InfoRequest = { kind: InfoRequestKind; what: string; who: string };
/** The model's field: what kind of request the work is ("none": ordinary work), who answers it and the one fact it gets. */
export type ModelInfoRequest = { kind: "none" | InfoRequestKind; who: string; fact: string };
/** The `request` field the work-writing Skills carry (strict mode: every field present, "" for none). Not `*_SCHEMA`: it is a part. */
export const REQUEST_FIELD = { type: "object", additionalProperties: false, required: ["kind", "who", "fact"], properties: {
  kind: { type: "string", enum: ["none", "ask_person", "look_up"] },
  who: { type: "string", maxLength: 60 },
  fact: { type: "string", maxLength: 200 } } } as const;
/** A request with nothing in it, for answers recorded before the field existed and for ordinary work. */
export const NO_REQUEST: ModelInfoRequest = { kind: "none", who: "", fact: "" };

/** The person's part of a request: checking the drafted message and sending it. */
export const INFO_REQUEST_PERSON_MINUTES = 15;

/** A model's `request` made usable: the request it names, or null for ordinary work, a malformed field or one recorded before it existed. */
export function readInfoRequest(value: unknown, fallbackWhat = ""): InfoRequest | null {
  const raw = value as Partial<ModelInfoRequest> | undefined;
  if (!raw || typeof raw !== "object" || (raw.kind !== "ask_person" && raw.kind !== "look_up")) return null;
  const what = (typeof raw.fact === "string" ? raw.fact.trim() : "") || fallbackWhat.trim();
  if (!what) return null;
  return { kind: raw.kind, what: what.slice(0, 200), who: typeof raw.who === "string" ? raw.who.trim().slice(0, 60) : "" };
}

/** Whether a stored work order is a request for a fact (its `payload.request`, from the Skill that wrote it). */
export const orderInfoRequest = (order: { payload?: unknown; title?: string }): InfoRequest | null =>
  readInfoRequest((order.payload as { request?: unknown } | undefined)?.request, order.title ?? "");

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
    const request = readInfoRequest(step.request, step.title);
    if (!request || step.produces) continue;
    const dependents = out.filter((other) => other.dependsOn.includes(step.id));
    const into = dependents[0];
    if (!into) continue;
    const index = out.findIndex((item) => item.id === step.id);
    out.splice(index, 1);
    into.dependsOn = [...new Set([...into.dependsOn.filter((id) => id !== step.id), ...step.dependsOn])];
    into.infoRequests = [...(into.infoRequests ?? []), request];
    if (!into.acquires && step.acquires) into.acquires = step.acquires;
    into.uses = [...new Set([...into.uses, ...step.uses])];
    into.estimate = { p25Minutes: into.estimate.p25Minutes + 5, p50Minutes: into.estimate.p50Minutes + 10,
      p85Minutes: into.estimate.p85Minutes + INFO_REQUEST_PERSON_MINUTES };
    for (const other of dependents.slice(1)) other.dependsOn = [...new Set([...other.dependsOn.filter((id) => id !== step.id), into.id])];
    folded.push({ title: step.title, into: into.id });
  }
  return { steps: out, folded };
}

/**
 * Asking the person (the owner's rule of 2026-11-25: 「模型如果有不确定的问题，给模型一个主动提问工具，允许其向用户提问获取信息（前提是用户
 * 应该知道这个信息）」; docs/plans/harness-1125.md 「主动提问」). Where the request above is a fact *someone else* holds, this is one only
 * the person holds — their plan, a preference, a fact about themselves, their situation. A Skill calls `ask_person` mid-run with the
 * assumption it goes on with meanwhile; the question waits on 待确认 (ask kind `skill_question`), the answer becomes a confirmed fact
 * (`sourceRef` `ask:pq:<id>`, 「本人回答」), and a `blocking` run is run again once it arrives. What code keeps is the attention budget:
 * at most `PERSON_QUESTIONS_PER_RUN` new questions a run, a question already answered in the question ledger is answered from it, one
 * already open is joined, and a run that read untrusted content may not pass a link to the person.
 */
export const PERSON_ANSWER_TYPES = ["text", "long_text", "date", "choice"] as const;
export type PersonAnswerType = (typeof PERSON_ANSWER_TYPES)[number];
export type PersonQuestionInput = {
  question: string; why: string; knownBy: "person"; options: string[]; answerType: PersonAnswerType;
  /** What the run goes on with until the answer comes: required, so no run ever waits on the person. */
  assumption: string;
  /** Only when the run's output cannot be right without it: the run is done again once the person answers. */
  blocking: boolean;
};
/** What a blocking question's answer reruns: a task's steps, a milestone's backplan, a task's tutorial or its material preparation. */
export type PersonQuestionRef = { kind: "task" | "milestone" | "tutorial" | "materials"; id: string };
/** `untrusted`: asked by a run that had read someone else's words (a web page, a mail); the card says so and carries no link. */
export type PersonQuestionOrigin = "own" | "untrusted";
export type PersonQuestionAsked = PersonQuestionInput & {
  id: string; skill: string; ref: PersonQuestionRef; identityId: string; projectId: string; dueBy: string; origin: PersonQuestionOrigin;
};
/** New questions one run may put to the person; joining one already open and reading one already answered do not count. */
export const PERSON_QUESTIONS_PER_RUN = 2;
/** Two questions this alike (`questionSimilarity`, 0–1) are one question: the second reads the first's answer or joins its wait. */
export const SAME_QUESTION = 0.6;
/** A blocking question is pushed only when what it bears on is due within this many hours; every other one only waits on 待确认. */
export const PERSON_QUESTION_PUSH_HOURS = 48;
/** The profile-fact slot an answer is kept under (`【question】answer`, like a step answer). */
export const PERSON_ANSWER_SLOT = "person_answer_";
export const personAnswerSlot = (question: string) =>
  `${PERSON_ANSWER_SLOT}${[...question].reduce((hash, char) => (hash * 31 + char.codePointAt(0)!) >>> 0, 7).toString(36)}`;

/** A link of any kind: a URL, a bare domain, a markdown link. A run that read untrusted content may not put one in front of the person. */
export const hasLink = (text: string): boolean =>
  /https?:\/\/|www\.|\]\(|\b[\w-]+\.(?:com|net|org|io|cn|lol|xyz|me|co|ai|edu|gov|info|app|dev|link|ly|top|site|online|shop|cc|tk|ru)\b/i.test(text);

/* i18n-ignore-start: the tool's description and refusals are read by the model */
export const ASK_PERSON_TOOL = {
  name: "ask_person",
  description: "Ask the person one question only they can answer: their own plan, preference, a fact about themselves or their situation. "
    + "Never ask what the run's input, the person's files, the ledger lookups or the web can tell you, and never a fact someone else holds "
    + "(that is a request: draft a message for the person to send). Give the assumption you go on with meanwhile; the question waits on the "
    + "person's 待确认 page and you never wait for the answer. At most 2 new questions a run; a question the person already answered comes "
    + "back with the answer.",
  inputSchema: { type: "object", additionalProperties: false, required: ["question", "why", "knownBy", "answerType", "assumption", "blocking"], properties: {
    question: { type: "string", description: "One question in the person's language, short, about one thing." },
    why: { type: "string", description: "What in this run depends on the answer, in one sentence." },
    knownBy: { type: "string", enum: ["person"], description: "Who holds the answer: only the person." },
    options: { type: "array", items: { type: "string" }, maxItems: 6, description: "For answerType choice: 2–6 concrete answers, the likeliest first." },
    answerType: { type: "string", enum: [...PERSON_ANSWER_TYPES] },
    assumption: { type: "string", description: "The answer you go on with until the person answers." },
    blocking: { type: "boolean", description: "true only when this run's output cannot be right without the answer; the run is done again once it comes." } } }
};

export const ASK_PERSON_INSTRUCTIONS = "`ask_person` puts one question to the person. Use it only for what the person alone knows (their plan, a "
  + "preference, a fact about themselves or their situation) and nothing in the input, their files, the ledger or the web settles. Every "
  + "question carries the assumption you continue with: finish this run's output on that assumption and never wait. blocking true only when "
  + "the output cannot be right without the answer. Do not ask what someone else holds, and never put a link or a passage of a web page or a "
  + "mail into a question.";

/** A model's `ask_person` arguments made usable, or the reason they are refused (said back to the model). */
export function readPersonQuestion(args: unknown, context: { untrusted?: boolean } = {}):
  { ok: true; question: PersonQuestionInput } | { ok: false; reason: string } {
  const raw = (args ?? {}) as Record<string, unknown>;
  const text = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";
  const question = text(raw.question, 300), why = text(raw.why, 300), assumption = text(raw.assumption, 200);
  if (raw.knownBy !== "person") return { ok: false, reason: "只能问本人才知道的信息（knownBy 必须是 person）；别人掌握的事实应写成请求，由本人发出。" };
  if (!question) return { ok: false, reason: "question 不能为空。" };
  if (!why) return { ok: false, reason: "why 不能为空：写明这次输出的哪一部分取决于答案。" };
  if (!assumption) return { ok: false, reason: "assumption 不能为空：写明没有答案时按什么继续。" };
  const answerType = PERSON_ANSWER_TYPES.find((type) => type === raw.answerType);
  if (!answerType) return { ok: false, reason: `answerType 只能是 ${PERSON_ANSWER_TYPES.join("、")}。` };
  const options = Array.isArray(raw.options) ? [...new Set(raw.options.map((option) => text(option, 80)).filter(Boolean))].slice(0, 6) : [];
  if (answerType === "choice" && options.length < 2) return { ok: false, reason: "answerType 为 choice 时要给 2–6 个 options。" };
  if (typeof raw.blocking !== "boolean") return { ok: false, reason: "blocking 必须是 true 或 false。" };
  if (context.untrusted && [question, why, assumption, ...options].some(hasLink))
    return { ok: false, reason: "这次运行读过外部内容，问题里不能带链接或网址；用自己的话问本人。" };
  return { ok: true, question: { question, why, knownBy: "person", options: answerType === "choice" ? options : [], answerType, assumption, blocking: raw.blocking } };
}
/* i18n-ignore-end */

/** Whether a question interrupts: blocking, and what it bears on is due within `PERSON_QUESTION_PUSH_HOURS` (`push-policy`: `person_question`). */
export function pushesPersonQuestion(question: { blocking: boolean; dueBy: string }, now: Date): boolean {
  if (!question.blocking || !/^\d{4}-\d{2}-\d{2}/.test(question.dueBy)) return false;
  const due = Date.parse(question.dueBy.length === 10 ? `${question.dueBy}T23:59:59Z` : question.dueBy);
  return Number.isFinite(due) && due - now.getTime() <= PERSON_QUESTION_PUSH_HOURS * 3_600_000;
}
