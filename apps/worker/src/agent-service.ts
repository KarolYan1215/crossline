import { homedir } from "node:os";
import path from "node:path";
import { enterUsageWorkspace, type CodexRpcBoundary } from "@crossline/codex";
import { deliverAgentResult, listAgentTasks, readCategories, requestCategory, type CrosslineStore } from "@crossline/db";
import { AGENT_CATEGORIES, backgroundSpend, isAgentCategory, type AgentCategory, type CostSignal } from "@crossline/core";
import { createAgentRunner, type AgentOutcome } from "./agent-task";
import { autoHandoffCandidates, dispatchCandidates, ledgerAsk, stepDispatchCandidates, taskFromWorkOrder } from "./agent-dispatch";
import { startingWithin } from "./schedule-window";
import { ownerOf } from "./owner";

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
export const AGENT_RUN_LOST = "AGENT_RUN_LOST";
/** The assistant tick starts nothing once either quota window is this full (decided 2026-10-10). */
export const QUOTA_CEILING_PERCENT = 95;

export function createAgentService(deps: {
  store: CrosslineStore; repoRoot: string; getClient: () => CodexRpcBoundary | undefined; readCost: () => Promise<CostSignal>;
  outputRoot?: string; log?: (event: Record<string, unknown>) => void;
  /** The machine owner's workspace; the assistant (a shell on this machine) works for no one else. Absent: everyone (tests). */
  isOwner?: (workspaceId: string) => boolean;
}) {
  const running = new Map<string, Set<string>>();
  // Per task: how to stop it, and what it has done so far (docs/review-2026-10-13.md §6.4: the run is watched and can be stopped).
  const controls = new Map<string, AbortController>();
  const live = new Map<string, { startedAt: string; audit: { commands: Array<{ command: string; status: string; exitCode: number | null }>;
    filesChanged: Array<{ path: string; kind: string }>; searches: string[] } }>();
  const log = deps.log ?? (() => {});
  const mark = (workspaceId: string) => running.get(workspaceId) ?? running.set(workspaceId, new Set()).get(workspaceId)!;

  function start(workspaceId: string, orderId: string, category: AgentCategory | undefined, stepId?: string): DispatchResult {
    if (deps.isOwner && !deps.isOwner(workspaceId))
      return { state: "blocked", code: "AGENT_OWNER_ONLY", message: "这台电脑上的助手只为电脑主人工作；其他账号的任务请本人完成。" };
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
    const control = new AbortController();
    controls.set(taskId, control);
    const run = createAgentRunner(deps.store, workspaceId, deps.repoRoot, deps.getClient, {
      outputRoot: deps.outputRoot ?? defaultOutputRoot(), askFor: (id) => ledgerAsk(deps.store, workspaceId, id),
      signal: control.signal, onLive: (record) => live.set(taskId, record)
    });
    void (async () => {
      enterUsageWorkspace(workspaceId);
      const outcome: AgentOutcome | { state: "failed"; message: string } = await run({ ...planned.input, category: chosen })
        .catch((error): { state: "failed"; message: string } => ({ state: "failed", message: error instanceof Error ? error.message : "" }));
      // A delegated result the kind's earned trust lets through goes straight to the gate; one that needs review waits for the person.
      // A preparation step is done when its run is: the result is material for the person's own steps, waiting in 材料 and 教程.
      // Any other step the system did (handed over by the button or by 「自动交给 Agent」) follows its kind's mode: done here when the
      // kind is trusted on its own checks (自动), otherwise when the person accepts the result on 待确认 (逐次审阅, `reviewAgentTask`).
      const handed = stepId ? deps.store.getStepPlan(workspaceId, orderId)?.steps.find((step) => step.id === stepId) : undefined;
      const prepStep = handed?.executor === "agent" ? handed : undefined;
      if (outcome.state === "done" && handed && (prepStep || !outcome.reviewRequired)) {
        try { deps.store.updateStepProgress(workspaceId, orderId, handed.id, { status: "done" }, deps.store.getWorkspaceOwnerId(workspaceId) ?? "", "agent"); } catch { /* replanned away */ }
      }
      const delivered = outcome.state === "done" && !outcome.reviewRequired && !prepStep ? deliverAgentResult(deps.store, workspaceId, taskId) : undefined;
      log({ type: `agent.${outcome.state}`, workspaceId, taskId, ...(outcome.state === "blocked" ? { code: outcome.code } : {}), ...(delivered ? { delivered } : {}) });
    })().finally(() => { mark(workspaceId).delete(taskId); controls.delete(taskId); live.delete(taskId); });
    return { state: "started", taskId };
  }

  return {
    /** The 交给助手 button: the person chose this order (and maybe the kind). */
    dispatch: (workspaceId: string, orderId: string, categoryName?: string, stepId?: string): DispatchResult =>
      start(workspaceId, orderId, categoryName === undefined ? undefined : isAgentCategory(categoryName) ? categoryName : undefined, stepId),

    /** On the tick: at most one new task per workspace, only of an approved kind, only with quota to spare, only when none is going. */
    async pass(workspaceId: string, now = new Date()): Promise<void> {
      if (mark(workspaceId).size || (deps.isOwner && !deps.isOwner(workspaceId))) return;
      // In order: a step 「自动交给 Agent」 handed over whose block has come up (it is wanted now); preparation steps (what the person's
      // next session is waiting for); whole orders; and, with nothing else waiting, a handed-over step whose block is later this week.
      // Preparation and whole errands only for work starting within two days (docs/review-2026-10-13.md §6.1): results for later work
      // went unread and were stale by the time it came up.
      const soon = startingWithin(deps.store, workspaceId, now);
      const auto = autoHandoffCandidates(deps.store, workspaceId, now);
      const step = auto.due[0] ?? stepDispatchCandidates(deps.store, workspaceId, soon)[0];
      const order = step ? undefined : dispatchCandidates(deps.store, workspaceId, soon)[0];
      const next = step ?? (order ? { orderId: order, stepId: undefined } : auto.early[0]);
      if (!next) return;
      const { orderId, stepId } = next;
      // Its own ceiling (the person's choice, 2026-10-10): it keeps working through economy and stops at 95% of either window, so the
      // last few percent stay for the person's own captures and plans. An unreadable or exhausted quota pauses it like every other
      // background pass. Starting by hand from 待确认 is not gated here.
      const signal = await deps.readCost().catch((error: unknown): CostSignal => ({ available: false, reason: String(error) }));
      const spend = backgroundSpend(signal);
      const used = signal.available ? Math.max(signal.short?.usedPercent ?? 0, signal.long?.usedPercent ?? 0) : 100;
      if (spend.mode === "manual_core_only" || used >= QUOTA_CEILING_PERCENT) {
        log({ type: "agent.skipped", workspaceId, code: spend.blocker?.code ?? "QUOTA_LOW", budget: spend.mode, usedPercent: used });
        return;
      }
      const result = start(workspaceId, orderId, undefined, stepId);
      log({ type: "agent.dispatched", workspaceId, orderId, ...(stepId ? { stepId } : {}), state: result.state });
    },

    runningTasks: (workspaceId: string): string[] => [...mark(workspaceId)],

    /** What a running task has done so far: the last commands, the files it changed, its searches. Undefined once it has ended. */
    progress(workspaceId: string, taskId: string) {
      if (!mark(workspaceId).has(taskId)) return undefined;
      const record = live.get(taskId);
      return { taskId, startedAt: record?.startedAt ?? "", commands: (record?.audit.commands ?? []).slice(-20).map(({ command, status, exitCode }) => ({ command, status, exitCode })),
        files: [...new Set((record?.audit.filesChanged ?? []).map((change) => change.path))].slice(-30), searches: (record?.audit.searches ?? []).slice(-10) };
    },

    /** 「中止」: stops a running task; its result is recorded as stopped by the person and it is not started again by itself. */
    cancel(workspaceId: string, taskId: string): { ok: true } | { ok: false; code: string } {
      const control = controls.get(taskId);
      if (!mark(workspaceId).has(taskId) || !control) return { ok: false, code: "AGENT_TASK_NOT_RUNNING" };
      control.abort();
      return { ok: true };
    },

    /**
     * At startup: a run with no outcome was lost with the process that held it (only one worker runs at a time). It is recorded as
     * lost now rather than shown as 「进行中」 until it ages out after eight hours — and a preparation step lost this way is tried again.
     */
    recoverLost(workspaceId: string): string[] {
      const lost = listAgentTasks(deps.store, workspaceId).filter((task) => task.status === "running" && !mark(workspaceId).has(task.taskId));
      for (const task of lost) {
        deps.store.appendEvent({ ownerId: ownerOf(deps.store, workspaceId), workspaceId, idempotencyKey: `agent:blocked:${task.taskId}`, type: "agent.task.blocked",
          entityId: task.taskId, payload: { taskId: task.taskId, code: AGENT_RUN_LOST, message: "后台进程重启，这次运行中断" } });
      }
      return lost.map((task) => task.taskId);
    }
  };
}
