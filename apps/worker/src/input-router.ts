import { INPUT_ROUTE_SCHEMA, captureItem, validateRoutedInput, type RoutedInput } from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";
import { identityLines } from "./lines";

const SKILL = "crossline:crossline-input-router";
const OPEN = ["awaiting_plan_approval", "approved", "preparing", "ready_for_human", "active"];

/**
 * Sorts what was typed into the one input box into its kinds (see `packages/core/src/input-router.ts`). Returns what it read; the web
 * writes each kind and previews schedule changes. A failed run returns the whole text as one capture, so nothing typed
 * is ever lost to the router.
 */
export function createInputRouter(store: CrosslineStore, workspaceId: string, cwd: string, getClient: () => CodexRpcBoundary | undefined) {
  return async function route(input: { text: string; batch: boolean; mentions: Array<{ kind: string; id: string; title: string }>; timeZone: string },
    signal?: AbortSignal): Promise<RoutedInput & { routed: boolean }> {
    const fallback = { routed: false, items: [captureItem(input.text)] };
    const client = getClient();
    if (!client) return fallback;
    const projects = new Map(store.listProjects(workspaceId, { includeArchived: true }).map((project) => [project.id, project.name]));
    const openTasks = store.listWorkOrders(workspaceId).filter((order) => OPEN.includes(order.state)).slice(0, 80).map((order) => ({
      id: order.id, title: order.intent, line: order.identityId, project: projects.get(order.projectId) ?? "",
      dueDate: (order.payload as { dueDate?: string } | undefined)?.dueDate ?? "", usualMinutes: order.estimate.p50Minutes }));
    const recentOps = recentOperations(store, workspaceId);
    const lines = identityLines(store, workspaceId).map((line) => ({ id: line.id, label: line.label, goals: line.goals ?? [], hard: Boolean(line.hard) }));
    const context = { version: "crossline.input-route.v2", text: input.text.slice(0, 4000), batch: input.batch, recentOps, lines,
      today: `${new Intl.DateTimeFormat("en-CA", { timeZone: input.timeZone }).format(new Date())} ${new Intl.DateTimeFormat("zh-CN", { timeZone: input.timeZone, weekday: "long" }).format(new Date())}`, timeZone: input.timeZone, openTasks, mentions: input.mentions.slice(0, 20) };
    const result = await runCodexSkill<RoutedInput>(client, context, { skillName: SKILL, cwd,
      developerInstructions: "Sort the input into the kinds the Skill describes. Return raw JSON only.",
      outputSchema: INPUT_ROUTE_SCHEMA, prepareInput: () => context,
      validateOutput: (output) => validateRoutedInput(output, openTasks.map((task) => task.id), input.text, recentOps.map((op) => op.id), lines.map((line) => line.id)),
      onAudit: () => {}, ...(signal ? { signal } : {}), timeoutMs: 10 * 60_000 });
    return result.ok ? { routed: true, ...result.output } : fallback;
  };
}

/** The person's operations of the last 24 hours that are not undone yet (the web's undo log, `apps/web/lib/undo.ts`), newest first. */
export function recentOperations(store: CrosslineStore, workspaceId: string, now = Date.now()): Array<{ id: string; label: string; at: string }> {
  const undone = new Set(store.listEvents(workspaceId, { type: "op.undone" }).map((event) => event.entityId));
  return store.listEvents(workspaceId, { type: "op.applied" })
    .filter((event) => !undone.has(event.entityId) && now - Date.parse(event.createdAt) < 24 * 3_600_000)
    .map((event) => ({ id: event.entityId, label: String((event.payload as { label?: string }).label ?? ""), at: event.createdAt }))
    .reverse().slice(0, 30);
}
