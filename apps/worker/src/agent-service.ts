import { homedir } from "node:os";
import path from "node:path";
import { enterUsageWorkspace, type CodexRpcBoundary } from "@crossline/codex";
import { deliverAgentResult, readCategories, requestCategory, type CrosslineStore } from "@crossline/db";
import { AGENT_CATEGORIES, budgetPolicy, isAgentCategory, type AgentCategory, type CostSignal } from "@crossline/core";
import { createAgentRunner, type AgentOutcome } from "./agent-task";
import { dispatchCandidates, ledgerAsk, taskFromWorkOrder } from "./agent-dispatch";

/**
 * The assistant as the rest of the worker sees it: start a work order's task by hand (the button), and start approved ones by itself
 * on the worker's tick. Runs are detached — a task can take an hour, and the calendar sync must not wait for it — and a run's outcome
 * is written to the ledger by the runner, so nothing here has to carry it anywhere.
 */
export type DispatchResult =
  | { state: "started"; taskId: string }
  | { state: "needs_category_approval"; category: AgentCategory; label: string }
  | { state: "blocked"; code: string; message: string };

export const defaultOutputRoot = (): string => process.env.CROSSLINE_AI_OUTPUT_DIR ?? path.join(homedir(), "Crossline", "ai-output");
/** Above this share of either quota window nothing is started by itself; a run already going is left to finish. */
const QUOTA_CEILING_PERCENT = 95;

export function createAgentService(deps: {
  store: CrosslineStore; repoRoot: string; getClient: () => CodexRpcBoundary | undefined; readCost: () => Promise<CostSignal>;
  outputRoot?: string; log?: (event: Record<string, unknown>) => void;
}) {
  const running = new Map<string, Set<string>>();
  const log = deps.log ?? (() => {});
  const mark = (workspaceId: string) => running.get(workspaceId) ?? running.set(workspaceId, new Set()).get(workspaceId)!;

  function start(workspaceId: string, orderId: string, category: AgentCategory | undefined, stepId?: string): DispatchResult {
    const planned = taskFromWorkOrder(deps.store, workspaceId, orderId, category, stepId);
    if (!planned.ok) return { state: "blocked", code: planned.code, message: planned.message };
    if (!planned.category) return { state: "blocked", code: "CATEGORY_REQUIRED", message: "这件事的描述没有明确指向某一类工作，请选一类再交给助手。" };
    const chosen = planned.category;
    if (!readCategories(deps.store, workspaceId)[chosen]) {
      requestCategory(deps.store, workspaceId, chosen, orderId, planned.why);
      return { state: "needs_category_approval", category: chosen, label: AGENT_CATEGORIES[chosen] };
    }
    const taskId = planned.input.taskId!;
    if (mark(workspaceId).has(taskId)) return { state: "started", taskId };
    mark(workspaceId).add(taskId);
    const run = createAgentRunner(deps.store, workspaceId, deps.repoRoot, deps.getClient, {
      outputRoot: deps.outputRoot ?? defaultOutputRoot(), askFor: (id) => ledgerAsk(deps.store, workspaceId, id)
    });
    void (async () => {
      enterUsageWorkspace(workspaceId);
      const outcome: AgentOutcome | { state: "failed"; message: string } = await run({ ...planned.input, category: chosen })
        .catch((error): { state: "failed"; message: string } => ({ state: "failed", message: error instanceof Error ? error.message : "" }));
      // A delegated result the kind's earned trust lets through goes straight to the gate; one that needs review waits for the person.
      const delivered = outcome.state === "done" && !outcome.reviewRequired ? deliverAgentResult(deps.store, workspaceId, taskId) : undefined;
      log({ type: `agent.${outcome.state}`, workspaceId, taskId, ...(outcome.state === "blocked" ? { code: outcome.code } : {}), ...(delivered ? { delivered } : {}) });
    })().finally(() => mark(workspaceId).delete(taskId));
    return { state: "started", taskId };
  }

  return {
    /** The 交给助手 button: the person chose this order (and maybe the kind). */
    dispatch: (workspaceId: string, orderId: string, categoryName?: string, stepId?: string): DispatchResult =>
      start(workspaceId, orderId, categoryName === undefined ? undefined : isAgentCategory(categoryName) ? categoryName : undefined, stepId),

    /** On the tick: at most one new task per workspace, only of an approved kind, only with quota to spare, only when none is going. */
    async pass(workspaceId: string): Promise<void> {
      if (mark(workspaceId).size) return;
      const [orderId] = dispatchCandidates(deps.store, workspaceId);
      if (!orderId) return;
      const signal = await deps.readCost().catch(() => undefined);
      // An unreadable quota is not a reason to stop: the run reports a spent one itself, as a blocked task.
      if (signal?.available && Math.max(signal.short?.usedPercent ?? 0, signal.long?.usedPercent ?? 0) >= QUOTA_CEILING_PERCENT) {
        log({ type: "agent.skipped", workspaceId, code: "QUOTA_LOW", budget: budgetPolicy(Math.max(signal.short?.usedPercent ?? 0, signal.long?.usedPercent ?? 0)).mode });
        return;
      }
      const result = start(workspaceId, orderId, undefined);
      log({ type: "agent.dispatched", workspaceId, orderId, state: result.state });
    },

    runningTasks: (workspaceId: string): string[] => [...mark(workspaceId)]
  };
}
