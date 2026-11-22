import { TASK_TITLES_SCHEMA, validateTaskTitles, type TaskTitles } from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";
import { ownerOf } from "./owner";

export const TASK_TITLER = "crossline:crossline-task-titler";

/**
 * Tasks the titler has not read yet (still on the board or in its history), oldest first: those written before short names existed, and
 * those whose `attends` is not recorded — every task once, old ones included, since the verb list that used to decide it is gone (2026-11-22).
 */
export function unreadTasks(store: CrosslineStore, workspaceId: string): Array<{ id: string; intent: string; project: string; title: string }> {
  const names = new Map(store.listProjects(workspaceId, { includeArchived: true }).map((project) => [project.id, project.name]));
  return store.listWorkOrders(workspaceId)
    .filter((order) => {
      const payload = (order.payload ?? {}) as { title?: unknown; attends?: unknown };
      return order.state !== "archived" && (!payload.title || typeof payload.attends !== "boolean");
    })
    .map((order) => {
      const title = (order.payload as { title?: unknown } | undefined)?.title;
      return { id: order.id, intent: order.intent, project: names.get(order.projectId) ?? "", title: typeof title === "string" ? title : "" };
    });
}

/**
 * Gives existing tasks their short name (decided 2026-10-08) and reads whether each is going to something at its own time (`attends`,
 * 2026-11-22): the original sentence stays as the description; only `payload.title` (when it has none) and `payload.attends` are added.
 * Up to forty a run, so a large board is read over a few ticks.
 */
export function createTaskTitler(store: CrosslineStore, workspaceId: string, cwd: string, getClient: () => CodexRpcBoundary | undefined) {
  return async function name(): Promise<{ named: number } | { blocked: string }> {
    const client = getClient();
    if (!client) return { blocked: "CODEX_SUPERVISOR_UNAVAILABLE" };
    const tasks = unreadTasks(store, workspaceId).slice(0, 40);
    if (!tasks.length) return { named: 0 };
    const context = { version: "crossline.task-titles.v2", tasks };
    const result = await runCodexSkill<TaskTitles>(client, context, { skillName: TASK_TITLER, cwd,
      developerInstructions: "Give each task the short name shown on its card and calendar block and say whether it is going to something at its own time, "
        + "as the crossline-task-titler Skill describes, and return only the requested JSON: a verb-first action of at most 24 characters that keeps the "
        + "course code and what tells the task apart (a task that already has a title keeps it; return it unchanged), and attends.", outputSchema: TASK_TITLES_SCHEMA, prepareInput: () => context,
      validateOutput: (output) => validateTaskTitles(output, tasks.map((task) => task.id)), onAudit: () => {}, timeoutMs: 20 * 60_000 });
    if (!result.ok) return { blocked: result.blocker.code };
    const orders = new Map(store.listWorkOrders(workspaceId).map((order) => [order.id, order]));
    for (const { id, title, attends } of result.output.titles) {
      const order = orders.get(id);
      if (!order) continue;
      const payload = (order.payload ?? {}) as Record<string, unknown>;
      // A name is added only where there is none: a name the person or another model gave stays.
      const named = !payload.title && title ? { title } : {};
      const read = typeof attends === "boolean" ? { attends } : {};
      if (!Object.keys(named).length && !Object.keys(read).length) continue;
      store.saveWorkOrder({ ...order, payload: { ...payload, ...named, ...read } });
    }
    store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `tasks.titled:${Date.now()}`, type: "tasks.titled", entityId: workspaceId,
      payload: { named: result.output.titles.length } });
    return { named: result.output.titles.length };
  };
}
