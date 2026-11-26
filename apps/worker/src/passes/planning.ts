// Split out of index.ts (move only). The worker's singletons (store, supervisor, services) stay in index.ts, which runs the
// side effects in order; this module reads them from `../index` only inside functions, after index.ts has set them up.
import { accountConcurrency, enterUsageWorkspace, forgetAccountModels, withUsagePurpose } from "@crossline/codex";
import { settleLinkNeeds, interviewChecklistFor, startConfirmedFor } from "@crossline/db";
import { capturesAwaitingAutoAnalysis } from "../analysis";
import { NEEDS_PER_PASS, createNeedChecker, needsAwaitingCheck } from "../need-check";
import { sponsorOffPeak, FIRST_DRAFTS_SETTING, readyToStart, spendAllows, NON_CORE_PURPOSE } from "@crossline/core";
import { assumeAtNeededDay, requestGranularityReplans, createProgressJudge, createStepPlanner, createWarningReviewer, reportsAwaitingJudgement, requestFinerSplits, requestOutdatedReplans, settleOldQuestions, tasksAwaitingStepPlan, warningsAwaitingReview } from "../step-planner";
import { createArchetypeCurator, curationDue } from "../archetype-curator";
import { createTaskTitler, unreadTasks } from "../task-titler";
import { todayFor } from "../opportunities";
import { createGoalSplitter, linesAwaitingCandidateSplit, linesAwaitingSplit } from "../goal-splitter";
import { createMilestoneRiskReviewer, milestonesAwaitingRiskReview } from "../milestone-risk-review";
import { materializeDatePairs, releaseWaits, settleHomeworkNeeds } from "../date-pairs";
import { createMilestoneProposer, createRelationReviser } from "../milestone-proposer";
import { createGoalBackplanner, milestonesAwaitingBackplan } from "../goal-backplanner";
import { createOnboardingExtractor, EXTRACT_LANES, extractionRunning, requestExtraction } from "../onboarding-extract";
import { runScaleAnalysis, scaleAnalysisOwed } from "../scale-analysis";
import { ownerOf } from "../owner";
import { identityLines } from "../lines";
import { nonCoreAllowed } from "../spend";
import { accountClient, analysisStore, codexSupervisor, getCaptureAnalyzer, heldForEval, mailService, modelProviders, paused, readCost, repoRoot, spendFor, workspaceConcurrency } from "../index";

/**
 * Classifies the workspace's new captures. Run by the tick and, right after a capture is written, by the web app — so the person
 * does not wait up to a tick (fifteen minutes) for something the system already knows how to do. One pass per workspace at a time.
 */
const autoAnalyzing = new Set<string>();
export async function autoAnalyzePass(workspaceId: string, checkedAt = new Date().toISOString()): Promise<void> {
  if (paused(workspaceId, "intake")) return;
  if (!codexSupervisor || autoAnalyzing.has(workspaceId)) return;
  autoAnalyzing.add(workspaceId);
  try {
    const ids = capturesAwaitingAutoAnalysis(analysisStore, workspaceId);
    if (!ids.length) return;
    if (!spendAllows(await spendFor(workspaceId), "intake")) return;
    // Started on use: a guest's runtime that went idle is started again (an invited account's quota is read from the ledger and never
    // starts it, so the old 「started by the quota read」 left its captures waiting); none means not connected, and that was just recorded.
    const client = accountClient(workspaceId);
    if (!client) return;
    enterUsageWorkspace(workspaceId);
    for (const id of ids) {
      const outcome = await getCaptureAnalyzer(workspaceId)(client, id).catch(() => undefined);
      if (outcome) console.info(JSON.stringify({ type: `analysis.auto.${outcome.state}`, checkedAt, workspaceId, captureId: id }));
    }
    // A proposal that took effect by default is planned into steps now, not at the next tick.
    void stepPlanPass(workspaceId).catch(() => {});
  } finally { autoAnalyzing.delete(workspaceId); }
}

/** Runs `work` over `items`, at most `limit` at a time: an account's background share of the model gate (model-gate.ts). */
async function eachLimited<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) await work(items[next++]!);
  }));
}

/**
 * Whether this account's work nobody waits on should wait for the developer's model's cheaper hours (Beijing 02–08, `sponsorOffPeak`):
 * only accounts that run on that model; an account on its own ChatGPT or provider is not billed by the hour.
 */
export function waitsForOffPeak(workspaceId: string, now = new Date()): boolean {
  return modelProviders.routing(workspaceId)?.provider.id === "sponsor" && !sponsorOffPeak(now);
}

/**
 * Works backwards from approved milestones due within three weeks that nothing serves yet. Run by the tick
 * and, right after the person approves a line's drafts, by the web app — so the week fills in at once.
 */
const autoBackplanning = new Set<string>();
export async function autoBackplanPass(workspaceId: string, checkedAt = new Date().toISOString()): Promise<void> {
  if (paused(workspaceId, "planning")) return;
  if (!codexSupervisor || autoBackplanning.has(workspaceId)) return;
  autoBackplanning.add(workspaceId);
  try {
    let ids = milestonesAwaitingBackplan(analysisStore, workspaceId);
    if (!ids.length) return;
    if (!spendAllows(await spendFor(workspaceId), "core")) return;
    enterUsageWorkspace(workspaceId);
    const backplan = createGoalBackplanner(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId), { rolling: true });
    // Batch after batch rather than three a tick: approving twelve milestones left nine of them for the next ticks, and each milestone's
    // tasks get their steps as soon as they exist instead of after the whole batch (2026-10-17 walkthrough, W-28).
    const tried = new Set<string>();
    while (ids.length) {
      // Two milestones at a time (the account's share of the gate): each one's tasks are written as soon as its run ends, and the
      // duplicate check runs at that write, so a task the other run just wrote is still caught.
      await eachLimited(ids, workspaceConcurrency(workspaceId), async (id) => {
        tried.add(id);
        const outcome = await backplan(id).catch(() => undefined);
        if (outcome) console.info(JSON.stringify({ type: `backplan.auto.${outcome.state}`, checkedAt, workspaceId, milestoneId: id }));
        void stepPlanPass(workspaceId).catch(() => {});
      });
      if (paused(workspaceId, "planning") || !spendAllows(await spendFor(workspaceId), "core")) break;
      // A milestone that failed in a way the timer retries (a runtime error) comes back here: it waits for the tick, not this loop.
      ids = milestonesAwaitingBackplan(analysisStore, workspaceId).filter((id) => !tried.has(id));
    }
  } finally { autoBackplanning.delete(workspaceId); }
}

/**
 * The archetype curator, on the person's period (or after twenty new preferences), only with a normal budget. Its run is long and
 * web-backed, so it never shares a tick with another curation for the same workspace.
 */
const curating = new Set<string>();
export async function curatorPass(workspaceId: string, checkedAt: string): Promise<void> {
  if (paused(workspaceId, "planning")) return;
  if (curating.has(workspaceId) || !codexSupervisor || !curationDue(analysisStore, workspaceId)) return;
  if (!nonCoreAllowed(analysisStore, workspaceId, await spendFor(workspaceId), "discretionary")) return;
  curating.add(workspaceId);
  try {
    enterUsageWorkspace(workspaceId);
    const outcome = await withUsagePurpose(NON_CORE_PURPOSE, () => createArchetypeCurator(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId))()).catch(() => undefined);
    if (outcome) console.info(JSON.stringify({ type: "archetypes.curated", checkedAt, workspaceId, added: outcome.added.length, dropped: outcome.dropped.length }));
  } finally { curating.delete(workspaceId); }
}

/** Names tasks written before short names existed and reads whether each is going to something (`attends`), a batch a tick, while the quota is normal. */
const titling = new Set<string>();
export async function titlePass(workspaceId: string, checkedAt: string): Promise<void> {
  if (paused(workspaceId, "planning")) return;
  if (titling.has(workspaceId) || !codexSupervisor || !unreadTasks(analysisStore, workspaceId).length) return;
  if (!spendAllows(await spendFor(workspaceId), "discretionary")) return;
  titling.add(workspaceId);
  try {
    enterUsageWorkspace(workspaceId);
    const outcome = await createTaskTitler(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId))().catch(() => undefined);
    if (outcome) console.info(JSON.stringify({ type: "tasks.titled", checkedAt, workspaceId, ...outcome }));
  } finally { titling.delete(workspaceId); }
}

/**
 * Splits long-term goals adopted as whole sentences into attributes (§4.1), once per goal; a small model, so it runs unless the quota is
 * down to core work. Also run on request (`POST /v1/lines/split-goals`).
 */
const splittingGoals = new Set<string>();
export async function goalSplitPass(workspaceId: string, checkedAt = new Date().toISOString()): Promise<void> {
  if (paused(workspaceId, "planning")) return;
  if (splittingGoals.has(workspaceId) || !codexSupervisor
    || (!linesAwaitingSplit(analysisStore, workspaceId).length && !linesAwaitingCandidateSplit(analysisStore, workspaceId).length)) return;
  if (!spendAllows(await spendFor(workspaceId), "core")) return;
  splittingGoals.add(workspaceId);
  try {
    enterUsageWorkspace(workspaceId);
    const outcome = await createGoalSplitter(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId))().catch(() => undefined);
    if (outcome) console.info(JSON.stringify({ type: "lines.goals_split", checkedAt, workspaceId, ...outcome }));
  } finally { splittingGoals.delete(workspaceId); }
}

/**
 * Reads new milestone drafts critically for what could keep them from being reached (`crossline-milestone-risk-reviewer`), once per
 * draft as drafted: after every architect run and on the tick. Part of designing milestones, so it runs while the quota allows core work.
 */
const reviewingRisks = new Set<string>();
export async function milestoneRiskPass(workspaceId: string, checkedAt = new Date().toISOString()): Promise<void> {
  if (paused(workspaceId, "planning") || reviewingRisks.has(workspaceId) || !codexSupervisor) return;
  if (!milestonesAwaitingRiskReview(analysisStore, workspaceId).length) return;
  if (!spendAllows(await spendFor(workspaceId), "core")) return;
  reviewingRisks.add(workspaceId);
  try {
    enterUsageWorkspace(workspaceId);
    const outcome = await createMilestoneRiskReviewer(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId))().catch(() => undefined);
    if (outcome) console.info(JSON.stringify({ type: "milestones.risk_reviewed", checkedAt, workspaceId, ...outcome }));
  } finally { reviewingRisks.delete(workspaceId); }
}

/**
 * The first milestone drafts, made once the start standard holds and the account has no milestone yet. Before this the person reached
 * Today with 「暂无可执行任务」 and nothing said that the next step was a button inside the interview (2026-10-15 walkthrough). Drafts take
 * effect only when approved on 主线, so designing them unasked costs a run and decides nothing. Once per account (`milestones.firstDrafts`).
 */
const draftingFirst = new Set<string>();
const FIRST_DRAFTS_RETRY_SETTING = "milestones.firstDrafts.retryAt";
export async function firstDraftsPass(workspaceId: string, checkedAt = new Date().toISOString()): Promise<void> {
  if (paused(workspaceId, "planning") || draftingFirst.has(workspaceId) || !codexSupervisor) return;
  if (analysisStore.getSetting(workspaceId, FIRST_DRAFTS_SETTING) || analysisStore.listMilestones(workspaceId).length) return;
  const retryAt = analysisStore.getSetting(workspaceId, FIRST_DRAFTS_RETRY_SETTING);
  if (retryAt && Date.parse(retryAt) > Date.parse(checkedAt)) return;
  const lines = identityLines(analysisStore, workspaceId).map((line) => ({ id: line.id, label: line.label, hard: Boolean(line.hard), goals: line.goals ?? [] }));
  if (!lines.length || !readyToStart(interviewChecklistFor(analysisStore, workspaceId, lines, { unfiledFiles: null }))) return;
  // Drafts rest on what the person confirmed before using the app (2026-10-19): not on facts they have not looked over yet.
  if (!startConfirmedFor(analysisStore, workspaceId)) return;
  // Not while the person is still in the interview: the architect runs in the interview's lane, and a round waited behind it for a
  // quarter of an hour (2026-10-15 walkthrough). Once the interview is complete, or nobody has answered in twenty minutes.
  const session = analysisStore.getLatestOnboardingSession(workspaceId);
  const lastSaid = session ? analysisStore.listOnboardingMessages(workspaceId, session.id).at(-1)?.createdAt : undefined;
  if (session?.state !== "complete" && lastSaid && Date.parse(checkedAt) - Date.parse(lastSaid) < 20 * 60_000) return;
  if (!spendAllows(await spendFor(workspaceId), "core")) return;
  draftingFirst.add(workspaceId);
  analysisStore.setSetting(workspaceId, FIRST_DRAFTS_SETTING, checkedAt);
  try {
    enterUsageWorkspace(workspaceId);
    const outcome = await createMilestoneProposer(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId))("", undefined).catch(() => undefined);
    console.info(JSON.stringify({ type: "milestones.first_drafts", checkedAt, workspaceId, state: outcome?.state ?? "failed",
      ...(outcome?.state === "blocked" ? { code: outcome.code } : {}) }));
    // A run that made nothing is tried again in half an hour: the start mark used to stay, so a run blocked once (a runtime that had
    // gone idle) was never retried and the screens said 「正在设计」 for good (2026-10-19).
    if (!analysisStore.listMilestones(workspaceId).length) {
      analysisStore.deleteSetting(workspaceId, FIRST_DRAFTS_SETTING);
      analysisStore.setSetting(workspaceId, FIRST_DRAFTS_RETRY_SETTING, new Date(Date.now() + 30 * 60_000).toISOString());
    }
  } finally { draftingFirst.delete(workspaceId); }
  void milestoneRiskPass(workspaceId).catch(() => undefined);
}

/** Starts the interview's extraction when one of the workspace's conversations has replies or files waiting and is due (not backing off). */
export async function onboardingExtractPass(workspaceId: string): Promise<void> {
  if (!codexSupervisor || paused(workspaceId, "planning")) return;
  // The scale's analysis (2026-11-22, scale-analysis.ts): owed once the person says the scale is done; core work like the extraction.
  if (scaleAnalysisOwed(analysisStore, workspaceId) && spendAllows(await spendFor(workspaceId), "core")) {
    enterUsageWorkspace(workspaceId); void runScaleAnalysis(analysisStore, workspaceId, repoRoot, accountClient(workspaceId)).catch(() => undefined);
  }
  // The start-on-use handle: a guest's runtime that went idle after the reply is started again, or the retry fails for want of a client.
  const extractor = createOnboardingExtractor(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId));
  // Each lane on its own (the ledger, the portrait's sections and its inferences): one that is running or has nothing due is left alone.
  const due = EXTRACT_LANES.filter((lane) => !extractionRunning(workspaceId, lane) && extractor.nextSession([], lane));
  if (!due.length) return;
  // A turn starts its own extraction whatever the quota says (the person is there); a retry from the tick is core work like any other.
  if (!spendAllows(await spendFor(workspaceId), "core")) return;
  for (const lane of due) {
    const done = requestExtraction(workspaceId, (preferred) => { enterUsageWorkspace(workspaceId); return extractor.runOnce(preferred, lane); }, undefined, lane);
    if (lane === "ledger") void done.then(() => { void firstDraftsPass(workspaceId).catch(() => undefined); });
  }
}

/**
 * A guest just connected its model (W-11). The quota is read again, which clears the 「后台自动工作已暂停」 written by a tick that ran before
 * the login, and the passes that were waiting on a model run now: a capture typed meanwhile, approved milestones, the first drafts.
 */
export async function afterConnected(workspaceId: string): Promise<void> {
  console.info(JSON.stringify({ type: "runtime.connected", workspaceId }));
  // Another account may be on another plan, with other models.
  forgetAccountModels(workspaceId);
  await spendFor(workspaceId).catch(() => undefined);
  // Information first: mail held back while no model could sort it is sorted now (its to-dos become captures for the analysis below).
  await mailService.pass(workspaceId).catch(() => undefined);
  await autoAnalyzePass(workspaceId).catch(() => undefined);
  void autoBackplanPass(workspaceId).catch(() => undefined);
  void firstDraftsPass(workspaceId).catch(() => undefined);
}

/**
 * Turns confirmed course dates into tasks, gives every committed task a step plan (the migration of existing tasks is this same pass,
 * two a tick), and has a reviewer look at plans the mechanical checks flagged. Quota-gated like the other model passes.
 */
const stepPlanning = new Set<string>();
/** Asked for while a pass was running: run once more when it ends, so a task approved mid-pass is not left for the next tick. */
const stepPlanAgain = new Set<string>();
export async function stepPlanPass(workspaceId: string, checkedAt = new Date().toISOString()): Promise<void> {
  if (stepPlanning.has(workspaceId)) { stepPlanAgain.add(workspaceId); return; }
  stepPlanning.add(workspaceId);
  try {
    try {
      const created = materializeDatePairs(analysisStore, workspaceId);
      if (created.length) console.info(JSON.stringify({ type: "datepair.created", checkedAt, workspaceId, created }));
      const release = releaseWaits(analysisStore, workspaceId);
      if (release.opened.length || release.arrived.length) console.info(JSON.stringify({ type: "datepair.release_waits", checkedAt, workspaceId, ...release }));
      const homework = settleHomeworkNeeds(analysisStore, workspaceId);
      if (homework.length) console.info(JSON.stringify({ type: "datepair.homework_provided", checkedAt, workspaceId, settled: homework }));
    } catch (error) { console.info(JSON.stringify({ type: "datepair.failed", checkedAt, workspaceId, message: error instanceof Error ? error.message : "" })); }
    // Questions the planner did not mark worth asking (and every question of a plan written before it could) are settled as assumptions;
    // an asked one still unanswered on the day its step needs it is settled too, and the person told (§7.1). No model call.
    try {
      const settled = settleOldQuestions(analysisStore, workspaceId);
      if (settled.length) console.info(JSON.stringify({ type: "step_questions.assumed", checkedAt, workspaceId, settled }));
      const late = assumeAtNeededDay(analysisStore, workspaceId, todayFor(analysisStore, workspaceId, new Date(checkedAt)));
      if (late.length) console.info(JSON.stringify({ type: "step_questions.assumed_at_needed_day", checkedAt, workspaceId, settled: late }));
    } catch { /* next tick */ }
    // A step that did not get done on two days is planned again smaller: rules only, picked up below like any replan.
    try {
      const splits = requestFinerSplits(analysisStore, workspaceId);
      if (splits.length) console.info(JSON.stringify({ type: "steps.finer_split_requested", checkedAt, workspaceId, splits }));
    } catch { /* next tick */ }
    // Once per workspace: every open plan with several person's steps is planned again at deliverable granularity (2026-11-20).
    try {
      const regrained = requestGranularityReplans(analysisStore, workspaceId);
      if (regrained.length) console.info(JSON.stringify({ type: "steps.granularity_replan_requested", checkedAt, workspaceId, orders: regrained }));
    } catch { /* next tick */ }
    // A plan written before first actions and AI assists were required is planned again once its work is a week away.
    try {
      const outdated = requestOutdatedReplans(analysisStore, workspaceId);
      if (outdated.length) console.info(JSON.stringify({ type: "steps.outdated_replan_requested", checkedAt, workspaceId, orders: outdated }));
    } catch { /* next tick */ }
    // A need for a link the task's own mail carries is met by it (W-158): no web search, no question to the person.
    try {
      const settled = settleLinkNeeds(analysisStore, workspaceId, ownerOf(analysisStore, workspaceId));
      if (settled.length) console.info(JSON.stringify({ type: "steps.need_from_mail", checkedAt, workspaceId, settled }));
    } catch { /* next tick */ }
    if (!codexSupervisor || paused(workspaceId, "planning")) return;
    const ids = tasksAwaitingStepPlan(analysisStore, workspaceId);
    const reviews = warningsAwaitingReview(analysisStore, workspaceId);
    const reports = reportsAwaitingJudgement(analysisStore, workspaceId);
    const needs = needsAwaitingCheck(analysisStore, workspaceId);
    if (!ids.length && !reviews.length && !reports.length && !needs.length) return;
    if (!spendAllows(await spendFor(workspaceId), "core")) return;
    enterUsageWorkspace(workspaceId);
    // A report the person just wrote comes first: they are waiting to see the rings move.
    const judge = createProgressJudge(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId));
    for (const report of reports) {
      const assessment = await judge(report).catch(() => undefined);
      if (assessment) console.info(JSON.stringify({ type: "progress.judged", checkedAt, workspaceId, workOrderId: report.workOrderId }));
    }
    const planner = createStepPlanner(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId));
    // The account's share of the model gate, each task on its own thread, until none waits (read past the ones already tried this pass,
    // so tasks that failed do not hide the rest): two a tick left thirty new tasks of approved
    // milestones unplanned for hours (2026-10-19). One pool, not batches (W-195, 2026-11-05): a slot that frees takes the next task at
    // once — a batch waited for its slowest plan, and the other slot sat idle for minutes while tasks the back-planner had just made waited.
    const tried = new Set<string>();
    const queue = [...ids];
    const nextTask = async (): Promise<string | undefined> => {
      for (;;) {
        const id = queue.shift();
        if (id !== undefined) { if (tried.has(id)) continue; tried.add(id); return id; }
        if (paused(workspaceId, "planning") || !spendAllows(await spendFor(workspaceId), "core")) return undefined;
        const more = tasksAwaitingStepPlan(analysisStore, workspaceId, tried.size + accountConcurrency() * 2).filter((other) => !tried.has(other));
        if (!more.length) return undefined;
        queue.push(...more);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, workspaceConcurrency(workspaceId)) }, async () => {
      for (let id = await nextTask(); id !== undefined; id = await nextTask()) {
        // A replan the person (or the assistant) asked for carries what to change.
        const request = analysisStore.listEvents(workspaceId, { type: "task.steps_replan_requested", entityId: id }).at(-1)?.payload as { feedback?: string } | undefined;
        const outcome = await planner(id, request?.feedback ?? "").catch(() => undefined);
        if (outcome) console.info(JSON.stringify({ type: `steps.${outcome.state}`, checkedAt, workspaceId, workOrderId: id,
          ...(outcome.state === "planned" ? { warnings: outcome.warnings.length } : { code: outcome.code }) }));
      }
    }));
    // New tasks never wait behind the checks below (W-195): when some arrived meanwhile the pass runs again first, and the checks wait.
    const newTasksWaiting = () => tasksAwaitingStepPlan(analysisStore, workspaceId, tried.size + accountConcurrency() * 2).some((id) => !tried.has(id));
    if (newTasksWaiting()) { stepPlanAgain.add(workspaceId); return; }
    // Material a plan would ask the person for is looked for on the web first (need-check.ts); only what is not found is asked.
    const checker = createNeedChecker(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId), { readCost: () => readCost(workspaceId) });
    for (const item of needsAwaitingCheck(analysisStore, workspaceId).slice(0, NEEDS_PER_PASS)) {
      if (newTasksWaiting()) { stepPlanAgain.add(workspaceId); return; }
      const outcome = await checker(item).catch(() => "skipped" as const);
      console.info(JSON.stringify({ type: "steps.need_checked", checkedAt, workspaceId, workOrderId: item.workOrderId, needId: item.needId, outcome }));
    }
    // Reviewing kept warnings waits while an evaluation spends the same quota; the warnings stay and are reviewed afterwards.
    if (heldForEval(workspaceId)) return;
    const reviewer = createWarningReviewer(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId), (id, feedback) => planner(id, feedback),
      createRelationReviser(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId)),
      (line, notes) => createMilestoneProposer(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId))(`复核意见：${notes}`, undefined /* i18n-ignore: the architect's brief */, [line], { revised: true }));
    for (const item of reviews) {
      if (newTasksWaiting()) { stepPlanAgain.add(workspaceId); return; }
      const verdict = await reviewer(item).catch(() => undefined);
      if (verdict) console.info(JSON.stringify({ type: `validation.${verdict.verdict}`, checkedAt, workspaceId, subject: item.subject, entityId: item.entityId }));
    }
  } finally {
    stepPlanning.delete(workspaceId);
    if (stepPlanAgain.delete(workspaceId)) void stepPlanPass(workspaceId).catch(() => {});
  }
}
