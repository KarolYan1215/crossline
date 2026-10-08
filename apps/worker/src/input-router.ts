import { INPUT_ROUTE_SCHEMA, validateRoutedInput, type RoutedInput } from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";

const SKILL = "crossline:crossline-input-router";
const OPEN = ["awaiting_plan_approval", "approved", "preparing", "ready_for_human", "active"];

/**
 * Splits a quick-capture input into captures and instructions about open tasks (see `packages/core/src/input-router.ts`). Returns what
 * it read; the web creates the captures and previews the changes. A failed run returns the whole text as one capture, so nothing typed
 * is ever lost to the router.
 */
export function createInputRouter(store: CrosslineStore, workspaceId: string, cwd: string, getClient: () => CodexRpcBoundary | undefined) {
  return async function route(input: { text: string; batch: boolean; mentions: Array<{ kind: string; id: string; title: string }>; timeZone: string },
    signal?: AbortSignal): Promise<RoutedInput & { routed: boolean }> {
    const fallback = { routed: false, items: [{ kind: "capture" as const, title: input.text.slice(0, 240), context: "", workOrderId: "", change: { type: "none" as const, date: "", minutes: 0 }, summary: "" }] };
    const client = getClient();
    if (!client) return fallback;
    const projects = new Map(store.listProjects(workspaceId, { includeArchived: true }).map((project) => [project.id, project.name]));
    const openTasks = store.listWorkOrders(workspaceId).filter((order) => OPEN.includes(order.state)).slice(0, 80).map((order) => ({
      id: order.id, title: order.intent, line: order.identityId, project: projects.get(order.projectId) ?? "",
      dueDate: (order.payload as { dueDate?: string } | undefined)?.dueDate ?? "", usualMinutes: order.estimate.p50Minutes }));
    const context = { version: "crossline.input-route.v1", text: input.text.slice(0, 4000), batch: input.batch,
      today: `${new Intl.DateTimeFormat("en-CA", { timeZone: input.timeZone }).format(new Date())} ${new Intl.DateTimeFormat("zh-CN", { timeZone: input.timeZone, weekday: "long" }).format(new Date())}`, timeZone: input.timeZone, openTasks, mentions: input.mentions.slice(0, 20) };
    const result = await runCodexSkill<RoutedInput>(client, context, { skillName: SKILL, cwd,
      developerInstructions: "Split the input into captures and schedule instructions as the Skill describes. Return raw JSON only.",
      outputSchema: INPUT_ROUTE_SCHEMA, prepareInput: () => context,
      validateOutput: (output) => validateRoutedInput(output, openTasks.map((task) => task.id), input.text),
      onAudit: () => {}, ...(signal ? { signal } : {}), timeoutMs: 10 * 60_000 });
    return result.ok ? { routed: true, ...result.output } : fallback;
  };
}
