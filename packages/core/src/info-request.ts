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
