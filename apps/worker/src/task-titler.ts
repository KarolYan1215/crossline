import { TASK_TITLES_SCHEMA, validateTaskTitles, type TaskTitles } from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";
import { ownerOf } from "./owner";

export const TASK_TITLER = "crossline:crossline-task-titler";

/** Tasks written before short names existed (and still on the board or in its history): what the titler names, oldest first. */
export function untitledTasks(store: CrosslineStore, workspaceId: string): Array<{ id: string; intent: string }> {
  return store.listWorkOrders(workspaceId)
    .filter((order) => order.state !== "archived" && !((order.payload as { title?: unknown } | undefined)?.title))
    .map((order) => ({ id: order.id, intent: order.intent }));
}

/**
 * Gives existing tasks their short name (decided 2026-10-08): the original sentence stays as the description; only `payload.title` is
 * added. Up to forty a run, so a large board is named over a few ticks.
 */
export function createTaskTitler(store: CrosslineStore, workspaceId: string, cwd: string, getClient: () => CodexRpcBoundary | undefined) {
  return async function name(): Promise<{ named: number } | { blocked: string }> {
    const client = getClient();
    if (!client) return { blocked: "CODEX_SUPERVISOR_UNAVAILABLE" };
    const tasks = untitledTasks(store, workspaceId).slice(0, 40);
    if (!tasks.length) return { named: 0 };
    const context = { version: "crossline.task-titles.v1", tasks };
    const result = await runCodexSkill<TaskTitles>(client, context, { skillName: TASK_TITLER, cwd,
      developerInstructions: "Name each task as the Skill describes. Return raw JSON only.", outputSchema: TASK_TITLES_SCHEMA, prepareInput: () => context,
      validateOutput: (output) => validateTaskTitles(output, tasks.map((task) => task.id)), onAudit: () => {}, timeoutMs: 20 * 60_000 });
    if (!result.ok) return { blocked: result.blocker.code };
    const orders = new Map(store.listWorkOrders(workspaceId).map((order) => [order.id, order]));
    for (const { id, title } of result.output.titles) {
      const order = orders.get(id);
      if (!order || (order.payload as { title?: unknown } | undefined)?.title) continue;
      store.saveWorkOrder({ ...order, payload: { ...((order.payload ?? {}) as Record<string, unknown>), title } });
    }
    store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `tasks.titled:${Date.now()}`, type: "tasks.titled", entityId: workspaceId,
      payload: { named: result.output.titles.length } });
    return { named: result.output.titles.length };
  };
}
