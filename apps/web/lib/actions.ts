import "server-only";
import { randomUUID } from "node:crypto";
import { reviewAgentTask } from "@crossline/db";
import { ACTIONS, describeEvent, type AccessContext, type ActionArgs, type ActionId, type ProposedAction } from "@crossline/core";
import { addCapturedTaskWithId, approveWorkOrderProposal, archiveWorkOrder, getStore } from "./crossline";
import { approveMilestoneDrafts, rejectMilestoneDrafts } from "./approvals";
import { answerAsk, snoozeAsk } from "./asks";
import { analyzeNewCapturesInBackground } from "./capture-followups";
import { requestCodexSupervisor } from "./codex-runtime";
import { scheduleEvent } from "./event-scheduling";
import { applyChange } from "./impact";
import { createMilestoneDraft } from "./input";
import { addLine, identityLines, lineLabels, updateLine } from "./lines";
import { applyTaskOp, recordEnergy } from "./task-ops";
import { undoOp, withUndo } from "./undo";

/** What carrying out one action did: `message` is shown on the card; `opId` is what the card's 撤销 takes back. */
export type ActionOutcome = { ok: true; message: string; opId?: string; href?: string } | { ok: false; message: string };

type Done = { ok: true; message?: string; href?: string } | { ok: false; code: string; message?: string };
type Handler<K extends ActionId> = (ctx: AccessContext, args: ActionArgs<K>) => Done | Promise<Done>;

/**
 * Every action of the registry (`packages/core/src/concierge.ts`), carried out through the same function its page uses. The input box,
 * a nudge's buttons and the pages therefore share one path per change. The record is checked to be complete by the type and by
 * `actions.test.ts`.
 */
export const ACTION_HANDLERS: { [K in ActionId]: Handler<K> } = {
  "task.create": (ctx, args) => {
    const labels = lineLabels(ctx);
    const milestone = args.milestoneId ? getStore().listMilestones(ctx.workspaceId).find((item) => item.id === args.milestoneId) : undefined;
    // The light card's fields reach the analysis as context; it still decides the line, the estimate and the steps.
    const hints = [args.lineId ? `主线：${labels[args.lineId] ?? args.lineId}` : "", args.dueDate ? `截止：${args.dueDate}` : "",
      milestone ? `关联里程碑：${milestone.title}` : ""].filter(Boolean).join("；");
    const id = randomUUID();
    addCapturedTaskWithId(ctx, { title: args.title.trim().slice(0, 240), context: [args.context.trim(), hints].filter(Boolean).join("\n").slice(0, 500) }, id, id);
    analyzeNewCapturesInBackground(ctx);
    return { ok: true, message: "已收集，正在分析估时与步骤", href: "/workbench" };
  },
  // The note is the conversation's own message, searchable from the box; nothing else is written.
  "note.add": () => ({ ok: true, message: "已记下，可在对话记录中搜索" }),
  "task.op": async (ctx, args) => {
    const result = await applyTaskOp(ctx, args.workOrderId, { ...args, summary: "" });
    return result.ok ? { ok: true, href: `/workbench/${encodeURIComponent(args.workOrderId)}` } : result;
  },
  "ask.answer": async (ctx, args) => answerAsk(ctx, args.askId, args.optionId, Object.fromEntries(args.fields.map((field) => [field.id, field.value]))),
  "ask.snooze": (ctx, args) => snoozeAsk(ctx, args.askId, args.until),
  "undo": (ctx, args) => {
    const result = undoOp(ctx, args.opId);
    return result.ok ? { ok: true, message: `已撤销：${result.label}` } : result;
  },
  "energy.report": (ctx, args) => recordEnergy(ctx, args.level, args.note),
  "event.create": async (ctx, args) => {
    const result = await scheduleEvent(ctx, { title: args.title, lineId: args.lineId, date: args.date, weekdays: args.weekdays, startTime: args.startTime,
      endTime: args.endTime, until: args.until, minutes: args.minutes > 0 ? args.minutes : 60, location: args.location });
    if (!result.ok) return { ok: false, code: result.code, message: result.message };
    return { ok: true, href: "/plan", message: `${describeEvent(result.event)}${result.placedBySystem ? "（系统选定的空档）" : ""}${result.moved ? ` · 重排了 ${result.moved} 个冲突的任务块` : ""}` };
  },
  "goal.add": (ctx, args) => {
    const line = identityLines(ctx).find((pack) => pack.id === args.lineId);
    if (!line) return { ok: false, code: "LINE_NOT_FOUND" };
    const goals = line.goals ?? [];
    return goals.includes(args.title) ? { ok: true, message: "这个长期目标已在" } : { ...updateLine(ctx, args.lineId, { goals: [...goals, args.title] }), href: "/milestones" };
  },
  "milestone.draft": (ctx, args) => {
    const result = createMilestoneDraft(ctx, { lineId: args.lineId, title: args.title, date: args.date, target: args.target });
    return result.ok ? { ok: true, message: "草稿已建立，在主线页批准", href: `/milestones?open=${encodeURIComponent(result.id)}` } : result;
  },
  "line.add": (ctx, args) => {
    const result = addLine(ctx, { label: args.label, goal: "" });
    return result.ok ? { ok: true, message: "这条主线的访谈可以开始了", href: `/onboarding?line=${encodeURIComponent(result.id)}` } : result;
  },
  "profile.tell": (ctx, args) => {
    const session = getStore().getLatestOnboardingSession(ctx.workspaceId);
    if (!session) return { ok: false, code: "INTERVIEW_NOT_STARTED", message: "还没有访谈，先在画像页开始访谈" };
    // The interview takes it as the person's reply, with its own instructions and everything it knows of them.
    void requestCodexSupervisor(ctx, "/v1/onboarding/turn", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: session.id, text: args.text }), signal: AbortSignal.timeout(3 * 60 * 60_000) }).catch(() => undefined);
    return { ok: true, message: "已交给访谈，画像随后更新", href: "/onboarding" };
  },
  "proposal.decide": (ctx, args) => args.decision === "approve"
    ? approveWorkOrderProposal(ctx, args.workOrderId)
    : archiveWorkOrder(ctx, args.workOrderId, args.reason.trim() || "在输入框中拒绝"),
  "milestones.decide": (ctx, args) => {
    const result = (args.decision === "approve" ? approveMilestoneDrafts : rejectMilestoneDrafts)(ctx, args.milestoneIds);
    if (!result.approved.length) return { ok: false, code: result.skipped[0]?.code ?? "MILESTONE_NOT_DRAFT" };
    return { ok: true, message: `${args.decision === "approve" ? "已批准" : "已撤下"} ${result.approved.length} 个${result.skipped.length ? `，${result.skipped.length} 个未处理` : ""}`, href: "/milestones" };
  },
  "agent_result.review": (ctx, args) => {
    const result = reviewAgentTask(getStore(), ctx.workspaceId, args.taskId, args.decision, args.note);
    return result.ok ? { ok: true } : { ok: false, code: result.code };
  },
  "importance.set": (ctx, args) => applyChange(ctx, { kind: "weight", milestoneId: args.milestoneId, weight: Math.round(args.weight) })
};

/** Words for the codes a handler can return, so a failed card says why in the person's terms. */
const FAILURE: Record<string, string> = {
  WORK_ORDER_NOT_FOUND: "任务已不存在", ASK_NOT_FOUND: "这件待决事项已处理或已过期", OP_NOT_UNDOABLE: "该操作已撤销或超过 24 小时",
  MILESTONE_NOT_DRAFT: "里程碑已不是草稿", LINE_NOT_FOUND: "主线不存在", TASK_NOT_FOUND: "助手任务不存在", PROPOSAL_VERSION_CHANGED: "任务已被改动，请刷新后重试"
};

/** Carries out one confirmed action. Everything except an undo is recorded for 撤销; a failure changes nothing and says why. */
export async function executeAction(ctx: AccessContext, item: ProposedAction): Promise<ActionOutcome> {
  const handler = ACTION_HANDLERS[item.action] as Handler<ActionId>;
  const label = `${ACTIONS[item.action].label}：${item.summary || ""}`.slice(0, 160);
  try {
    const result = item.action === "undo" ? await handler(ctx, item.args) : await withUndo(ctx, label, () => handler(ctx, item.args));
    if (!result.ok) return { ok: false, message: result.message ?? FAILURE[result.code] ?? `未完成（${result.code}）` };
    const op = "op" in result ? (result as { op?: { id: string } }).op : undefined;
    return { ok: true, message: result.message ?? "已完成", ...(op ? { opId: op.id } : {}), ...(result.href ? { href: result.href } : {}) };
  } catch (error) {
    return { ok: false, message: error instanceof Error && FAILURE[error.message] ? FAILURE[error.message]! : "未完成，请重试" };
  }
}
