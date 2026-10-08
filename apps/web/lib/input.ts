import "server-only";
import { randomUUID } from "node:crypto";
import type { AccessContext, RoutedInput } from "@crossline/core";
import { addCapturedTaskWithId, effectiveSchedulePreferences, getStore } from "./crossline";
import { requestCodexSupervisor } from "./codex-runtime";
import { analyzeNewCapturesInBackground } from "./capture-followups";
import { applyChange, type Change } from "./impact";
import { recentOps, withUndo } from "./undo";

/** The person's choice: an instruction about a planned task is applied at once instead of shown as a preview first. */
export const INPUT_AUTO_APPLY = "input.schedule.autoApply";
export type Mention = { kind: "material" | "task" | "milestone"; id: string; title: string };

export const autoApplySchedule = (ctx: AccessContext) => getStore().getSetting(ctx.workspaceId, INPUT_AUTO_APPLY) === "1";
export function setAutoApplySchedule(ctx: AccessContext, on: boolean): void { getStore().setSetting(ctx.workspaceId, INPUT_AUTO_APPLY, on ? "1" : "0"); }

/** What links a capture to existing things, written into its context so the analysis sees it. */
export const mentionContext = (mentions: Mention[]) => mentions.length
  ? `关联：${mentions.map((item) => `${{ material: "资料", task: "任务", milestone: "里程碑" }[item.kind]}「${item.title}」`).join("；")}` : "";

/**
 * A quick-capture input that is a batch or reads like an instruction: the router splits it; captures are written at once, changes to
 * planned tasks come back to be previewed (or are applied, when the person chose that). Without the worker the text is captured as is.
 */
export async function routeInput(ctx: AccessContext, input: { text: string; batch: boolean; mentions: Mention[] }): Promise<{
  captured: Array<{ id: string; title: string }>; changes: Array<{ change: Change; summary: string }>; applied: string[]; routed: boolean;
  /** 「撤销刚才的…」: the operation it names (`opId` "" when none of the recent ones matched), shown with an 撤销 button, not applied. */
  undos: Array<{ opId: string; label: string; summary: string }>;
}> {
  const timeZone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  let routed: RoutedInput & { routed: boolean };
  try {
    routed = await requestCodexSupervisor<RoutedInput & { routed: boolean }>(ctx, "/v1/input/route", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...input, timeZone }), signal: AbortSignal.timeout(10 * 60_000) });
  } catch {
    routed = { routed: false, items: [{ kind: "capture", title: input.text.slice(0, 240), context: "", workOrderId: "", change: { type: "none", date: "", minutes: 0 }, summary: "", opId: "" }] };
  }
  const captured: Array<{ id: string; title: string }> = [];
  const changes: Array<{ change: Change; summary: string }> = [];
  const extra = mentionContext(input.mentions);
  const undos: Array<{ opId: string; label: string; summary: string }> = [];
  const ops = new Map(recentOps(ctx).map((op) => [op.id, op.label]));
  for (const item of routed.items) {
    if (item.kind === "undo") { undos.push({ opId: item.opId, label: ops.get(item.opId) ?? "", summary: item.summary }); continue; }
    if (item.kind === "capture") {
      const id = randomUUID();
      addCapturedTaskWithId(ctx, { title: item.title, context: [item.context, extra].filter(Boolean).join("\n").slice(0, 500) }, id, id);
      captured.push({ id, title: item.title });
    } else if (item.change.type === "estimate") changes.push({ change: { kind: "estimate", workOrderId: item.workOrderId, p50Minutes: item.change.minutes }, summary: item.summary });
    else if (item.change.type === "due" || item.change.type === "defer") changes.push({ change: { kind: item.change.type, workOrderId: item.workOrderId, date: item.change.date }, summary: item.summary });
  }
  if (captured.length) analyzeNewCapturesInBackground(ctx);
  const applied: string[] = [];
  if (autoApplySchedule(ctx)) {
    for (const item of changes.splice(0)) if ((await withUndo(ctx, item.summary, () => applyChange(ctx, item.change))).ok) applied.push(item.summary);
  }
  return { captured, changes, applied, routed: routed.routed, undos };
}

/** What `@` can reference: the person's files, open tasks and live milestones, matching the typed text. */
export function searchMentions(ctx: AccessContext, query: string, kind?: Mention["kind"]): Mention[] {
  const store = getStore();
  const q = query.trim().toLowerCase();
  const match = (text: string) => !q || text.toLowerCase().includes(q);
  const results: Mention[] = [];
  if (!kind || kind === "material") results.push(...store.listSourceDocuments(ctx.workspaceId).filter((doc) => match(doc.fileName))
    .map((doc) => ({ kind: "material" as const, id: doc.id, title: doc.fileName })));
  if (!kind || kind === "task") results.push(...store.listWorkOrders(ctx.workspaceId).filter((order) => !["accepted", "archived"].includes(order.state) && match(order.intent))
    .map((order) => ({ kind: "task" as const, id: order.id, title: order.intent })));
  if (!kind || kind === "milestone") results.push(...store.listMilestones(ctx.workspaceId).filter((item) => item.status !== "archived" && match(item.title))
    .map((item) => ({ kind: "milestone" as const, id: item.id, title: item.title })));
  return results.slice(0, 12);
}
