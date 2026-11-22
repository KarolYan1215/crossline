import "server-only";
import { askNature, mcpAnswerable, mcpText, onPersonsBoard, taskTitleOf, type AccessContext, type Ask, type McpCompletion, type ProposedAction } from "@crossline/core";
import { appNow, getStore } from "../crossline";
import { dayAtGlance } from "../nudges";
import { answerAsk, listed, openAsks, thisWeek } from "../asks";
import { executeAction } from "../actions";
import { lineLabels } from "../lines";
import { loadWrap } from "../wrap";
import { tOf } from "../locale";

/**
 * What each MCP tool does (docs/mcp-server.md §3), as plain functions over an `AccessContext`: the server (`./server.ts`) only declares
 * them. Every one reads or writes through the function the page uses — the opener's `dayAtGlance`, the badge's ask list, `answerAsk`,
 * `executeAction` — so the checks, the state machine and 撤销 are the page's own, and nothing here decides anything a page would not.
 *
 * What goes back is the least an agent needs to answer the person: titles, times, ids to act on, the lines' names. Never notes, files,
 * materials, evidence, mail, money, the portrait or anything the person said in the interview. Every title passes `mcpText` and is data.
 */

export class McpToolError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

const ACTIVE_STATES = new Set(["approved", "preparing", "ready_for_human", "active"]);
const workOrderOfBlock = (blockId: string) => blockId.startsWith("scheduled:") ? blockId.split(":")[1] ?? "" : "";

/** 「我今天排了什么」: the day's fixed arrangements and work, what is due within three days, and how many asks wait. */
export async function todayTool(ctx: AccessContext, now = appNow()) {
  const { today, fixed, work, soon, asks, records, opener } = await dayAtGlance(ctx, now);
  const labels = lineLabels(ctx);
  const line = (id: string | undefined) => id && labels[id] ? labels[id] : undefined;
  const recorded = new Map(loadWrap(ctx, now).rows.filter((row) => row.answered).map((row) => [row.blockId, row.answered!]));
  const orders = new Map(getStore().listWorkOrders(ctx.workspaceId).map((order) => [order.id, order]));
  const listedAsks = listed(openAsks(ctx, now));
  return {
    day: today, timeZone: opener.timeZone,
    fixed: fixed.map((block) => ({ start: block.start, end: block.end, title: mcpText(block.title) })),
    work: work.map((block) => {
      const orderId = workOrderOfBlock(block.id);
      const outcome = recorded.get(block.id);
      return { blockId: block.id, workOrderId: orderId, start: block.start, end: block.end, task: mcpText(block.task ?? block.title),
        ...(block.step ? { step: mcpText(block.step) } : {}), ...(line(orders.get(orderId)?.identityId) ? { line: line(orders.get(orderId)?.identityId) } : {}),
        ...(outcome ? { recorded: outcome } : {}) };
    }),
    // The work whose time passed today undone: already planned again, named so the person is not surprised it moved.
    missed: opener.work.filter((block) => block.missed).map((block) => ({ start: block.start, end: block.end, task: mcpText(block.title) })),
    dueWithin3Days: soon.map((item) => ({ workOrderId: item.order.id, title: mcpText(taskTitleOf(item.order)), due: item.due,
      ...(line(item.order.identityId) ? { line: line(item.order.identityId) } : {}) })),
    asks: { toDecide: asks.length - records.length, toRecord: records.length,
      // Waiting for the weekly review or a later week: not this week's, counted so the numbers match nothing hidden.
      later: Math.max(0, listedAsks.length - asks.length) }
  };
}

type AskView = {
  id: string; nature: "decide" | "record"; title: string; why: string; urgency: Ask["urgency"]; dueDay?: string; line?: string;
  select: "one" | "many"; freeText?: { placeholder: string };
  options: Array<{ id: string; label: string; detail?: string; recommended?: boolean; needsNote?: boolean;
    fields?: Array<{ id: string; label: string; kind: string; required: boolean; choices?: Array<{ id: string; label: string }> }> }>;
};

function askView(ask: Ask, labels: Record<string, string>): AskView {
  return {
    id: ask.id, nature: askNature(ask.kind), title: mcpText(ask.title), why: mcpText(ask.why, 400), urgency: ask.urgency,
    ...(ask.dueDay ? { dueDay: ask.dueDay } : {}), ...(ask.line && labels[ask.line] ? { line: labels[ask.line] } : {}),
    select: ask.select ?? "one", ...(ask.freeText ? { freeText: { placeholder: mcpText(ask.freeText.placeholder) } } : {}),
    // A link option opens a page and answers nothing: an agent cannot press it.
    options: ask.options.filter((option) => !option.href).map((option) => ({ id: option.id, label: mcpText(option.label, 80),
      ...(option.detail ? { detail: mcpText(option.detail) } : {}), ...(option.recommended ? { recommended: true } : {}), ...(option.needsNote ? { needsNote: true } : {}),
      ...(option.fields?.length ? { fields: option.fields.map((field) => ({ id: field.id, label: mcpText(field.label, 80), kind: field.kind, required: field.required,
        ...(field.choices ? { choices: field.choices.map((choice) => ({ id: choice.id, label: mcpText(choice.label, 80) })) } : {}) })) } : {}) }))
  };
}

/**
 * This week's asks, the same list as 待确认 and the badge, most urgent first. Those an agent may not answer (`mcpAnswerable`: anything
 * leading outward, money, sign-ins) are only counted, with nothing about them, and answered in Crossline.
 */
export function listAsksTool(ctx: AccessContext, input: { nature?: "decide" | "record" | "all" | undefined }, now = appNow()) {
  const labels = lineLabels(ctx);
  const week = thisWeek(listed(openAsks(ctx, now))).filter((ask) => !input.nature || input.nature === "all" || askNature(ask.kind) === input.nature);
  const open = week.filter((ask) => mcpAnswerable(ask.kind));
  return { asks: open.map((ask) => askView(ask, labels)), onlyInCrossline: week.length - open.length };
}

/** The open tasks with their steps, for naming one to record: titles, due days, lines and step ids, no more. */
export function listTasksTool(ctx: AccessContext, input: { query?: string | undefined }) {
  const store = getStore();
  const labels = lineLabels(ctx);
  const anchors = new Map(store.listMilestoneAnchors(ctx.workspaceId).map((anchor) => [anchor.milestoneId, anchor.deadline]));
  const words = (input.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const tasks = store.listWorkOrders(ctx.workspaceId).filter((order) => ACTIVE_STATES.has(order.state) && onPersonsBoard(order))
    .map((order) => ({ order, title: taskTitleOf(order), due: (order.payload as { dueDate?: string }).dueDate || anchors.get(order.milestoneId) || "" }))
    .filter((item) => words.every((word) => item.title.toLowerCase().includes(word)))
    .sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));
  return {
    tasks: tasks.slice(0, 30).map(({ order, title, due }) => {
      const steps = store.getStepPlan(ctx.workspaceId, order.id)?.steps ?? [];
      return { workOrderId: order.id, title: mcpText(title), state: order.state, ...(due ? { due } : {}),
        ...(labels[order.identityId] ? { line: labels[order.identityId] } : {}),
        steps: steps.map((step) => ({ stepId: step.id, title: mcpText(step.title, 120), done: step.status !== "planned" })) };
    }),
    more: Math.max(0, tasks.length - 30)
  };
}

const outcomeOf = (result: { ok: true; message: string; opId?: string } | { ok: false; message: string }, code: string) => {
  if (!result.ok) throw new McpToolError(code, result.message);
  return { ok: true as const, message: result.message, ...(result.opId ? { undo: { opId: result.opId } } : {}) };
};

/** 「随口记一件事」: one line into the box's capture path (capture → analysis → task), exactly as the 新建任务 card writes it. */
export async function captureTool(ctx: AccessContext, input: { text: string; context?: string | undefined }) {
  const title = input.text.trim();
  if (!title) throw new McpToolError("INVALID_TASK_INPUT", tOf(ctx)("内容为空"));
  const action: ProposedAction = { action: "task.create", summary: title.slice(0, 60),
    args: { title, context: (input.context ?? "").trim().slice(0, 500), lineId: "", dueDate: "", milestoneId: "" } };
  const result = await executeAction(ctx, action);
  return { ...outcomeOf(result, "CAPTURE_FAILED"), ...(result.ok && result.captureId ? { captureId: result.captureId } : {}) };
}

/** An answer to one ask, by option id, through `answerAsk` — the card's own check (`validateAskChoice`), its effect and its 撤销. */
export async function answerAskTool(ctx: AccessContext, input: { askId: string; optionIds: string[]; values?: Record<string, string> | undefined; note?: string | undefined },
  now = appNow()) {
  const ask = listed(openAsks(ctx, now)).find((item) => item.id === input.askId);
  if (!ask) throw new McpToolError("ASK_NOT_FOUND", tOf(ctx)("这件待决事项已处理或已过期"));
  if (!mcpAnswerable(ask.kind)) throw new McpToolError("ASK_ONLY_IN_CROSSLINE", tOf(ctx)("这件事只能在 Crossline 里回答"));
  const result = await answerAsk(ctx, ask.id, { optionIds: input.optionIds, note: input.note ?? "" }, input.values ?? {}, now, { ask });
  if (!result.ok) throw new McpToolError(result.code, tOf(ctx)("没有记下：{{code}}", { code: result.code }));
  return { ok: true as const, ...(result.op ? { undo: { opId: result.op.id, label: result.op.label } } : {}) };
}

/**
 * Work done, on a block of today or on a task: `done` finishes the block (as the wrap-up's 完成), the step (`stepId`) or the whole task
 * (as 完成 on its page: the state machine, the duration observation, acceptance); `partial` records how far the block got, or the
 * person's words about a task's progress (`note`, which the progress judge reads).
 */
export async function completeTool(ctx: AccessContext, input: { blockId?: string | undefined; workOrderId?: string | undefined; stepId?: string | undefined;
  outcome: McpCompletion; minutes?: number | undefined; note?: string | undefined }) {
  const t = tOf(ctx);
  const minutes = input.minutes && input.minutes > 0 ? Math.min(Math.round(input.minutes), 720) : 0;
  const note = (input.note ?? "").trim().slice(0, 1000);
  if (input.blockId) {
    const action: ProposedAction = { action: "block.outcome", summary: input.blockId.slice(0, 60), args: { blockId: input.blockId, outcome: input.outcome } };
    return outcomeOf(await executeAction(ctx, action), "BLOCK_NOT_RECORDED");
  }
  if (!input.workOrderId) throw new McpToolError("TARGET_MISSING", t("需要 blockId 或 workOrderId"));
  const order = getStore().getWorkOrder(ctx.workspaceId, input.workOrderId);
  if (!order || !onPersonsBoard(order)) throw new McpToolError("WORK_ORDER_NOT_FOUND", t("任务已不存在"));
  const base = { workOrderId: order.id, date: "", minutes, stepId: "", text: note, who: "", energy: "" as const, outcome: "" as const };
  const summary = taskTitleOf(order).slice(0, 60);
  if (input.outcome === "partial") {
    if (!note) throw new McpToolError("NOTE_REQUIRED", t("部分完成需要一句话说明做到哪了"));
    return outcomeOf(await executeAction(ctx, { action: "task.op", summary, args: { ...base, type: "progress" } }), "PROGRESS_NOT_RECORDED");
  }
  if (input.stepId) {
    if (!getStore().getStepPlan(ctx.workspaceId, order.id)?.steps.some((step) => step.id === input.stepId))
      throw new McpToolError("STEP_NOT_FOUND", t("stepId 须是该任务的步骤"));
    return outcomeOf(await executeAction(ctx, { action: "task.op", summary, args: { ...base, type: "step_done", stepId: input.stepId } }), "STEP_NOT_RECORDED");
  }
  return outcomeOf(await executeAction(ctx, { action: "task.op", summary, args: { ...base, type: "complete" } }), "COMPLETION_NOT_RECORDED");
}
