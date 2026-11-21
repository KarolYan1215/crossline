import "server-only";
import { randomUUID } from "node:crypto";
import { DELIVERABLE_JUDGED, gapWorthAsking, onPersonsBoard, readSourceFolders, SOURCE_FOLDERS_SETTING, sourceFolderIndexSetting, taskTitleOf, tidySentenceEnds, type AccessContext, type Ask, type AskOption, type DeliverableJudgement } from "@crossline/core";
import { acceptWorkOrderEvidence, appNow, completeWorkOrderExecution, getStore, planToday, startWorkOrderExecution } from "./crossline";
import { recordOp, reopenWorkOrders } from "./undo";
import { tOf } from "./locale";

/**
 * The web's half of the system's acceptance (docs/plans/attention-ledger-1120.md §7.2, batch 5): the worker's model reads new files in the
 * person's folders (`apps/worker/src/deliverable-check.ts`) and records a `deliverable.judged` per file; here, on the attention timer,
 * - a file that is an open task's deliverable and meets its done criteria completes the task, said once in the day's conversation with 撤销
 *   (an undo is a lesson: the next judgement reads it);
 * - a file that falls short of a task the person already finished is asked about once, only at a key place (`gapWorthAsking`);
 * - everything else is only recorded, and so is a pass on finished work.
 * Work waiting in `evidence_review` with no milestone (the old 「算数，验收」 card) is accepted by the system the same way, undoable.
 * A completion a file made is taken back when that file is deleted or emptied within two weeks (as Linear reopens an issue whose PR is
 * reverted); a file the person left out of the folder, or a folder no longer authorized, takes back nothing.
 */
export type JudgedFile = DeliverableJudgement & { fileName: string; uri: string; at: string; folderId?: string };
export const DELIVERABLE_SETTLED = "deliverable.settled";
export const GAP_ANSWERED = "deliverable.gap_answered";
export const DELIVERABLE_WITHDRAWN = "deliverable.withdrawn";
/** How long after it closed a task a deleted or emptied file still takes the completion back. */
const WITHDRAW_DAYS = 14;
const OPEN = new Set(["approved", "ready_for_human", "active"]);

export function judgedFiles(ctx: AccessContext): JudgedFile[] {
  return getStore().listEvents(ctx.workspaceId, { type: DELIVERABLE_JUDGED })
    .map((event) => ({ ...(event.payload as Omit<JudgedFile, "at">), at: event.createdAt }));
}

export function settleDeliverables(ctx: AccessContext, now = appNow()): string[] {
  const store = getStore();
  const t = tOf(ctx);
  const settled = new Set(store.listEvents(ctx.workspaceId, { type: DELIVERABLE_SETTLED }).map((event) => event.entityId));
  const closed: Array<{ id: string; title: string; file: string }> = [];
  for (const file of judgedFiles(ctx)) {
    if (settled.has(file.doc)) continue;
    const order = file.task ? store.getWorkOrder(ctx.workspaceId, file.task) : undefined;
    let outcome = "recorded";
    if (order && file.verdict === "deliverable" && file.criterion === "pass" && OPEN.has(order.state)) {
      const at = now.toISOString();
      const started = order.state === "active" || startWorkOrderExecution(ctx, order.id, at).ok;
      if (started && completeWorkOrderExecution(ctx, order.id, [{ kind: "file", uri: file.uri, description: file.fileName }], [], at).ok) {
        closed.push({ id: order.id, title: taskTitleOf(order), file: file.fileName });
        outcome = "completed";
      }
    }
    store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `${DELIVERABLE_SETTLED}:${file.doc}`, type: DELIVERABLE_SETTLED,
      entityId: file.doc, payload: { task: file.task, outcome } });
  }
  for (const order of store.listWorkOrders(ctx.workspaceId).filter((item) => item.state === "evidence_review" && !item.milestoneId && onPersonsBoard(item))) {
    if (!acceptWorkOrderEvidence(ctx, order.id).ok) continue;
    recordOp(ctx, t("系统验收「{{title}}」", { title: taskTitleOf(order) }), { kind: "work_order.reopen", ids: [order.id] }, { bySystem: true });
  }
  withdrawDeliverables(ctx, now);
  if (!closed.length) return [];
  const label = closed.length === 1 ? t("看到「{{file}}」，把「{{title}}」记为完成", { file: closed[0]!.file, title: closed[0]!.title })
    : t("按新文件把 {{count}} 个任务记为完成", { count: closed.length });
  const op = recordOp(ctx, label, { kind: "work_order.reopen", ids: closed.map((item) => item.id) }, { bySystem: true });
  const text = closed.map((item) => t("看到「{{file}}」，已把「{{title}}」记为完成。", { file: item.file, title: item.title })).join("\n");
  const conversation = store.conversationFor(ctx.workspaceId, planToday(ctx, now));
  store.appendConversationMessage({ id: randomUUID(), workspaceId: ctx.workspaceId, conversationId: conversation.id, role: "nudge", text: "", createdAt: now.toISOString(),
    payload: { nudge: { kind: "deliverable_closed", fingerprint: `deliverable_closed:${op.id}`, urgent: false, counted: false, delivery: "pending" },
      card: { actions: [{ action: "undo", summary: t("撤销：任务回到未完成"), args: { opId: op.id } }], items: [{ state: "pending" }], confidence: "high", nudgeKind: "deliverable_closed",
        clarify: { question: tidySentenceEnds(text), options: [{ label: t("撤销"), actions: [0], kind: "action" }, { label: t("知道了"), actions: [], kind: "ack" }] } } } });
  return closed.map((item) => item.id);
}

const short = (text: string, length = 30) => text.length > length ? `${text.slice(0, length)}…` : text;

/**
 * A file that falls short of work the person already finished, asked once and only at a key place (`gapWorthAsking`: the task bears on a
 * milestone, or the shortfall goes outside). Open work with a gap is not asked about: the person is still on it.
 */
export function gapAsks(ctx: AccessContext): Ask[] {
  const store = getStore();
  const t = tOf(ctx);
  const answered = new Set(store.listEvents(ctx.workspaceId, { type: GAP_ANSWERED }).map((event) => event.entityId));
  const orders = new Map(store.listWorkOrders(ctx.workspaceId).map((order) => [order.id, order]));
  return judgedFiles(ctx).flatMap((file): Ask[] => {
    const order = file.task ? orders.get(file.task) : undefined;
    if (!order || order.state !== "accepted" || file.verdict !== "deliverable" || answered.has(file.doc) || !gapWorthAsking(file, order.milestoneId)) return [];
    const options: AskOption[] = [
      { id: "done", label: t("已经交了，结束"), recommended: !file.external },
      { id: "fix", label: t("我补一下"), detail: t("任务回到未完成"), recommended: file.external },
      { id: "na", label: t("这条标准不适用"), detail: t("记进偏好，以后验收不再按它判") }
    ];
    return [{ id: `gap:${file.doc}`, kind: "acceptance_gap", entityId: order.id, line: order.identityId, urgency: file.external ? "soon" : "later",
      raisedAt: file.at, fingerprint: file.doc, title: t("「{{title}}」可能还缺：{{gap}}", { title: short(taskTitleOf(order)), gap: short(file.gap, 40) }),
      why: t("按「{{file}}」看，{{why}}", { file: file.fileName, why: tidySentenceEnds(file.why || file.gap) }),
      preview: { kind: "task", href: `/workbench/${encodeURIComponent(order.id)}`, label: t("看任务") }, options }];
  });
}

/** Carries out the answer to an `acceptance_gap` ask. */
export function answerGap(ctx: AccessContext, ask: Ask, optionId: string): { ok: true } | { ok: false; code: string } {
  const store = getStore();
  const file = judgedFiles(ctx).find((item) => item.doc === ask.fingerprint);
  if (!file) return { ok: false, code: "ASK_STALE" };
  if (optionId === "fix") {
    const reopened = reopenWorkOrders(ctx, [ask.entityId], tOf(ctx)("验收发现缺：{{gap}}", { gap: file.gap }));
    if (!reopened.ok) return reopened;
  } else if (optionId === "na") {
    const order = store.getWorkOrder(ctx.workspaceId, ask.entityId);
    store.addPreference({ workspaceId: ctx.workspaceId, source: "correction", scope: "all", weight: 1, refId: `gap:${file.doc}`,
      text: tOf(ctx)("本人说「{{title}}」验收时「{{gap}}」这一条不适用：同类任务以后不按它判。", { title: order ? taskTitleOf(order) : file.fileName, gap: file.gap }).slice(0, 300) });
  } else if (optionId !== "done") return { ok: false, code: "ASK_OPTION_UNKNOWN" };
  store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `${GAP_ANSWERED}:${file.doc}`, type: GAP_ANSWERED, entityId: file.doc,
    payload: { task: ask.entityId, answer: optionId } });
  return { ok: true };
}

/** Whether the file that closed a task is gone from its folder or now empty; undefined when that cannot be told (folder not authorized). */
function deliverableGone(ctx: AccessContext, file: JudgedFile, docs: ReadonlyMap<string, { extractedText: string }>, folders: ReadonlySet<string>): boolean | undefined {
  // Left out by the person's exclusions or purged with its folder: the document is gone from the ledger, and that is not a withdrawal.
  if (!file.folderId || !folders.has(file.folderId) || !docs.has(file.doc)) return undefined;
  let index: Record<string, { documentId?: string }> = {};
  try { index = JSON.parse(getStore().getSetting(ctx.workspaceId, sourceFolderIndexSetting(file.folderId)) ?? "{}") as typeof index; } catch { return undefined; }
  const entries = Object.entries(index).map(([relative, entry]) => ({ relative: relative.replace(/\\/g, "/"), documentId: entry.documentId ?? "" }));
  // Still in the folder (moved inside it keeps the same document).
  if (entries.some((entry) => entry.documentId === file.doc)) return false;
  const now = entries.find((entry) => entry.relative === file.fileName);
  // Changed into a new version with text: that version is judged on its own.
  if (now?.documentId && (docs.get(now.documentId)?.extractedText.trim() ?? "")) return false;
  return true;
}

export function withdrawDeliverables(ctx: AccessContext, now = appNow()): string[] {
  const store = getStore();
  const t = tOf(ctx);
  const since = now.getTime() - WITHDRAW_DAYS * 86_400_000;
  const withdrawn = new Set(store.listEvents(ctx.workspaceId, { type: DELIVERABLE_WITHDRAWN }).map((event) => event.entityId));
  const closedBy = store.listEvents(ctx.workspaceId, { type: DELIVERABLE_SETTLED })
    .filter((event) => (event.payload as { outcome?: string }).outcome === "completed" && Date.parse(event.createdAt) >= since && !withdrawn.has(event.entityId));
  if (!closedBy.length) return [];
  const files = new Map(judgedFiles(ctx).map((file) => [file.doc, file]));
  const docs = new Map(store.listSourceDocuments(ctx.workspaceId).map((doc) => [doc.id, doc]));
  const folders = new Set(readSourceFolders(store.getSetting(ctx.workspaceId, SOURCE_FOLDERS_SETTING)).map((folder) => folder.id));
  const reopened: Array<{ id: string; title: string; file: string }> = [];
  for (const event of closedBy) {
    const file = files.get(event.entityId);
    if (!file || deliverableGone(ctx, file, docs, folders) !== true) continue;
    const order = store.getWorkOrder(ctx.workspaceId, file.task);
    store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `${DELIVERABLE_WITHDRAWN}:${file.doc}`, type: DELIVERABLE_WITHDRAWN,
      entityId: file.doc, payload: { task: file.task, fileName: file.fileName } });
    // Only a completion still standing: one the person already reopened, or finished again some other way since, is left alone.
    if (order?.state !== "accepted") continue;
    if (!reopenWorkOrders(ctx, [order.id], t("交付文件「{{file}}」被删除或清空", { file: file.fileName })).ok) continue;
    reopened.push({ id: order.id, title: taskTitleOf(order), file: file.fileName });
  }
  if (!reopened.length) return [];
  const text = reopened.map((item) => t("「{{file}}」被删除或清空，「{{title}}」已改回未完成。若只是移走了，按一下完成即可。", { file: item.file, title: item.title })).join("\n");
  const conversation = store.conversationFor(ctx.workspaceId, planToday(ctx, now));
  store.appendConversationMessage({ id: randomUUID(), workspaceId: ctx.workspaceId, conversationId: conversation.id, role: "nudge", text: "", createdAt: now.toISOString(),
    payload: { nudge: { kind: "deliverable_withdrawn", fingerprint: `deliverable_withdrawn:${reopened.map((item) => item.id).join(",")}:${now.toISOString()}`, urgent: false, counted: false,
      delivery: "pending" }, card: { actions: [], items: [{ state: "pending" }], confidence: "high", nudgeKind: "deliverable_withdrawn",
      clarify: { question: tidySentenceEnds(text), options: [{ label: t("知道了"), actions: [], kind: "ack" }] } } } });
  return reopened.map((item) => item.id);
}
