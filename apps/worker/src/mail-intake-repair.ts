import { randomUUID } from "node:crypto";
import { taskTitleOf } from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";
import { briefIds, buildLedgerBrief } from "./ledger-brief";
import { tOfWorkspace } from "./locale";
import { MAIL_TRIAGE_SKILL } from "./mailbox";
import { ownerOf } from "./owner";
import { archiveBySystem } from "./return-tidy";
import { sayToPerson } from "./workflow-smith";

/**
 * Once per workspace (docs/plans/near-term-and-mail-bar-1120.md §3.7, approved 2026-11-20): the tasks mail made before the ledger brief
 * existed — movie nights, health days, a weekly meeting's invitation, a second copy of an assignment — are judged again, with the brief,
 * as new mail now is. One nobody has started (no timer, no own step done) that is only going to something, serves none of the person's
 * milestones or lines, or is the same as something the ledger has, is archived by the system with its reason; the rest stay. The person is
 * told once; one undo brings them all back, and each can be restored on its own from 已归档.
 */
export const MAIL_INTAKE_REPAIR = "repair.mail-intake.v1";
const OPEN = new Set(["captured", "analyzing", "awaiting_plan_approval", "approved", "preparing", "ready_for_human", "blocked"]);
const MAX = 40;

type Verdict = { id: string; verdict: "keep" | "event" | "unrelated" | "known"; known: string; why: string };
const SCHEMA = {
  type: "object", additionalProperties: false, required: ["items"], properties: {
    items: { type: "array", maxItems: MAX, items: { type: "object", additionalProperties: false, required: ["id", "verdict", "known", "why"], properties: {
      id: { type: "string", maxLength: 200 }, verdict: { type: "string", enum: ["keep", "event", "unrelated", "known"] },
      known: { type: "string", maxLength: 200 }, why: { type: "string", maxLength: 200 } } } } }
} as const;

// Repair messages to the model, not interface text.
/* i18n-ignore-start */
export function validateIntakeRepair(value: unknown, ids: readonly string[], known: ReadonlySet<string>): { items: Verdict[] } {
  const answer = value as { items?: Verdict[] } | undefined;
  if (!answer || !Array.isArray(answer.items)) throw Object.assign(new Error("MAIL_INTAKE_REPAIR_INVALID"), { detail: "items 必须是数组" });
  const problems: string[] = [];
  for (const item of answer.items) {
    if (!ids.includes(item.id)) problems.push(`id「${item.id}」不是这次给出的任务`);
    if (item.verdict === "known" && (!known.has(item.known) || item.known === item.id)) problems.push(`${item.id} 判为 known，known 必须是账本简报里另一项的 id`);
  }
  if (problems.length) throw Object.assign(new Error("MAIL_INTAKE_REPAIR_INVALID"), { detail: problems.slice(0, 6).join("；") });
  return answer as { items: Verdict[] };
}
/* i18n-ignore-end */

export async function mailIntakeRepair(store: CrosslineStore, workspaceId: string, client: CodexRpcBoundary | undefined, cwd: string, now = new Date()): Promise<string[]> {
  if (!client || store.getSetting(workspaceId, MAIL_INTAKE_REPAIR)) return [];
  const started = new Set(store.listEvents(workspaceId, { type: "work_order.transitioned" })
    .filter((event) => (event.payload as { event?: { type?: string } }).event?.type === "human.started").map((event) => event.entityId));
  const touched = (id: string) => started.has(id) || (store.getStepPlan(workspaceId, id)?.steps ?? [])
    .some((step) => step.executor !== "agent" && (step.status === "done" || (step.progressQuarter ?? 0) > 0));
  const candidates = store.listWorkOrders(workspaceId).filter((order) => order.id.startsWith("cap-mail-") && OPEN.has(order.state) && !order.tombstone && !touched(order.id))
    .slice(0, MAX);
  if (!candidates.length) { store.setSetting(workspaceId, MAIL_INTAKE_REPAIR, now.toISOString()); return []; }
  const brief = buildLedgerBrief(store, workspaceId, now);
  const ids = briefIds(brief);
  const input = { ledger: brief, today: now.toISOString().slice(0, 10),
    tasks: candidates.map((order) => ({ id: order.id, title: taskTitleOf(order), intent: order.intent.slice(0, 300), milestoneId: order.milestoneId,
      due: (order.payload as { dueDate?: string } | undefined)?.dueDate ?? "" })) };
  const result = await runCodexSkill<{ items: Verdict[] }>(client, input, { skillName: MAIL_TRIAGE_SKILL, cwd, outputSchema: SCHEMA as unknown as Record<string, unknown>,
    developerInstructions: "These open tasks were made from mail before the ledger was given to you. Judge each again against the ledger, as "
      + "you sort new mail now: event when it is only going to something at a set time (a talk, a club night, a meeting) and preparing nothing; "
      + "unrelated when it serves none of the person's milestones or lines' long-term goals (a campus-wide notice, a health day, a social event); "
      + "known when it is the same piece of work or the same meeting as another ledger item (give that item's id in known); keep otherwise, and "
      // i18n-ignore: model-facing
      + "always keep course work from course staff with a due day. why is one short sentence for the person. When unsure, keep.",
    stableKeys: ["ledger"], prepareInput: () => input,
    validateOutput: (output) => validateIntakeRepair(output, candidates.map((order) => order.id), ids.known), onAudit: () => {}, timeoutMs: 20 * 60_000 });
  // Marked only once answered: a quota or a stall tries again on a later tick.
  if (!result.ok) return [];
  store.setSetting(workspaceId, MAIL_INTAKE_REPAIR, now.toISOString());
  const t = tOfWorkspace(store, workspaceId);
  const knownTitles = new Map([...brief.openTasks, ...brief.doneTasks, ...brief.time].map((item) => [item.id, item.title]));
  const orders = new Map(candidates.map((order) => [order.id, order]));
  const out = result.output.items.flatMap((item) => {
    const order = orders.get(item.id);
    if (!order || item.verdict === "keep") return [];
    const why = item.verdict === "event" ? t("邮件里的活动，不作为任务") : item.verdict === "unrelated" ? t("与里程碑无关，未列入")
      : t("与「{{title}}」是同一件", { title: knownTitles.get(item.known) ?? item.known });
    return [{ order, why }];
  });
  if (!out.length) return [];
  const archived = archiveBySystem(store, workspaceId, out, "intake");
  const opId = `op-${now.getTime().toString(36)}-${randomUUID().slice(0, 6)}`;
  store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `op.applied:${opId}`, type: "op.applied", entityId: opId,
    payload: { bySystem: true, label: t("清理邮件来的任务 {{count}} 个", { count: archived.length }), inverse: { kind: "work_order.restore", ids: archived.map((item) => item.id) } } });
  const lines = archived.slice(0, 8).map((item) => `- ${t("「{{title}}」：{{why}}", { title: item.title, why: item.why })}`);
  sayToPerson(store, workspaceId, [t("已清理 {{count}} 个从邮件来的任务（活动、与里程碑无关、或与已有的重复）：", { count: archived.length }), ...lines,
    ...(archived.length > 8 ? [t("另有 {{count}} 个，见任务页「已归档」。", { count: archived.length - 8 })] : []),
    t("每个都可在任务页「已归档」里单独恢复。")].join("\n"), "mail_intake_cleanup", `mail-intake-repair:${workspaceId}`,
  [{ label: t("全部撤销"), action: { action: "undo", summary: t("撤销：恢复这些任务"), args: { opId } } }], now);
  return archived.map((item) => item.id);
}
