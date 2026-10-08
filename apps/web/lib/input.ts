import "server-only";
import { randomUUID } from "node:crypto";
import { captureItem, type AccessContext, type RoutedInput } from "@crossline/core";
import { addCapturedTaskWithId, effectiveSchedulePreferences, getStore, saveMilestoneEdit } from "./crossline";
import { requestCodexSupervisor } from "./codex-runtime";
import { analyzeNewCapturesInBackground } from "./capture-followups";
import { applyChange, type Change } from "./impact";
import { recentOps, withUndo } from "./undo";
import { addLine, identityLines, updateLine } from "./lines";
import { recordEnergy, recordTaskNote } from "./task-ops";

/** The person's choice: an instruction about a planned task is applied at once instead of shown as a preview first. */
export const INPUT_AUTO_APPLY = "input.schedule.autoApply";
export type Mention = { kind: "material" | "task" | "milestone"; id: string; title: string };

export const autoApplySchedule = (ctx: AccessContext) => getStore().getSetting(ctx.workspaceId, INPUT_AUTO_APPLY) === "1";
export function setAutoApplySchedule(ctx: AccessContext, on: boolean): void { getStore().setSetting(ctx.workspaceId, INPUT_AUTO_APPLY, on ? "1" : "0"); }

/** What links a capture to existing things, written into its context so the analysis sees it. */
export const mentionContext = (mentions: Mention[]) => mentions.length
  ? `关联：${mentions.map((item) => `${{ material: "资料", task: "任务", milestone: "里程碑" }[item.kind]}「${item.title}」`).join("；")}` : "";

export type RoutedOutcome = {
  captured: Array<{ id: string; title: string }>; changes: Array<{ change: Change; summary: string }>; applied: string[]; routed: boolean;
  /** 「撤销刚才的…」: the operation it names (`opId` "" when none of the recent ones matched), shown with an 撤销 button, not applied. */
  undos: Array<{ opId: string; label: string; summary: string }>;
  /** Long-term goals added to a line, milestone drafts (approved on 主线), new lines (their interview follows), records written. */
  goals: Array<{ lineId: string; line: string; title: string }>;
  milestones: Array<{ id: string; line: string; title: string; date: string }>;
  lines: Array<{ id: string; label: string }>;
  records: string[];
  /** Questions are not written anywhere: the page hands them to 小助手. */
  questions: string[];
  /** What could not be written, in words. */
  failed: string[];
};

/**
 * What the one input box receives when it is a batch or does not read like plain new work: the router sorts it; captures, goals,
 * milestone drafts, new lines and records are written at once (each undoable), changes to planned tasks come back to be previewed (or
 * are applied, when the person chose that). Without the worker the text is captured as is.
 */
export async function routeInput(ctx: AccessContext, input: { text: string; batch: boolean; mentions: Mention[] }): Promise<RoutedOutcome> {
  const timeZone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  let routed: RoutedInput & { routed: boolean };
  try {
    routed = await requestCodexSupervisor<RoutedInput & { routed: boolean }>(ctx, "/v1/input/route", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...input, timeZone }), signal: AbortSignal.timeout(10 * 60_000) });
  } catch {
    routed = { routed: false, items: [captureItem(input.text)] };
  }
  const outcome: RoutedOutcome = { captured: [], changes: [], applied: [], routed: routed.routed, undos: [], goals: [], milestones: [], lines: [], records: [], questions: [], failed: [] };
  const extra = mentionContext(input.mentions);
  const ops = new Map(recentOps(ctx).map((op) => [op.id, op.label]));
  const labels = new Map(identityLines(ctx).map((line) => [line.id, line.label]));
  const capture = (title: string, context: string) => {
    const id = randomUUID();
    addCapturedTaskWithId(ctx, { title, context: [context, extra].filter(Boolean).join("\n").slice(0, 500) }, id, id);
    outcome.captured.push({ id, title });
  };
  for (const item of routed.items) {
    switch (item.kind) {
      case "undo": outcome.undos.push({ opId: item.opId, label: ops.get(item.opId) ?? "", summary: item.summary }); break;
      case "capture": capture(item.title, item.context); break;
      case "schedule":
        if (item.change.type === "estimate") outcome.changes.push({ change: { kind: "estimate", workOrderId: item.workOrderId, p50Minutes: item.change.minutes }, summary: item.summary });
        else if (item.change.type === "due" || item.change.type === "defer") outcome.changes.push({ change: { kind: item.change.type, workOrderId: item.workOrderId, date: item.change.date }, summary: item.summary });
        break;
      case "goal": {
        const line = identityLines(ctx).find((pack) => pack.id === item.lineId);
        const goals = line?.goals ?? [];
        if (goals.includes(item.title)) break;
        const result = await withUndo(ctx, `新增长期目标：${item.title}`, () => updateLine(ctx, item.lineId, { goals: [...goals, item.title] }));
        if (result.ok) outcome.goals.push({ lineId: item.lineId, line: labels.get(item.lineId) ?? "", title: item.title });
        else outcome.failed.push(`长期目标「${item.title}」未添加（${result.code}）`);
        break;
      }
      case "milestone": {
        const result = await withUndo(ctx, `新建里程碑草稿：${item.title}`, () => createMilestoneDraft(ctx, { lineId: item.lineId, title: item.title, date: item.date, target: item.context }));
        if (result.ok) outcome.milestones.push({ id: result.id, line: labels.get(item.lineId) ?? "", title: item.title, date: item.date });
        else outcome.failed.push(`里程碑「${item.title}」未建立（${result.code}）`);
        break;
      }
      case "line": {
        const result = await withUndo(ctx, `新增主线：${item.title}`, () => addLine(ctx, { label: item.title, goal: "" }));
        if (result.ok) outcome.lines.push({ id: result.id, label: item.title });
        else outcome.failed.push(`主线「${item.title}」未新增（${result.code}）`);
        break;
      }
      case "record": {
        const result = await withUndo(ctx, `记录：${item.title.slice(0, 24)}`, () => item.energy
          ? recordEnergy(ctx, item.energy as "low" | "medium" | "high", item.title, item.workOrderId || undefined)
          : recordTaskNote(ctx, item.workOrderId, item.title));
        if (result.ok) outcome.records.push(item.title);
        else outcome.failed.push(`记录「${item.title}」未写入`);
        break;
      }
      case "question": outcome.questions.push(item.title); break;
    }
  }
  if (outcome.captured.length) analyzeNewCapturesInBackground(ctx);
  if (autoApplySchedule(ctx)) {
    for (const item of outcome.changes.splice(0)) if ((await withUndo(ctx, item.summary, () => applyChange(ctx, item.change))).ok) outcome.applied.push(item.summary);
  }
  return outcome;
}

/**
 * A milestone the person stated: a draft on its line, approved on the 主线 page like any other. Its deadline (when said) and target go
 * into its anchor, which is where the timeline reads a draft's date from.
 */
export function createMilestoneDraft(ctx: AccessContext, input: { lineId: string; title: string; date: string; target: string }): { ok: true; id: string } | { ok: false; code: string } {
  const saved = saveMilestoneEdit(ctx, { identityId: input.lineId, projectId: "", title: input.title, status: "draft", successCriteria: [] });
  if (!saved.ok) return saved;
  if (input.date || input.target) getStore().saveMilestoneAnchor({ workspaceId: ctx.workspaceId, milestoneId: saved.id, stage: 1, deadline: input.date, baseline: "",
    target: input.target.slice(0, 500), stakeholders: [], sourceFactIds: [], dependsOn: [], updatedAt: new Date().toISOString() });
  return { ok: true, id: saved.id };
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
