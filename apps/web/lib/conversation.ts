import "server-only";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { formatInTimeZone } from "date-fns-tz";
import { closeMailReply, resultsAwaitingReview, type StoredConversationMessage } from "@crossline/db";
import {
  ACTIONS, AUTOMATIONS_SETTING, LINE_PROFILES_SETTING, MAIL_ACCOUNTS_SETTING, actionProblem, readAutomations, readMailAccounts, triggerLabel, availableSlots, conciergeRefs, needsReview, taskTitleOf, type StoredLineProfile,
  type AccessContext, type AvailabilityWindow, type ClarifyOption, type ConciergePack, type ConciergeTurn, type ProposedAction
} from "@crossline/core";
import { DOMAIN_PACKS } from "@crossline/identity-packs";
import { effectiveSchedulePreferences, effectiveWeight, getStore, loadCurrentPlan, loadGoalForecast, planToday, readAvailability } from "./crossline";
import { openAsks } from "./asks";
import { executeAction } from "./actions";
import { CodexSupervisorRequestError, requestCodexSupervisor } from "./codex-runtime";
import { identityLines, lineLabels } from "./lines";
import { recentOps } from "./undo";
import { ANSWERED_SETTING, muteNudgeKind } from "./nudges";
import { readOpener, type OpenerView } from "./opener";
import { returnPageLines } from "./return";
import { captureProgress } from "./capture-progress";

/** Where the person typed from: the page and the object open there (a task, a milestone, a plan day). */
/** `stepId`: on a task, the step its block is for (Today's day panel), so 「这一步」 names that step rather than the first open one. */
export type PageContext = { kind: string; entityId: string; stepId?: string };
export type Mention = { kind: "material" | "task" | "milestone" | "goal"; id: string; title: string };

/** One action on a card and what became of it. */
export type CardItem = { state: "pending" | "done" | "failed" | "dismissed"; message?: string; opId?: string; href?: string; captureId?: string };
/** An assistant message's card: what the turn proposed, the question back, and the state of each. */
/**
 * An option of a card's question. A turn's options carry candidate actions; a nudge's buttons may instead open a page (`href`),
 * acknowledge (`ack`), ask about this kind less (`mute`) or invite typing (`say`). Choosing any of them is the answer — except `copy`, which
 * puts the text at `href` on the clipboard and leaves the card open. `close` (on an `ack`) closes the card's mail reply draft
 * (`Card.mailReplyId`) as answered or as needing no answer.
 */
export type CardOption = ClarifyOption & { kind?: "action" | "ack" | "mute" | "href" | "say" | "copy"; href?: string; close?: "replied" | "dismissed" };
export type Card = {
  actions: ProposedAction[]; items: CardItem[];
  clarify: { question: string; options: CardOption[]; chosen?: number };
  /** Set on a nudge's card: which rule raised it (for 「少问这类」). */
  nudgeKind?: string;
  /** Set on a message about a mail reply draft: the draft its 「已回复」 and 「不用回」 close. */
  mailReplyId?: string;
  confidence: ConciergeTurn["confidence"]; error?: string;
  /** The words this card is a reading of (for remembering a correction of it). */
  heard?: string;
  /** The stronger model is looking at it again (先快后准); nothing on it can run meanwhile. */
  reviewing?: boolean;
  /** It was looked at again; `revised` when that changed what it proposes. */
  reviewed?: boolean; revised?: boolean;
  /** This turn corrected the previous card. */
  corrects?: boolean;
};
export type MessageView = { id: string; role: StoredConversationMessage["role"]; text: string; createdAt: string; card?: Card; page?: PageContext;
  /** The day's opener as data (`lib/opener.ts`); absent on older openers, which are shown as their text. */
  opener?: OpenerView };
/** What a card's fields can be changed to, by name: the open tasks (with their steps), the lines and the milestones. */
export type CardChoices = { tasks: Array<{ id: string; title: string; steps: Array<{ id: string; title: string }> }>; lines: Array<{ id: string; label: string }>;
  milestones: Array<{ id: string; title: string }> };

const OPEN = ["approved", "preparing", "ready_for_human", "active", "evidence_review", "blocked"];
const isSeeded = (payload: unknown) => Boolean((payload as { seeded?: boolean } | undefined)?.seeded);

/** The person's state right now, for the turn's lookups (docs/one-input.md §3.2). Built in-process; nothing here calls a model. */
export async function contextPack(ctx: AccessContext, page: PageContext, now = new Date()): Promise<ConciergePack> {
  const store = getStore();
  const timeZone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  const today = planToday(ctx, now);
  const labels = lineLabels(ctx);
  const label = (id: string) => labels[id] ?? id;
  const projects = new Map(store.listProjects(ctx.workspaceId, { includeArchived: true }).map((project) => [project.id, project.name]));
  const orders = store.listWorkOrders(ctx.workspaceId).filter((order) => !isSeeded(order.payload));
  const plan = await loadCurrentPlan(ctx);
  const weekEnd = new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
  const upcoming = plan.blocks.filter((block) => block.day && block.day >= today && block.day < weekEnd)
    .sort((a, b) => `${a.day} ${a.start}`.localeCompare(`${b.day} ${b.start}`));
  // What there is to plan with, the scheduler's own arithmetic: available hours minus fixed arrangements, and what work already holds.
  const minutesOf = (time: string) => { const [h, m] = time.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };
  const days = Array.from({ length: 7 }, (_, index) => new Date(Date.parse(`${today}T12:00:00Z`) + index * 86_400_000).toISOString().slice(0, 10));
  const isWork = (id: string) => id.startsWith("scheduled:") || id.startsWith("proposed:") || id.startsWith("optional:");
  const free = availableSlots(readAvailability(ctx), days, upcoming.filter((block) => !isWork(block.id)).map((block) => ({ day: block.day!, start: block.start, end: block.end })));
  // Today counts from now: at 22:15 the day's 09–18 is gone (the first real answer said 「今天还有 5 小时 45 分」).
  const nowMinute = minutesOf(formatInTimeZone(now, timeZone, "HH:mm"));
  const span = (day: string, start: string, end: string) => Math.max(0, minutesOf(end) - Math.max(minutesOf(start), day === today ? nowMinute : 0));
  const capacity = days.map((day) => ({ day,
    availableMinutes: free.filter((slot) => slot.day === day).reduce((sum, slot) => sum + span(day, slot.start, slot.end), 0),
    scheduledMinutes: upcoming.filter((block) => block.day === day && block.id.startsWith("scheduled:")).reduce((sum, block) => sum + span(day, block.start, block.end), 0) }));
  const nextBlock = new Map<string, string>();
  for (const block of upcoming.filter((item) => item.id.startsWith("scheduled:"))) {
    const id = block.id.split(":")[1]!;
    if (!nextBlock.has(id)) nextBlock.set(id, `${block.day} ${block.start}–${block.end}`);
  }
  const anchors = new Map(store.listMilestoneAnchors(ctx.workspaceId).map((anchor) => [anchor.milestoneId, anchor]));
  const milestones = store.listMilestones(ctx.workspaceId).filter((item) => item.status !== "archived");
  const docs = store.listSourceDocuments(ctx.workspaceId);
  const latestEnergy = store.listEnergyObservations(ctx.workspaceId).at(-1);
  const forecast = (() => { try { return loadGoalForecast(ctx).goals; } catch { return []; } })();
  const titles = new Map(milestones.map((item) => [item.id, item.title]));
  const pageOrder = page.kind === "task" ? orders.find((order) => order.id === page.entityId) : undefined;
  const pageTitle = pageOrder ? taskTitleOf(pageOrder) : page.kind === "milestone" ? titles.get(page.entityId) ?? "" : page.kind === "line" ? labels[page.entityId] ?? "" : page.entityId;
  const profiles = (() => { try { return JSON.parse(store.getSetting(ctx.workspaceId, LINE_PROFILES_SETTING) ?? "{}") as Record<string, StoredLineProfile>; } catch { return {}; } })();
  return {
    now: now.toISOString(), today, timeZone, page: { ...page, title: pageTitle },
    lines: identityLines(ctx).map((line) => ({ id: line.id, label: line.label, goals: line.goals ?? [], hard: Boolean(line.hard), description: profiles[line.id]?.description ?? "",
      ...(line.domain ? { domain: DOMAIN_PACKS[line.domain].label } : {}) })),
    tasks: orders.filter((order) => OPEN.includes(order.state)).map((order) => {
      const payload = (order.payload ?? {}) as { dueDate?: string; notBefore?: string };
      return { id: order.id, title: taskTitleOf(order), line: label(order.identityId), project: projects.get(order.projectId) ?? "", state: order.state,
        dueDate: payload.dueDate ?? "", notBefore: payload.notBefore ?? "", usualMinutes: order.estimate.p50Minutes, nextBlock: nextBlock.get(order.id) ?? "",
        steps: (store.getStepPlan(ctx.workspaceId, order.id)?.steps ?? []).map((step) => ({ id: step.id, title: step.title, status: step.status,
          minutes: step.estimate.p50Minutes, executor: step.executor })) };
    }),
    proposals: orders.filter((order) => order.state === "awaiting_plan_approval").map((order) => ({ id: order.id, title: taskTitleOf(order), line: label(order.identityId) })),
    milestones: milestones.map((item) => ({ id: item.id, title: item.title, line: label(item.identityId), status: item.status,
      deadline: anchors.get(item.id)?.deadline ?? "", weight: item.status === "approved" ? effectiveWeight(ctx, item.id) : 0 })),
    asks: openAsks(ctx, now).map((ask) => ({ id: ask.id, kind: ask.kind, title: ask.title, why: ask.why.slice(0, 400), urgency: ask.urgency,
      options: ask.options.filter((option) => !option.href).map((option) => ({ id: option.id, label: option.label,
        fields: (option.fields ?? []).map((field) => ({ id: field.id, label: field.label, required: field.required })) })) })),
    plan: upcoming.map((block) => ({ day: block.day!, start: block.start, end: block.end, title: block.title,
      kind: block.id.split(":")[0] === "graph_calendar" ? "calendar" : block.id.split(":")[0]! })),
    capacity,
    weeklyPattern: weeklyPattern(readAvailability(ctx)),
    automations: readAutomations(store.getSetting(ctx.workspaceId, AUTOMATIONS_SETTING)).map((item) => ({ name: item.name, trigger: triggerLabel(item.trigger), status: item.status, lineId: item.lineId })),
    mailboxes: readMailAccounts(store.getSetting(ctx.workspaceId, MAIL_ACCOUNTS_SETTING)).length,
    ops: recentOps(ctx, now).map((op) => ({ id: op.id, label: op.label, at: op.at })),
    agentResults: resultsAwaitingReview(store, ctx.workspaceId)
      .map((task) => ({ taskId: task.taskId, title: task.title, summary: `产出：${task.artifacts.map((artifact) => artifact.path.split(/[\\/]/).at(-1)).slice(0, 6).join("、") || "无"}${task.needsHuman ? `；${task.needsHuman} 项需本人完成` : ""}` })),
    materials: docs.map((doc) => ({ id: doc.id, fileName: doc.fileName, project: doc.projectId ? projects.get(doc.projectId) ?? "" : "" })),
    projects: store.listProjects(ctx.workspaceId).map((project) => ({ id: project.id, name: project.name, line: label(project.identityId) })),
    facts: store.listProfileFacts(ctx.workspaceId).filter((fact) => fact.status === "confirmed")
      .map((fact) => `[${label(fact.identityId)}${fact.projectId ? `/${projects.get(fact.projectId) ?? fact.projectId}` : ""}] ${fact.slot}：${fact.value.slice(0, 200)}`),
    preferences: store.preferenceLines(ctx.workspaceId, ["all"], 15),
    energy: latestEnergy ? { level: latestEnergy.level, at: latestEnergy.observedAt } : null,
    forecast: forecast.map((goal) => ({ milestoneId: goal.milestoneId, title: goal.title, deadline: goal.confirmedDeadline ?? "",
      usualFinish: goal.p50Day ?? "", cautiousFinish: goal.p85Day ?? "", atRisk: goal.slackDays !== null && goal.slackDays < 2 }))
  };
}

/**
 * What every turn carries in its prompt; the rest is looked up. With `lists`, the things most sentences are about — open tasks, what
 * waits, the recent operations — are named by id here, so a turn usually needs no lookup before it can propose (each lookup is another
 * model round, a few seconds each).
 */
export function conciergeSnapshot(pack: ConciergePack, now = new Date(), options: { lists?: boolean } = {}): string {
  const today = pack.plan.filter((block) => block.day === pack.today);
  const lists = options.lists ? [
    "打开的任务（id | 标题 | 截止）：", ...pack.tasks.slice(0, 40).map((task) => `- ${task.id} | ${task.title} | ${task.dueDate || "—"}`),
    "待批准的任务提案（id | 标题）：", ...pack.proposals.slice(0, 20).map((item) => `- ${item.id} | ${item.title}`),
    "待决事项（id | 标题 | 选项 id=标签）：", ...pack.asks.slice(0, 20).map((ask) => `- ${ask.id} | ${ask.title.slice(0, 60)} | ${ask.options.map((option) => `${option.id}=${option.label}`).join("，")}`),
    "最近可撤销的操作（id | 标签，最新在前）：", ...pack.ops.slice(0, 10).map((op) => `- ${op.id} | ${op.label}`),
    "待审阅的助手成果（taskId | 标题 | 产出）：", ...pack.agentResults.slice(0, 10).map((item) => `- ${item.taskId} | ${item.title.slice(0, 60)} | ${item.summary}`)
  ] : [];
  return [
    `现在：${formatInTimeZone(now, pack.timeZone, "yyyy-MM-dd EEE HH:mm")}（${pack.timeZone}）`,
    `今天：${today.length ? today.map((block) => `${block.start}–${block.end} ${block.title}`).join("；") : "无安排"}`,
    `每周可用时段（改动用 availability.set，给出改后的完整时段）：${pack.weeklyPattern?.join("；") || "未设置"}`,
    `未来 7 天可用于工作的时间（可用时段扣除固定安排；已排任务）：${pack.capacity.map((day) => `${day.day.slice(5)} ${(day.availableMinutes / 60).toFixed(1)}h；已排 ${(day.scheduledMinutes / 60).toFixed(1)}h`).join(" · ")}`,
    `待决事项 ${pack.asks.length} 项${pack.asks.length ? `，最紧急：${pack.asks.slice(0, 3).map((ask) => ask.title).join("；")}` : ""}`,
    `待批准的任务提案 ${pack.proposals.length} 项；里程碑草稿 ${pack.milestones.filter((item) => item.status === "draft").length} 个；待审阅的助手成果 ${pack.agentResults.length} 项`,
    `最近一次精力记录：${pack.energy ? `${pack.energy.level}（${formatInTimeZone(new Date(pack.energy.at), pack.timeZone, "MM-dd HH:mm")}）` : "无"}`,
    `自动化（改哪个就用 workflow.request 写明改法）：${pack.automations?.length ? pack.automations.map((item) => `${item.name}（${item.trigger}${item.status === "off" ? "，已暂停" : ""}${item.lineId ? `，主线 ${item.lineId}` : ""}）`).join("；") : "无"}；已接入邮箱 ${pack.mailboxes ?? 0} 个`,
    `当前页面：${pack.page.kind}${pack.page.title ? `「${pack.page.title}」(${pack.page.entityId})` : ""}`,
    `主线（id | 名称）：${pack.lines.map((line) => `${line.id} | ${line.label}${line.hard ? "（硬约束）" : ""}${line.domain ? `（${line.domain}）` : ""}`).join("；") || "无"}`,
    `项目（id | 名称 | 主线）：${pack.projects.map((project) => `${project.id} | ${project.name} | ${project.line}`).join("；") || "无"}`,
    ...pageTask(pack),
    ...pageLine(pack),
    ...(pack.preferences.length ? ["本人的偏好与此前的更正（照此理解）：", ...pack.preferences.map((line) => `- ${line}`)] : []),
    ...lists
  ].join("\n");
}

/**
 * On a task's page, 「这一步」「做完了」 mean that task: its steps by id, the current one (the first not done) marked, so the turn can name
 * the step without a lookup.
 */
/**
 * On a line's card or interview (`kind: "line"`), 「这条线」「目标改成…」「我在这上面…」 mean that line: its id, long-term goal and the
 * interview's reading of it, and that what the person says about it belongs to that line's own interview.
 */
export function pageLine(pack: ConciergePack): string[] {
  if (pack.page.kind !== "line") return [];
  const line = pack.lines.find((item) => item.id === pack.page.entityId);
  if (!line) return [];
  return [`本页主线：${line.id} | ${line.label}${line.hard ? "（硬约束）" : ""} | 长期目标：${line.goals[0] || "未设"}`,
    ...(line.description ? [`访谈对该主线的描述：${line.description.slice(0, 300)}`] : []),
    `关于这条主线的情况交给访谈时 profile.tell 的 lineId 填 ${line.id}；修改长期目标同样交给该主线的访谈（由本人在卡片上确认）。`];
}

export function pageTask(pack: ConciergePack): string[] {
  if (pack.page.kind !== "task") return [];
  const task = pack.tasks.find((item) => item.id === pack.page.entityId);
  if (!task) return [];
  // From a picked block the step is that block's own, while it is still open; otherwise the first open step.
  const current = task.steps.find((step) => step.id === pack.page.stepId && step.status === "planned") ?? task.steps.find((step) => step.status === "planned");
  return [`本页任务：${task.id} | ${task.title} | 截止 ${task.dueDate || "—"}；步骤（id | 标题 | 状态，▶ 为当前步骤）：`,
    ...task.steps.map((step) => `- ${step === current ? "▶ " : ""}${step.id} | ${step.title} | ${step.status}${step.executor === "agent" ? "（助手做）" : ""}`)];
}

const view = (message: StoredConversationMessage): MessageView => ({ id: message.id, role: message.role, text: message.text, createdAt: message.createdAt,
  ...(message.payload.card ? { card: message.payload.card as Card } : {}), ...(message.payload.page ? { page: message.payload.page as PageContext } : {}),
  ...(readOpener(message.payload.opener) ? { opener: readOpener(message.payload.opener)! } : {}) });

/** The names a card's editable fields take their values from. */
export async function cardChoices(ctx: AccessContext): Promise<CardChoices> {
  const pack = await contextPack(ctx, { kind: "", entityId: "" });
  return { tasks: pack.tasks.map((task) => ({ id: task.id, title: task.title, steps: task.steps.map((step) => ({ id: step.id, title: step.title })) })),
    lines: pack.lines.map((line) => ({ id: line.id, label: line.label })), milestones: pack.milestones.map((item) => ({ id: item.id, title: item.title })) };
}

/** Today's conversation (made on first use), oldest first. */
export function loadConversation(ctx: AccessContext, day = planToday(ctx)): { id: string; day: string; messages: MessageView[] } {
  const conversation = getStore().conversationFor(ctx.workspaceId, day);
  return { id: conversation.id, day, messages: withCaptureProgress(ctx, getStore().listConversationMessages(ctx.workspaceId, conversation.id).map(view)) };
}

/** A 「收集」 card's line follows its capture: analysed, done, accepted (W-16). Read when shown; the stored card is not rewritten. */
function withCaptureProgress(ctx: AccessContext, messages: MessageView[]): MessageView[] {
  if (!messages.some((message) => message.card?.items.some((item) => item.captureId))) return messages;
  const store = getStore();
  const captures = new Map(store.listCaptures(ctx.workspaceId).map((capture) => [capture.id, capture]));
  return messages.map((message) => !message.card?.items.some((item) => item.captureId) ? message : { ...message, card: { ...message.card,
    items: message.card.items.map((item) => {
      if (!item.captureId || item.state !== "done") return item;
      const order = store.getWorkOrder(ctx.workspaceId, item.captureId);
      const now = captureProgress(captures.get(item.captureId), order && { id: order.id, state: order.state, title: taskTitleOf(order) });
      return now ? { ...item, message: now.message, ...(now.href ? { href: now.href } : {}) } : item;
    }) } });
}

export const searchConversation = (ctx: AccessContext, query: string) =>
  getStore().searchConversationMessages(ctx.workspaceId, query.trim().slice(0, 100)).map((message) => ({ ...view(message), day: message.conversationId.slice(-10) }));

function cardFrom(turn: ConciergeTurn, heard: string): Card {
  return { actions: turn.actions, items: turn.actions.map(() => ({ state: "pending" })), clarify: turn.clarify, confidence: turn.confidence, heard,
    ...(turn.corrects ? { corrects: true } : {}) };
}

type TurnOutcome = { state: "replied"; turn: ConciergeTurn; warnings?: string[] } | { state: "blocked"; code: string; message: string };

/** A correction of how the box read the person, kept for every later reading (Settings → 个性化 lists and deletes it). */
function rememberCorrection(ctx: AccessContext, refId: string, text: string): void {
  getStore().addPreference({ workspaceId: ctx.workspaceId, source: "correction", scope: "all", weight: 1, refId: `conv:${refId}`, text: text.slice(0, 300) });
}

const cardWords = (card: Card) => card.actions.map((item) => `${ACTIONS[item.action].label}：${item.summary}`).join("；");

/**
 * One turn: the person's words are kept first (nothing typed is lost, whatever happens next), then the worker reads them with the
 * snapshot and the pack, and its answer is kept with its card. When the model cannot be reached, the card offers the words as a new
 * task, so the person can still keep it as work with one click.
 */
export async function conversationTurn(ctx: AccessContext, input: { text: string; mentions: Mention[]; page: PageContext; files?: string[] }, now = new Date()): Promise<MessageView[]> {
  const store = getStore();
  const conversation = store.conversationFor(ctx.workspaceId, planToday(ctx, now));
  const earlier = store.listConversationMessages(ctx.workspaceId, conversation.id);
  const history = earlier.map((message) => ({ role: message.role, text: message.text }));
  // Once the person has corrected the box today, it reads every later line on the stronger model at once.
  const corrected = earlier.some((message) => (message.payload.card as Card | undefined)?.corrects);
  // Files dropped with the line (already stored and read): named in the message, described in the snapshot.
  const docs = (input.files ?? []).map((id) => store.listSourceDocuments(ctx.workspaceId).find((doc) => doc.id === id)).filter((doc) => doc !== undefined);
  const text = [input.text.trim(), input.mentions.length ? `（引用：${input.mentions.map((item) => `${item.kind}:${item.id}「${item.title}」`).join("；")}）` : "",
    docs.length ? `（附件：${docs.map((doc) => `《${doc.fileName}》`).join("")}）` : ""].filter(Boolean).join("\n");
  store.setSetting(ctx.workspaceId, ANSWERED_SETTING, now.toISOString());
  const person = store.appendConversationMessage({ id: randomUUID(), workspaceId: ctx.workspaceId, conversationId: conversation.id, role: "person", text,
    payload: { page: input.page, ...(docs.length ? { files: docs.map((doc) => doc.id) } : {}) } });
  const pack = await contextPack(ctx, input.page, now);
  const attached = attachedFiles(docs, pack);
  // From the return page: what the absence left to settle, and which task and step a line typed beside one is about.
  const returning = input.page.kind === "return" ? ["", ...returnPageLines(ctx, input.page, now)].join("\n") : "";
  // A screenshot dropped with the line (a payment, a meal) is shown to the model itself, so it can read the numbers into a record card the
  // person confirms (docs/domain-lines.md); at most three, stored files only.
  const images = docs.filter((doc) => /\.(png|jpe?g|webp|gif)$/i.test(doc.fileName) && doc.uri.startsWith("file:")).slice(0, 3)
    .map((doc) => fileURLToPath(doc.uri));
  const request = { conversationId: conversation.id, text: input.text || "（只附了文件）", mentions: input.mentions,
    snapshot: `${conciergeSnapshot(pack, now, { lists: true })}${returning}${attached}`, pack, history, ...(images.length ? { images } : {}),
    ...(corrected ? { corrected: true } : {}) };
  let reply: { text: string; card: Card };
  let warnings: string[] = [];
  try {
    const outcome = await askWorker(ctx, request);
    if (outcome.state === "replied") { reply = { text: outcome.turn.reply, card: cardFrom(outcome.turn, text) }; warnings = outcome.warnings ?? []; }
    else reply = fallback(input.text, outcome.message, outcome.code);
  } catch (error) {
    reply = fallback(input.text, "模型服务暂时不可用", error instanceof CodexSupervisorRequestError ? error.blocker.code : "CONVERSATION_TURN_FAILED");
  }
  if (reply.card.corrects) withdrawPrevious(ctx, earlier, text);
  // 先快后准: a reading the quick model was unsure of, or one that changes several things, is shown at once and looked at again; it
  // cannot be carried out until that second look is back. Already on the stronger model (after a correction), once is enough.
  const review = !corrected && !reply.card.error && needsReview({ actions: reply.card.actions, confidence: reply.card.confidence } as ConciergeTurn, warnings);
  if (review) reply.card.reviewing = true;
  const assistant = store.appendConversationMessage({ id: randomUUID(), workspaceId: ctx.workspaceId, conversationId: conversation.id, role: "assistant",
    text: reply.text, payload: { card: reply.card } });
  if (review) void reviewCard(ctx, assistant.id, { ...request, review: true });
  return [view(person), view(assistant)];
}

/** The files that came with a line, as the snapshot names them: id, name, kind, whether the text could be read, project, opening. */
export function attachedFiles(docs: Array<{ id: string; fileName: string; kind: string; extractionStatus: string; extractedText: string; projectId?: string }>,
  pack: ConciergePack): string {
  return docs.length ? ["\n本次附带的文件（id | 名称 | 类型 | 文本 | 所属项目 | 开头）：", ...docs.map((doc) => `- ${doc.id} | ${doc.fileName} | ${doc.kind} | `
    + `${doc.extractionStatus === "done" ? `${doc.extractedText.length} 字` : doc.extractionStatus === "pending" ? "尚未读取" : "无法读取文本"} | `
    + `${pack.projects.find((project) => project.id === doc.projectId)?.name ?? "未归入"} | ${doc.extractedText.slice(0, 400).replace(/\s+/g, " ")}`)].join("\n") : "";
}

const askWorker = (ctx: AccessContext, body: Record<string, unknown>) => requestCodexSupervisor<TurnOutcome>(ctx, "/v1/conversation/turn", {
  method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(15 * 60_000), body: JSON.stringify(body) });

/**
 * 「不是作业 2，是作业 3」: the latest card still waiting is withdrawn, and how it was misread is remembered, so the next reading of a
 * line like it starts from the correction.
 */
function withdrawPrevious(ctx: AccessContext, earlier: StoredConversationMessage[], correction: string): void {
  const store = getStore();
  const previous = [...earlier].reverse().find((message) => {
    const card = message.payload.card as Card | undefined;
    return card?.items.some((item) => item.state === "pending");
  });
  const card = previous?.payload.card as Card | undefined;
  if (!previous || !card) return;
  card.items = card.items.map((item) => item.state === "pending" ? { state: "dismissed", message: "已由后一句更正" } : item);
  card.reviewing = false;
  store.updateConversationPayload(ctx.workspaceId, previous.id, { ...previous.payload, card });
  rememberCorrection(ctx, previous.id, `输入框曾把「${(card.heard ?? "").slice(0, 80)}」理解为「${cardWords(card).slice(0, 120)}」；本人更正：「${correction.slice(0, 80)}」`);
}

/** The second look, in the background: the card is replaced by what the stronger model returns, or left as it was if that fails. */
async function reviewCard(ctx: AccessContext, messageId: string, body: Record<string, unknown>): Promise<void> {
  let outcome: TurnOutcome | undefined;
  try { outcome = await askWorker(ctx, body); } catch { outcome = undefined; }
  const store = getStore();
  const message = store.getConversationMessage(ctx.workspaceId, messageId);
  const card = message?.payload.card as Card | undefined;
  if (!message || !card) return;
  if (outcome?.state !== "replied") {
    store.updateConversationPayload(ctx.workspaceId, messageId, { ...message.payload, card: { ...card, reviewing: false } });
    return;
  }
  const next = cardFrom(outcome.turn, card.heard ?? "");
  const revised = JSON.stringify(next.actions) !== JSON.stringify(card.actions) || JSON.stringify(next.clarify) !== JSON.stringify(card.clarify);
  getStore().updateConversationPayload(ctx.workspaceId, messageId, { ...message.payload, card: { ...next, ...(card.corrects ? { corrects: true } : {}), reviewed: true, revised } });
  if (revised && outcome.turn.reply) store.updateConversationText(ctx.workspaceId, messageId, outcome.turn.reply);
}

function fallback(text: string, why: string, code: string): { text: string; card: Card } {
  const action: ProposedAction = { action: "task.create", summary: text.slice(0, 200), args: { title: text.slice(0, 240), context: "", lineId: "", dueDate: "", milestoneId: "" } };
  // Not 「未能理解」: the model was not reached, or refused the round; saying it misunderstood hid the real reason (2026-10-19).
  return { text: `这句话还没有得到回答：${why.replace(/[。.]$/, "")}。原话已保存在对话里，可稍后重新发送；也可以先作为新任务收集。`,
    card: { actions: [action], items: [{ state: "pending" }], clarify: { question: "", options: [] }, confidence: "low", error: code } };
}

/**
 * The person's decision on a card: carry out the chosen pending actions (all of them by default), choose a clarify option (which
 * carries out its candidate actions — choosing is the confirmation), or dismiss what is left. Each action is checked again against the
 * state of this moment before it runs, because the card may have waited a while.
 */
export async function decideCard(ctx: AccessContext, messageId: string,
  decision: { indexes?: number[]; option?: number; dismiss?: boolean; edits?: Record<number, Record<string, unknown>> },
  now = new Date()): Promise<{ ok: true; message: MessageView } | { ok: false; code: string }> {
  const store = getStore();
  const message = store.getConversationMessage(ctx.workspaceId, messageId);
  const card = message?.payload.card as Card | undefined;
  if (!message || !card) return { ok: false, code: "CARD_NOT_FOUND" };
  if (card.reviewing && !decision.dismiss) return { ok: false, code: "CARD_REVIEWING" };
  store.setSetting(ctx.workspaceId, ANSWERED_SETTING, now.toISOString());
  applyEdits(ctx, message.id, card, decision.edits ?? {});
  const candidates = new Set(card.clarify.options.flatMap((option) => option.actions));
  let chosen: number[];
  let closeDraft: CardOption["close"];
  if (decision.option !== undefined) {
    const option = card.clarify.options[decision.option];
    if (!option || option.kind === "copy" || card.clarify.chosen !== undefined) return { ok: false, code: "OPTION_NOT_AVAILABLE" };
    card.clarify.chosen = decision.option;
    if (option.kind === "mute" && card.nudgeKind) muteNudgeKind(ctx, card.nudgeKind, now);
    if (option.close && card.mailReplyId) closeDraft = option.close;
    chosen = option.actions;
    // The candidates not chosen will never run.
    for (const index of candidates) if (!option.actions.includes(index) && card.items[index]?.state === "pending") card.items[index] = { state: "dismissed" };
  } else {
    chosen = (decision.indexes ?? card.actions.map((_, index) => index)).filter((index) => !candidates.has(index));
  }
  if (decision.dismiss) {
    for (const index of chosen) if (card.items[index]?.state === "pending") card.items[index] = { state: "dismissed" };
  } else if (chosen.some((index) => card.items[index]?.state === "pending")) {
    const refs = conciergeRefs(await contextPack(ctx, { kind: "", entityId: "" }, now));
    for (const index of chosen) {
      const item = card.actions[index];
      if (!item || card.items[index]?.state !== "pending") continue;
      const problem = actionProblem(item, refs);
      card.items[index] = problem ? { state: "failed", message: `未执行：${problem.replace(/（用 \w+ 查[^）]*）/, "")}` } : outcomeItem(await executeAction(ctx, item));
    }
  }
  store.updateConversationPayload(ctx.workspaceId, messageId, { ...message.payload, card });
  // After the card is written: closing the draft marks every message about it (this one keeps the choice just made).
  if (closeDraft && card.mailReplyId) closeMailReply(store, ctx.workspaceId, card.mailReplyId, closeDraft, "person", now);
  return { ok: true, message: view({ ...message, payload: { ...message.payload, card } }) };
}

/**
 * Fields the person changed on the card before carrying it out (a date, a task, a duration). Only fields the action has, of the type
 * it has, and only on actions still waiting; each change is remembered as a correction of how the box read them.
 */
function applyEdits(ctx: AccessContext, messageId: string, card: Card, edits: Record<number, Record<string, unknown>>): void {
  for (const [key, changes] of Object.entries(edits)) {
    const index = Number(key);
    const item = card.actions[index];
    if (!item || card.items[index]?.state !== "pending" || !changes || typeof changes !== "object") continue;
    const spec = ACTIONS[item.action].args as Record<string, { type?: string }>;
    const args = { ...(item.args as Record<string, unknown>) };
    const changed: string[] = [];
    for (const [field, value] of Object.entries(changes)) {
      const type = spec[field]?.type;
      if (!type || JSON.stringify(args[field]) === JSON.stringify(value)) continue;
      const next = type === "number" ? Number(value) : type === "array" ? (Array.isArray(value) ? value : args[field]) : String(value ?? "").slice(0, 2000);
      if (type === "number" && !Number.isFinite(next as number)) continue;
      changed.push(`${field}「${String(args[field] ?? "")}」改为「${String(next)}」`);
      args[field] = next;
    }
    if (!changed.length) continue;
    card.actions[index] = { ...item, args } as ProposedAction;
    rememberCorrection(ctx, `${messageId}:${index}`, `输入框把「${(card.heard ?? "").slice(0, 80)}」理解为「${ACTIONS[item.action].label}：${item.summary.slice(0, 60)}」；本人把 ${changed.join("、").slice(0, 160)}`);
  }
}

const outcomeItem = (outcome: Awaited<ReturnType<typeof executeAction>>): CardItem => outcome.ok
  ? { state: "done", message: outcome.message, ...(outcome.opId ? { opId: outcome.opId } : {}), ...(outcome.href ? { href: outcome.href } : {}),
    ...(outcome.captureId ? { captureId: outcome.captureId } : {}) }
  : { state: "failed", message: outcome.message };

const WEEKDAY_LABEL = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const ENERGY_LABEL = { high: "高", medium: "中", low: "低" } as const;
/** The weekly pattern as the concierge reads it: one line per band, days in week order from Monday. */
export function weeklyPattern(windows: AvailabilityWindow[]): string[] {
  const order = (day: number) => (day + 6) % 7;
  return windows.map((window) => `${[...window.days].sort((a, b) => order(a) - order(b)).map((day) => WEEKDAY_LABEL[day]).join(" ")} ${window.start}–${window.end} ${ENERGY_LABEL[window.energy]}`);
}
