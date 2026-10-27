import { homedir } from "node:os";
import path from "node:path";
import { enterUsageWorkspace, type CodexRpcBoundary } from "@crossline/codex";
import { agentChainsFor, deliverAgentResult, isPaused, listAgentTasks, readCategories, readGrownSkills, requestAgentRetry, requestCategory, type CrosslineStore } from "@crossline/db";
import { AGENT_CATEGORIES, backgroundSpend, deliverableKey, tFor, isAgentCategory, retryDue, type AgentCategory, type CostSignal } from "@crossline/core";
import { createAgentRunner, salvageStoppedRun, type AgentOutcome, type AgentTaskInput } from "./agent-task";
import type { MailLookup } from "./agent-tools";
import { autoHandoffCandidates, dispatchCandidates, ledgerAsk, ledgerQuestion, retryCandidates, stepDispatchCandidates, taskFromWorkOrder } from "./agent-dispatch";
import { browserProfilesRoot, sayToPerson, startWorkflowRun } from "./workflow-smith";
import { localeOf, tOfWorkspace } from "./locale";
import { ASSISTANT_PREP_HOURS, prepWindow } from "./schedule-window";
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
/**
 * How many assistant runs one account may have going at once (docs/work-split.md §4, the owner's decision of 2026-10-21; it was one).
 * Each still waits for a slot of the model gate, and the tick still stops at the quota ceiling, a pause or the quota saver.
 */
export const ASSISTANT_CONCURRENCY = 2;

export function createAgentService(deps: {
  store: CrosslineStore; repoRoot: string; getClient: () => CodexRpcBoundary | undefined; readCost: () => Promise<CostSignal>;
  /** Assistant runs a workspace may have at once; `ASSISTANT_CONCURRENCY` unless its compute nodes add room (docs/compute-node.md). */
  concurrency?: (workspaceId: string) => number;
  outputRoot?: string; log?: (event: Record<string, unknown>) => void;
  /** The machine owner's workspace; the assistant (a shell on this machine) works for no one else. Absent: everyone (tests). */
  isOwner?: (workspaceId: string) => boolean;
  /**
   * How the assistant works for a workspace (docs/personal-agent.md, 2026-10-19): `shell` on the machine owner's own Codex, `tools` —
   * Crossline's own functions on whatever model serves the account — for everyone else. With this set, `isOwner` no longer turns
   * other accounts away; it only decides the mode.
   */
  modeFor?: (workspaceId: string) => "shell" | "sandbox" | "tools";
  /** For `sandbox`: beside its inputs what it may read, and what it may never read (the server's data and state). */
  sandbox?: { readable: string[]; deny: string[] };
  /** The workspace's own runtime, for a tools-mode run (the shell runs on the owner's `getClient`). */
  clientFor?: (workspaceId: string) => CodexRpcBoundary | undefined;
  /** The person's mailbox, read-only, when connected. */
  mailFor?: (workspaceId: string) => MailLookup | undefined;
}) {
  const running = new Map<string, Set<string>>();
  // Per task: how to stop it, and what it has done so far (docs/review-2026-10-13.md §6.4: the run is watched and can be stopped).
  const controls = new Map<string, AbortController>();
  const live = new Map<string, { startedAt: string; audit: { commands: Array<{ command: string; status: string; exitCode: number | null }>;
    filesChanged: Array<{ path: string; kind: string }>; searches: string[]; plan?: { explanation: string; steps: Array<{ step: string; status: string }> } } }>();
  const log = deps.log ?? (() => {});
  const mark = (workspaceId: string) => running.get(workspaceId) ?? running.set(workspaceId, new Set()).get(workspaceId)!;
  const limitOf = (workspaceId: string) => Math.max(ASSISTANT_CONCURRENCY, deps.concurrency?.(workspaceId) ?? ASSISTANT_CONCURRENCY);
  // What each run started from the board works on, so a second run never takes the same order (or the same deliverable of its project)
  // before the first run's request reaches the ledger, where the candidate lists would see it.
  const working = new Map<string, Map<string, { orderId: string; project: string; deliverable: string }>>();
  const workOf = (workspaceId: string, orderId: string, stepId?: string) => {
    const order = deps.store.listWorkOrders(workspaceId).find((item) => item.id === orderId);
    const step = stepId ? deps.store.getStepPlan(workspaceId, orderId)?.steps.find((item) => item.id === stepId) : undefined;
    return { orderId, project: order?.projectId ?? "", deliverable: deliverableKey(step?.title ?? order?.intent ?? "") };
  };
  const clashes = (workspaceId: string, orderId: string, stepId?: string): boolean => {
    const runs = [...(working.get(workspaceId)?.values() ?? [])];
    if (!runs.length) return false;
    const work = workOf(workspaceId, orderId, stepId);
    return runs.some((run) => run.orderId === orderId || Boolean(work.deliverable) && run.project === work.project && run.deliverable === work.deliverable);
  };
  /** Turned away only where no mode is offered: with `modeFor`, every account has the assistant in one mode or the other. */
  const refused = (workspaceId: string) => !deps.modeFor && deps.isOwner !== undefined && !deps.isOwner(workspaceId);
  const runnerFor = (workspaceId: string, control: AbortController, onLive: Parameters<typeof createAgentRunner>[4]["onLive"]) => {
    const mode = deps.modeFor?.(workspaceId) ?? "shell";
    const mail = mode !== "shell" ? deps.mailFor?.(workspaceId) : undefined;
    // Tools and sandbox modes run on the account's own runtime only: never the owner's (a guest's task must not spend the owner's account).
    return createAgentRunner(deps.store, workspaceId, deps.repoRoot, mode === "shell" ? deps.getClient : () => deps.clientFor?.(workspaceId), {
      outputRoot: deps.outputRoot ?? defaultOutputRoot(), askFor: (id) => ledgerAsk(deps.store, workspaceId, id),
      // A question asked mid-run waits on 待确认 and reaches the phone as well: nobody is watching a background run.
      questionFor: (id, title) => ledgerQuestion(deps.store, workspaceId, id, title, { onAsked: (questionId, questions) =>
        sayToPerson(deps.store, workspaceId, tOfWorkspace(deps.store, workspaceId)("助手在做「{{title}}」时需要本人回答：{{question}}（10 分钟内未回答就按最稳妥的做法继续）",
          { title: title.slice(0, 40), question: questions[0]!.question.slice(0, 160) }),
          "agent_question", questionId, [{ label: tOfWorkspace(deps.store, workspaceId)("去回答"), href: "/approvals#assistant" }]) }),
      signal: control.signal, ...(onLive ? { onLive } : {}), mode, ...(mail ? { mail } : {}), ...(mode === "sandbox" && deps.sandbox ? { sandbox: deps.sandbox } : {})
    });
  };

  function start(workspaceId: string, orderId: string, category: AgentCategory | undefined, stepId?: string, by: "person" | "system" = "system"): DispatchResult {
    const t = tOfWorkspace(deps.store, workspaceId);
    if (refused(workspaceId))
      return { state: "blocked", code: "AGENT_OWNER_ONLY", message: t("这台电脑上的助手只为电脑主人工作；其他账号的任务请本人完成。") };
    const planned = taskFromWorkOrder(deps.store, workspaceId, orderId, category, stepId);
    if (!planned.ok) return { state: "blocked", code: planned.code, message: planned.message };
    if (!planned.category) return { state: "blocked", code: "CATEGORY_REQUIRED", message: t("这件事的描述没有明确指向某一类工作，请选一类再交给助手。") };
    const chosen = planned.category;
    if (!readCategories(deps.store, workspaceId)[chosen]) {
      requestCategory(deps.store, workspaceId, chosen, orderId, planned.why);
      return { state: "needs_category_approval", category: chosen, label: AGENT_CATEGORIES[chosen] };
    }
    const taskId = planned.input.taskId!;
    if (mark(workspaceId).has(taskId)) return { state: "started", taskId };
    mark(workspaceId).add(taskId);
    (working.get(workspaceId) ?? working.set(workspaceId, new Map()).get(workspaceId)!).set(taskId, workOf(workspaceId, orderId, stepId));
    const control = new AbortController();
    controls.set(taskId, control);
    const run = runnerFor(workspaceId, control, (record) => live.set(taskId, record));
    void (async () => {
      enterUsageWorkspace(workspaceId);
      const outcome: AgentOutcome | { state: "failed"; message: string } = await run({ ...planned.input, category: chosen, by })
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
      // Taken as accepted by itself (nothing for the person to do, allow or judge): the person is told what was made and where it is.
      if (outcome.state === "done" && !outcome.reviewRequired) {
        try { tellAccepted(workspaceId, taskId, planned.input.title, orderId, outcome); } catch { /* the message is a courtesy */ }
      }
      if (outcome.state === "done") tellWhatItFound(workspaceId, taskId, planned.input.title, outcome);
      log({ type: `agent.${outcome.state}`, workspaceId, taskId, ...(outcome.state === "blocked" ? { code: outcome.code } : {}), ...(delivered ? { delivered } : {}) });
    })().finally(() => { mark(workspaceId).delete(taskId); working.get(workspaceId)?.delete(taskId); controls.delete(taskId); live.delete(taskId); });
    return { state: "started", taskId };
  }

  // Results taken without review since the last pass, said to the person together (the owner's choice, 2026-10-15: one message per
  // pass listing what was finished and where each is; no daily digest).
  const accepted = new Map<string, Array<{ taskId: string; title: string; orderId: string; files: string[]; directory: string }>>();
  function tellAccepted(workspaceId: string, taskId: string, title: string, orderId: string, outcome: Extract<AgentOutcome, { state: "done" }>): void {
    accepted.set(workspaceId, [...(accepted.get(workspaceId) ?? []), { taskId, title, orderId, files: outcome.artifacts.map((artifact) => artifact.path), directory: outcome.directory }]);
  }
  /** One message for every result accepted since the last pass: what each was, what it made, where it is. */
  function sayAccepted(workspaceId: string, now: Date): void {
    const done = accepted.get(workspaceId) ?? [];
    if (!done.length) return;
    accepted.delete(workspaceId);
    const locale = localeOf(deps.store, workspaceId);
    const t = tFor(locale);
    const line = (item: (typeof done)[number]) => {
      const list = (files: string[]) => locale === "en" ? files.join(", ") : files.join("、");
      const files = item.files.length > 3 ? t("{{files}} 等 {{count}} 个文件", { files: list(item.files.slice(0, 3)), count: item.files.length }) : list(item.files);
      const title = item.title.length > 40 ? `${item.title.slice(0, 40)}…` : item.title;
      return files ? t("「{{title}}」：{{files}}，放在 {{directory}}", { title, files, directory: item.directory })
        : t("「{{title}}」，放在 {{directory}}", { title, directory: item.directory });
    };
    const text = done.length === 1 ? t("助手做好了{{item}}。自检全部通过、没有需要本人处理的事，已直接采纳。", { item: line(done[0]!) })
      : t("助手做好了 {{count}} 件事，自检全部通过、没有需要本人处理的事，已直接采纳：", { count: done.length }) + `\n${done.map((item, i) => `${i + 1}. ${line(item)}`).join("\n")}`;
    const orders = [...new Set(done.map((item) => item.orderId).filter(Boolean))];
    sayToPerson(deps.store, workspaceId, text, "agent_accepted", `accepted:${done.map((item) => item.taskId).join(",")}`,
      [{ label: t("查看", { context: "view" }), href: orders.length === 1 ? `/workbench/${encodeURIComponent(orders[0]!)}` : "/approvals#assistant" }], now);
  }

  /** A tools-mode run's own words to the person (`tell_person`) and what it put in the inbox, said once when it finishes. */
  function tellWhatItFound(workspaceId: string, taskId: string, title: string, outcome: Extract<AgentOutcome, { state: "done" }>): void {
    const told = outcome.told ?? [], captured = outcome.captured ?? [];
    if (!told.length && !captured.length) return;
    const locale = localeOf(deps.store, workspaceId);
    const t = tFor(locale);
    const shown = title.length > 40 ? `${title.slice(0, 40)}…` : title;
    const text = [...told.map((line) => t("助手在「{{title}}」里提醒：{{line}}", { title: shown, line })),
      ...(captured.length ? [t("助手在「{{title}}」里记下 {{count}} 件待办，已放进收件箱：{{items}}", { title: shown, count: captured.length, items: captured.join(locale === "en" ? "; " : "；") })] : [])].join("\n");
    try { sayToPerson(deps.store, workspaceId, text, "agent_told", `told:${taskId}`, [{ label: t("查看", { context: "view" }), href: "/" }], new Date()); } catch { /* a courtesy */ }
  }

  function runFree(workspaceId: string, input: AgentTaskInput & { taskId: string }, after?: (outcome: AgentOutcome | { state: "failed"; message: string }) => void): DispatchResult {
    const t = tOfWorkspace(deps.store, workspaceId);
    if (refused(workspaceId))
      return { state: "blocked", code: "AGENT_OWNER_ONLY", message: t("这台电脑上的助手只为电脑主人工作。") };
    if (!readCategories(deps.store, workspaceId)[input.category]) return { state: "needs_category_approval", category: input.category, label: AGENT_CATEGORIES[input.category] };
    if (mark(workspaceId).size >= limitOf(workspaceId)) return { state: "blocked", code: "AGENT_BUSY", message: t("助手正在做别的事。") };
    mark(workspaceId).add(input.taskId);
    const control = new AbortController();
    controls.set(input.taskId, control);
    const run = runnerFor(workspaceId, control, (record) => live.set(input.taskId, record));
    void (async () => {
      enterUsageWorkspace(workspaceId);
      const outcome = await run(input).catch((error): { state: "failed"; message: string } => ({ state: "failed", message: error instanceof Error ? error.message : "" }));
      if (outcome.state === "done") tellWhatItFound(workspaceId, input.taskId, input.title, outcome);
      try { after?.(outcome); } catch (error) { log({ type: "agent.after_failed", workspaceId, taskId: input.taskId, message: error instanceof Error ? error.message : "" }); }
      log({ type: `agent.${outcome.state}`, workspaceId, taskId: input.taskId });
    })().finally(() => { mark(workspaceId).delete(input.taskId); controls.delete(input.taskId); live.delete(input.taskId); });
    return { state: "started", taskId: input.taskId };
  }

  /** A grown workflow's run whose next run is due again (interrupted, or asked for by the person): the workflow and the chain. */
  function flowRetry(workspaceId: string, now: Date) {
    const records = readGrownSkills(deps.store, workspaceId).filter((record) => record.status === "active");
    for (const chain of agentChainsFor(deps.store, workspaceId, now)) {
      if (chain.latest.workOrderId || !chain.latest.taskId.startsWith("flow-") || !retryDue(chain, now)) continue;
      const record = records.find((item) => chain.latest.taskId.startsWith(`flow-${item.id.replace(/^flow-/, "")}-`));
      if (record) return { record, chain };
    }
    return undefined;
  }

  /** Whether the assistant may start background work now: its own ceiling (95% of either window), and a readable quota. */
  async function quotaAllows(workspaceId: string): Promise<boolean> {
    const signal = await deps.readCost().catch((error: unknown): CostSignal => ({ available: false, reason: String(error) }));
    const spend = backgroundSpend(signal, localeOf(deps.store, workspaceId));
    const used = signal.available ? Math.max(signal.short?.usedPercent ?? 0, signal.long?.usedPercent ?? 0) : 100;
    if (spend.mode === "manual_core_only" || used >= QUOTA_CEILING_PERCENT) {
      log({ type: "agent.skipped", workspaceId, code: spend.blocker?.code ?? "QUOTA_LOW", budget: spend.mode, usedPercent: used });
      return false;
    }
    return true;
  }

  const api = {
    /** The 交给助手 button: the person chose this order (and maybe the kind). */
    dispatch: (workspaceId: string, orderId: string, categoryName?: string, stepId?: string): DispatchResult =>
      start(workspaceId, orderId, categoryName === undefined ? undefined : isAgentCategory(categoryName) ? categoryName : undefined, stepId, "person"),

    /**
     * The person asks for another run of a task (`POST /api/agent/tasks/<id>/retry`, or an answer on 待确认): their words and the items to
     * redo are recorded for the next run, which starts now when the assistant is free, not paused and the quota allows — otherwise at a
     * later tick, under the same rules. A workflow being grown is picked up by the workflow pass.
     */
    async retry(workspaceId: string, taskId: string, input: { note?: string; only?: string[] }, now = new Date()):
      Promise<{ ok: true; state: "started" | "queued"; message: string } | { ok: false; code: string; message: string }> {
      const t = tOfWorkspace(deps.store, workspaceId);
      if (refused(workspaceId)) return { ok: false, code: "AGENT_OWNER_ONLY", message: t("这台电脑上的助手只为电脑主人工作。") };
      if (mark(workspaceId).has(taskId)) return { ok: false, code: "TASK_RUNNING", message: t("这个任务正在运行。") };
      const recorded = requestAgentRetry(deps.store, workspaceId, taskId, input, now);
      if (!recorded.ok) return { ok: false, code: recorded.code, message: recorded.code === "TASK_NOT_FOUND" ? t("找不到这个助手任务。") : t("这个任务正在运行。") };
      if (isPaused(deps.store, workspaceId)) return { ok: true, state: "queued", message: t("助手已暂停；恢复后按本人的说明重做。") };
      if (mark(workspaceId).size >= limitOf(workspaceId)) return { ok: true, state: "queued", message: t("助手正在做别的事；做完后按本人的说明重做。") };
      if (!(await quotaAllows(workspaceId))) return { ok: true, state: "queued", message: t("额度紧张；额度恢复后按本人的说明重做。") };
      // A clock read after the request was written: the request is due from the moment it was recorded.
      const before = mark(workspaceId).size;
      await api.pass(workspaceId, new Date(Math.max(now.getTime(), Date.now())), { quotaChecked: true });
      return mark(workspaceId).size > before ? { ok: true, state: "started", message: t("已按本人的说明重新开始。") } : { ok: true, state: "queued", message: t("已记下；稍后按本人的说明重做。") };
    },

    /**
     * On the tick: new tasks until `ASSISTANT_CONCURRENCY` run in the workspace, only of an approved kind, only with quota to spare,
     * never on an order a running task already works on (`clashes`).
     */
    async pass(workspaceId: string, now = new Date(), options: { quotaChecked?: boolean } = {}): Promise<void> {
      try { sayAccepted(workspaceId, now); } catch { /* the message is a courtesy */ }
      if (refused(workspaceId)) return;
      let quotaChecked = options.quotaChecked ?? false;
      let flowTried = false;
      // Tried in this pass already: a candidate that did not start (a kind to ask about, an order the store refused) is not taken again.
      const tried = new Set<string>();
      const open = (candidate: { orderId: string; stepId?: string | undefined }) =>
        !tried.has(`${candidate.orderId}#${candidate.stepId ?? ""}`) && !clashes(workspaceId, candidate.orderId, candidate.stepId);
      while (mark(workspaceId).size < limitOf(workspaceId)) {
        // In order: a step 「自动交给 Agent」 handed over whose block has come up (it is wanted now); preparation steps (what the person's
        // next session is waiting for); whole orders; and, with nothing else waiting, a handed-over step whose block is later this week.
        // Preparation and whole errands only within two days of the person's step they serve (docs/work-split.md §4, `prepWindow`):
        // results for later work went unread and were stale by the time it came up.
        const soon = prepWindow(deps.store, workspaceId, now, ASSISTANT_PREP_HOURS);
        // Work that was interrupted (or that the person asked to redo) goes first: it was already under way.
        const retry = retryCandidates(deps.store, workspaceId, now, soon).find(open);
        const flow = retry || flowTried || isPaused(deps.store, workspaceId) ? undefined : flowRetry(workspaceId, now);
        const auto = autoHandoffCandidates(deps.store, workspaceId, now);
        const step = retry ? undefined : auto.due.find(open) ?? stepDispatchCandidates(deps.store, workspaceId, soon.steps, now).find(open);
        const order = retry || step ? undefined : dispatchCandidates(deps.store, workspaceId, soon.orders, now).find((orderId) => open({ orderId }));
        const next = retry ?? step ?? (order ? { orderId: order, stepId: undefined } : auto.early.find(open));
        if (!next && !flow) return;
        // Its own ceiling (the person's choice, 2026-10-10): it keeps working through economy and stops at 95% of either window, so the
        // last few percent stay for the person's own captures and plans. An unreadable or exhausted quota pauses it like every other
        // background pass. Starting by hand from 待确认 is not gated here.
        if (!quotaChecked) {
          if (!(await quotaAllows(workspaceId))) return;
          quotaChecked = true;
        }
        if (!next && flow) {
          flowTried = true;
          const result = startWorkflowRun(deps.store, workspaceId, flow.record, (input, after) => runFree(workspaceId, { ...input, by: flow.chain.byPerson ? "person" : "system" }, after),
            browserProfilesRoot(workspaceId), now);
          log({ type: "agent.retried_workflow", workspaceId, id: flow.record.id, state: result.state });
          continue;
        }
        const { orderId, stepId } = next!;
        tried.add(`${orderId}#${stepId ?? ""}`);
        const result = start(workspaceId, orderId, undefined, stepId, retry?.chain.byPerson ? "person" : "system");
        log({ type: retry ? "agent.retried" : "agent.dispatched", workspaceId, orderId, ...(stepId ? { stepId } : {}), state: result.state });
      }
    },

    /**
     * A run tied to no work order — a workflow being grown, or a grown workflow's scheduled run (docs/skills-library.md §6): the same
     * owner-only, `ASSISTANT_CONCURRENCY`-at-a-time, approved-kinds-only machinery as an order's, with `after` told how it ended. A busy assistant or a kind
     * the person has not allowed is refused, and the caller tries again later.
     */
    runFree(workspaceId: string, input: AgentTaskInput & { taskId: string }, after?: (outcome: AgentOutcome | { state: "failed"; message: string }) => void): DispatchResult {
      return runFree(workspaceId, input, after);
    },

    runningTasks: (workspaceId: string): string[] => [...mark(workspaceId)],

    /** What a running task has done so far: the last commands, the files it changed, its searches. Undefined once it has ended. */
    progress(workspaceId: string, taskId: string) {
      if (!mark(workspaceId).has(taskId)) return undefined;
      const record = live.get(taskId);
      return { taskId, startedAt: record?.startedAt ?? "", commands: (record?.audit.commands ?? []).slice(-20).map(({ command, status, exitCode }) => ({ command, status, exitCode })),
        files: [...new Set((record?.audit.filesChanged ?? []).map((change) => change.path))].slice(-30), searches: (record?.audit.searches ?? []).slice(-10),
        ...(record?.audit.plan ? { plan: record.audit.plan } : {}) };
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
    /**
     * At startup: a run stopped in the last day (by the person, a stall or a restart) that left files of its own, and was not yet offered
     * for review, goes to 待确认 as an unfinished result (`salvageStoppedRun`).
     */
    salvageStopped(workspaceId: string, now = new Date()): string[] {
      return listAgentTasks(deps.store, workspaceId, now).filter((task) => task.status === "blocked" && now.getTime() - Date.parse(task.requestedAt) < 86_400_000)
        .filter((task) => salvageStoppedRun(deps.store, workspaceId, task.taskId, deps.outputRoot ?? defaultOutputRoot(), now)).map((task) => task.taskId);
    },

    recoverLost(workspaceId: string): string[] {
      const lost = listAgentTasks(deps.store, workspaceId).filter((task) => task.status === "running" && !mark(workspaceId).has(task.taskId));
      for (const task of lost) {
        deps.store.appendEvent({ ownerId: ownerOf(deps.store, workspaceId), workspaceId, idempotencyKey: `agent:blocked:${task.taskId}`, type: "agent.task.blocked",
          entityId: task.taskId, payload: { taskId: task.taskId, code: AGENT_RUN_LOST, message: tOfWorkspace(deps.store, workspaceId)("后台进程重启，这次运行中断"),
            directory: path.join(deps.outputRoot ?? defaultOutputRoot(), task.taskId) } });
      }
      return lost.map((task) => task.taskId);
    }
  };
  return api;
}
