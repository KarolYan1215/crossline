import "server-only";
import { randomUUID } from "node:crypto";
import { formatInTimeZone } from "date-fns-tz";
import { listAgentTasks, type StoredConversationMessage } from "@crossline/db";
import {
  actionProblem, conciergeRefs, taskTitleOf,
  type AccessContext, type ConciergePack, type ConciergeTurn, type ProposedAction
} from "@crossline/core";
import { effectiveSchedulePreferences, effectiveWeight, getStore, loadCurrentPlan, loadGoalForecast, planToday } from "./crossline";
import { openAsks } from "./asks";
import { executeAction } from "./actions";
import { CodexSupervisorRequestError, requestCodexSupervisor } from "./codex-runtime";
import { identityLines, lineLabels } from "./lines";
import { recentOps } from "./undo";

/** Where the person typed from: the page and the object open there (a task, a milestone, a plan day). */
export type PageContext = { kind: string; entityId: string };
export type Mention = { kind: "material" | "task" | "milestone"; id: string; title: string };

/** One action on a card and what became of it. */
export type CardItem = { state: "pending" | "done" | "failed" | "dismissed"; message?: string; opId?: string; href?: string };
/** An assistant message's card: what the turn proposed, the question back, and the state of each. */
export type Card = {
  actions: ProposedAction[]; items: CardItem[];
  clarify: ConciergeTurn["clarify"] & { chosen?: number };
  confidence: ConciergeTurn["confidence"]; error?: string;
};
export type MessageView = { id: string; role: StoredConversationMessage["role"]; text: string; createdAt: string; card?: Card };

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
  const pageTitle = pageOrder ? taskTitleOf(pageOrder) : page.kind === "milestone" ? titles.get(page.entityId) ?? "" : page.entityId;
  return {
    now: now.toISOString(), today, timeZone, page: { ...page, title: pageTitle },
    lines: identityLines(ctx).map((line) => ({ id: line.id, label: line.label, goals: line.goals ?? [], hard: Boolean(line.hard) })),
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
    ops: recentOps(ctx, now).map((op) => ({ id: op.id, label: op.label, at: op.at })),
    agentResults: listAgentTasks(store, ctx.workspaceId).filter((task) => task.status === "needs_review")
      .map((task) => ({ taskId: task.taskId, title: task.title, summary: `产出：${task.artifacts.map((artifact) => artifact.path.split(/[\\/]/).at(-1)).slice(0, 6).join("、") || "无"}${task.needsHuman ? `；${task.needsHuman} 项需本人完成` : ""}` })),
    materials: docs.map((doc) => ({ id: doc.id, fileName: doc.fileName, project: doc.projectId ? projects.get(doc.projectId) ?? "" : "" })),
    facts: store.listProfileFacts(ctx.workspaceId).filter((fact) => fact.status === "confirmed")
      .map((fact) => `[${label(fact.identityId)}${fact.projectId ? `/${projects.get(fact.projectId) ?? fact.projectId}` : ""}] ${fact.slot}：${fact.value.slice(0, 200)}`),
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
    `待决事项 ${pack.asks.length} 项${pack.asks.length ? `，最紧急：${pack.asks.slice(0, 3).map((ask) => ask.title).join("；")}` : ""}`,
    `待批准的任务提案 ${pack.proposals.length} 项；里程碑草稿 ${pack.milestones.filter((item) => item.status === "draft").length} 个；待审阅的助手成果 ${pack.agentResults.length} 项`,
    `最近一次精力记录：${pack.energy ? `${pack.energy.level}（${formatInTimeZone(new Date(pack.energy.at), pack.timeZone, "MM-dd HH:mm")}）` : "无"}`,
    `当前页面：${pack.page.kind}${pack.page.title ? `「${pack.page.title}」(${pack.page.entityId})` : ""}`,
    `主线（id | 名称）：${pack.lines.map((line) => `${line.id} | ${line.label}${line.hard ? "（硬约束）" : ""}`).join("；") || "无"}`,
    ...lists
  ].join("\n");
}

const view = (message: StoredConversationMessage): MessageView => ({ id: message.id, role: message.role, text: message.text, createdAt: message.createdAt,
  ...(message.payload.card ? { card: message.payload.card as Card } : {}) });

/** Today's conversation (made on first use), oldest first. */
export function loadConversation(ctx: AccessContext, day = planToday(ctx)): { id: string; day: string; messages: MessageView[] } {
  const conversation = getStore().conversationFor(ctx.workspaceId, day);
  return { id: conversation.id, day, messages: getStore().listConversationMessages(ctx.workspaceId, conversation.id).map(view) };
}

export const searchConversation = (ctx: AccessContext, query: string) =>
  getStore().searchConversationMessages(ctx.workspaceId, query.trim().slice(0, 100)).map((message) => ({ ...view(message), day: message.conversationId.slice(-10) }));

function cardFrom(turn: ConciergeTurn): Card {
  return { actions: turn.actions, items: turn.actions.map(() => ({ state: "pending" })), clarify: turn.clarify, confidence: turn.confidence };
}

/**
 * One turn: the person's words are kept first (nothing typed is lost, whatever happens next), then the worker reads them with the
 * snapshot and the pack, and its answer is kept with its card. When the model cannot be reached, the card offers the words as a new
 * task, so the person can still keep it as work with one click.
 */
export async function conversationTurn(ctx: AccessContext, input: { text: string; mentions: Mention[]; page: PageContext }, now = new Date()): Promise<MessageView[]> {
  const store = getStore();
  const conversation = store.conversationFor(ctx.workspaceId, planToday(ctx, now));
  const history = store.listConversationMessages(ctx.workspaceId, conversation.id).map((message) => ({ role: message.role, text: message.text }));
  const text = [input.text.trim(), input.mentions.length ? `（引用：${input.mentions.map((item) => `${item.kind}:${item.id}「${item.title}」`).join("；")}）` : ""].filter(Boolean).join("\n");
  const person = store.appendConversationMessage({ id: randomUUID(), workspaceId: ctx.workspaceId, conversationId: conversation.id, role: "person", text,
    payload: { page: input.page } });
  const pack = await contextPack(ctx, input.page, now);
  let reply: { text: string; card: Card };
  try {
    const outcome = await requestCodexSupervisor<{ state: "replied"; turn: ConciergeTurn } | { state: "blocked"; code: string; message: string }>(ctx, "/v1/conversation/turn", {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(15 * 60_000),
      body: JSON.stringify({ conversationId: conversation.id, text: input.text, mentions: input.mentions, snapshot: conciergeSnapshot(pack, now, { lists: true }), pack, history })
    });
    reply = outcome.state === "replied"
      ? { text: outcome.turn.reply, card: cardFrom(outcome.turn) }
      : fallback(input.text, outcome.message, outcome.code);
  } catch (error) {
    reply = fallback(input.text, "模型服务暂时不可用", error instanceof CodexSupervisorRequestError ? error.blocker.code : "CONVERSATION_TURN_FAILED");
  }
  const assistant = store.appendConversationMessage({ id: randomUUID(), workspaceId: ctx.workspaceId, conversationId: conversation.id, role: "assistant",
    text: reply.text, payload: { card: reply.card } });
  return [view(person), view(assistant)];
}

function fallback(text: string, why: string, code: string): { text: string; card: Card } {
  const action: ProposedAction = { action: "task.create", summary: text.slice(0, 200), args: { title: text.slice(0, 240), context: "", lineId: "", dueDate: "", milestoneId: "" } };
  return { text: `未能理解这句话（${why}）。原话已保存在对话里，可稍后重新发送；也可以先作为新任务收集。`,
    card: { actions: [action], items: [{ state: "pending" }], clarify: { question: "", options: [] }, confidence: "low", error: code } };
}

/**
 * The person's decision on a card: carry out the chosen pending actions (all of them by default), choose a clarify option (which
 * carries out its candidate actions — choosing is the confirmation), or dismiss what is left. Each action is checked again against the
 * state of this moment before it runs, because the card may have waited a while.
 */
export async function decideCard(ctx: AccessContext, messageId: string, decision: { indexes?: number[]; option?: number; dismiss?: boolean },
  now = new Date()): Promise<{ ok: true; message: MessageView } | { ok: false; code: string }> {
  const store = getStore();
  const message = store.getConversationMessage(ctx.workspaceId, messageId);
  const card = message?.payload.card as Card | undefined;
  if (!message || !card) return { ok: false, code: "CARD_NOT_FOUND" };
  const candidates = new Set(card.clarify.options.flatMap((option) => option.actions));
  let chosen: number[];
  if (decision.option !== undefined) {
    const option = card.clarify.options[decision.option];
    if (!option || card.clarify.chosen !== undefined) return { ok: false, code: "OPTION_NOT_AVAILABLE" };
    card.clarify.chosen = decision.option;
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
  return { ok: true, message: view({ ...message, payload: { ...message.payload, card } }) };
}

const outcomeItem = (outcome: Awaited<ReturnType<typeof executeAction>>): CardItem => outcome.ok
  ? { state: "done", message: outcome.message, ...(outcome.opId ? { opId: outcome.opId } : {}), ...(outcome.href ? { href: outcome.href } : {}) }
  : { state: "failed", message: outcome.message };
