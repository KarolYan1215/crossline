import { get } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { configureModelGate, enterUsageWorkspace, guestRuntimeLimit, modelGateStatus, setProviderResolver, setSpendModeProvider, setUsageSink, startCodexSupervisor, startModelGateway, type CodexSupervisor } from "@crossline/codex";
import { containerMemory, containerPeak } from "./memory";
import { createDpapiSecretStore } from "@crossline/connectors";
import { createModelProviderService } from "./model-provider";
import { CrosslineStore, aiToolsFor, grownHomeLine, interviewChecklistFor, isPaused, listPushSubscriptions, readGrownSkills, readPublicSkills, removePushSubscriptions } from "@crossline/db";
import { capturesAwaitingAutoAnalysis, createCaptureAnalyzer } from "./analysis";
import { autoApproveEligible } from "./auto-approval";
import { retireShadowedDemos } from "./demo-cleanup";
import { notifyPass } from "./notify";
import { createActivityTracker } from "./activity-recorder";
import { agentHistoryPass } from "./agent-history";
import { createWindowsActivitySource } from "./activity-source";
import { createNightlyFlywheel } from "./nightly";
import { createDiligenceRunner, linesDueForDiligence } from "./diligence";
import { createAgentService } from "./agent-service";
import { createCalendarPublisher } from "./calendar-publish";
import { repairDuplicateImports, repairFrozenRace } from "./calendar-repair";
import { createWriteLogin } from "./calendar-write-login";
import { AGENT_HISTORY_CONSENT, AGENT_HISTORY_SUMMARY, BACKGROUND_PAUSED, backgroundSpend, CALENDAR_SYNC_FAILURE, FIRST_DRAFTS_SETTING, grownSkillName, publicSkillName, pausedKinds, readyToStart, spendAllows, type BackgroundKind, type PlanRankingInput } from "@crossline/core";
import { createFlywheelExpander } from "./flywheel";
import { createManualbookBuilder, pendingMaterialWorkOrders, pendingTutorials } from "./manualbook";
import { createProgressJudge, createStepPlanner, createWarningReviewer, reportsAwaitingJudgement, requestFinerSplits, settleOldQuestions, tasksAwaitingStepPlan, warningsAwaitingReview } from "./step-planner";
import { createArchetypeCurator, curationDue } from "./archetype-curator";
import { energyAdvicePass } from "./energy-advice";
import { dedupePass } from "./dedupe";
import { createTaskTitler, untitledTasks } from "./task-titler";
import { createCalendarClassifier, unfiledCalendarEvents } from "./calendar-classifier";
import { createInsightCompiler, linesAwaitingMineSkill } from "./insight-compiler";
import { cleanPublicSkills, createSkillScout, scoutDue } from "./public-skills";
import { browserProfilesRoot, cleanGrownSkills, finishWorkflowLogin, growCandidates, growTask, installGrown, markWorkflowRun, openWorkflowLogin, sayToPerson, startWorkflowRun,
  workflowSchedulePass } from "./workflow-smith";
import { createGoalSplitter, linesAwaitingCandidateSplit, linesAwaitingSplit } from "./goal-splitter";
import { createMilestoneRiskReviewer, milestonesAwaitingRiskReview } from "./milestone-risk-review";
import { fileSourceDocuments } from "./source-filing";
import { createPortraitWriter, PORTRAIT_GAP_AT, PORTRAIT_REWRITE_MARKER, portraitRewriteDue } from "./portrait-writer";
import { createPortraitIllustrator } from "./portrait-illustrator";
import { materializeDatePairs, releaseWaits } from "./date-pairs";
import { createConcierge, type ConciergeRequest } from "./concierge";
import { createMilestoneGate, pendingMilestoneGates } from "./milestone-gate-runner";
import { createMilestoneConversation, createMilestoneProposer, createRelationReviser } from "./milestone-proposer";
import { createGoalBackplanner, milestonesAwaitingBackplan } from "./goal-backplanner";
import { createPlanExplainer } from "./plan-explainer-runner";
import { createWeeklyInsight } from "./weekly-insight-runner";
import { createOnboardingSessionRunner } from "./onboarding-session";
import { extractText, reextractForLayout } from "./extract";
import { createTranscriber, createWhisperEngine, modelsDirectory } from "./transcribe";
import { createBackgroundFactsExtractor } from "./background-facts-runner";
import { createGraphSync, type SyncOutcome } from "./graph-sync";
import { addSubscription, hasSubscriptions, removeSubscription, subscriptionSources } from "./calendar-subscriptions";
import { addFolder, personNames, previewFolder, removeFolder, setFolderLines, setFolderRules, syncFolders } from "./source-folders";
import { createFolderClassifier } from "./folder-classifier";
import { homedir } from "node:os";
import { defaultSafeGetDeps } from "./safe-fetch";
import { REQUIRED_SKILLS } from "./required-skills";
import { monthSpend, ownerOf, runtimeOwner, runtimesDir } from "./owner";
import { identityLines } from "./lines";
import { createBackgroundSpend } from "./spend";
import { telemetryPass } from "./telemetry";
import {
  buildSources, calendarLabel, listCatalogue, readSelection, saveSelection, seedNewAccounts, sourceKey, mayUseGraphLogin, withdrawForeignCalendar } from "./calendar-sources";
import { createGraphAuthSession, GraphReadSource, loadVapidKeys, sendWebPush, type GraphCredentialProvider } from "@crossline/connectors";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
// The worker runs with its own package as cwd, and nothing else here reads .env files — so without
// this the calendar client id was simply never present and the sync could never switch on, silently.
// Node has this built in; no dependency is added for it. Values already in the environment win.
for (const file of [".env.local", ".env"]) {
  const envFile = path.join(repoRoot, file);
  if (existsSync(envFile)) { try { process.loadEnvFile(envFile); } catch { /* malformed: fall through */ } }
}

const intervalMinutes = Number(process.env.CROSSLINE_SYNC_INTERVAL_MINUTES ?? 15);
const webHealthUrl = process.env.CROSSLINE_WEB_HEALTH_URL ?? "http://127.0.0.1:3210/api/health";
const dataDir = path.resolve(process.env.CROSSLINE_DATA_DIR ?? path.join(repoRoot, "data"));
const supervisorPort = Number(process.env.CROSSLINE_CODEX_SUPERVISOR_PORT ?? 3211);

/**
 * Only one worker may run against one ledger. A second one would open a second SQLite writer, race for
 * the supervisor port, and run the nightly flywheel twice.
 *
 * The lock is a heartbeat rather than a bare PID: a crashed worker leaves its PID behind, and Windows
 * recycles PIDs, so "that PID exists" is not evidence the holder is alive. A heartbeat that stopped
 * refreshing is — and it self-heals within a bounded time instead of keeping the worker down forever.
 */
const lockPath = path.join(dataDir, "worker.lock");
const staleAfterMs = intervalMinutes * 60_000 * 3;

function claimWorkerLock(): boolean {
  try {
    const held = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number; heartbeatAt: string };
    const age = Date.now() - Date.parse(held.heartbeatAt);
    let running = false;
    // EPERM means the process exists but belongs to someone else — that is still "alive", and reading
    // it as "gone" would let a second worker start alongside a healthy one.
    try { process.kill(held.pid, 0); running = true; }
    catch (error) { running = (error as NodeJS.ErrnoException).code === "EPERM"; }
    // A lock naming this very process was left by an earlier run that had the same pid: a container restarted after an out-of-memory
    // kill starts the worker under the pid it had before, and honouring the lock made it exit and restart in a loop for 45 minutes.
    if (held.pid === process.pid) running = false;
    if (running && Number.isFinite(age) && age >= 0 && age < staleAfterMs) return false;
  } catch { /* absent, malformed or unreadable lock: the holder left nothing worth honouring */ }
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, heartbeatAt: new Date().toISOString() }));
  return true;
}

const beat = (): void => {
  try {
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, heartbeatAt: new Date().toISOString() }));
  } catch { /* a missed heartbeat only costs a takeover after staleAfterMs; never worth crashing for */ }
};

/**
 * Classifies the workspace's new captures. Run by the tick and, right after a capture is written, by the web app — so the person
 * does not wait up to a tick (fifteen minutes) for something the system already knows how to do. One pass per workspace at a time.
 */
const autoAnalyzing = new Set<string>();
async function autoAnalyzePass(workspaceId: string, checkedAt = new Date().toISOString()): Promise<void> {
  if (paused(workspaceId, "intake")) return;
  if (!codexSupervisor || autoAnalyzing.has(workspaceId)) return;
  autoAnalyzing.add(workspaceId);
  try {
    const ids = capturesAwaitingAutoAnalysis(analysisStore, workspaceId);
    if (!ids.length) return;
    if (!spendAllows(await spendFor(workspaceId), "intake")) return;
    // Started by the quota read just above when it is the account's own runtime; none means not connected, and that was just recorded.
    const client = codexSupervisor.clientFor(workspaceId);
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

/**
 * Works backwards from approved milestones due within three weeks that nothing serves yet. Run by the tick
 * and, right after the person approves a line's drafts, by the web app — so the week fills in at once.
 */
const autoBackplanning = new Set<string>();
async function autoBackplanPass(workspaceId: string, checkedAt = new Date().toISOString()): Promise<void> {
  if (paused(workspaceId, "planning")) return;
  if (!codexSupervisor || autoBackplanning.has(workspaceId)) return;
  autoBackplanning.add(workspaceId);
  try {
    const ids = milestonesAwaitingBackplan(analysisStore, workspaceId);
    if (!ids.length) return;
    if (!spendAllows(await spendFor(workspaceId), "core")) return;
    enterUsageWorkspace(workspaceId);
    const backplan = createGoalBackplanner(analysisStore, workspaceId, repoRoot, () => codexSupervisor?.clientFor(workspaceId), { rolling: true });
    for (const id of ids) {
      const outcome = await backplan(id).catch(() => undefined);
      if (outcome) console.info(JSON.stringify({ type: `backplan.auto.${outcome.state}`, checkedAt, workspaceId, milestoneId: id }));
    }
    void stepPlanPass(workspaceId).catch(() => {});
  } finally { autoBackplanning.delete(workspaceId); }
}

/**
 * Turns confirmed course dates into tasks, gives every committed task a step plan (the migration of existing tasks is this same pass,
 * two a tick), and has a reviewer look at plans the mechanical checks flagged. Quota-gated like the other model passes.
 */
/**
 * The archetype curator, on the person's period (or after twenty new preferences), only with a normal budget. Its run is long and
 * web-backed, so it never shares a tick with another curation for the same workspace.
 */
const curating = new Set<string>();
async function curatorPass(workspaceId: string, checkedAt: string): Promise<void> {
  if (paused(workspaceId, "planning")) return;
  if (curating.has(workspaceId) || !codexSupervisor || !curationDue(analysisStore, workspaceId)) return;
  if (!spendAllows(await spendFor(workspaceId), "discretionary")) return;
  curating.add(workspaceId);
  try {
    enterUsageWorkspace(workspaceId);
    const outcome = await createArchetypeCurator(analysisStore, workspaceId, repoRoot, () => codexSupervisor?.clientFor(workspaceId))().catch(() => undefined);
    if (outcome) console.info(JSON.stringify({ type: "archetypes.curated", checkedAt, workspaceId, added: outcome.added.length, dropped: outcome.dropped.length }));
  } finally { curating.delete(workspaceId); }
}

/** Names tasks written before short names existed, a batch a tick, while the quota is normal. */
const titling = new Set<string>();
async function titlePass(workspaceId: string, checkedAt: string): Promise<void> {
  if (paused(workspaceId, "planning")) return;
  if (titling.has(workspaceId) || !codexSupervisor || !untitledTasks(analysisStore, workspaceId).length) return;
  if (!spendAllows(await spendFor(workspaceId), "discretionary")) return;
  titling.add(workspaceId);
  try {
    enterUsageWorkspace(workspaceId);
    const outcome = await createTaskTitler(analysisStore, workspaceId, repoRoot, () => codexSupervisor?.clientFor(workspaceId))().catch(() => undefined);
    if (outcome) console.info(JSON.stringify({ type: "tasks.titled", checkedAt, workspaceId, ...outcome }));
  } finally { titling.delete(workspaceId); }
}

/** Files new calendar events under the person's lines after a sync, a batch a tick; a small model, so it still runs when quota is tight. */
/**
 * Reads a stored document's text: the worker's one extraction path (the web's upload and the supervisor route; authorized folders call `extractText` before keeping a file).
 * Only files this app wrote itself, by the path it recorded: the model and the browser never supply one.
 */
async function extractDocument(documentId: string, workspaceId: string) {
  const doc = analysisStore.listSourceDocuments(workspaceId).find((item) => item.id === documentId);
  if (!doc) return { state: "blocked" as const, code: "SOURCE_NOT_FOUND", message: "找不到这个文件。" };
  if (doc.kind === "audio") return transcribeDocument(workspaceId, doc.id);
  let result;
  try { result = await extractText(new Uint8Array(readFileSync(fileURLToPath(doc.uri))), doc.kind); }
  catch { result = { status: "failed" as const, text: "", note: "读不到已保存的文件。" }; }
  analysisStore.setSourceDocumentExtraction(workspaceId, doc.id, { status: result.status, text: result.text, ...(result.note ? { note: result.note } : {}) });
  return { state: "extracted" as const, documentId: doc.id, status: result.status, characters: result.text.length };
}

/** Authorized folders (source-folders.ts): read what is new or changed, then have the model propose lines for newly read folders. */
/**
 * Whatever reads this computer itself — its folders, its screen, its idle stretches, its coding agents' logs — belongs to the machine
 * owner's account only. A guest reaches this app over the private network from another device; offering them these readings handed
 * them the owner's documents, window titles and working hours (found walking the app as an invitee, 2026-10-15).
 */
// On the hosted beta the machine is a shared server: nobody's account reads its folders, screen or logs, and nobody gets its shell.
const hostedBeta = process.env.CROSSLINE_PUBLIC_BETA === "1";
const machineOwner = (workspaceId: string) => !hostedBeta && runtimeOwner(analysisStore) === workspaceId;
const OWNER_ONLY_FOLDER = { state: "blocked" as const, code: "FOLDER_OWNER_ONLY",
  message: "文件夹在运行 Crossline 的那台电脑上，只有那台电脑的主人能授权。请改用「添加文件」上传。" };
const folderDeps = { dataDir, home: homedir(), readText: extractText };
const readingFolders = new Set<string>();
// A folder added while a pass runs would wait for the next tick (up to fifteen minutes) while its card says 「正在读取」 — four folders
// authorized at once read only the first (2026-10-15) — so a call during a pass runs one more pass after it.
const rereadFolders = new Set<string>();
async function folderPass(workspaceId: string, checkedAt: string): Promise<void> {
  if (readingFolders.has(workspaceId)) { rereadFolders.add(workspaceId); return; }
  if (paused(workspaceId, "intake") || !machineOwner(workspaceId)) return;
  readingFolders.add(workspaceId);
  try {
    const outcomes = await syncFolders(analysisStore, workspaceId, folderDeps).catch(() => []);
    const read = outcomes.reduce((sum, item) => sum + item.read, 0);
    if (read) console.info(JSON.stringify({ type: "sources.folders_read", checkedAt, workspaceId, outcomes }));
    if (!codexSupervisor || !spendAllows(await spendFor(workspaceId), "intake")) return;
    enterUsageWorkspace(workspaceId);
    const filed = await createFolderClassifier(analysisStore, workspaceId, repoRoot, () => codexSupervisor?.clientFor(workspaceId))().catch(() => undefined);
    if (filed && "filed" in filed && filed.filed) console.info(JSON.stringify({ type: "sources.folder_lines_filed", checkedAt, workspaceId, ...filed }));
  } finally {
    readingFolders.delete(workspaceId);
    if (rereadFolders.delete(workspaceId)) void folderPass(workspaceId, new Date().toISOString()).catch(() => undefined);
  }
}

const filingCalendar = new Set<string>();
async function calendarLinePass(workspaceId: string, checkedAt: string): Promise<void> {
  if (paused(workspaceId, "intake")) return;
  if (filingCalendar.has(workspaceId) || !codexSupervisor || !unfiledCalendarEvents(analysisStore, workspaceId).length) return;
  if (!spendAllows(await spendFor(workspaceId), "intake")) return;
  filingCalendar.add(workspaceId);
  try {
    enterUsageWorkspace(workspaceId);
    const outcome = await createCalendarClassifier(analysisStore, workspaceId, repoRoot, () => codexSupervisor?.clientFor(workspaceId))().catch(() => undefined);
    if (outcome) console.info(JSON.stringify({ type: "calendar.lines_filed", checkedAt, workspaceId, ...outcome }));
  } finally { filingCalendar.delete(workspaceId); }
}

/**
 * Splits long-term goals adopted as whole sentences into attributes (§4.1), once per goal; a small model, so it runs unless the quota is
 * down to core work. Also run on request (`POST /v1/lines/split-goals`).
 */
const splittingGoals = new Set<string>();
async function goalSplitPass(workspaceId: string, checkedAt = new Date().toISOString()): Promise<void> {
  if (paused(workspaceId, "planning")) return;
  if (splittingGoals.has(workspaceId) || !codexSupervisor
    || (!linesAwaitingSplit(analysisStore, workspaceId).length && !linesAwaitingCandidateSplit(analysisStore, workspaceId).length)) return;
  if (!spendAllows(await spendFor(workspaceId), "core")) return;
  splittingGoals.add(workspaceId);
  try {
    enterUsageWorkspace(workspaceId);
    const outcome = await createGoalSplitter(analysisStore, workspaceId, repoRoot, () => codexSupervisor?.clientFor(workspaceId))().catch(() => undefined);
    if (outcome) console.info(JSON.stringify({ type: "lines.goals_split", checkedAt, workspaceId, ...outcome }));
  } finally { splittingGoals.delete(workspaceId); }
}

/**
 * Reads new milestone drafts critically for what could keep them from being reached (`crossline-milestone-risk-reviewer`), once per
 * draft as drafted: after every architect run and on the tick. Part of designing milestones, so it runs while the quota allows core work.
 */
const reviewingRisks = new Set<string>();
async function milestoneRiskPass(workspaceId: string, checkedAt = new Date().toISOString()): Promise<void> {
  if (paused(workspaceId, "planning") || reviewingRisks.has(workspaceId) || !codexSupervisor) return;
  if (!milestonesAwaitingRiskReview(analysisStore, workspaceId).length) return;
  if (!spendAllows(await spendFor(workspaceId), "core")) return;
  reviewingRisks.add(workspaceId);
  try {
    enterUsageWorkspace(workspaceId);
    const outcome = await createMilestoneRiskReviewer(analysisStore, workspaceId, repoRoot, () => codexSupervisor?.clientFor(workspaceId))().catch(() => undefined);
    if (outcome) console.info(JSON.stringify({ type: "milestones.risk_reviewed", checkedAt, workspaceId, ...outcome }));
  } finally { reviewingRisks.delete(workspaceId); }
}

/**
 * The first milestone drafts, made once the start standard holds and the account has no milestone yet. Before this the person reached
 * Today with 「暂无可执行任务」 and nothing said that the next step was a button inside the interview (2026-10-15 walkthrough). Drafts take
 * effect only when approved on 主线, so designing them unasked costs a run and decides nothing. Once per account (`milestones.firstDrafts`).
 */
const draftingFirst = new Set<string>();
async function firstDraftsPass(workspaceId: string, checkedAt = new Date().toISOString()): Promise<void> {
  if (paused(workspaceId, "planning") || draftingFirst.has(workspaceId) || !codexSupervisor) return;
  if (analysisStore.getSetting(workspaceId, FIRST_DRAFTS_SETTING) || analysisStore.listMilestones(workspaceId).length) return;
  const lines = identityLines(analysisStore, workspaceId).map((line) => ({ id: line.id, label: line.label, hard: Boolean(line.hard), goals: line.goals ?? [] }));
  if (!lines.length || !readyToStart(interviewChecklistFor(analysisStore, workspaceId, lines, { unfiledFiles: null }))) return;
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
    const outcome = await createMilestoneProposer(analysisStore, workspaceId, repoRoot, () => codexSupervisor?.clientFor(workspaceId))("", undefined).catch(() => undefined);
    console.info(JSON.stringify({ type: "milestones.first_drafts", checkedAt, workspaceId, state: outcome?.state ?? "failed" }));
  } finally { draftingFirst.delete(workspaceId); }
  void milestoneRiskPass(workspaceId).catch(() => undefined);
}

/**
 * Rewrites a line's own skill (`crossline-mine:<line>`, docs/skills-library.md §1) when the person has said or decided something new about how
 * they do that line's work: one line a tick, while the quota allows core work. The version it replaces stays in the ledger.
 */
const compilingMine = new Set<string>();
async function minePass(workspaceId: string, checkedAt: string): Promise<void> {
  if (paused(workspaceId, "planning")) return;
  if (compilingMine.has(workspaceId) || !codexSupervisor || !linesAwaitingMineSkill(analysisStore, workspaceId).length) return;
  if (!spendAllows(await spendFor(workspaceId), "core")) return;
  compilingMine.add(workspaceId);
  try {
    enterUsageWorkspace(workspaceId);
    const outcome = await createInsightCompiler(analysisStore, workspaceId, repoRoot, () => codexSupervisor?.clientFor(workspaceId))().catch(() => undefined);
    if (outcome) console.info(JSON.stringify({ type: "skill.mine.compiled", checkedAt, workspaceId, ...outcome }));
  } finally { compilingMine.delete(workspaceId); }
}

/**
 * Public skills (docs/skills-library.md §2): once a day the ones not called for thirty days are removed; the scout runs for a new library,
 * once a month (checking installed ones for a newer commit too), and the day after a task found nothing that fits. Discretionary spend.
 */
const scoutingSkills = new Set<string>();
async function publicSkillPass(workspaceId: string, checkedAt: string): Promise<void> {
  try {
    const removed = cleanPublicSkills(analysisStore, workspaceId);
    if (removed.length) console.info(JSON.stringify({ type: "skill.public.cleaned", checkedAt, workspaceId, removed }));
  } catch { /* housekeeping */ }
  if (paused(workspaceId, "planning")) return;
  if (scoutingSkills.has(workspaceId) || !codexSupervisor || !scoutDue(analysisStore, workspaceId)) return;
  if (!spendAllows(await spendFor(workspaceId), "discretionary")) return;
  scoutingSkills.add(workspaceId);
  try {
    enterUsageWorkspace(workspaceId);
    const outcome = await createSkillScout(analysisStore, workspaceId, repoRoot, () => codexSupervisor?.clientFor(workspaceId))().catch(() => undefined);
    if (outcome) console.info(JSON.stringify({ type: "skill.public.scouted", checkedAt, workspaceId, ...outcome }));
  } finally { scoutingSkills.delete(workspaceId); }
}

/**
 * Grown workflows (docs/skills-library.md §6): reminders and scheduled runs whose time has come, the daily clean-up, and — when the
 * assistant is free, not paused and the quota allows — one errand grown into a workflow. Growing and scheduled runs go through the same
 * assistant machinery as any task (owner only, approved kinds only); reminders go out whatever the assistant is doing.
 */
const growingWorkflows = new Set<string>();
async function workflowPass(workspaceId: string, checkedAt: string): Promise<void> {
  try {
    const removed = cleanGrownSkills(analysisStore, workspaceId);
    if (removed.length) console.info(JSON.stringify({ type: "skill.grown.cleaned", checkedAt, workspaceId, removed }));
  } catch { /* housekeeping */ }
  const assistantOff = isPaused(analysisStore, workspaceId) || !codexSupervisor;
  try {
    const fired = workflowSchedulePass(analysisStore, workspaceId, (input, after) => assistantOff
      ? { state: "blocked", code: "AGENT_PAUSED", message: "助手已暂停。" } : agentService.runFree(workspaceId, input, after), new Date(), browserProfilesRoot(workspaceId));
    if (fired.length) console.info(JSON.stringify({ type: "skill.grown.scheduled", checkedAt, workspaceId, fired }));
  } catch { /* next tick */ }
  if (assistantOff || growingWorkflows.has(workspaceId) || agentService.runningTasks(workspaceId).length) return;
  const candidate = growCandidates(analysisStore, workspaceId)[0];
  // What the person asked for in words is their own work, like a capture: it runs while the quota lasts. An errand the system noticed
  // repeating is its own idea, and waits for a normal quota.
  if (!candidate || !spendAllows(await spendFor(workspaceId), candidate.origin.kind === "asked" ? "core" : "discretionary")) return;
  // What this line's library already holds, so the new workflow names and builds on it instead of copying it.
  const library = [...readPublicSkills(analysisStore, workspaceId).filter((skill) => skill.lines.includes(candidate.lineId) && skill.review.final !== "reject")
    .map((skill) => ({ name: publicSkillName(skill.id), description: skill.description })),
    ...readGrownSkills(analysisStore, workspaceId).filter((skill) => skill.status === "active" && grownHomeLine(analysisStore, workspaceId, skill) === candidate.lineId)
      .map((skill) => ({ name: grownSkillName(skill.id), description: skill.manifest.summary }))];
  const input = growTask(candidate, identityLines(analysisStore, workspaceId).map((line) => line.id), aiToolsFor(analysisStore, workspaceId), library);
  growingWorkflows.add(workspaceId);
  const started = agentService.runFree(workspaceId, input, (outcome) => {
    void installGrown(analysisStore, workspaceId, candidate, outcome, { client: codexSupervisor?.clientFor(workspaceId), cwd: repoRoot })
      .then((result) => console.info(JSON.stringify({ type: "skill.grown." + result.state, workspaceId, ...result })))
      .catch(() => undefined).finally(() => {
        growingWorkflows.delete(workspaceId);
        // A request the person made while this one was growing is taken up now, not a tick later (found 2026-10-14: a request typed
        // during a system-noticed growth waited behind it for the next tick).
        if (growCandidates(analysisStore, workspaceId).some((next) => next.origin.kind === "asked")) void workflowPass(workspaceId, new Date().toISOString()).catch(() => undefined);
      });
  });
  if (started.state !== "started") growingWorkflows.delete(workspaceId);
  // A busy assistant or another account's workspace is tried again on a later tick; nothing is recorded for it.
  if (started.state === "blocked") return;
  // Tried once per errand or request: a kind the person has not allowed is said once, not every tick.
  analysisStore.appendEvent({ ownerId: ownerOf(analysisStore, workspaceId), workspaceId, idempotencyKey: "skill.grown.attempted:" + input.taskId, type: "skill.grown.attempted",
    entityId: candidate.lineId, payload: { taskId: input.taskId, state: started.state, ...(candidate.origin.kind === "asked" ? { requestId: candidate.origin.requestId } : { taskIds: candidate.origin.taskIds }) } });
  if (started.state === "needs_category_approval") sayToPerson(analysisStore, workspaceId, "要把「" + candidate.text.slice(0, 40) + "」固化成工作流，需要先允许助手做「" + started.label + "」这类工作。",
    "skill_grown", "grow-needs:" + input.taskId, [{ label: "去开启", href: "/settings#automation" }]);
}

/**
 * Writes the portrait (the interview's end, 重新生成, or the one rewrite after the fixed dimensions shipped): `portrait.requested` first,
 * so the page shows it running, then `portrait.blocked` with the reason, or the figure drawn in the background after the words.
 */
async function writePortraitFor(workspaceId: string) {
  enterUsageWorkspace(workspaceId);
  const store = analysisStore;
  store.appendEvent({ ownerId: store.getWorkspaceOwnerId(workspaceId) ?? "", workspaceId, idempotencyKey: `portrait.requested:${Date.now()}`, type: "portrait.requested", entityId: workspaceId, payload: {} });
  const outcome = await createPortraitWriter(store, workspaceId, repoRoot, () => codexSupervisor?.clientFor(workspaceId))();
  if (outcome.state === "blocked") store.appendEvent({ ownerId: store.getWorkspaceOwnerId(workspaceId) ?? "", workspaceId, idempotencyKey: `portrait.blocked:${Date.now()}`,
    type: "portrait.blocked", entityId: workspaceId, payload: { code: outcome.code, message: outcome.message } });
  // The pictures follow the words, in the background: the report is readable at once and gains its illustrations as they land.
  else void createPortraitIllustrator(store, workspaceId, repoRoot, dataDir, () => codexSupervisor?.clientFor(workspaceId))()
    .then((drawn) => console.info(JSON.stringify({ type: "portrait.illustrated", workspaceId, ...drawn })))
    .catch(() => undefined);
  return outcome;
}

/**
 * Rewrites a portrait in the background when `portraitRewriteDue` says so: once for a report from before the fixed dimensions, and the
 * say–do part at most monthly once the execution record can be drawn. Nobody is waiting on either, so both wait for a normal quota.
 * The marker is written before the run: a failure shows on the page (重新生成 is the person's), it is never retried every tick.
 */
const rewritingPortraits = new Set<string>();
async function portraitPass(workspaceId: string, checkedAt: string): Promise<void> {
  if (rewritingPortraits.has(workspaceId) || !codexSupervisor) return;
  const due = portraitRewriteDue(analysisStore, workspaceId, new Date(checkedAt));
  if (!due || !spendAllows(await spendFor(workspaceId), "discretionary")) return;
  rewritingPortraits.add(workspaceId);
  try {
    if (due === "schema" || due === "first") {
      if (due === "schema") analysisStore.setSetting(workspaceId, PORTRAIT_REWRITE_MARKER, checkedAt);
      const outcome = await writePortraitFor(workspaceId).catch(() => undefined);
      console.info(JSON.stringify({ type: "portrait.rewritten", checkedAt, workspaceId, state: outcome?.state ?? "failed" }));
    } else {
      analysisStore.setSetting(workspaceId, PORTRAIT_GAP_AT, checkedAt);
      enterUsageWorkspace(workspaceId);
      const outcome = await createPortraitWriter(analysisStore, workspaceId, repoRoot, () => codexSupervisor?.clientFor(workspaceId), { only: "gap" })().catch(() => undefined);
      console.info(JSON.stringify({ type: "portrait.gap_rewrite", checkedAt, workspaceId, state: outcome?.state ?? "failed" }));
    }
  } finally { rewritingPortraits.delete(workspaceId); }
}

const stepPlanning = new Set<string>();
/** Asked for while a pass was running: run once more when it ends, so a task approved mid-pass is not left for the next tick. */
const stepPlanAgain = new Set<string>();
async function stepPlanPass(workspaceId: string, checkedAt = new Date().toISOString()): Promise<void> {
  if (stepPlanning.has(workspaceId)) { stepPlanAgain.add(workspaceId); return; }
  stepPlanning.add(workspaceId);
  try {
    try {
      const created = materializeDatePairs(analysisStore, workspaceId);
      if (created.length) console.info(JSON.stringify({ type: "datepair.created", checkedAt, workspaceId, created }));
      const release = releaseWaits(analysisStore, workspaceId);
      if (release.opened.length || release.arrived.length) console.info(JSON.stringify({ type: "datepair.release_waits", checkedAt, workspaceId, ...release }));
    } catch (error) { console.info(JSON.stringify({ type: "datepair.failed", checkedAt, workspaceId, message: error instanceof Error ? error.message : "" })); }
    // Questions of plans made before importance was judged: filtered by rule, no model call (docs/review-2026-10-13.md §11).
    try {
      const settled = settleOldQuestions(analysisStore, workspaceId);
      if (settled.length) console.info(JSON.stringify({ type: "step_questions.assumed", checkedAt, workspaceId, settled }));
    } catch { /* next tick */ }
    // A step that did not get done on two days is planned again smaller: rules only, picked up below like any replan.
    try {
      const splits = requestFinerSplits(analysisStore, workspaceId);
      if (splits.length) console.info(JSON.stringify({ type: "steps.finer_split_requested", checkedAt, workspaceId, splits }));
    } catch { /* next tick */ }
    if (!codexSupervisor || paused(workspaceId, "planning")) return;
    const ids = tasksAwaitingStepPlan(analysisStore, workspaceId);
    const reviews = warningsAwaitingReview(analysisStore, workspaceId);
    const reports = reportsAwaitingJudgement(analysisStore, workspaceId);
    if (!ids.length && !reviews.length && !reports.length) return;
    if (!spendAllows(await spendFor(workspaceId), "core")) return;
    enterUsageWorkspace(workspaceId);
    // A report the person just wrote comes first: they are waiting to see the rings move.
    const judge = createProgressJudge(analysisStore, workspaceId, repoRoot, () => codexSupervisor?.clientFor(workspaceId));
    for (const report of reports) {
      const assessment = await judge(report).catch(() => undefined);
      if (assessment) console.info(JSON.stringify({ type: "progress.judged", checkedAt, workspaceId, workOrderId: report.workOrderId }));
    }
    const planner = createStepPlanner(analysisStore, workspaceId, repoRoot, () => codexSupervisor?.clientFor(workspaceId));
    for (const id of ids) {
      // A replan the person (or the assistant) asked for carries what to change.
      const request = analysisStore.listEvents(workspaceId, { type: "task.steps_replan_requested", entityId: id }).at(-1)?.payload as { feedback?: string } | undefined;
      const outcome = await planner(id, request?.feedback ?? "").catch(() => undefined);
      if (outcome) console.info(JSON.stringify({ type: `steps.${outcome.state}`, checkedAt, workspaceId, workOrderId: id,
        ...(outcome.state === "planned" ? { warnings: outcome.warnings.length } : { code: outcome.code }) }));
    }
    const reviewer = createWarningReviewer(analysisStore, workspaceId, repoRoot, () => codexSupervisor?.clientFor(workspaceId), (id, feedback) => planner(id, feedback),
      createRelationReviser(analysisStore, workspaceId, repoRoot, () => codexSupervisor?.clientFor(workspaceId)),
      (line, notes) => createMilestoneProposer(analysisStore, workspaceId, repoRoot, () => codexSupervisor?.clientFor(workspaceId))(`复核意见：${notes}`, undefined, [line], { revised: true }));
    for (const item of reviews) {
      const verdict = await reviewer(item).catch(() => undefined);
      if (verdict) console.info(JSON.stringify({ type: `validation.${verdict.verdict}`, checkedAt, workspaceId, subject: item.subject, entityId: item.entityId }));
    }
  } finally {
    stepPlanning.delete(workspaceId);
    if (stepPlanAgain.delete(workspaceId)) void stepPlanPass(workspaceId).catch(() => {});
  }
}

async function tick(): Promise<void> {
  const checkedAt = new Date().toISOString();
  mkdirSync(dataDir, { recursive: true });
  beat();
  // Readings arrive from the source on their own clock; the tick only does the retention sweep.
  try { activityTracker.prune(); } catch { /* retention is housekeeping, never worth a failed tick */ }
  // Every real workspace, not one hardcoded id — a real account's own work orders and calendar state
  // used to be structurally invisible to all three of these jobs no matter how long the worker ran.
  const workspaces = analysisStore.listWorkspaces();
  for (const workspace of workspaces) {
    try {
      const retired = retireShadowedDemos(analysisStore, workspace.id);
      if (retired.length) console.info(JSON.stringify({ type: "demo_orders.retired", checkedAt, workspaceId: workspace.id, retired }));
    } catch { /* housekeeping: never worth a failed tick */ }
    // Proposals written before the default-effect rule covered them (or while it was narrower) get the same rule on the tick;
    // an approval the person took back is never re-applied.
    try {
      const approved = autoApproveEligible(analysisStore, workspace.id);
      if (approved.length) console.info(JSON.stringify({ type: "work_orders.auto_approved", checkedAt, workspaceId: workspace.id, approved }));
    } catch { /* next tick */ }
  }
  // Material preparation is the one background job that writes into the project directory, so it only
  // ever runs for work orders the human already approved into `preparing`.
  for (const workspace of workspaces) {
    enterUsageWorkspace(workspace.id);
    for (const workOrderId of pendingMaterialWorkOrders(analysisStore, workspace.id)) {
      const outcome = await getMaterialPreparer(workspace.id)(workOrderId).catch(() => undefined);
      if (outcome) console.info(JSON.stringify({ type: `materials.${outcome.state}`, checkedAt, workspaceId: workspace.id, ...outcome }));
    }
    // Tutorials for work coming up in the next seven days (decided 2026-10-08): one per workspace per tick, and only while the quota is normal.
    const tutorial = pendingTutorials(analysisStore, workspace.id)[0];
    if (tutorial && codexSupervisor && !paused(workspace.id, "tutorials") && spendAllows(await spendFor(workspace.id), "discretionary")) {
      const outcome = await getMaterialPreparer(workspace.id)(tutorial, { mode: "tutorial" }).catch(() => undefined);
      if (outcome) console.info(JSON.stringify({ type: `tutorial.${outcome.state}`, checkedAt, workspaceId: workspace.id, ...outcome }));
    }
  }
  // A new capture is classified, estimated and split without anyone pressing 分析: the person's job is to write it down, the
  // system's is to turn it into a proposal waiting in 待确认. Quota-gated (nothing runs unless the budget is normal) and capped
  // per tick; a capture that came back blocked is left for the person rather than retried on a timer.
  if (codexSupervisor) {
    for (const workspace of workspaces) await autoAnalyzePass(workspace.id, checkedAt);
    for (const workspace of workspaces) await autoBackplanPass(workspace.id, checkedAt);
  }
  for (const workspace of workspaces) await stepPlanPass(workspace.id, checkedAt);
  for (const workspace of workspaces) await curatorPass(workspace.id, checkedAt);
  for (const workspace of workspaces) await energyAdvicePass({ store: analysisStore, workspaceId: workspace.id, cwd: repoRoot, client: () => codexSupervisor?.clientFor(workspace.id), spend: () => spendFor(workspace.id), paused: (kind) => paused(workspace.id, kind), enterUsage: enterUsageWorkspace }).catch(() => undefined);
  for (const workspace of workspaces) await dedupePass({ store: analysisStore, workspaceId: workspace.id, cwd: repoRoot, client: () => codexSupervisor?.clientFor(workspace.id), spend: () => spendFor(workspace.id), paused: (kind) => paused(workspace.id, kind), enterUsage: enterUsageWorkspace }).catch(() => undefined);
  for (const workspace of workspaces) await titlePass(workspace.id, checkedAt);
  for (const workspace of workspaces) await goalSplitPass(workspace.id, checkedAt);
  for (const workspace of workspaces) await milestoneRiskPass(workspace.id, checkedAt);
  for (const workspace of workspaces) void firstDraftsPass(workspace.id, checkedAt).catch(() => undefined);
  for (const workspace of workspaces) await minePass(workspace.id, checkedAt);
  for (const workspace of workspaces) await publicSkillPass(workspace.id, checkedAt);
  for (const workspace of workspaces) await portraitPass(workspace.id, checkedAt);
  // Authorized folders: what changed since the last tick is read (at most forty files a folder a tick), before filing runs over it.
  for (const workspace of workspaces) await folderPass(workspace.id, checkedAt);
  // Uploaded files are filed under the project their own name or opening names; what stays unclear is asked about on 待确认.
  for (const workspace of workspaces) {
    try {
      const filed = fileSourceDocuments(analysisStore, workspace.id);
      if (filed.length) console.info(JSON.stringify({ type: "source.project_inferred", checkedAt, workspaceId: workspace.id, filed }));
    } catch { /* housekeeping */ }
  }
  // The milestone gate. Without this it existed only inside `scripts/gate-loop-check.ts`, so on the
  // real ledger a milestone-bound work order reached `evidence_review`, the approvals page said
  // 「等待里程碑闸门」 — and nothing was ever going to judge it. A verdict other than `pass` holds the
  // order for a person, so a held order is skipped rather than re-judged every fifteen minutes.
  for (const workspace of workspaces) {
    enterUsageWorkspace(workspace.id);
    for (const workOrderId of pendingMilestoneGates(analysisStore, workspace.id)) {
      const outcome = await getMilestoneGate(workspace.id)(workOrderId).catch(() => undefined);
      if (outcome) console.info(JSON.stringify({ type: `milestone_gate.${outcome.state}`, checkedAt, workspaceId: workspace.id, ...outcome }));
    }
  }
  // Calendar reality is pulled every tick. It never rewrites an approved plan — a change there becomes
  // a new draft whose diffs are conflicts for the person to look at.
  {
    for (const workspace of workspaces) {
      const outcome = await syncCalendarFor(workspace.id).catch((error): SyncOutcome =>
        ({ state: "blocked", code: "GRAPH_SYNC_FAILED", message: error instanceof Error ? error.message : "" }));
      if (!outcome) continue;
      recordCalendarOutcome(analysisStore, workspace.id, outcome, checkedAt);
      await calendarLinePass(workspace.id, checkedAt);
      if (outcome.state === "blocked" || outcome.changes > 0 || outcome.resynced) {
        console.info(JSON.stringify({ type: `graph.${outcome.state}`, checkedAt, workspaceId: workspace.id, ...outcome }));
      }
    }
  }
  // The nightly expansion decides for itself whether this tick is its moment; most ticks are not.
  for (const workspace of workspaces) {
    enterUsageWorkspace(workspace.id);
    // The nightly flywheel, research and the assistant run only while the person is around (docs/review-2026-10-13.md §6.1): their
    // results are for someone to look at, and for days nobody did.
    if ((await spendFor(workspace.id)).engagement !== "active") continue;
    const decision = paused(workspace.id, "nightly") ? undefined : await getNightly(workspace.id)().catch(() => undefined);
    if (decision && !decision.run && decision.code !== "BEFORE_PLANNED_TIME" && decision.code !== "ALREADY_RAN_TODAY") {
      console.info(JSON.stringify({ type: "flywheel.nightly.skipped", checkedAt, workspaceId: workspace.id, code: decision.code }));
    }
    startDiligencePass(workspace.id, checkedAt);
    // A workflow the person asked for goes before the assistant's own background work, which would otherwise keep it busy.
    await workflowPass(workspace.id, checkedAt).catch(() => undefined);
    // The assistant starts approved kinds of work by itself; it never holds the tick (its runs are detached).
    if (codexSupervisor) await agentService.pass(workspace.id).catch(() => undefined);
  }
  // Bounded, and never able to wedge the tick: a health probe that neither errors nor fires its socket
  // timeout — which is what a web server killed mid-response looks like — would otherwise hold the
  // whole tick open forever, and the next interval would start a second one on top of it.
  await Promise.race([
    new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
    new Promise<void>((resolve) => {
    const request = get(webHealthUrl, (response) => {
      response.resume();
      console.info(JSON.stringify({ type: "worker.tick", checkedAt, webStatus: response.statusCode ?? 0 }));
      resolve();
    });
    request.on("error", (error) => {
      console.warn(JSON.stringify({ type: "worker.blocked", checkedAt, code: "WEB_UNREACHABLE", message: error.message }));
      resolve();
    });
    request.setTimeout(5_000, () => request.destroy(new Error("health check timeout")));
    })
  ]);
}

let codexSupervisor: CodexSupervisor | undefined;
mkdirSync(dataDir, { recursive: true });
if (!claimWorkerLock()) {
  // Exit 0: the watchdog re-runs the launcher on a schedule, and a healthy worker already running is
  // the success case, not a failure to report.
  console.info(JSON.stringify({ type: "worker.already_running", lockPath }));
  process.exit(0);
}
const analysisStore = new CrosslineStore(path.join(dataDir, "crossline.db"));
// Keys and links that are credentials (a model provider's key, a calendar's private link): DPAPI files, never the ledger.
const secrets = createDpapiSecretStore(dataDir);
// A workspace's own third-party model (R7): Codex reaches it through this local gateway, which adds the key (model-gateway.ts).
const modelProviders = createModelProviderService({
  store: analysisStore, secrets, cwd: repoRoot,
  gateway: await startModelGateway({ resolve: (workspaceId, providerId) => modelProviders.upstream(workspaceId, providerId) }),
  signedIn: (workspaceId) => codexSupervisor?.runtimes?.signedIn(workspaceId) ?? true,
  client: async (workspaceId) => {
    const runtime = await codexSupervisor?.runtimes?.client(workspaceId);
    return runtime?.ok ? runtime.client : codexSupervisor?.clientFor(workspaceId);
  }
});
setProviderResolver((workspaceId) => modelProviders.routing(workspaceId));
// Screen activity: a foreground-window reader feeding a tracker that asks every workspace for its own consent on every
// reading. Without consent nothing is stored; the source itself reads only the window's app, title and idle time.
const activityIntervalSeconds = Math.max(5, Number(process.env.CROSSLINE_ACTIVITY_INTERVAL_SECONDS) || 60);
const activityTracker = createActivityTracker(analysisStore, () => analysisStore.listWorkspaces().map((workspace) => workspace.id).filter(machineOwner), activityIntervalSeconds);
const activitySource = createWindowsActivitySource({ intervalSeconds: activityIntervalSeconds });
if (process.env.CROSSLINE_RUN_ONCE !== "1") activitySource.start((reading) => activityTracker.handle(reading));
process.on("exit", () => activitySource.stop());
/** A workspace's own quota: the owner's runtime for the owner, the account's own for anyone else (which starts it when connected). */
const readCost = async (workspaceId?: string) => codexSupervisor
  ? await codexSupervisor.readCostSignal(workspaceId)
  : { available: false as const, reason: "CODEX_SUPERVISOR_UNAVAILABLE" };
// One nightly decision per real workspace. This used to be a single instance bound to the pre-accounts
// workspace id, so no account created since ever had its flywheel expanded, whatever the hour or the budget.
// What every Skill run cost goes into the ledger, and how tight the quota is decides which model a run may use.
// The quota reading is cached for a minute inside the runner; an unreadable quota counts as normal, so a broken
// probe never quietly moves everything onto a cheaper model.
setUsageSink((usage) => {
  if (!usage.workspaceId) return;
  analysisStore.saveModelUsage({
    workspaceId: usage.workspaceId, skill: usage.skillName, tier: usage.tier ?? "", model: usage.model ?? "", effort: usage.effort ?? "",
    spendMode: usage.spendMode, threadId: usage.threadId ?? "", ok: usage.ok, errorCode: usage.errorCode ?? "", repairs: usage.repairs, turns: usage.turns,
    inputTokens: usage.inputTokens, cachedInputTokens: usage.cachedInputTokens, outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningOutputTokens, totalTokens: usage.totalTokens, durationMs: usage.durationMs, at: usage.at
  });
});
// Unreadable reads as manual_core_only here, which routes like normal: only economy steps a Skill down.
setSpendModeProvider(async (workspaceId) => backgroundSpend(await readCost(workspaceId)).mode);
// The one quota gate for every background pass (core: keeps the person's own work moving; discretionary: nobody is waiting on it).
const spendFor = createBackgroundSpend(analysisStore, (workspaceId) => readCost(workspaceId));
/** A kind of background work the person paused on the background tasks page (the assistant has its own `agent.paused`). */
const paused = (workspaceId: string, kind: BackgroundKind): boolean => pausedKinds(analysisStore.getSetting(workspaceId, BACKGROUND_PAUSED)).has(kind);
const nightlies = new Map<string, ReturnType<typeof createNightlyFlywheel>>();
const getNightly = (workspaceId: string) => {
  let nightly = nightlies.get(workspaceId);
  if (!nightly) {
    nightly = createNightlyFlywheel({
      store: analysisStore, workspaceId, readCost: () => readCost(workspaceId),
      expand: createFlywheelExpander(analysisStore, workspaceId, repoRoot, () => codexSupervisor?.clientFor(workspaceId))
    });
    nightlies.set(workspaceId, nightly);
  }
  return nightly;
};
// Recordings are turned into text on this machine. The recogniser may only reach the network inside the
// one-time model download the person agreed to; see `transcribe.ts`.
const transcriber = createTranscriber({ ...createWhisperEngine(modelsDirectory(dataDir)), modelsDir: modelsDirectory(dataDir) });
// One recording at a time: transcription is CPU-bound and a second would only slow the first.
let transcribeQueue: Promise<void> = Promise.resolve();
async function transcribeDocument(workspaceId: string, documentId: string): Promise<{ state: string; documentId: string }> {
  const doc = analysisStore.listSourceDocuments(workspaceId).find((item) => item.id === documentId);
  if (!doc) return { state: "blocked", documentId };
  const status = await transcriber.status();
  if (status.state !== "ready") {
    const note = status.state === "unavailable" ? status.message
      : status.state === "downloading" ? "正在下载语音识别模型，下载完会自动开始转写。"
      : `转写录音需要先下载语音识别模型（约 ${status.approxMegabytes} MB，一次性，之后完全离线）。`;
    analysisStore.setSourceDocumentExtraction(workspaceId, doc.id, { status: "pending", text: "", note });
    return { state: "waiting_for_model", documentId };
  }
  analysisStore.setSourceDocumentExtraction(workspaceId, doc.id, { status: "pending", text: "", note: "正在转写…" });
  transcribeQueue = transcribeQueue.then(async () => {
    try {
      const bytes = new Uint8Array(readFileSync(fileURLToPath(doc.uri)));
      const result = await transcriber.transcribe(bytes, doc.fileName, process.env.CROSSLINE_TRANSCRIBE_LANGUAGE?.trim() || undefined);
      if (result.state === "transcribed") {
        analysisStore.setSourceDocumentExtraction(workspaceId, doc.id, { status: "done", text: result.text, note: `本机转写，约 ${Math.round(result.seconds / 60)} 分钟的录音。` });
      } else {
        analysisStore.setSourceDocumentExtraction(workspaceId, doc.id, { status: "failed", text: "",
          note: result.state === "failed" ? result.message : "语音识别模型还没有准备好。" });
      }
    } catch {
      analysisStore.setSourceDocumentExtraction(workspaceId, doc.id, { status: "failed", text: "", note: "读不到已保存的录音。" });
    }
  }).catch(() => undefined);
  return { state: "transcribing", documentId };
}
/** After the model arrives, every recording that was waiting for it starts. */
// Files read before columns were kept (a schedule table came out as a list nobody could tell the columns of) are read once more.
void (async () => {
  for (const workspace of analysisStore.listWorkspaces()) {
    const changed = await reextractForLayout(analysisStore, workspace.id, (uri) => new Uint8Array(readFileSync(fileURLToPath(uri)))).catch(() => 0);
    if (changed) console.info(JSON.stringify({ type: "extract.layout_reread", workspaceId: workspace.id, files: changed }));
  }
})();

async function resumeWaitingRecordings(): Promise<void> {
  for (const workspace of analysisStore.listWorkspaces()) {
    for (const doc of analysisStore.listSourceDocuments(workspace.id)) {
      if (doc.kind === "audio" && doc.extractionStatus === "pending") await transcribeDocument(workspace.id, doc.id);
    }
  }
}
const diligenceRunners = new Map<string, ReturnType<typeof createDiligenceRunner>>();
const getDiligence = (workspaceId: string) => {
  let runner = diligenceRunners.get(workspaceId);
  if (!runner) {
    runner = createDiligenceRunner(analysisStore, workspaceId, repoRoot, () => codexSupervisor?.clientFor(workspaceId), { readCost: () => readCost(workspaceId) });
    diligenceRunners.set(workspaceId, runner);
  }
  return runner;
};
// The token session for writing to the Crossline calendar: the same cache as reading, asked for the calendar-write scopes only.
// Made on first use so a machine that never enables writing never builds it.
let calendarWriteSession: Promise<Awaited<ReturnType<typeof createGraphAuthSession>> | undefined> | undefined;
const getCalendarWriteSession = () => calendarWriteSession ??= (async () => {
  const clientId = process.env.CROSSLINE_MS_CLIENT_ID?.trim();
  if (!clientId) return undefined;
  return createGraphAuthSession({ clientId, ...(process.env.CROSSLINE_MS_TENANT_ID?.trim() ? { tenantId: process.env.CROSSLINE_MS_TENANT_ID.trim() } : {}), access: "calendar-write" });
})().catch(() => undefined);
// The writer account's sign-in from the calendar card: the same MSAL cache the publisher reads, so a new token is used at once.
const calendarWriteLogin = createWriteLogin(analysisStore, { session: getCalendarWriteSession, ownerOf: (workspaceId) => ownerOf(analysisStore, workspaceId) });
const agentService = createAgentService({
  // The shell assistant runs on the machine owner's runtime only: it works with the operating system user's files, and a guard is a
  // tripwire, not a sandbox, so it is not offered to other accounts on this machine (docs/model-providers.md).
  store: analysisStore, repoRoot, getClient: () => codexSupervisor?.client, readCost: () => readCost(), isOwner: machineOwner,
  log: (event) => console.info(JSON.stringify({ ...event, checkedAt: new Date().toISOString() }))
});
for (const workspace of analysisStore.listWorkspaces()) {
  const lost = agentService.recoverLost(workspace.id);
  if (lost.length) console.info(JSON.stringify({ type: "agent.recovered_lost", workspaceId: workspace.id, lost, checkedAt: new Date().toISOString() }));
  const salvaged = agentService.salvageStopped(workspace.id);
  if (salvaged.length) console.info(JSON.stringify({ type: "agent.salvaged", workspaceId: workspace.id, salvaged, checkedAt: new Date().toISOString() }));
  // Once: the locks and 「deleted by the person」 marks that overlapping calendar publishes left behind (before the supervisor serves a publish).
  const repaired = repairFrozenRace(analysisStore, workspace.id, ownerOf(analysisStore, workspace.id));
  if (repaired && (repaired.released.length || repaired.republished.length))
    console.info(JSON.stringify({ type: "repair.frozen_race", workspaceId: workspace.id, released: repaired.released.length, republished: repaired.republished.length, checkedAt: new Date().toISOString() }));
  // Once: imported class blocks a date batch put on the plan twice (a weekly class and that day's dated session in one slot).
  const deduped = repairDuplicateImports(analysisStore, workspace.id, ownerOf(analysisStore, workspace.id));
  if (deduped) console.info(JSON.stringify({ type: "repair.import_duplicates", workspaceId: workspace.id, removed: deduped.removed, checkedAt: new Date().toISOString() }));
  // First drafts begun by a worker that stopped before any milestone existed were lost with it: forget the start, so the pass runs
  // again and the screens do not say 「正在设计」 for a run nobody is doing.
  if (analysisStore.getSetting(workspace.id, FIRST_DRAFTS_SETTING) && !analysisStore.listMilestones(workspace.id).length)
    analysisStore.deleteSetting(workspace.id, FIRST_DRAFTS_SETTING);
}
const diligencePasses = new Set<string>();
/**
 * The automatic research pass: once the interview is complete (or a report already exists, which makes this
 * the weekly refresh), each line whose last report is a week old is researched, one after another, in the
 * background. It never holds the tick, because a line can take ten minutes and the calendar should not wait.
 */
function startDiligencePass(workspaceId: string, checkedAt: string): void {
  if (paused(workspaceId, "research")) return;
  if (diligencePasses.has(workspaceId)) return;
  const interviewDone = analysisStore.getLatestOnboardingSession(workspaceId)?.state === "complete";
  const hasReport = analysisStore.listDiligenceReports(workspaceId).some((report) => report.status === "done");
  if (!interviewDone && !hasReport) return;
  const due = linesDueForDiligence(analysisStore, workspaceId, new Date());
  if (!due.length) return;
  diligencePasses.add(workspaceId);
  void (async () => {
    enterUsageWorkspace(workspaceId);
    for (const identityId of due) {
      const outcome = await getDiligence(workspaceId)(identityId).catch((error): { state: "blocked"; code: string; message: string } =>
        ({ state: "blocked", code: "DILIGENCE_FAILED", message: error instanceof Error ? error.message : "" }));
      console.info(JSON.stringify({ type: `diligence.${outcome.state}`, checkedAt, workspaceId, identityId, ...outcome }));
      // A tight budget applies to every line alike: stop rather than ask the next one and be told the same.
      if (outcome.state === "blocked" && /BUDGET|COST_SIGNAL/.test(outcome.code)) break;
    }
  })().finally(() => diligencePasses.delete(workspaceId));
}
// Where every task's manualbook (and anything the assistant saves for a task) lives: inside the data directory, so a
// backup carries it and it is never written into the repository.
const materialsDir = path.join(dataDir, "materials");
// Material preparation and the milestone gate used to be created once, bound to a single hardcoded
// workspace — every real account's own `preparing`/`evidence_review` work orders were invisible to
// both the automatic tick and the manual "重新准备材料"/"现在判定" buttons, since neither ever operated
// on any workspace but that one. `createMaterialPreparer`/`createMilestoneGate`'s other arguments (the
// store, repoRoot, the Codex client getter, the cost reader) are not workspace-specific, so a per-real-
// workspace closure is cheap to build and safe to cache.
const materialPreparers = new Map<string, ReturnType<typeof createManualbookBuilder>>();
const getMaterialPreparer = (workspaceId: string) => {
  let preparer = materialPreparers.get(workspaceId);
  if (!preparer) {
    preparer = createManualbookBuilder(analysisStore, workspaceId, materialsDir, repoRoot, () => codexSupervisor?.clientFor(workspaceId), { readCost: () => readCost(workspaceId) });
    materialPreparers.set(workspaceId, preparer);
  }
  return preparer;
};
const milestoneGates = new Map<string, ReturnType<typeof createMilestoneGate>>();
const getMilestoneGate = (workspaceId: string) => {
  let gate = milestoneGates.get(workspaceId);
  if (!gate) {
    gate = createMilestoneGate(analysisStore, workspaceId, repoRoot, () => codexSupervisor?.clientFor(workspaceId));
    milestoneGates.set(workspaceId, gate);
  }
  return gate;
};
// Same fix, same reason: `createCaptureAnalyzer` used to close over a hardcoded workspace id (and an
// `ownerId === <the old constant>` read filter on top of it), so a real account's own captures and approved
// milestones were invisible to it — analysis threw `CAPTURE_NOT_FOUND` or
// `ANALYSIS_APPROVED_MILESTONE_REQUIRED` regardless of what was actually on the ledger.
const captureAnalyzers = new Map<string, ReturnType<typeof createCaptureAnalyzer>>();
const getCaptureAnalyzer = (workspaceId: string) => {
  let analyzer = captureAnalyzers.get(workspaceId);
  if (!analyzer) {
    analyzer = createCaptureAnalyzer(analysisStore, workspaceId, repoRoot);
    captureAnalyzers.set(workspaceId, analyzer);
  }
  return analyzer;
};
/** The ranking the web app sent, kept only where every field has the shape the explainer expects. */
const readRanking = (value: unknown): PlanRankingInput | undefined => Array.isArray(value) ? value.slice(0, 60).flatMap((item) => {
  const row = item as Record<string, unknown>;
  const text = (key: string) => typeof row[key] === "string" ? (row[key] as string).slice(0, 300) : null;
  return typeof row.id === "string" && typeof row.tier === "number" && typeof row.weight === "number"
    ? [{ id: row.id, tier: row.tier, weight: row.weight, deadline: text("deadline"), firstDay: text("firstDay"), firstStart: text("firstStart"), blocker: text("blocker") }]
    : [];
}) : undefined;
const planExplainers = new Map<string, ReturnType<typeof createPlanExplainer>>();
const getPlanExplainer = (workspaceId: string) => {
  let explainer = planExplainers.get(workspaceId);
  if (!explainer) {
    explainer = createPlanExplainer(analysisStore, workspaceId, repoRoot, () => codexSupervisor?.clientFor(workspaceId));
    planExplainers.set(workspaceId, explainer);
  }
  return explainer;
};
const weeklyInsights = new Map<string, ReturnType<typeof createWeeklyInsight>>();
const getWeeklyInsight = (workspaceId: string) => {
  let insight = weeklyInsights.get(workspaceId);
  if (!insight) {
    insight = createWeeklyInsight(analysisStore, workspaceId, repoRoot, () => codexSupervisor?.clientFor(workspaceId));
    weeklyInsights.set(workspaceId, insight);
  }
  return insight;
};
/** The zone calendar events are placed in: the person's setting, else the machine's configured zone. */
const calendarZone = (workspaceId: string): string | undefined => {
  const raw = analysisStore.getSetting(workspaceId, "schedule.preferences");
  if (raw) {
    try {
      const zone = (JSON.parse(raw) as { timeZone?: unknown }).timeZone;
      if (typeof zone === "string") {
        new Intl.DateTimeFormat("en", { timeZone: zone });
        return zone;
      }
    } catch { /* An unreadable setting must not stop calendar sync. */ }
  }
  return process.env.CROSSLINE_TIME_ZONE;
};
// Calendars read from a subscription link (calendar-subscriptions.ts): no Graph, no sign-in, any workspace.
const subscriptionDeps = { secrets, fetch: defaultSafeGetDeps() };
const subscriptionsOf = (workspaceId: string) => subscriptionSources(analysisStore, workspaceId, subscriptionDeps, () => calendarZone(workspaceId));
// A workspace that reads only subscriptions (no Graph login of its own) has its own syncer over them alone.
const subscriptionSyncers = new Map<string, ReturnType<typeof createGraphSync>>();
const subscriptionSync = (workspaceId: string) => {
  let syncer = subscriptionSyncers.get(workspaceId);
  if (!syncer) {
    syncer = createGraphSync(analysisStore, workspaceId, { sources: () => subscriptionsOf(workspaceId), timeZone: () => calendarZone(workspaceId) });
    subscriptionSyncers.set(workspaceId, syncer);
  }
  return syncer;
};

/**
 * Graph calendar sync only exists when a client id is configured. Without one there is nothing to read, and
 * inventing a connector that always fails would put a permanent blocker on every tick.
 *
 * The Graph login itself is one credential session for the whole worker process — signing in is a real
 * interactive device-code flow done once (`scripts/graph-add-account.ts`), not a per-workspace thing.
 * What was wrong was never the credential; it was that every function built from it closed over one
 * hardcoded `workspaceId`, so the real ledger rows (selection, sync cursor, imported blocks) it read and
 * wrote always landed on that one legacy workspace regardless of which real account actually asked.
 * `sync`/`listSources`/`saveSources` below all take the real caller's `workspaceId` as a parameter now.
 */
const calendar = await (async () => {
  const clientId = process.env.CROSSLINE_MS_CLIENT_ID?.trim();
  // Said out loud: "no log at all" made an unconfigured sync indistinguishable from a broken one.
  if (!clientId) { console.info(JSON.stringify({ type: "graph.not_configured" })); return undefined; }
  try {
    const credential = await createGraphAuthSession({
      clientId,
      ...(process.env.CROSSLINE_MS_TENANT_ID?.trim() ? { tenantId: process.env.CROSSLINE_MS_TENANT_ID.trim() } : {}),
      access: "read"
    });
    // No token means nobody has signed in yet. That is a normal state, not a failure to report every
    // fifteen minutes: the sync simply does not start until the device-code login has been done.
    if (!await credential.getAccessToken()) {
      console.info(JSON.stringify({ type: "graph.not_signed_in" }));
      return undefined;
    }
    const reader = (bound: GraphCredentialProvider, calendarId?: string) =>
      new GraphReadSource({ credential: bound, futureDays: 63, ...(calendarId ? { calendarId } : {}) });

    // A newly signed-in account arrives with its default calendar already ticked instead of appearing
    // to do nothing — done once per real workspace (not once globally), the first time any of the three
    // functions below is actually asked about that workspace.
    const catalogueSeeded = new Set<string>();
    const ensureCatalogueSeeded = async (workspaceId: string) => {
      if (catalogueSeeded.has(workspaceId)) return;
      catalogueSeeded.add(workspaceId);
      const catalogue = await listCatalogue(credential, analysisStore, workspaceId, reader);
      seedNewAccounts(analysisStore, workspaceId, catalogue);
      console.info(JSON.stringify({
        type: "graph.calendars", workspaceId, accounts: catalogue.length,
        selected: readSelection(analysisStore, workspaceId).length
      }));
    };
    const syncers = new Map<string, ReturnType<typeof createGraphSync>>();
    const getSyncer = (workspaceId: string) => {
      let syncer = syncers.get(workspaceId);
      if (!syncer) {
        syncer = createGraphSync(analysisStore, workspaceId, {
          // Resolved per tick, so unticking a calendar takes effect on the next sync with no restart. One syncer over every source
          // (Graph calendars and subscriptions alike): per-source authority drops the blocks of any source not in this list.
          sources: () => [...buildSources(analysisStore, workspaceId, credential, reader), ...subscriptionsOf(workspaceId)],
          timeZone: () => calendarZone(workspaceId)
        });
        syncers.set(workspaceId, syncer);
      }
      return syncer;
    };

    // Another account on the same install never reads the owner's calendar; what it was given before this rule is withdrawn by one sync
    // with no sources (a source with no selection loses its blocks), so the owner's meetings leave its plan too.
    const foreign = async (workspaceId: string): Promise<SyncOutcome | null> => {
      if (mayUseGraphLogin(analysisStore, workspaceId)) return null;
      const withdrew = withdrawForeignCalendar(analysisStore, workspaceId);
      {
        // A sync with no sources refuses to run, so what came from the owner's calendar is taken out here: its blocks leave the current plan.
        const plan = analysisStore.listPlanVersions(workspaceId)[0];
        let removedBlocks = false;
        if (plan) {
          const payload = (plan.payload ?? {}) as { blocks?: Array<{ id?: string }> };
          if (Array.isArray(payload.blocks) && payload.blocks.some((block) => String(block.id ?? "").startsWith("graph_calendar:"))) {
            removedBlocks = true;
            analysisStore.savePlanVersion({ ...plan, payload: { ...payload, blocks: payload.blocks.filter((block) => !String(block.id ?? "").startsWith("graph_calendar:")) } });
          }
        }
        if (withdrew || removedBlocks) console.info(JSON.stringify({ type: "graph.foreign_calendar_withdrawn", workspaceId, removedBlocks }));
      }
      return { state: "blocked", code: "GRAPH_LOGIN_OTHER_ACCOUNT", message: "本机的日历登录属于另一个账号；这个账号要读日历需用自己的微软账号登录。" };
    };
    return {
      sync: async (workspaceId: string) => {
        // Not this machine's Graph login, but calendars of its own by link: those are read, and the owner's blocks leave with the
        // selection withdrawn (a source not in the list loses its blocks).
        if (!mayUseGraphLogin(analysisStore, workspaceId) && hasSubscriptions(analysisStore, workspaceId)) {
          withdrawForeignCalendar(analysisStore, workspaceId);
          return subscriptionSync(workspaceId)();
        }
        return (await foreign(workspaceId)) ?? (await ensureCatalogueSeeded(workspaceId), getSyncer(workspaceId)());
      },
      listSources: async (workspaceId: string) => {
        if (await foreign(workspaceId)) return [];
        await ensureCatalogueSeeded(workspaceId);
        const fresh = await listCatalogue(credential, analysisStore, workspaceId, reader);
        seedNewAccounts(analysisStore, workspaceId, fresh);
        // Re-read rather than reuse: seeding may have ticked a calendar that the first pass showed
        // unticked, and showing the person a list that is already one step stale is how a checkbox
        // ends up disagreeing with what the next sync actually reads.
        return listCatalogue(credential, analysisStore, workspaceId, reader);
      },
      saveSources: async (workspaceId: string, keys: string[]) => {
        if (await foreign(workspaceId)) return [];
        await ensureCatalogueSeeded(workspaceId);
        const fresh = await listCatalogue(credential, analysisStore, workspaceId, reader);
        const wanted = new Set(keys);
        const selection = fresh.flatMap((account) => account.calendars
          .filter((calendar) => wanted.has(sourceKey(account.accountId, calendar.id)))
          .map((calendar) => ({
            accountId: account.accountId, calendarId: calendar.id,
            label: calendarLabel(calendar.name, account.username)
          })));
        // A key naming a calendar this account cannot see is dropped rather than stored: the stored
        // selection is what the next tick reads, and a source nobody can read is a permanent failure.
        saveSelection(analysisStore, workspaceId, selection);
        return listCatalogue(credential, analysisStore, workspaceId, reader);
      }
    };
  } catch {
    console.warn(JSON.stringify({ type: "worker.blocked", code: "GRAPH_AUTH_UNAVAILABLE" }));
    return undefined;
  }
})();

/**
 * One calendar sync per workspace: through Graph (subscriptions included) when this machine has a Graph login, else its
 * subscriptions alone; null when the workspace reads no calendar at all, which is not a failure to report.
 */
const syncCalendarFor = async (workspaceId: string): Promise<SyncOutcome | null> => {
  if (calendar) return calendar.sync(workspaceId);
  return hasSubscriptions(analysisStore, workspaceId) ? subscriptionSync(workspaceId)() : null;
};

// Independent from BETTER_AUTH_SECRET on purpose: the auth secret leaking should not also hand out the
// ability to trigger real Codex runs on the loopback supervisor port — see `packages/codex/src/capability.ts`.
const capabilitySecret = process.env.CROSSLINE_SUPERVISOR_CAPABILITY_SECRET?.trim();
if (!capabilitySecret) {
  console.warn(JSON.stringify({ type: "worker.blocked", code: "CROSSLINE_SUPERVISOR_CAPABILITY_SECRET_MISSING" }));
} else try {
  codexSupervisor = await startCodexSupervisor({
    port: supervisorPort,
    capabilitySecret,
    plugin: {
      name: "crossline",
      marketplacePath: path.join(repoRoot, "skills", "marketplace", ".agents", "plugins", "marketplace.json"),
      cwd: repoRoot,
      requiredSkills: REQUIRED_SKILLS
    },
    // Every account but the machine owner's runs on its own Codex (runtime-registry.ts), in its own home beside the owner's.
    // On the hosted beta as many other accounts at a time keep a runtime as model runs may go at once (`guestRuntimeLimit`: 2 on the
    // 1.6 GB host, 4 on the 3.5 GB one, set by deploy/server/run.sh), stopped after ten quiet minutes or when one more account needs
    // one and it has been quiet 15 s (never while a run is in flight; the newcomer waits); elsewhere three and half an hour.
    runtimes: { baseDir: runtimesDir(), ownerWorkspaceId: () => runtimeOwner(analysisStore), hasProvider: (workspaceId) => modelProviders.hasProvider(workspaceId),
      ...(hostedBeta ? { maxRunning: guestRuntimeLimit() ?? 2, idleMs: 10 * 60_000 } : {}) },
    modelProviders: { handle: (method, pathname, workspaceId, body) => modelProviders.handle(method, pathname, workspaceId, body),
      cost: (workspaceId) => modelProviders.cost(workspaceId) },
    monthSpend: (workspaceId) => monthSpend(analysisStore, workspaceId),
    autoAnalyzeCaptures: (workspaceId) => autoAnalyzePass(workspaceId),
    autoBackplanGoals: (workspaceId) => autoBackplanPass(workspaceId),
    runTaskPass: (workspaceId) => stepPlanPass(workspaceId),
    splitGoals: (workspaceId) => goalSplitPass(workspaceId),
    conciergeTurn: (workspaceId, request, signal) => { enterUsageWorkspace(workspaceId);
      return createConcierge(analysisStore, workspaceId, repoRoot, () => codexSupervisor?.clientFor(workspaceId))(request as unknown as ConciergeRequest, signal); },
    analyzeCapture: (client, id, signal, workspaceId) => getCaptureAnalyzer(workspaceId)(client, id, signal),
    // `workspaceId` is the real caller's, from its own verified capability token — not a hardcoded
    // constant, which is what left milestone proposal and goal backplanning invisible to any real
    // account the same way material prep/the milestone gate/calendar sync were (see `getMaterialPreparer`
    // above for the fuller explanation; this is the same bug, same fix, in the same file).
    proposeMilestones: (_client, request, signal, workspaceId, only) =>
      createMilestoneProposer(analysisStore, workspaceId, repoRoot, () => codexSupervisor?.clientFor(workspaceId))(request, signal, only)
        // The new drafts are read for risks right away, so the person sees them when deciding (in the background; the answer is not held for it).
        .finally(() => { void milestoneRiskPass(workspaceId).catch(() => undefined); }),
    continueMilestoneConversation: (_client, threadId, message, signal, workspaceId) =>
      createMilestoneConversation(analysisStore, workspaceId, repoRoot, () => codexSupervisor?.clientFor(workspaceId))(threadId, message, signal),
    onboardingTurn: (_client, sessionId, text, _signal, workspaceId, reread) =>
      createOnboardingSessionRunner(analysisStore, workspaceId, repoRoot, () => codexSupervisor?.clientFor(workspaceId))({ sessionId, text, ...(reread ? { reread: true } : {}) }),
    transcriptionStatus: () => transcriber.status(),
    startTranscriptionDownload: async () => {
      const current = await transcriber.status();
      if (current.state === "ready" || current.state === "downloading") return current;
      // Answered at once: the download is long, and the screen polls the status for its progress.
      void transcriber.download().then(() => resumeWaitingRecordings()).catch(() => undefined);
      return { state: "downloading", progress: 0 };
    },
    runDiligence: (_client, identityId, force, workspaceId) => getDiligence(workspaceId)(identityId, { force }),
    extractSource: (documentId, workspaceId) => extractDocument(documentId, workspaceId),
    // Authorized folders: a preview (what would be read) before anything is read, then the folder is kept and read in the background.
    sourceFolders: {
      preview: async (workspaceId: string, folderPath: string, names?: string[]) =>
        machineOwner(workspaceId) ? previewFolder(folderPath, folderDeps, personNames(analysisStore, workspaceId, names)) : OWNER_ONLY_FOLDER,
      add: async (workspaceId: string, folderPath: string, rules?: { exclude?: unknown; include?: unknown; names?: unknown }) => {
        if (!machineOwner(workspaceId)) return OWNER_ONLY_FOLDER;
        const added = await addFolder(analysisStore, workspaceId, folderPath, folderDeps, rules);
        // Read in the background: a folder can take minutes; the page shows its progress from the folder list.
        if (added.state === "added") void folderPass(workspaceId, new Date().toISOString()).catch(() => undefined);
        return added;
      },
      remove: async (workspaceId: string, id: string, purge?: boolean) => removeFolder(analysisStore, workspaceId, id, { purge: Boolean(purge), dataDir }),
      setRules: async (workspaceId: string, id: string, rules: { exclude?: unknown; include?: unknown; names?: unknown }) =>
        machineOwner(workspaceId) ? setFolderRules(analysisStore, workspaceId, id, rules, folderDeps) : OWNER_ONLY_FOLDER,
      setLines: async (workspaceId: string, id: string, lines: string[]) => ({ saved: setFolderLines(analysisStore, workspaceId, id, lines) })
    },
    extractBackgroundFacts: (_client, captureTitle, captureContext, signal, workspaceId) =>
      createBackgroundFactsExtractor(analysisStore, workspaceId, repoRoot, () => codexSupervisor?.clientFor(workspaceId))(captureTitle, captureContext, signal),
    backplanGoal: (_client, milestoneId, signal, workspaceId) =>
      createGoalBackplanner(analysisStore, workspaceId, repoRoot, () => codexSupervisor?.clientFor(workspaceId))(milestoneId, signal),
    // The same preparer/gate the tick loop uses, exposed so a person's retry gets an answer now rather
    // than at the next tick. `pendingMaterialWorkOrders`/`pendingMilestoneGates` still govern which
    // orders the loop itself picks up.
    prepareMaterials: (workOrderId, workspaceId) => getMaterialPreparer(workspaceId)(workOrderId),
    writePortrait: (workspaceId) => writePortraitFor(workspaceId),
    buildTutorial: (workOrderId, workspaceId) => { enterUsageWorkspace(workspaceId); return getMaterialPreparer(workspaceId)(workOrderId, { mode: "tutorial" }); },
    judgeMilestone: (workOrderId, workspaceId) => getMilestoneGate(workspaceId)(workOrderId),
    dispatchAgentTask: (workspaceId, workOrderId, category, stepId) => agentService.dispatch(workspaceId, workOrderId, category, stepId),
    agentProgress: (workspaceId, taskId) => agentService.progress(workspaceId, taskId),
    cancelAgentTask: (workspaceId, taskId) => agentService.cancel(workspaceId, taskId),
    retryAgentTask: async (workspaceId, taskId, input) => { const result = await agentService.retry(workspaceId, taskId, input); void workflowPass(workspaceId, new Date().toISOString()).catch(() => undefined); return result; },
    growWorkflows: (workspaceId) => { void workflowPass(workspaceId, new Date().toISOString()).catch(() => undefined); },
    workflowAction: (workspaceId, id, action, service) => {
      if (action === "login") return openWorkflowLogin(analysisStore, workspaceId, id, service, browserProfilesRoot(workspaceId));
      if (action === "login_done") return finishWorkflowLogin(analysisStore, workspaceId, id, service);
      const record = readGrownSkills(analysisStore, workspaceId).find((item) => item.id === id && item.status === "active");
      if (!record) return { ok: false, code: "WORKFLOW_NOT_ACTIVE", message: "这个工作流还没启用。" };
      if (isPaused(analysisStore, workspaceId)) return { ok: false, code: "AGENT_PAUSED", message: "助手已暂停。" };
      const started = startWorkflowRun(analysisStore, workspaceId, record, (input, after) => agentService.runFree(workspaceId, input, after), browserProfilesRoot(workspaceId));
      if (started.state === "started") markWorkflowRun(analysisStore, workspaceId, id, "started_by_person");
      return started.state === "started" ? { ok: true, taskId: started.taskId }
        : { ok: false, code: started.state === "blocked" ? started.code : "AGENT_CATEGORY_NOT_APPROVED", message: started.state === "blocked" ? started.message : `助手还没获准做「${started.label}」这类工作。` };
    },
    calendarWriteLogin: {
      start: (workspaceId: string) => calendarWriteLogin.start(workspaceId),
      status: (workspaceId: string) => calendarWriteLogin.status(workspaceId)
    },
    publishCalendar: async (workspaceId, blocks, scope) => {
      const session = await getCalendarWriteSession();
      if (!session) return { state: "blocked", code: "GRAPH_NOT_CONFIGURED", message: "没有配置 Microsoft 日历（CROSSLINE_MS_CLIENT_ID）。" };
      return createCalendarPublisher(analysisStore, workspaceId, { credentialFor: (accountId) => session.credentialFor(accountId) })(blocks, scope);
    },
    explainPlan: (today, workspaceId, ranking) => getPlanExplainer(workspaceId)(today, readRanking(ranking)),
    runWeeklyInsight: (workspaceId) => getWeeklyInsight(workspaceId)(),
    // 立即同步日历 records its outcome like a tick does, so a read that works clears 「日历无法读取」 at once. A workspace that reads no
    // calendar at all is told so, and nothing is recorded (it is not a failure).
    syncCalendar: async (workspaceId: string) => {
      const outcome = await syncCalendarFor(workspaceId);
      if (!outcome) return { state: "blocked", code: "CALENDAR_NOT_CONNECTED", message: "还没有接入任何日历。" };
      recordCalendarOutcome(analysisStore, workspaceId, outcome, new Date().toISOString());
      // New events are filed under their lines in the background; the answer does not wait for the model.
      void calendarLinePass(workspaceId, new Date().toISOString()).catch(() => undefined);
      return outcome;
    },
    // Subscription links: read once before they are kept, the link itself only in the secret store.
    calendarSubscriptions: {
      add: (workspaceId: string, input: { link: string; label: string }) =>
        addSubscription(analysisStore, workspaceId, subscriptionDeps, { ...input, timeZone: calendarZone(workspaceId) ?? "UTC" }),
      remove: async (workspaceId: string, id: string) => ({ removed: removeSubscription(analysisStore, workspaceId, secrets, id) })
    },
    // Undefined when no client id is configured or nobody has signed in, in which case the routes are
    // simply not mounted and the card says the connector is unavailable rather than lying.
    ...(calendar ? {
      listCalendarSources: (workspaceId: string) => calendar.listSources(workspaceId),
      saveCalendarSources: (workspaceId: string, keys: string[]) => calendar.saveSources(workspaceId, keys)
    } : {})
  });
  console.info(JSON.stringify({ type: "codex.supervisor.ready", url: codexSupervisor.url, runtimeOwner: runtimeOwner(analysisStore) ?? null }));
  // Other accounts' runtimes stop after a quiet spell (above), so an idle account holds no process.
  setInterval(() => codexSupervisor?.runtimes?.stopIdle(), 60_000).unref();
  // One model run at a time on the hosted beta, and none started above the memory high-water mark (model-gate.ts).
  configureModelGate({ probe: () => containerMemory(), reclaim: () => codexSupervisor?.runtimes?.reclaim() });
  // What the health check and the logs read: memory in use, its ceiling and peak, and the gate's line, every five minutes.
  const mb = (bytes: number | undefined) => bytes === undefined ? null : Math.round(bytes / 1048576);
  setInterval(() => {
    const gate = modelGateStatus();
    console.info(JSON.stringify({ type: "worker.memory", usedMb: mb(gate.memory?.used), limitMb: mb(gate.memory?.limit), peakMb: mb(containerPeak()),
      active: gate.active, queued: gate.queued }));
  }, 5 * 60_000).unref();
} catch {
  console.warn(JSON.stringify({ type: "worker.blocked", code: "CODEX_SUPERVISOR_START_FAILED" }));
}

const releaseWorkerLock = (): void => {
  try { rmSync(lockPath, { force: true }); } catch { /* a leftover lock goes stale on its own */ }
};

await tick();
if (process.env.CROSSLINE_RUN_ONCE === "1") {
  await codexSupervisor?.stop();
  analysisStore.close();
  releaseWorkerLock();
} else {
  // Never two ticks at once. Material preparation and the milestone gate each allow ten minutes, so on
  // a fifteen-minute interval a tick that does real work routinely outlives the gap to the next one —
  // overlap is the normal case, not an edge case. Two concurrent ticks read the same pending list
  // before either writes, so the same order gets prepared or judged twice, two calendar syncs race on
  // one delta cursor, and the nightly window is evaluated twice. A skipped tick costs fifteen minutes;
  // an overlapping one costs duplicated Codex spend and a corrupted cursor.
  // Notifications run on their own short clock, not inside the tick: a tick can spend an hour preparing
  // materials, and a morning brief that arrives at noon is not a morning brief. Reads only; never overlaps.
  // The person's phones (Web Push through the platform's push service, encrypted for the device; see packages/connectors/src/web-push.ts).
  // Devices the service reports gone are dropped, so a removed home-screen app is not retried every two minutes.
  const pushToPhones = async (workspaceId: string, message: { title: string; body: string; path: string; tag: string }): Promise<boolean> => {
    const devices = listPushSubscriptions(analysisStore, workspaceId);
    if (!devices.length) return false;
    const keys = loadVapidKeys(dataDir);
    const results = await Promise.all(devices.map((device) => sendWebPush(device, message, keys)));
    removePushSubscriptions(analysisStore, workspaceId, devices.filter((_, index) => results[index] === "gone").map((device) => device.endpoint));
    return results.includes("sent");
  };
  let notifying = false;
  if (process.env.CROSSLINE_NOTIFY !== "off") setInterval(() => {
    if (notifying) return;
    notifying = true;
    void (async () => {
      for (const workspace of analysisStore.listWorkspaces()) {
        try {
          // The desktop toast shows on this computer's screen: only for its owner. A guest is told on their own subscribed devices.
          const sent = await notifyPass(analysisStore, workspace.id, new Date(), machineOwner(workspace.id) ? undefined : async () => false, undefined, pushToPhones);
          if (sent.length) console.info(JSON.stringify({ type: "notification.sent", workspaceId: workspace.id, sent }));
        } catch { /* a notification is never worth a crash */ }
      }
    })().finally(() => { notifying = false; });
  }, 2 * 60_000);
  // Coding-agent history, time only, for workspaces that said yes (Settings → 隐私): checked every five minutes, read when a summary is
  // missing (just switched on) or six hours old.
  const zoneOf = (workspaceId: string) => {
    try {
      const zone = (JSON.parse(analysisStore.getSetting(workspaceId, "schedule.preferences") ?? "{}") as { timeZone?: unknown }).timeZone;
      if (typeof zone === "string") { new Intl.DateTimeFormat("en", { timeZone: zone }); return zone; }
    } catch { /* default below */ }
    return process.env.CROSSLINE_TIME_ZONE ?? "America/Chicago";
  };
  let readingHistory = false;
  const historyPass = () => {
    if (readingHistory) return;
    readingHistory = true;
    void agentHistoryPass(analysisStore, analysisStore.listWorkspaces().map((workspace) => workspace.id).filter(machineOwner), dataDir, zoneOf)
      .catch((error) => console.warn(JSON.stringify({ type: "agent_history.failed", message: error instanceof Error ? error.message : "" })))
      .finally(() => { readingHistory = false; });
  };
  setInterval(() => {
    const stale = analysisStore.listWorkspaces().some((workspace) => {
      if (analysisStore.getSetting(workspace.id, AGENT_HISTORY_CONSENT) !== "on") return false;
      const updatedAt = (JSON.parse(analysisStore.getSetting(workspace.id, AGENT_HISTORY_SUMMARY) ?? "{}") as { updatedAt?: string }).updatedAt;
      return !updatedAt || Date.now() - Date.parse(updatedAt) > 6 * 3_600_000;
    });
    if (stale) historyPass();
  }, 5 * 60_000);
  // An installed copy's usage metadata (docs/local-installer.md, 回传): a no-op unless the launcher set the collector up.
  let reporting = false;
  const report = () => {
    if (reporting) return;
    reporting = true;
    void telemetryPass({ store: analysisStore, workspaceId: runtimeOwner(analysisStore), dataDir,
      accountEmail: async () => {
        const account = (await codexSupervisor?.client.request("account/read", { refreshToken: false }) as { account?: { type?: string; email?: string } | null } | undefined)?.account;
        return account?.type === "chatgpt" && typeof account.email === "string" ? account.email : undefined;
      } })
      .then((outcome) => { if (!("skipped" in outcome)) console.info(JSON.stringify({ type: "telemetry.pass", ...outcome })); })
      .catch(() => undefined).finally(() => { reporting = false; });
  };
  if (process.env.CROSSLINE_TELEMETRY_URL) { setTimeout(report, 60_000).unref(); setInterval(report, 15 * 60_000); }
  let ticking = false;
  setInterval(() => {
    if (ticking) {
      console.info(JSON.stringify({ type: "worker.tick_skipped", reason: "PREVIOUS_TICK_STILL_RUNNING" }));
      return;
    }
    ticking = true;
    void tick().catch((error) => {
      console.warn(JSON.stringify({ type: "worker.tick_failed",
        message: error instanceof Error ? error.message : "" }));
    }).finally(() => { ticking = false; });
  }, intervalMinutes * 60_000);
  const shutdown = async () => {
    await codexSupervisor?.stop();
    analysisStore.close();
    releaseWorkerLock();
    process.exit(0);
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
}

/**
 * What a calendar read left behind, kept where the web reads it (an ask: 「日历无法读取」) and cleared by the next clean read — from the
 * tick or from 立即同步日历. It used to be a log line only, so a signed-out account looked exactly like a quiet calendar; and the button
 * once read the calendar without clearing it, so the ask outlived the fix by a whole tick.
 */
function recordCalendarOutcome(store: CrosslineStore, workspaceId: string, outcome: SyncOutcome, at: string): void {
  // Not reading a calendar that belongs to another account on this install is not a failure to ask anyone about.
  const failure = outcome.state === "blocked" && outcome.code === "GRAPH_LOGIN_OTHER_ACCOUNT" ? undefined
    : outcome.state === "blocked" ? { code: outcome.code, message: outcome.message ?? "", sources: [] as string[] }
    : outcome.failed?.length ? { code: outcome.failed[0]!.code, message: "", sources: outcome.failed.map((item) => item.label) } : undefined;
  try { store.setSetting(workspaceId, CALENDAR_SYNC_FAILURE, failure ? JSON.stringify({ ...failure, at }) : ""); } catch { /* housekeeping */ }
}

