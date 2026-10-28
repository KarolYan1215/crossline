import "@crossline/i18n/catalog/worker";
import { createHash, timingSafeEqual } from "node:crypto";
import { get } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { accountConcurrency, codexProcessEnvironment, configureModelGate, enterUsageWorkspace, forgetAccountModels, guestRuntimeLimit, installLocalPlugin, modelGateStatus, setLocaleProvider, setProviderResolver, setSpendModeProvider, setUsageLimitHandler, setUsageSink, startCodexSupervisor, startModelGateway, withUsagePurpose, withUsageWorkspace, type CodexSupervisor } from "@crossline/codex";
import { containerMemory, containerPeak, createCollectMemory, heldMemory } from "./memory";
import { createDpapiSecretStore } from "@crossline/connectors";
import { createModelProviderService } from "./model-provider";
import { createSponsorService, sponsorFromEnv, type SponsorService } from "./sponsor";
import { CrosslineStore, aiToolsFor, readLocale, recordGrownLogin, lessonsPass, backfillExtractWatermarks, backfillFactEvidence, grownHomeLine, interviewChecklistFor, isPaused, startConfirmedFor, listPushSubscriptions, readGrownSkills, readPublicSkills, removePushSubscriptions, repairOwnCompletions } from "@crossline/db";
import { capturesAwaitingAutoAnalysis, createCaptureAnalyzer } from "./analysis";
import { closeInterruptedCollections, createTopicClassifier, favouritesTopicPass } from "./favourites-topics";
import { workflowImprovePass } from "./workflow-improver";
import { workflowMergeDue, workflowMergePass } from "./workflow-merge";
import { NEEDS_PER_PASS, createNeedChecker, needsAwaitingCheck } from "./need-check";
import { autoApproveEligible } from "./auto-approval";
import { retireShadowedDemos } from "./demo-cleanup";
import { notifyPass } from "./notify";
import { createActivityTracker } from "./activity-recorder";
import { agentHistoryPass } from "./agent-history";
import { createDeviceLinkService, readDeviceLink } from "./device/link";
import { workerMode } from "./device/mode";
import { runDeviceWorker } from "./device/worker";
import { createWindowsActivitySource } from "./activity-source";
import { createNightlyFlywheel } from "./nightly";
import { createDiligenceRunner, linesDueForDiligence } from "./diligence";
import { createAgentService, defaultOutputRoot } from "./agent-service";
import { createMediaDescriber, realVideoTools } from "./note-media";
import { createCalendarPublisher } from "./calendar-publish";
import { repairDuplicateImports, repairFrozenRace } from "./calendar-repair";
import { repairLineAttributes } from "./attribute-repair";
import { returnTidy } from "./return-tidy";
import { workSplitRepair } from "./work-split-repair";
import { mailReminderRepair, moneyAskRepair } from "./mail-reminder-repair";
import { mailRecordsRepair } from "./mail-records-repair";
import { moneyReportPass } from "./money-report";
import { dateAdvancePass } from "./date-advance";
import { createWriteLogin } from "./calendar-write-login";
import { AGENT_HISTORY_CONSENT, AGENT_HISTORY_SUMMARY, BACKGROUND_PAUSED, DEVICE_TOKEN_SETTING, NODE_COMPUTE_SETTING, NODE_STATUS_SETTING, NODE_TOKEN_SETTING, EVAL_HOLD_FILE, evalHoldActive, backgroundSpend, hoursToOffPeakEnd, sponsorOffPeak, CALENDAR_SYNC_FAILURE, htmlLang, tFor, FIRST_DRAFTS_SETTING, grownSkillName, publicSkillName, pausedKinds, readyToStart, spendAllows, NON_CORE_PURPOSE, type BackgroundKind, type PlanRankingInput } from "@crossline/core";
import { createFlywheelExpander } from "./flywheel";
import { createManualbookBuilder, pendingMaterialWorkOrders, pendingTutorials } from "./manualbook";
import { startingWithin } from "./schedule-window";
import { createProgressJudge, createStepPlanner, createWarningReviewer, reportsAwaitingJudgement, requestFinerSplits, requestOutdatedReplans, settleOldQuestions, tasksAwaitingStepPlan, warningsAwaitingReview } from "./step-planner";
import { createArchetypeCurator, curationDue } from "./archetype-curator";
import { energyAdvicePass } from "./energy-advice";
import { dedupePass } from "./dedupe";
import { guestCodexHomes, importCodexMemories } from "./codex-memory-import";
import { createTaskTitler, untitledTasks } from "./task-titler";
import { createCalendarClassifier, unfiledCalendarEvents } from "./calendar-classifier";
import { createInsightCompiler, linesAwaitingMineSkill } from "./insight-compiler";
import { cleanPublicSkills, createPublicSkillInstaller, createSkillScout, lineSetupDue, scoutDue } from "./public-skills";
import { browserProfilesRoot, cleanGrownSkills, configureFavouritesCollector, configureRemoteLogin, finishWorkflowLogin, growCandidates, growTask, installGrown, loginBrowser, markWorkflowRun,
  openWorkflowLogin, resumeByPerson, sayToPerson, startWorkflowRun, workflowCollecting, workflowLoginTarget, workflowSchedulePass } from "./workflow-smith";
import { loginMode } from "./browser-launch";
import { createRemoteBrowsers } from "./remote-browser";
import { localeOf, tOfWorkspace } from "./locale";
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
import { createOnboardingExtractor, extractionRunning, requestExtraction } from "./onboarding-extract";
import { extractText, reextractForLayout } from "./extract";
import { WHISPER_MODEL, createTranscriber, createWhisperEngine, modelsDirectory } from "./transcribe";
import { recordingPass, recordingsOn, transcribeConcurrency } from "./recordings";
import { createRecordingDigester, transcriptsAwaitingDigest } from "./recording-digest";
import { createBackgroundFactsExtractor } from "./background-facts-runner";
import { createGraphSync, type SyncOutcome } from "./graph-sync";
import { addSubscription, hasSubscriptions, removeSubscription, subscriptionSources } from "./calendar-subscriptions";
import { addFolder, personNames, previewFolder, removeFolder, setFolderLines, setFolderRules, syncFolders } from "./source-folders";
import { createFolderClassifier } from "./folder-classifier";
import { homedir, tmpdir } from "node:os";
import { defaultSafeGetDeps } from "./safe-fetch";
import { REQUIRED_SKILLS } from "./required-skills";
import { createMailService } from "./mailbox";
import { createImportService } from "./importer";
import { probeSandboxShell } from "./sandbox-probe";
import { automationPass, createAutomationService, designPending, onNewMail, suggestFromRepeats, type AutomationDeps } from "./automations";
import { monthSpend, ownerOf, runtimeOwner, runtimesDir } from "./owner";
import { createNodeHub, type NodeHub } from "./node/hub";
import { skillLibraryDir } from "./skill-library";
import { identityLines } from "./lines";
import { createBackgroundSpend, nonCoreAllowed } from "./spend";
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

/**
 * Works backwards from approved milestones due within three weeks that nothing serves yet. Run by the tick
 * and, right after the person approves a line's drafts, by the web app — so the week fills in at once.
 */
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
function waitsForOffPeak(workspaceId: string, now = new Date()): boolean {
  return modelProviders.routing(workspaceId)?.provider.id === "sponsor" && !sponsorOffPeak(now);
}

const autoBackplanning = new Set<string>();
async function autoBackplanPass(workspaceId: string, checkedAt = new Date().toISOString()): Promise<void> {
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
  if (!nonCoreAllowed(analysisStore, workspaceId, await spendFor(workspaceId), "discretionary")) return;
  curating.add(workspaceId);
  try {
    enterUsageWorkspace(workspaceId);
    const outcome = await withUsagePurpose(NON_CORE_PURPOSE, () => createArchetypeCurator(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId))()).catch(() => undefined);
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
    const outcome = await createTaskTitler(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId))().catch(() => undefined);
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
  const t = tOfWorkspace(analysisStore, workspaceId);
  if (!doc) return { state: "blocked" as const, code: "SOURCE_NOT_FOUND", message: t("找不到这个文件。") };
  if (doc.kind === "audio") return transcribeDocument(workspaceId, doc.id);
  let result;
  try { result = await extractText(new Uint8Array(readFileSync(fileURLToPath(doc.uri))), doc.kind, localeOf(analysisStore, workspaceId)); }
  catch { result = { status: "failed" as const, text: "", note: t("读不到已保存的文件。") }; }
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
const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};
let evalHeldBefore = false;
/** A local evaluation on the owner's Codex sign-in is running (`EVAL_HOLD_FILE`); said once in the log each time it starts or ends. */
const evalHeld = (): boolean => {
  let text: string | undefined;
  try { text = readFileSync(path.join(dataDir, EVAL_HOLD_FILE), "utf8"); } catch { text = undefined; }
  const held = evalHoldActive(text, new Date(), pidAlive);
  if (held !== evalHeldBefore) { evalHeldBefore = held; console.info(JSON.stringify({ type: "worker.eval_hold", held })); }
  return held;
};
/** Only the owner's runtime is the one the evaluation spends; a guest's own sign-in is not touched. */
const heldForEval = (workspaceId: string) => machineOwner(workspaceId) && evalHeld();
const ownerOnlyFolder = (workspaceId: string) => ({ state: "blocked" as const, code: "FOLDER_OWNER_ONLY",
  message: tOfWorkspace(analysisStore, workspaceId)("文件夹在运行 Crossline 的那台电脑上，只有那台电脑的主人能授权。请改用「添加文件」上传。") });
const folderDeps = { dataDir, home: homedir(), readText: extractText };
/** With 录音自动转写 on, the folder pass also queues the recordings it finds (recordings.ts). */
const folderDepsFor = (workspaceId: string) => ({ ...folderDeps, audio: recordingsOn(analysisStore, workspaceId) });
const readingFolders = new Set<string>();
// A folder added while a pass runs would wait for the next tick (up to fifteen minutes) while its card says 「正在读取」 — four folders
// authorized at once read only the first (2026-10-15) — so a call during a pass runs one more pass after it.
const rereadFolders = new Set<string>();
async function folderPass(workspaceId: string, checkedAt: string): Promise<void> {
  if (readingFolders.has(workspaceId)) { rereadFolders.add(workspaceId); return; }
  if (paused(workspaceId, "intake") || !machineOwner(workspaceId)) return;
  readingFolders.add(workspaceId);
  try {
    const outcomes = await syncFolders(analysisStore, workspaceId, folderDepsFor(workspaceId)).catch(() => []);
    const read = outcomes.reduce((sum, item) => sum + item.read, 0);
    if (read) console.info(JSON.stringify({ type: "sources.folders_read", checkedAt, workspaceId, outcomes }));
    // Recordings the pass just queued start now, in the background: a long one takes far longer than a tick.
    startRecordings(workspaceId);
    void digestPass(workspaceId).catch(() => undefined);
    if (!codexSupervisor || !spendAllows(await spendFor(workspaceId), "intake")) return;
    enterUsageWorkspace(workspaceId);
    const filed = await createFolderClassifier(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId))().catch(() => undefined);
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
    const outcome = await createCalendarClassifier(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId))().catch(() => undefined);
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
    const outcome = await createGoalSplitter(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId))().catch(() => undefined);
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
async function firstDraftsPass(workspaceId: string, checkedAt = new Date().toISOString()): Promise<void> {
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
async function onboardingExtractPass(workspaceId: string): Promise<void> {
  if (!codexSupervisor || extractionRunning(workspaceId) || paused(workspaceId, "planning")) return;
  // The start-on-use handle: a guest's runtime that went idle after the reply is started again, or the retry fails for want of a client.
  const extractor = createOnboardingExtractor(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId));
  if (!extractor.nextSession()) return;
  // A turn starts its own extraction whatever the quota says (the person is there); a retry from the tick is core work like any other.
  if (!spendAllows(await spendFor(workspaceId), "core")) return;
  void requestExtraction(workspaceId, (preferred) => { enterUsageWorkspace(workspaceId); return extractor.runOnce(preferred); })
    .then(() => { void firstDraftsPass(workspaceId).catch(() => undefined); });
}

/**
 * A guest just connected its model (W-11). The quota is read again, which clears the 「后台自动工作已暂停」 written by a tick that ran before
 * the login, and the passes that were waiting on a model run now: a capture typed meanwhile, approved milestones, the first drafts.
 */
async function afterConnected(workspaceId: string): Promise<void> {
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
 * Rewrites a line's own skill (`crossline-mine:<line>`, docs/skills-library.md §1) when the person has said or decided something new about how
 * they do that line's work: one line a tick, while the quota allows core work. The version it replaces stays in the ledger.
 */
const compilingMine = new Set<string>();
async function minePass(workspaceId: string, checkedAt: string): Promise<void> {
  if (paused(workspaceId, "planning")) return;
  if (compilingMine.has(workspaceId) || !codexSupervisor || !linesAwaitingMineSkill(analysisStore, workspaceId).length) return;
  // Core by its quota rule (as before), non-core for the saver (docs/token-economy.md §2.3).
  if (!nonCoreAllowed(analysisStore, workspaceId, await spendFor(workspaceId), "core")) return;
  compilingMine.add(workspaceId);
  try {
    enterUsageWorkspace(workspaceId);
    const outcome = await withUsagePurpose(NON_CORE_PURPOSE, () => createInsightCompiler(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId))()).catch(() => undefined);
    if (outcome) console.info(JSON.stringify({ type: "skill.mine.compiled", checkedAt, workspaceId, ...outcome }));
  } finally { compilingMine.delete(workspaceId); }
}

/**
 * Public skills (docs/skills-library.md §2): once a day the ones not called for thirty days are removed; the scout searches once for each
 * line when it is set up (the interview done, or a line added later), then once a month (checking installed ones for a newer commit
 * too). The setup search is core work; the monthly one is non-core (the quota saver), as are its reviews.
 */
const scoutingSkills = new Set<string>();
async function publicSkillPass(workspaceId: string, checkedAt: string, offPeakWait = false): Promise<void> {
  try {
    const removed = cleanPublicSkills(analysisStore, workspaceId);
    if (removed.length) console.info(JSON.stringify({ type: "skill.public.cleaned", checkedAt, workspaceId, removed }));
  } catch { /* housekeeping */ }
  if (paused(workspaceId, "planning")) return;
  if (scoutingSkills.has(workspaceId) || !codexSupervisor) return;
  // A line's search when it is set up is part of setting the account up: it runs as core work and does not wait for the developer's
  // model's cheaper hours. The monthly search is non-core and waits.
  const setup = lineSetupDue(analysisStore, workspaceId);
  if (!setup.length && (offPeakWait || !scoutDue(analysisStore, workspaceId))) return;
  const spend = await spendFor(workspaceId);
  if (setup.length ? !spendAllows(spend, "core") : !nonCoreAllowed(analysisStore, workspaceId, spend, "discretionary")) return;
  scoutingSkills.add(workspaceId);
  try {
    enterUsageWorkspace(workspaceId);
    const scout = createSkillScout(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId), setup.length ? { mode: "setup", lines: setup } : { mode: "routine" });
    const outcome = await (setup.length ? scout() : withUsagePurpose(NON_CORE_PURPOSE, scout)).catch(() => undefined);
    if (outcome) console.info(JSON.stringify({ type: "skill.public.scouted", checkedAt, workspaceId, mode: setup.length ? "setup" : "routine", ...outcome }));
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
      ? { state: "blocked", code: "AGENT_PAUSED", message: tOfWorkspace(analysisStore, workspaceId)("助手已暂停。") } : agentService.runFree(workspaceId, input, after), new Date(), browserProfilesRoot(workspaceId));
    if (fired.length) console.info(JSON.stringify({ type: "skill.grown.scheduled", checkedAt, workspaceId, fired }));
  } catch { /* next tick */ }
  // Favourites organised by topic: the day's share by day, everything in order by night (favourites-topics.ts).
  try {
    const started = favouritesTopicPass(analysisStore, workspaceId, readGrownSkills(analysisStore, workspaceId), (input, after) => assistantOff
      ? { state: "blocked", code: "AGENT_PAUSED", message: tOfWorkspace(analysisStore, workspaceId)("助手已暂停。") } : agentService.runFree(workspaceId, input, after), browserProfilesRoot(workspaceId));
    if (started.length) console.info(JSON.stringify({ type: "favourites.topics_started", checkedAt, workspaceId, started }));
  } catch { /* next tick */ }
  // Workflows that do the same job are merged (workflow-merge.ts): once a day, or now when the person asked; a merge is folded in below.
  try {
    const today = new Date().toISOString().slice(0, 10);
    const due = workflowMergeDue(analysisStore, workspaceId, today);
    if (due && readGrownSkills(analysisStore, workspaceId).length > 1 && spendAllows(await spendFor(workspaceId), due === "requested" ? "core" : "discretionary")) {
      const merged = await workflowMergePass(analysisStore, workspaceId, accountClient(workspaceId), repoRoot, today);
      if (merged.length) console.info(JSON.stringify({ type: "skill.grown.merged", checkedAt, workspaceId, merged }));
    }
  } catch { /* next tick */ }
  // A workflow the person commented on, or whose runs keep failing, is revised by the assistant (workflow-improver.ts); every account.
  if (!assistantOff && !agentService.runningTasks(workspaceId).some((taskId) => taskId.startsWith("improve-"))) {
    try {
      const spend = await spendFor(workspaceId);
      const improving = workflowImprovePass(analysisStore, workspaceId, (input, after) => agentService.runFree(workspaceId, input, after),
        { client: () => accountClient(workspaceId), cwd: repoRoot, workRoot: path.join(dataDir, "workflow-improve"), spend: (kind) => spendAllows(spend, kind) });
      if (improving) console.info(JSON.stringify({ type: "skill.grown.improve_started", checkedAt, workspaceId, id: improving }));
    } catch { /* next tick */ }
  }
  // Growing a workflow writes and tests scripts with the runtime's `skill-creator`: only the shell assistant can (the owner's own Codex).
  if (assistantOff || !machineOwner(workspaceId) || growingWorkflows.has(workspaceId) || agentService.runningTasks(workspaceId).length) return;
  const candidate = growCandidates(analysisStore, workspaceId)[0];
  // What the person asked for in words is their own work, like a capture: it runs while the quota lasts. An errand the system noticed
  // repeating is its own idea, and waits for a normal quota.
  if (!candidate || !spendAllows(await spendFor(workspaceId), candidate.origin.kind === "asked" ? "core" : "discretionary")) return;
  // What this line's library already holds, so the new workflow names and builds on it instead of copying it.
  const library = [...readPublicSkills(analysisStore, workspaceId).filter((skill) => skill.lines.includes(candidate.lineId) && skill.review.final !== "reject")
    .map((skill) => ({ name: publicSkillName(skill.id), description: skill.description })),
    ...readGrownSkills(analysisStore, workspaceId).filter((skill) => skill.status === "active" && grownHomeLine(analysisStore, workspaceId, skill) === candidate.lineId)
      .map((skill) => ({ name: grownSkillName(skill.id), description: skill.manifest.summary }))];
  const input = growTask(candidate, identityLines(analysisStore, workspaceId).map((line) => line.id), aiToolsFor(analysisStore, workspaceId), library, localeOf(analysisStore, workspaceId));
  growingWorkflows.add(workspaceId);
  const started = agentService.runFree(workspaceId, input, (outcome) => {
    void installGrown(analysisStore, workspaceId, candidate, outcome, { client: accountClient(workspaceId), cwd: repoRoot })
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
  if (started.state === "needs_category_approval") {
    const t = tOfWorkspace(analysisStore, workspaceId);
    sayToPerson(analysisStore, workspaceId, t("要把「{{text}}」固化成工作流，需要先允许助手做「{{label}}」这类工作。", { text: candidate.text.slice(0, 40), label: t(started.label) }),
      "skill_grown", "grow-needs:" + input.taskId, [{ label: t("去开启"), href: "/settings#automation" }]);
  }
}

/**
 * Writes the portrait (the interview's end, 重新生成, or the one rewrite after the fixed dimensions shipped): `portrait.requested` first,
 * so the page shows it running, then `portrait.blocked` with the reason, or the figure drawn in the background after the words (kept
 * when one exists, `figureRedrawDue`).
 */
async function writePortraitFor(workspaceId: string) {
  enterUsageWorkspace(workspaceId);
  const store = analysisStore;
  store.appendEvent({ ownerId: store.getWorkspaceOwnerId(workspaceId) ?? "", workspaceId, idempotencyKey: `portrait.requested:${Date.now()}`, type: "portrait.requested", entityId: workspaceId, payload: {} });
  const outcome = await createPortraitWriter(store, workspaceId, repoRoot, () => accountClient(workspaceId))();
  if (outcome.state === "blocked") store.appendEvent({ ownerId: store.getWorkspaceOwnerId(workspaceId) ?? "", workspaceId, idempotencyKey: `portrait.blocked:${Date.now()}`,
    type: "portrait.blocked", entityId: workspaceId, payload: { code: outcome.code, message: outcome.message } });
  // The pictures follow the words, in the background: the report is readable at once and gains its illustrations as they land.
  else void createPortraitIllustrator(store, workspaceId, repoRoot, dataDir, () => accountClient(workspaceId))()
    .then((drawn) => console.info(JSON.stringify({ type: "portrait.illustrated", workspaceId, ...drawn })))
    .catch(() => undefined);
  return outcome;
}

/** The person's 「重画一版」 on the portrait page: a new figure only, the words stay as they are and the earlier figures are kept. */
async function redrawFigureFor(workspaceId: string) {
  enterUsageWorkspace(workspaceId);
  const drawn = await createPortraitIllustrator(analysisStore, workspaceId, repoRoot, dataDir, () => accountClient(workspaceId))({ redraw: true });
  console.info(JSON.stringify({ type: "portrait.illustrated", workspaceId, redraw: true, ...drawn }));
  return drawn;
}

/**
 * Rewrites a portrait in the background when `portraitRewriteDue` says so: once for a report from before the fixed dimensions, and the
 * say–do part at most monthly once the execution record can be drawn. Nobody is waiting on either, so both wait for a normal quota.
 * The marker is written before the run: a failure shows on the page (重新生成 is the person's), it is never retried every tick.
 */
const rewritingPortraits = new Set<string>();
async function portraitPass(workspaceId: string, checkedAt: string, offPeakWait = false): Promise<void> {
  if (rewritingPortraits.has(workspaceId) || !codexSupervisor) return;
  const due = portraitRewriteDue(analysisStore, workspaceId, new Date(checkedAt));
  // The first report is waited for; a rewrite of one that exists waits for the cheaper hours.
  if (!due || (offPeakWait && due !== "first")) return;
  // The first report ends the interview; a rewrite of one that exists is non-core (the quota saver).
  const spend = await spendFor(workspaceId);
  if (due === "first" ? !spendAllows(spend, "discretionary") : !nonCoreAllowed(analysisStore, workspaceId, spend, "discretionary")) return;
  const purpose = <T,>(run: () => Promise<T>) => due === "first" ? run() : withUsagePurpose(NON_CORE_PURPOSE, run);
  rewritingPortraits.add(workspaceId);
  try {
    if (due === "schema" || due === "first") {
      if (due === "schema") analysisStore.setSetting(workspaceId, PORTRAIT_REWRITE_MARKER, checkedAt);
      const outcome = await purpose(() => writePortraitFor(workspaceId)).catch(() => undefined);
      console.info(JSON.stringify({ type: "portrait.rewritten", checkedAt, workspaceId, state: outcome?.state ?? "failed" }));
    } else {
      analysisStore.setSetting(workspaceId, PORTRAIT_GAP_AT, checkedAt);
      enterUsageWorkspace(workspaceId);
      const outcome = await purpose(() => createPortraitWriter(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId), { only: "gap" })()).catch(() => undefined);
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
    // A plan written before first actions and AI assists were required is planned again once its work is a week away.
    try {
      const outdated = requestOutdatedReplans(analysisStore, workspaceId);
      if (outdated.length) console.info(JSON.stringify({ type: "steps.outdated_replan_requested", checkedAt, workspaceId, orders: outdated }));
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
    // Two tasks at a time, each planned on its own thread (the account's share of the model gate), batch after batch until none waits:
    // two a tick left thirty new tasks of approved milestones unplanned for hours (2026-10-19).
    const tried = new Set<string>();
    let batch = ids;
    while (batch.length) {
      await eachLimited(batch, workspaceConcurrency(workspaceId), async (id) => {
        tried.add(id);
        // A replan the person (or the assistant) asked for carries what to change.
        const request = analysisStore.listEvents(workspaceId, { type: "task.steps_replan_requested", entityId: id }).at(-1)?.payload as { feedback?: string } | undefined;
        const outcome = await planner(id, request?.feedback ?? "").catch(() => undefined);
        if (outcome) console.info(JSON.stringify({ type: `steps.${outcome.state}`, checkedAt, workspaceId, workOrderId: id,
          ...(outcome.state === "planned" ? { warnings: outcome.warnings.length } : { code: outcome.code }) }));
      });
      if (paused(workspaceId, "planning") || !spendAllows(await spendFor(workspaceId), "core")) break;
      batch = tasksAwaitingStepPlan(analysisStore, workspaceId, accountConcurrency() * 2).filter((id) => !tried.has(id));
    }
    // Material a plan would ask the person for is looked for on the web first (need-check.ts); only what is not found is asked.
    const checker = createNeedChecker(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId), { readCost: () => readCost(workspaceId) });
    for (const item of needsAwaitingCheck(analysisStore, workspaceId).slice(0, NEEDS_PER_PASS)) {
      const outcome = await checker(item).catch(() => "skipped" as const);
      console.info(JSON.stringify({ type: "steps.need_checked", checkedAt, workspaceId, workOrderId: item.workOrderId, needId: item.needId, outcome }));
    }
    // Reviewing kept warnings waits while an evaluation spends the same quota; the warnings stay and are reviewed afterwards.
    if (heldForEval(workspaceId)) return;
    const reviewer = createWarningReviewer(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId), (id, feedback) => planner(id, feedback),
      createRelationReviser(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId)),
      (line, notes) => createMilestoneProposer(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId))(`复核意见：${notes}`, undefined /* i18n-ignore: the architect's brief */, [line], { revised: true }));
    for (const item of reviews) {
      const verdict = await reviewer(item).catch(() => undefined);
      if (verdict) console.info(JSON.stringify({ type: `validation.${verdict.verdict}`, checkedAt, workspaceId, subject: item.subject, entityId: item.entityId }));
    }
  } finally {
    stepPlanning.delete(workspaceId);
    if (stepPlanAgain.delete(workspaceId)) void stepPlanPass(workspaceId).catch(() => {});
  }
}

/** One account's share of the tick, in the order the tick always ran it; the tick runs every account's at once (see `tick`). */
/**
 * Information first (the owner, 2026-10-21: 「整个系统的逻辑是先获取信息再进行规划和准备」). What arrived since the last tick — authorized
 * folders and recordings, the calendar, new mail, captures (mail's included), the interview's replies — is read and recorded before anything
 * is planned from it. It runs on its own each tick, not behind the account's planning and preparation: mail sorting sat last in one long
 * pass and was reached only once tutorials, step plans and the gate had all finished, so a backlog there could hold it for hours. The model
 * gate gives these Skills the same precedence (`INTAKE_SKILLS` in model-gate.ts).
 */
async function intakeTick(workspace: { id: string }, checkedAt: string): Promise<void> {
  // Authorized folders: what changed since the last tick is read (at most forty files a folder a tick), before filing runs over it.
  await folderPass(workspace.id, checkedAt);
  // Transcripts from any source — this computer's folders or the server transcriber's inbox — are digested for every workspace.
  void digestPass(workspace.id).catch(() => undefined);
  // Uploaded files are filed under the project their own name or opening names; what stays unclear is asked about on 待确认.
  try {
    const filed = fileSourceDocuments(analysisStore, workspace.id);
    if (filed.length) console.info(JSON.stringify({ type: "source.project_inferred", checkedAt, workspaceId: workspace.id, filed }));
  } catch { /* housekeeping */ }
  // Calendar reality is pulled every tick. It never rewrites an approved plan — a change there becomes
  // a new draft whose diffs are conflicts for the person to look at.
  {
    const outcome = await syncCalendarFor(workspace.id).catch((error): SyncOutcome =>
      ({ state: "blocked", code: "GRAPH_SYNC_FAILED", message: error instanceof Error ? error.message : "" }));
    if (outcome) {
      recordCalendarOutcome(analysisStore, workspace.id, outcome, checkedAt);
      await calendarLinePass(workspace.id, checkedAt);
      if (outcome.state === "blocked" || outcome.changes > 0 || outcome.resynced) {
        console.info(JSON.stringify({ type: `graph.${outcome.state}`, checkedAt, workspaceId: workspace.id, ...outcome }));
      }
    }
  }
  // The mailbox (docs/personal-agent.md): new mail read and sorted; to-dos and dates it finds become captures, analysed just below.
  await mailService.pass(workspace.id).catch(() => undefined);
  // Lists kept in other tools (docs/personal-agent.md §9): each connected one read once a day, its new items sorted into captures; Todoist
  // write-back for accounts that switched it on.
  await importService.pass(workspace.id).catch(() => undefined);
  // A new capture is classified, estimated and split without anyone pressing 分析: the person's job is to write it down, the
  // system's is to turn it into a proposal waiting in 待确认. Capped per tick; a capture that came back blocked is left for the person
  // rather than retried on a timer.
  if (codexSupervisor) await autoAnalyzePass(workspace.id, checkedAt);
  // The interview's extraction, for replies a failed run left (after its backoff) or a worker restart cut off; a turn starts it itself.
  await onboardingExtractPass(workspace.id).catch(() => undefined);
}

/** Planning, then preparation, for one account; started each tick once that tick's intake for the account has finished (`tick`). */
async function workspaceTick(workspace: { id: string }, checkedAt: string): Promise<void> {
  // Planning: what was taken in becomes work on the board.
  if (codexSupervisor) await autoBackplanPass(workspace.id, checkedAt);
  await stepPlanPass(workspace.id, checkedAt);
  // Once: the board written before work had an owner is split into the person's core work, the assistant's preparation and questions
  // (work-split-repair.ts, docs/work-split.md §5). Duplicates are merged at once; milestones left without core work are worked back again.
  const split = await workSplitRepair(analysisStore, workspace.id, { mergeNow: async () => (await dedupePass({ store: analysisStore, workspaceId: workspace.id,
    cwd: repoRoot, client: () => accountClient(workspace.id), spend: () => spendFor(workspace.id), paused: (kind) => paused(workspace.id, kind),
    enterUsage: enterUsageWorkspace, force: true })).reduce((sum, item) => sum + item.absorbed.length, 0) })
    .catch((error) => { console.warn(JSON.stringify({ type: "repair.work_split_failed", workspaceId: workspace.id, error: String(error), checkedAt })); return undefined; });
  if (split) console.info(JSON.stringify({ type: "repair.work_split", workspaceId: workspace.id, assistant: split.assistant, ask: split.ask, merged: split.merged,
    backplan: split.backplan.length, prepOnly: split.prepOnly.length, checkedAt }));
  // Once: to-dos from mail that only ask to look at something become reminders in the bell (mail-reminder-repair.ts).
  try {
    const reminded = mailReminderRepair(analysisStore, workspace.id);
    if (reminded.length) console.info(JSON.stringify({ type: "repair.mail_reminders", workspaceId: workspace.id, archived: reminded.length, checkedAt }));
    const money = moneyAskRepair(analysisStore, workspace.id);
    if (money.length) console.info(JSON.stringify({ type: "repair.money_asks", workspaceId: workspace.id, moved: money.length, checkedAt }));
    const records = mailRecordsRepair(analysisStore, workspace.id);
    if (records.voided || records.refunds || records.merged) console.info(JSON.stringify({ type: "repair.mail_records", workspaceId: workspace.id, ...records, checkedAt }));
  } catch (error) { console.warn(JSON.stringify({ type: "repair.mail_reminders_failed", workspaceId: workspace.id, error: String(error), checkedAt })); }
  // Monday's and the 1st's spending reports (money-report.ts, docs/mail-bookkeeping.md §5.3). From the ledger by code, no model.
  try {
    const reported = moneyReportPass(analysisStore, workspace.id);
    if (reported.weekly || reported.monthly) console.info(JSON.stringify({ type: "money.reported", workspaceId: workspace.id, ...reported, checkedAt }));
  } catch (error) { console.warn(JSON.stringify({ type: "money.report_failed", workspaceId: workspace.id, error: String(error), checkedAt })); }
  // Back after two days or more: overdue milestones of their own moved, old work archived, duplicates merged now (return-tidy.ts).
  const tidied = await returnTidy(analysisStore, workspace.id, { mergeNow: async () => (await dedupePass({ store: analysisStore, workspaceId: workspace.id,
    cwd: repoRoot, client: () => accountClient(workspace.id), spend: () => spendFor(workspace.id), paused: (kind) => paused(workspace.id, kind),
    enterUsage: enterUsageWorkspace, force: true })).reduce((sum, item) => sum + item.absorbed.length, 0) }).catch(() => undefined);
  if (tidied) console.info(JSON.stringify({ type: "return.tidied", workspaceId: workspace.id, shifted: tidied.shifted.length, archived: tidied.archived.length,
    merged: tidied.merged, checkedAt }));
  // Once a day: what waits for the person moves with the date — old assistant results decided or put away, overdue milestones moved or
  // asked about, untouched proposals and drafts archived (date-advance.ts). Rules only, no model.
  try {
    const advanced = dateAdvancePass(analysisStore, workspace.id);
    if (advanced) console.info(JSON.stringify({ type: "date.advanced", workspaceId: workspace.id, superseded: advanced.superseded.length, adopted: advanced.adopted.length,
      expired: advanced.expired.length, shifted: advanced.shifted.length, asked: advanced.asked.length, archived: advanced.archived.length, drafts: advanced.drafts.length, checkedAt }));
  } catch (error) { console.warn(JSON.stringify({ type: "date.advance_failed", workspaceId: workspace.id, message: error instanceof Error ? error.message : String(error) })); }
  // Once a day: lessons drawn by rule from what happened, and what went unused lapses (lessons.ts, docs/token-economy.md §2). No model.
  try {
    const learned = lessonsPass(analysisStore, workspace.id);
    if (learned) console.info(JSON.stringify({ type: "lessons.pass", workspaceId: workspace.id, ...learned, checkedAt }));
  } catch (error) { console.warn(JSON.stringify({ type: "lessons.pass_failed", workspaceId: workspace.id, message: error instanceof Error ? error.message : String(error) })); }
  await dedupePass({ store: analysisStore, workspaceId: workspace.id, cwd: repoRoot, client: () => accountClient(workspace.id), spend: () => spendFor(workspace.id), paused: (kind) => paused(workspace.id, kind), enterUsage: enterUsageWorkspace }).catch(() => undefined);
  await titlePass(workspace.id, checkedAt);
  await goalSplitPass(workspace.id, checkedAt);
  await milestoneRiskPass(workspace.id, checkedAt);
  void firstDraftsPass(workspace.id, checkedAt).catch(() => undefined);
  // The milestone gate. Without this it existed only inside `scripts/gate-loop-check.ts`, so on the
  // real ledger a milestone-bound work order reached `evidence_review`, the approvals page said
  // 「等待里程碑闸门」 — and nothing was ever going to judge it. A verdict other than `pass` holds the
  // order for a person, so a held order is skipped rather than re-judged every fifteen minutes.
  for (const workOrderId of pendingMilestoneGates(analysisStore, workspace.id)) {
    const outcome = await getMilestoneGate(workspace.id)(workOrderId).catch(() => undefined);
    if (outcome) console.info(JSON.stringify({ type: `milestone_gate.${outcome.state}`, checkedAt, workspaceId: workspace.id, ...outcome }));
  }
  // Preparation: materials, tutorials, the person's own skills, research, the assistant.
  // Material preparation is the one background job that writes into the project directory, so it only
  // ever runs for work orders the human already approved into `preparing`.
  for (const workOrderId of pendingMaterialWorkOrders(analysisStore, workspace.id)) {
    const outcome = await getMaterialPreparer(workspace.id)(workOrderId).catch(() => undefined);
    if (outcome) console.info(JSON.stringify({ type: `materials.${outcome.state}`, checkedAt, workspaceId: workspace.id, ...outcome }));
  }
  // Work nobody waits on waits for the developer's model's cheaper hours on accounts that run on it (docs/model-scheduling.md).
  const offPeakWait = waitsForOffPeak(workspace.id);
  // Tutorials only for work at the `tutorial` preparation level, three days before it starts (docs/task-preparation.md): one per workspace per tick, and only while the quota is normal.
  // Waiting for the cheaper hours, only a tutorial whose work starts within a day of their end is written now.
  const urgent = offPeakWait ? startingWithin(analysisStore, workspace.id, new Date(), hoursToOffPeakEnd(new Date()) + 24) : undefined;
  const tutorial = pendingTutorials(analysisStore, workspace.id).find((id) => !urgent || urgent.has(id));
  if (tutorial && codexSupervisor && !paused(workspace.id, "tutorials") && spendAllows(await spendFor(workspace.id), "discretionary")) {
    const outcome = await getMaterialPreparer(workspace.id)(tutorial, { mode: "tutorial" }).catch(() => undefined);
    if (outcome) console.info(JSON.stringify({ type: `tutorial.${outcome.state}`, checkedAt, workspaceId: workspace.id, ...outcome }));
  }
  if (!offPeakWait) await curatorPass(workspace.id, checkedAt);
  if (!offPeakWait) await withUsagePurpose(NON_CORE_PURPOSE, () => energyAdvicePass({ store: analysisStore, workspaceId: workspace.id, cwd: repoRoot, client: () => accountClient(workspace.id), spend: () => spendFor(workspace.id), paused: (kind) => paused(workspace.id, kind), enterUsage: enterUsageWorkspace })).catch(() => undefined);
  if (!offPeakWait) await minePass(workspace.id, checkedAt);
  await publicSkillPass(workspace.id, checkedAt, offPeakWait);
  await portraitPass(workspace.id, checkedAt, offPeakWait);
  // The automations (docs/personal-agent.md): each one's trigger looked at, new mail's included (the intake pass recorded it).
  await automationTick(workspace.id).catch(() => undefined);
  // The nightly expansion decides for itself whether this tick is its moment; most ticks are not.
  // The nightly flywheel, research and the assistant run only while the person is around (docs/review-2026-10-13.md §6.1): their
  // results are for someone to look at, and for days nobody did.
  if ((await spendFor(workspace.id)).engagement !== "active") return;
  // The nightly flywheel and research are non-core (the quota saver), on top of their own budget checks.
  const nonCore = nonCoreAllowed(analysisStore, workspace.id, await spendFor(workspace.id), "discretionary");
  const decision = paused(workspace.id, "nightly") || offPeakWait || !nonCore ? undefined
    : await withUsagePurpose(NON_CORE_PURPOSE, () => getNightly(workspace.id)()).catch(() => undefined);
  if (decision && !decision.run && decision.code !== "BEFORE_PLANNED_TIME" && decision.code !== "ALREADY_RAN_TODAY") {
    console.info(JSON.stringify({ type: "flywheel.nightly.skipped", checkedAt, workspaceId: workspace.id, code: decision.code }));
  }
  if (!offPeakWait && nonCore) startDiligencePass(workspace.id, checkedAt);
  // A workflow the person asked for goes before the assistant's own background work, which would otherwise keep it busy.
  await workflowPass(workspace.id, checkedAt).catch(() => undefined);
  // The assistant starts approved kinds of work by itself; it never holds the tick (its runs are detached).
  if (codexSupervisor) await agentService.pass(workspace.id).catch(() => undefined);
}

/** Each account's model work from the tick still running, so the next tick starts it again only once it has ended. */
const workspaceTicks = new Map<string, Promise<void>>();
/** Each account's intake from the tick still running (`intakeTick`): it never waits behind the account's planning and preparation. */
const intakeTicks = new Map<string, Promise<void>>();

async function tick(options: { waitForWorkspaces?: boolean } = {}): Promise<void> {
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
  // Each account's model work runs on its own (2026-10-19, docs/model-scheduling.md): the tick starts it for every account not already
  // busy and does not wait, so one account's long backlog (85 minutes of step plans on the developer's model) no longer holds every other
  // account's captures and calendar until it ends; the model gate takes turns between the accounts' runs.
  // Intake goes first and on its own (2026-10-21): an account whose planning or preparation from an earlier tick still runs has its mail,
  // calendar and captures read anyway; planning and preparation start after this tick's intake, on what it took in.
  const launched = workspaces.map((workspace) => {
    let intake = intakeTicks.get(workspace.id);
    if (!intake) {
      const started: Promise<void> = withUsageWorkspace(workspace.id, () => intakeTick(workspace, checkedAt))
        .catch((error: unknown) => console.warn(JSON.stringify({ type: "worker.intake_tick_failed", workspaceId: workspace.id,
          message: error instanceof Error ? error.message : "" })))
        .finally(() => { if (intakeTicks.get(workspace.id) === started) intakeTicks.delete(workspace.id); });
      intakeTicks.set(workspace.id, started);
      intake = started;
    }
    if (workspaceTicks.has(workspace.id)) return intake;
    const work = intake.then(() => withUsageWorkspace(workspace.id, () => workspaceTick(workspace, checkedAt)))
      .catch((error: unknown) => console.warn(JSON.stringify({ type: "worker.workspace_tick_failed", workspaceId: workspace.id,
        message: error instanceof Error ? error.message : "" })))
      .finally(() => workspaceTicks.delete(workspace.id));
    workspaceTicks.set(workspace.id, work);
    return work;
  });
  if (options.waitForWorkspaces) await Promise.all(launched);
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
/**
 * Linking or unlinking this computer as a device (docs/device-mode.md) changes what the whole worker is, so the worker leaves and the
 * keeper loop (`keep-running.ps1`) starts it again in the other mode a few seconds later. The lock goes first, or the new process would
 * read it as alive and stand down.
 */
const restartForMode = (): void => {
  console.info(JSON.stringify({ type: "worker.mode_changed", action: "restart", at: new Date().toISOString() }));
  setTimeout(() => {
    try { rmSync(lockPath, { force: true }); } catch { /* goes stale on its own */ }
    process.exit(0);
  }, 1_500).unref();
};
// A linked device does only what needs this machine and sends it to the hosted site; none of the full worker below runs (no Codex, no
// model, no plan). Module evaluation stops here for good: the device worker's timers keep the process alive.
const deviceLink = await readDeviceLink(dataDir, secrets);
if (workerMode(deviceLink) === "device" && deviceLink) {
  await runDeviceWorker({ store: analysisStore, dataDir, secrets, link: deviceLink, port: supervisorPort, intervalMinutes,
    capabilitySecret: process.env.CROSSLINE_SUPERVISOR_CAPABILITY_SECRET?.trim() || undefined, beat, restart: restartForMode,
    runOnce: process.env.CROSSLINE_RUN_ONCE === "1" });
  const leave = (code: number) => { analysisStore.close(); try { rmSync(lockPath, { force: true }); } catch { /* stale on its own */ } process.exit(code); };
  if (process.env.CROSSLINE_RUN_ONCE === "1") leave(0);
  process.once("SIGINT", () => leave(0));
  process.once("SIGTERM", () => leave(0));
  await new Promise<never>(() => undefined);
}
// A workspace's own third-party model (R7): Codex reaches it through this local gateway, which adds the key (model-gateway.ts).
const modelGateway = await startModelGateway({ resolve: (workspaceId, providerId) => modelProviders.upstream(workspaceId, providerId) });
// The developer's model for accounts that redeemed an invite code (sponsor.ts): only when the server has a key and candidates.
let sponsorService: SponsorService | undefined;
// The shell assistant for every account inside Codex's Linux sandbox, when the server turned it on and a sandbox really starts here.
const sandboxShell = probeSandboxShell();
console.info(JSON.stringify({ type: "worker.sandbox_shell", ...sandboxShell }));
const modelProviders = createModelProviderService({
  store: analysisStore, secrets, cwd: repoRoot, sponsor: () => sponsorService, sandboxShell: sandboxShell.ok,
  gateway: modelGateway,
  signedIn: (workspaceId) => codexSupervisor?.runtimes?.signedIn(workspaceId) ?? true,
  onConformance: (workspaceId) => { void afterConnected(workspaceId); },
  client: async (workspaceId) => {
    const runtime = await codexSupervisor?.runtimes?.client(workspaceId);
    return runtime?.ok ? runtime.client : codexSupervisor?.clientFor(workspaceId);
  }
});
// A candidate's sample interview (sponsor.ts) is routed to that candidate; every other run to the workspace's own provider.
setProviderResolver((workspaceId) => sponsorService?.dialogueRouting(workspaceId) ?? modelProviders.routing(workspaceId));
// A run refused by the account's own ChatGPT quota: the developer's model stands in until it resets, where the account holds it.
setUsageLimitHandler((workspaceId) => modelProviders.noteUsageLimit(workspaceId));
if (sponsorFromEnv()) sponsorService = createSponsorService({ store: analysisStore, dataDir, cwd: repoRoot, gateway: modelGateway,
  capabilities: modelProviders.capabilities, client: () => { const owner = runtimeOwner(analysisStore); return owner ? codexSupervisor?.clientFor(owner) : undefined; } });
// Screen activity: a foreground-window reader feeding a tracker that asks every workspace for its own consent on every
// reading. Without consent nothing is stored; the source itself reads only the window's app, title and idle time.
const activityIntervalSeconds = Math.max(5, Number(process.env.CROSSLINE_ACTIVITY_INTERVAL_SECONDS) || 60);
const activityTracker = createActivityTracker(analysisStore, () => analysisStore.listWorkspaces().map((workspace) => workspace.id).filter(machineOwner), activityIntervalSeconds);
const activitySource = createWindowsActivitySource({ intervalSeconds: activityIntervalSeconds });
let lastIdle: { idleMs: number; at: number } | undefined;
if (process.env.CROSSLINE_RUN_ONCE !== "1") activitySource.start((reading) => { lastIdle = { idleMs: reading.idleMs, at: Date.now() }; activityTracker.handle(reading); });
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
  if (!usage.workspaceId || sponsorService?.noteEvalUsage(usage)) return;
  analysisStore.saveModelUsage({
    workspaceId: usage.workspaceId, skill: usage.skillName, tier: usage.tier ?? "", model: usage.model ?? "", effort: usage.effort ?? "",
    spendMode: usage.spendMode, threadId: usage.threadId ?? "", ok: usage.ok, errorCode: usage.errorCode ?? "", repairs: usage.repairs, turns: usage.turns,
    inputTokens: usage.inputTokens, cachedInputTokens: usage.cachedInputTokens, outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningOutputTokens, totalTokens: usage.totalTokens, durationMs: usage.durationMs, at: usage.at,
    ...(usage.purpose ? { purpose: usage.purpose } : {})
  });
});
// Unreadable reads as manual_core_only here, which routes like normal: only economy steps a Skill down.
setSpendModeProvider(async (workspaceId) => backgroundSpend(await readCost(workspaceId)).mode);
// New model output is written in the workspace's language (docs/i18n.md); read per run, so a switch applies to the next run.
setLocaleProvider((workspaceId) => workspaceId ? readLocale(analysisStore, workspaceId) : undefined);
// The one quota gate for every background pass (core: keeps the person's own work moving; discretionary: nobody is waiting on it).
const readSpend = createBackgroundSpend(analysisStore, (workspaceId) => readCost(workspaceId));
const spendFor = async (workspaceId: string) => {
  const spend = await readSpend(workspaceId);
  return heldForEval(workspaceId) ? { ...spend, held: true } : spend;
};
/** A kind of background work the person paused on the background tasks page (the assistant has its own `agent.paused`). */
const paused = (workspaceId: string, kind: BackgroundKind): boolean => pausedKinds(analysisStore.getSetting(workspaceId, BACKGROUND_PAUSED)).has(kind);
const nightlies = new Map<string, ReturnType<typeof createNightlyFlywheel>>();
const getNightly = (workspaceId: string) => {
  let nightly = nightlies.get(workspaceId);
  if (!nightly) {
    nightly = createNightlyFlywheel({
      store: analysisStore, workspaceId, readCost: () => readCost(workspaceId),
      expand: createFlywheelExpander(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId))
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
  const locale = localeOf(analysisStore, workspaceId);
  const t = tFor(locale);
  const status = await transcriber.status(locale);
  if (status.state !== "ready") {
    const note = status.state === "unavailable" ? status.message
      : status.state === "downloading" ? t("正在下载语音识别模型，下载完会自动开始转写。")
      : t("转写录音需要先下载语音识别模型（约 {{mb}} MB，一次性，之后完全离线）。", { mb: status.approxMegabytes });
    analysisStore.setSourceDocumentExtraction(workspaceId, doc.id, { status: "pending", text: "", note });
    return { state: "waiting_for_model", documentId };
  }
  analysisStore.setSourceDocumentExtraction(workspaceId, doc.id, { status: "pending", text: "", note: t("正在转写…") });
  transcribeQueue = transcribeQueue.then(async () => {
    try {
      const bytes = new Uint8Array(readFileSync(fileURLToPath(doc.uri)));
      const result = await transcriber.transcribe(bytes, doc.fileName, process.env.CROSSLINE_TRANSCRIBE_LANGUAGE?.trim() || undefined, locale);
      if (result.state === "transcribed") {
        analysisStore.setSourceDocumentExtraction(workspaceId, doc.id, { status: "done", text: result.text, note: t("本机转写，约 {{minutes}} 分钟的录音。", { minutes: Math.round(result.seconds / 60) }) });
      } else {
        analysisStore.setSourceDocumentExtraction(workspaceId, doc.id, { status: "failed", text: "",
          note: result.state === "failed" ? result.message : t("语音识别模型还没有准备好。") });
      }
    } catch {
      analysisStore.setSourceDocumentExtraction(workspaceId, doc.id, { status: "failed", text: "", note: t("读不到已保存的录音。") });
    }
  }).catch(() => undefined);
  return { state: "transcribing", documentId };
}
/**
 * 录音自动转写 (recordings.ts, docs/phone-recording.md): recordings queued from the authorized folders, a few at once
 * (`transcribeConcurrency`), beside uploaded recordings, slowed down while the person uses the computer in the day. The idle time is the screen-activity reader's latest,
 * kept in memory only — it is read whether or not screen activity is recorded, and nothing of it is stored here.
 */
const recordingWorkspaces = new Set<string>();
let recordingRunning = false;
function startRecordings(workspaceId: string): void {
  if (!machineOwner(workspaceId) || !recordingsOn(analysisStore, workspaceId) || paused(workspaceId, "intake")) return;
  recordingWorkspaces.add(workspaceId);
  if (recordingRunning) return;
  recordingRunning = true;
  void (async () => {
    while (recordingWorkspaces.size) {
      const next = [...recordingWorkspaces][0]!;
      recordingWorkspaces.delete(next);
      const outcomes = await recordingPass(analysisStore, next, {
        transcriber, dataDir, timeZone: calendarZone(next) ?? "America/Chicago",
        ...(process.env.CROSSLINE_TRANSCRIBE_LANGUAGE?.trim() ? { language: process.env.CROSSLINE_TRANSCRIBE_LANGUAGE.trim() } : {}),
        idleMs: () => lastIdle && Date.now() - lastIdle.at < 5 * 60_000 ? lastIdle.idleMs + (Date.now() - lastIdle.at) : undefined,
        modelNeeded: (waiting) => sayToPerson(analysisStore, next, tOfWorkspace(analysisStore, next)("有 {{count}} 个手机录音等着转写，需要先在设置里同意下载语音识别模型（约 {{megabytes}} MB，一次性）。",
          { count: waiting, megabytes: WHISPER_MODEL.approxMegabytes }), "recording_model", "recording_model", [{ label: tOfWorkspace(analysisStore, next)("去设置"), href: "/settings#privacy" }])
      }, transcribeConcurrency()).catch(() => []);
      if (outcomes.length) console.info(JSON.stringify({ type: "recordings.transcribed", workspaceId: next, outcomes }));
      // What was just transcribed is sorted and summarised at once, not at the next tick.
      if (outcomes.some((item) => item.state === "transcribed")) void digestPass(next).catch(() => undefined);
    }
  })().catch(() => undefined).finally(() => { recordingRunning = false; });
}

/**
 * Recording digests (recording-digest.ts): transcripts sorted into kept and not, summarised, and their commitments, facts and days taken
 * into the ledger. Intake work: it runs while the quota allows intake, one pass per workspace at a time.
 */
const digesting = new Set<string>();
async function digestPass(workspaceId: string): Promise<void> {
  if (digesting.has(workspaceId) || paused(workspaceId, "intake") || !transcriptsAwaitingDigest(analysisStore, workspaceId).length) return;
  if (!codexSupervisor || !spendAllows(await spendFor(workspaceId), "intake")) return;
  digesting.add(workspaceId);
  try {
    enterUsageWorkspace(workspaceId);
    // The start-on-use handle, like every other pass: the running runtime only left a guest whose runtime had gone idle undigested.
    const outcome = await createRecordingDigester(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId),
      { dataDir, timeZone: calendarZone(workspaceId) ?? "America/Chicago" })();
    console.info(JSON.stringify({ type: "recordings.digested", workspaceId, ...outcome }));
  } finally { digesting.delete(workspaceId); }
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
    startRecordings(workspace.id);
    for (const doc of analysisStore.listSourceDocuments(workspace.id)) {
      if (doc.kind === "audio" && doc.extractionStatus === "pending") await transcribeDocument(workspace.id, doc.id);
    }
  }
}
const diligenceRunners = new Map<string, ReturnType<typeof createDiligenceRunner>>();
const getDiligence = (workspaceId: string) => {
  let runner = diligenceRunners.get(workspaceId);
  if (!runner) {
    runner = createDiligenceRunner(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId), { readCost: () => readCost(workspaceId) });
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
/**
 * The account's own model runtime for work it asked for (tools-mode assistant, mail sorting, automations): the start-on-use handle,
 * so an idle guest runtime starts again instead of the run being skipped — and never the owner's runtime for anyone else.
 */
// Every model run the worker starts for a workspace takes its client here (2026-10-19: background passes used the running runtime only,
// so an invited account's drafts, backplans and step plans were skipped once its runtime went idle).
const accountClient = (workspaceId: string) => {
  const handle = codexSupervisor?.runtimes?.handle(workspaceId);
  if (handle) return handle.ok ? handle.client : undefined;
  return machineOwner(workspaceId) || !hostedBeta ? codexSupervisor?.clientFor(workspaceId) : undefined;
};
// The person's mailbox, read-only (docs/personal-agent.md): new mail read every quarter hour and sorted into the inbox; the assistant
// searches and reads it; matching mail fires the person's automations. Sorting is intake work (it runs while the person is around or
// cooling off); reading never needs the model.
const mailService = createMailService({ store: analysisStore, secrets, cwd: repoRoot, client: accountClient, dataDir,
  sortAllowed: async (workspaceId) => !paused(workspaceId, "intake") && spendAllows(await spendFor(workspaceId), "intake"),
  onNewMail: (workspaceId, messages) => { onNewMail(analysisStore, workspaceId, messages); },
  // Sorting's to-dos are captures: analysed at once, not at the next tick's intake.
  onCaptured: (workspaceId) => { void autoAnalyzePass(workspaceId).catch(() => undefined); },
  log: (event) => console.info(JSON.stringify({ ...event, checkedAt: new Date().toISOString() })) });
// Lists brought from Todoist, TickTick, Notion, a paste, a CSV or a screenshot (docs/personal-agent.md §9): tokens in the secret store,
// sorting is intake work like mail's, a screenshot is read by the picture reader on the account's own Codex.
const importService = createImportService({ store: analysisStore, secrets, dataDir, cwd: repoRoot, client: accountClient,
  sortAllowed: async (workspaceId) => !paused(workspaceId, "intake") && spendAllows(await spendFor(workspaceId), "intake"),
  describe: (workspaceId) => { const client = accountClient(workspaceId); return client ? createMediaDescriber(client, repoRoot) : undefined; },
  timeZone: (workspaceId) => calendarZone(workspaceId),
  onCaptured: (workspaceId) => { void autoAnalyzePass(workspaceId).catch(() => undefined); },
  log: (event) => console.info(JSON.stringify({ ...event, checkedAt: new Date().toISOString() })) });
// The person's Xiaohongshu favourites, read whole by a worker job in their own visible browser (favourites-reader.ts): pictures described
// on the account's own Codex, videos heard by the recordings' transcriber (ffmpeg on the PATH, or CROSSLINE_FFMPEG).
const classifyTopics = createTopicClassifier(analysisStore, repoRoot, (workspaceId) => accountClient(workspaceId));
configureFavouritesCollector({
  outputRoot: defaultOutputRoot(),
  // The owner's computer reads the favourites when a node of theirs offers a browser (node/browser.ts); the hub is set up further down.
  nodeBrowser: (workspaceId) => workspaceId === runtimeOwner(analysisStore) ? nodeHub?.browserFor(workspaceId) : undefined,
  reclaim: () => codexSupervisor?.runtimes?.reclaim(),
  memory: createCollectMemory({ reclaim: () => codexSupervisor?.runtimes?.reclaim() }),
  // Sorting the titles is the person's own request at work: it runs while the quota allows core work.
  classify: async (workspaceId, workflowId) => {
    if (!spendAllows(await spendFor(workspaceId), "core")) return 0;
    enterUsageWorkspace(workspaceId);
    return classifyTopics(workspaceId, workflowId);
  },
  media: (workspaceId) => {
    const client = accountClient(workspaceId);
    return { ...(client ? { describe: createMediaDescriber(client, repoRoot) } : {}), ffmpeg: realVideoTools, locale: localeOf(analysisStore, workspaceId),
      transcribe: async (wav: string) => {
        const language = process.env.CROSSLINE_TRANSCRIBE_LANGUAGE?.trim();
        const heard = await transcriber.transcribeSpeech(readFileSync(wav), "audio.wav", { ...(language ? { language } : {}), locale: localeOf(analysisStore, workspaceId) });
        if (heard.state === "transcribed") return { text: heard.text };
        const t = tOfWorkspace(analysisStore, workspaceId);
        return { problem: heard.state === "needs_download" ? t("语音识别模型还没下载（设置 → 录音里可下载），视频未转写") : heard.state === "silent" ? t("视频里没有听到说话") : heard.state === "failed" ? heard.message : t("转写被中止") };
      },
      log: (event) => console.info(JSON.stringify({ ...event, workspaceId, checkedAt: new Date().toISOString() })) };
  },
  log: (event) => console.info(JSON.stringify({ ...event, checkedAt: new Date().toISOString() }))
});
// Logins where this worker has no screen (the hosted beta): a headless browser on the server, streamed into a dialog on the page
// (remote-browser.ts). On the person's own computer the login stays a window on their desktop and none of this starts.
const remoteBrowsers = loginMode() === "remote" ? createRemoteBrowsers({
  resolve: (workspaceId, workflowId, service) => workflowLoginTarget(analysisStore, workspaceId, workflowId, service, browserProfilesRoot(workspaceId)),
  onLoggedIn: (workspaceId, workflowId, service) => recordGrownLogin(analysisStore, workspaceId, workflowId, service, new Date(), ""),
  busy: (workspaceId, workflowId) => workflowCollecting(workspaceId, workflowId) ? tOfWorkspace(analysisStore, workspaceId)("正在读取收藏") : undefined,
  executablePath: () => loginBrowser(), locale: (workspaceId) => localeOf(analysisStore, workspaceId),
  log: (event) => console.info(JSON.stringify({ ...event, checkedAt: new Date().toISOString() }))
}) : undefined;
configureRemoteLogin(remoteBrowsers);
if (remoteBrowsers) setInterval(() => { void remoteBrowsers.sweep().catch(() => undefined); }, 30_000).unref();
const agentService = createAgentService({
  // The owner's assistant (tools mode on the hosted site) runs through the pool too: its nodes add room for more at once.
  concurrency: (workspaceId) => workspaceConcurrency(workspaceId),
  // The shell assistant runs on the machine owner's runtime only: it works with the operating system user's files, and a guard is a
  // tripwire, not a sandbox, so it is not offered to other accounts on this machine (docs/model-providers.md).
  store: analysisStore, repoRoot, getClient: () => codexSupervisor?.client, readCost: () => readCost(), isOwner: machineOwner,
  // Everyone else's assistant works through Crossline's own functions on the account's own model (docs/personal-agent.md, 2026-10-19).
  modeFor: (workspaceId) => machineOwner(workspaceId) ? "shell" : sandboxShell.ok ? "sandbox" : "tools",
  // What a sandboxed run may never read: the server's data and state (every account's ledger, files and runtime homes) — its own task
  // folder and inputs, which live under them, stay reachable because the more specific entry wins.
  sandbox: { readable: [path.dirname(process.env.CROSSLINE_CODEX_PATH ?? "/opt/codex/codex")], deny: [dataDir, process.env.CROSSLINE_STATE_DIR ?? path.join(dataDir, "..", "state")] },
  clientFor: accountClient,
  mailFor: (workspaceId) => mailService.lookup(workspaceId),
  log: (event) => console.info(JSON.stringify({ ...event, checkedAt: new Date().toISOString() }))
});
// Automations (docs/personal-agent.md): requests in words designed into a trigger and steps, then watched every tick and run by the
// assistant when they fire. Designing is the person's own request (core work); firing runs while the person is around or cooling off,
// and stops — with everything else — once they have been away a week.
const automationDeps: AutomationDeps = { store: analysisStore, cwd: repoRoot, client: accountClient,
  runFree: (workspaceId, input, after) => agentService.runFree(workspaceId, input, after),
  zone: (workspaceId) => calendarZone(workspaceId) ?? process.env.CROSSLINE_TIME_ZONE?.trim() ?? "America/Chicago",
  log: (event) => console.info(JSON.stringify({ ...event, checkedAt: new Date().toISOString() })) };
const designingAutomations = new Set<string>();
async function automationDesignPass(workspaceId: string): Promise<void> {
  if (designingAutomations.has(workspaceId) || !codexSupervisor || !spendAllows(await spendFor(workspaceId), "core")) return;
  designingAutomations.add(workspaceId);
  try {
    enterUsageWorkspace(workspaceId);
    const designed = await designPending(automationDeps, workspaceId);
    if (designed.length) console.info(JSON.stringify({ type: "automation.designed", workspaceId, designed, checkedAt: new Date().toISOString() }));
  } finally { designingAutomations.delete(workspaceId); }
}
async function automationTick(workspaceId: string): Promise<void> {
  await automationDesignPass(workspaceId);
  // The machine owner's repeated errands are grown into workflows (workflowPass); everyone else is offered an automation for them.
  if (!machineOwner(workspaceId)) { try { suggestFromRepeats(analysisStore, workspaceId, growCandidates(analysisStore, workspaceId)); } catch { /* a courtesy */ } }
  if (!codexSupervisor || paused(workspaceId, "assistant") || !spendAllows(await spendFor(workspaceId), "intake")) return;
  enterUsageWorkspace(workspaceId);
  await automationPass(automationDeps, workspaceId);
}
// 「按链接添加」 a public skill (docs/skills-library.md §2): the person's link goes through the scout's own fetch, scan and review.
const publicSkillInstaller = createPublicSkillInstaller({ store: analysisStore, cwd: repoRoot, client: accountClient,
  beforeRun: (workspaceId) => enterUsageWorkspace(workspaceId),
  log: (event) => console.info(JSON.stringify({ ...event, checkedAt: new Date().toISOString() })) });
const automationService = createAutomationService({ ...automationDeps, afterRequest: (workspaceId) => { void automationDesignPass(workspaceId).catch(() => undefined); } });
for (const workspace of analysisStore.listWorkspaces()) {
  const lost = agentService.recoverLost(workspace.id);
  if (lost.length) console.info(JSON.stringify({ type: "agent.recovered_lost", workspaceId: workspace.id, lost, checkedAt: new Date().toISOString() }));
  // A collection the last worker was running when it stopped never wrote its end: closed, so the page does not show it running.
  const interrupted = closeInterruptedCollections(analysisStore, workspace.id);
  if (interrupted.length) console.info(JSON.stringify({ type: "collect.interrupted", workspaceId: workspace.id, interrupted, checkedAt: new Date().toISOString() }));
  const salvaged = agentService.salvageStopped(workspace.id);
  if (salvaged.length) console.info(JSON.stringify({ type: "agent.salvaged", workspaceId: workspace.id, salvaged, checkedAt: new Date().toISOString() }));
  // Once: the locks and 「deleted by the person」 marks that overlapping calendar publishes left behind (before the supervisor serves a publish).
  const repaired = repairFrozenRace(analysisStore, workspace.id, ownerOf(analysisStore, workspace.id));
  if (repaired && (repaired.released.length || repaired.republished.length))
    console.info(JSON.stringify({ type: "repair.frozen_race", workspaceId: workspace.id, released: repaired.released.length, republished: repaired.republished.length, checkedAt: new Date().toISOString() }));
  // Once: work the person marked done before 完成 became the acceptance (2026-10-15) and the gate then blocked is accepted as done.
  const ownDone = repairOwnCompletions(analysisStore, workspace.id, ownerOf(analysisStore, workspace.id));
  if (ownDone?.length) console.info(JSON.stringify({ type: "repair.own_completion", workspaceId: workspace.id, accepted: ownDone, checkedAt: new Date().toISOString() }));
  // Once: imported class blocks a date batch put on the plan twice (a weekly class and that day's dated session in one slot).
  const deduped = repairDuplicateImports(analysisStore, workspace.id, ownerOf(analysisStore, workspace.id));
  if (deduped) console.info(JSON.stringify({ type: "repair.import_duplicates", workspaceId: workspace.id, removed: deduped.removed, checkedAt: new Date().toISOString() }));
  // Once: long-term goal chips a model proposed before the adjective rule (2026-10-19) that are actions or achievements.
  const chips = repairLineAttributes(analysisStore, workspace.id, ownerOf(analysisStore, workspace.id));
  if (chips && Object.keys(chips).length) console.info(JSON.stringify({ type: "repair.line_attributes", workspaceId: workspace.id, removed: chips, checkedAt: new Date().toISOString() }));
  // Once: conversations from before the interview's extraction start at their last reply; facts written before numbered evidence get the
  // sentences their quotes stand in.
  try {
    const watermarks = backfillExtractWatermarks(analysisStore, workspace.id);
    if (watermarks) console.info(JSON.stringify({ type: "repair.extract_watermarks", workspaceId: workspace.id, sessions: watermarks }));
    const evidence = backfillFactEvidence(analysisStore, workspace.id);
    if (evidence) console.info(JSON.stringify({ type: "repair.fact_evidence", workspaceId: workspace.id, ...evidence, checkedAt: new Date().toISOString() }));
  } catch (error) { console.warn(JSON.stringify({ type: "repair.fact_evidence_failed", workspaceId: workspace.id, error: String(error), checkedAt: new Date().toISOString() })); }
  // First drafts begun by a worker that stopped before any milestone existed were lost with it: forget the start, so the pass runs
  // again and the screens do not say 「正在设计」 for a run nobody is doing.
  if (analysisStore.getSetting(workspace.id, FIRST_DRAFTS_SETTING) && !analysisStore.listMilestones(workspace.id).length)
    analysisStore.deleteSetting(workspace.id, FIRST_DRAFTS_SETTING);
}
// Once: Codex's own memories (now off for structured Skills) become each account's lessons, and the files are moved into the data
// folder's backups (codex-memory-import.ts, docs/token-economy.md §2). Before the runtime starts, so nothing holds them open.
try {
  const ownerHome = codexProcessEnvironment().CODEX_HOME;
  const imported = importCodexMemories(analysisStore, { dataDir,
    homes: [...(ownerHome ? [{ label: "owner", dir: ownerHome }] : []), ...guestCodexHomes(runtimesDir())] });
  if (imported) console.info(JSON.stringify({ type: "repair.codex_memory_import", ...imported, checkedAt: new Date().toISOString() }));
} catch (error) { console.warn(JSON.stringify({ type: "repair.codex_memory_import_failed", error: String(error), checkedAt: new Date().toISOString() })); }
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
  void withUsagePurpose(NON_CORE_PURPOSE, async () => {
    enterUsageWorkspace(workspaceId);
    for (const identityId of due) {
      const outcome = await getDiligence(workspaceId)(identityId).catch((error): { state: "blocked"; code: string; message: string } =>
        ({ state: "blocked", code: "DILIGENCE_FAILED", message: error instanceof Error ? error.message : "" }));
      console.info(JSON.stringify({ type: `diligence.${outcome.state}`, checkedAt, workspaceId, identityId, ...outcome }));
      // A tight budget applies to every line alike: stop rather than ask the next one and be told the same.
      if (outcome.state === "blocked" && /BUDGET|COST_SIGNAL/.test(outcome.code)) break;
    }
  }).finally(() => diligencePasses.delete(workspaceId));
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
    preparer = createManualbookBuilder(analysisStore, workspaceId, materialsDir, repoRoot, () => accountClient(workspaceId), { readCost: () => readCost(workspaceId) });
    materialPreparers.set(workspaceId, preparer);
  }
  return preparer;
};
const milestoneGates = new Map<string, ReturnType<typeof createMilestoneGate>>();
const getMilestoneGate = (workspaceId: string) => {
  let gate = milestoneGates.get(workspaceId);
  if (!gate) {
    gate = createMilestoneGate(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId));
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
    explainer = createPlanExplainer(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId));
    planExplainers.set(workspaceId, explainer);
  }
  return explainer;
};
const weeklyInsights = new Map<string, ReturnType<typeof createWeeklyInsight>>();
const getWeeklyInsight = (workspaceId: string) => {
  let insight = weeklyInsights.get(workspaceId);
  if (!insight) {
    insight = createWeeklyInsight(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId));
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
    // Per workspace: the placeholders a reader writes (an untitled event, an unnamed calendar) are in that workspace's language.
    const readerFor = (workspaceId: string) => (bound: GraphCredentialProvider, calendarId?: string) =>
      new GraphReadSource({ credential: bound, futureDays: 63, ...(calendarId ? { calendarId } : {}), locale: localeOf(analysisStore, workspaceId) });

    // A newly signed-in account arrives with its default calendar already ticked instead of appearing
    // to do nothing — done once per real workspace (not once globally), the first time any of the three
    // functions below is actually asked about that workspace.
    const catalogueSeeded = new Set<string>();
    const ensureCatalogueSeeded = async (workspaceId: string) => {
      if (catalogueSeeded.has(workspaceId)) return;
      catalogueSeeded.add(workspaceId);
      const catalogue = await listCatalogue(credential, analysisStore, workspaceId, readerFor(workspaceId));
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
          sources: () => [...buildSources(analysisStore, workspaceId, credential, readerFor(workspaceId)), ...subscriptionsOf(workspaceId)],
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
      return { state: "blocked", code: "GRAPH_LOGIN_OTHER_ACCOUNT", message: tOfWorkspace(analysisStore, workspaceId)("本机的日历登录属于另一个账号；这个账号要读日历需用自己的微软账号登录。") };
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
        const fresh = await listCatalogue(credential, analysisStore, workspaceId, readerFor(workspaceId));
        seedNewAccounts(analysisStore, workspaceId, fresh);
        // Re-read rather than reuse: seeding may have ticked a calendar that the first pass showed
        // unticked, and showing the person a list that is already one step stale is how a checkbox
        // ends up disagreeing with what the next sync actually reads.
        return listCatalogue(credential, analysisStore, workspaceId, readerFor(workspaceId));
      },
      saveSources: async (workspaceId: string, keys: string[]) => {
        if (await foreign(workspaceId)) return [];
        await ensureCatalogueSeeded(workspaceId);
        const fresh = await listCatalogue(credential, analysisStore, workspaceId, readerFor(workspaceId));
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
        return listCatalogue(credential, analysisStore, workspaceId, readerFor(workspaceId));
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

/**
 * How many runs of one workspace a pass starts at once: the account's share of the model gate, plus the runs its compute nodes take
 * (docs/compute-node.md, 协同: a node is far stronger than this server, so the owner's planning and assistant work fan out across it).
 */
function workspaceConcurrency(workspaceId: string): number {
  try { return accountConcurrency() + (nodeHub && workspaceId === runtimeOwner(analysisStore) ? nodeHub.capacity(workspaceId) : 0); }
  catch { return accountConcurrency(); }
}

// The compute node (docs/compute-node.md): on the hosted site the owner's own computer may connect out to `wss://<site>/node` (Caddy
// hands it to this port) and serve the owner's model runs with its Codex; with no node connected, or the switch off, nothing changes.
const nodePort = Number(process.env.CROSSLINE_NODE_PORT ?? (hostedBeta ? 3213 : 0));
const crosslineMarketplace = path.join(repoRoot, "skills", "marketplace", ".agents", "plugins", "marketplace.json");
const nodeHub: NodeHub | undefined = nodePort > 0 ? await createNodeHub({
  port: nodePort,
  // A linked device's token, or the standalone node's own (paired on the 「这台电脑」 card).
  authenticate: (token) => {
    const hash = createHash("sha256").update(token).digest();
    return analysisStore.listWorkspaces().find((workspace) => [DEVICE_TOKEN_SETTING, NODE_TOKEN_SETTING].some((key) => {
      const stored = analysisStore.getSetting(workspace.id, key);
      return stored?.length === 64 && timingSafeEqual(Buffer.from(stored, "hex"), hash);
    }))?.id;
  },
  // Only the runtime owner's account, and only once it switched the node on (the plan's A; other accounts are P4).
  allowed: (workspaceId) => workspaceId === runtimeOwner(analysisStore) && analysisStore.getSetting(workspaceId, NODE_COMPUTE_SETTING) === "on",
  roots: (workspaceId) => [path.dirname(path.dirname(path.dirname(crosslineMarketplace))), skillLibraryDir(workspaceId)],
  // The input box's typed copies of uploads (concierge.ts `asTypedImage`) and everything under the data directory (favourites' pictures).
  imageRoots: () => [path.join(tmpdir(), "crossline-images"), dataDir],
  gateway: () => `http://127.0.0.1:${modelGateway.port}`,
  serverCodex: () => codexSupervisor?.runtimeVersion ?? "",
  prepare: async (client) => {
    const skills = await installLocalPlugin(client, { name: "crossline", marketplacePath: crosslineMarketplace, cwd: repoRoot, requiredSkills: REQUIRED_SKILLS });
    const missing = REQUIRED_SKILLS.filter((name) => !skills.includes(name));
    if (missing.length) throw new Error(`CODEX_PLUGIN_SKILLS_MISSING ${missing.slice(0, 3).join(",")}`);
  },
  onStatus: (workspaceId, status) => analysisStore.setSetting(workspaceId, NODE_STATUS_SETTING, JSON.stringify(status)),
  log: (event) => console.info(JSON.stringify({ ...event, checkedAt: new Date().toISOString() }))
}).catch((error: unknown) => { console.warn(JSON.stringify({ type: "node.hub_failed", message: error instanceof Error ? error.message : String(error) })); return undefined; }) : undefined;

// Independent from BETTER_AUTH_SECRET on purpose: the auth secret leaking should not also hand out the
// ability to trigger real Codex runs on the loopback supervisor port — see `packages/codex/src/capability.ts`.
const capabilitySecret = process.env.CROSSLINE_SUPERVISOR_CAPABILITY_SECRET?.trim();
if (!capabilitySecret) {
  console.warn(JSON.stringify({ type: "worker.blocked", code: "CROSSLINE_SUPERVISOR_CAPABILITY_SECRET_MISSING" }));
} else try {
  codexSupervisor = await startCodexSupervisor({
    port: supervisorPort,
    capabilitySecret,
    // The owner's runtime cannot be replaced in place, so a killed one restarts the whole worker (docker's `unless-stopped` on the
    // hosted beta, the keeper loop here). The lock goes first: a new container's process can get the same PID and would otherwise read
    // the old lock as alive and stand down (`worker.already_running`). Exit code 1, so the restart is visible in restarts.log.
    onRuntimeExit: () => {
      console.error(JSON.stringify({ type: "codex.runtime_exited", action: "worker_restart", at: new Date().toISOString() }));
      setTimeout(() => {
        try { rmSync(lockPath, { force: true }); } catch { /* goes stale on its own */ }
        process.exit(1);
      }, 2_000).unref();
    },
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
      onConnected: (workspaceId) => { void afterConnected(workspaceId); },
      ...(hostedBeta ? { maxRunning: guestRuntimeLimit() ?? 2, idleMs: 10 * 60_000 } : {}) },
    modelProviders: { handle: (method, pathname, workspaceId, body) => modelProviders.handle(method, pathname, workspaceId, body),
      cost: (workspaceId) => modelProviders.cost(workspaceId), afterChatgptCost: (workspaceId, signal) => modelProviders.afterChatgptCost(workspaceId, signal) },
    services: [{ prefix: "/v1/mail", handle: mailService.handle }, { prefix: "/v1/import", handle: importService.handle }, { prefix: "/v1/automations", handle: automationService.handle },
      { prefix: "/v1/skills/public", handle: publicSkillInstaller.handle },
      // The login browser on the server, shown in a dialog on the page (remote-browser.ts); only where there is no screen of our own.
      ...(remoteBrowsers ? [{ prefix: "/v1/remote-browser", handle: remoteBrowsers.handle }] : []),
      // Linking this computer as a device of the hosted account (docs/device-mode.md); the worker restarts into device mode.
      { prefix: "/v1/device", handle: createDeviceLinkService({ dataDir, secrets, onChanged: restartForMode, localeFor: (workspaceId) => localeOf(analysisStore, workspaceId) }).handle }],
    monthSpend: (workspaceId) => monthSpend(analysisStore, workspaceId),
    // The owner's runs spread over this server's runtime and every compute node connected for the account (runtime-pool.ts).
    ...(nodeHub ? { ownerNodes: () => { const owner = runtimeOwner(analysisStore); return owner ? nodeHub.members(owner) : []; } } : {}),
    autoAnalyzeCaptures: (workspaceId) => autoAnalyzePass(workspaceId),
    autoBackplanGoals: (workspaceId) => autoBackplanPass(workspaceId),
    runTaskPass: (workspaceId) => stepPlanPass(workspaceId),
    splitGoals: (workspaceId) => goalSplitPass(workspaceId),
    conciergeTurn: (workspaceId, request, signal) => { enterUsageWorkspace(workspaceId);
      return createConcierge(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId))(request as unknown as ConciergeRequest, signal); },
    analyzeCapture: (client, id, signal, workspaceId) => getCaptureAnalyzer(workspaceId)(client, id, signal),
    // `workspaceId` is the real caller's, from its own verified capability token — not a hardcoded
    // constant, which is what left milestone proposal and goal backplanning invisible to any real
    // account the same way material prep/the milestone gate/calendar sync were (see `getMaterialPreparer`
    // above for the fuller explanation; this is the same bug, same fix, in the same file).
    proposeMilestones: (_client, request, signal, workspaceId, only) =>
      createMilestoneProposer(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId))(request, signal, only)
        // The new drafts are read for risks right away, so the person sees them when deciding (in the background; the answer is not held for it).
        .finally(() => { void milestoneRiskPass(workspaceId).catch(() => undefined); }),
    continueMilestoneConversation: (_client, threadId, message, signal, workspaceId) =>
      createMilestoneConversation(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId))(threadId, message, signal),
    onboardingTurn: (_client, sessionId, text, _signal, workspaceId, reread) =>
      createOnboardingSessionRunner(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId))({ sessionId, text, ...(reread ? { reread: true } : {}) })
        // The interview just finished: the first drafts start now, not at the next tick up to fifteen minutes later, while 主线 said
        // 「完成初始访谈后生成」 to someone who had (2026-10-17 walkthrough, W-12).
        .then((outcome) => {
          // The interview just finished: the first drafts, and the search for the lines' skills (lineSetupDue), start now, not at the next tick.
          if (outcome.state === "ready") { void firstDraftsPass(workspaceId).catch(() => undefined); void publicSkillPass(workspaceId, new Date().toISOString()).catch(() => undefined); }
          return outcome; }),
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
        machineOwner(workspaceId) ? previewFolder(folderPath, folderDeps, personNames(analysisStore, workspaceId, names), localeOf(analysisStore, workspaceId)) : ownerOnlyFolder(workspaceId),
      add: async (workspaceId: string, folderPath: string, rules?: { exclude?: unknown; include?: unknown; names?: unknown }) => {
        if (!machineOwner(workspaceId)) return ownerOnlyFolder(workspaceId);
        const added = await addFolder(analysisStore, workspaceId, folderPath, folderDeps, rules);
        // Read in the background: a folder can take minutes; the page shows its progress from the folder list.
        if (added.state === "added") void folderPass(workspaceId, new Date().toISOString()).catch(() => undefined);
        return added;
      },
      remove: async (workspaceId: string, id: string, purge?: boolean) => removeFolder(analysisStore, workspaceId, id, { purge: Boolean(purge), dataDir }),
      setRules: async (workspaceId: string, id: string, rules: { exclude?: unknown; include?: unknown; names?: unknown }) =>
        machineOwner(workspaceId) ? setFolderRules(analysisStore, workspaceId, id, rules, folderDepsFor(workspaceId)) : ownerOnlyFolder(workspaceId),
      setLines: async (workspaceId: string, id: string, lines: string[]) => ({ saved: setFolderLines(analysisStore, workspaceId, id, lines) })
    },
    extractBackgroundFacts: (_client, captureTitle, captureContext, signal, workspaceId) =>
      createBackgroundFactsExtractor(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId))(captureTitle, captureContext, signal),
    backplanGoal: (_client, milestoneId, signal, workspaceId) =>
      createGoalBackplanner(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId))(milestoneId, signal),
    // The same preparer/gate the tick loop uses, exposed so a person's retry gets an answer now rather
    // than at the next tick. `pendingMaterialWorkOrders`/`pendingMilestoneGates` still govern which
    // orders the loop itself picks up.
    prepareMaterials: (workOrderId, workspaceId) => getMaterialPreparer(workspaceId)(workOrderId),
    writePortrait: (workspaceId, options) => options.redrawFigure ? redrawFigureFor(workspaceId) : writePortraitFor(workspaceId),
    buildTutorial: (workOrderId, workspaceId) => { enterUsageWorkspace(workspaceId); return getMaterialPreparer(workspaceId)(workOrderId, { mode: "tutorial" }); },
    judgeMilestone: (workOrderId, workspaceId) => getMilestoneGate(workspaceId)(workOrderId),
    dispatchAgentTask: (workspaceId, workOrderId, category, stepId) => agentService.dispatch(workspaceId, workOrderId, category, stepId),
    agentProgress: (workspaceId, taskId) => agentService.progress(workspaceId, taskId),
    cancelAgentTask: (workspaceId, taskId) => agentService.cancel(workspaceId, taskId),
    retryAgentTask: async (workspaceId, taskId, input) => { const result = await agentService.retry(workspaceId, taskId, input); void workflowPass(workspaceId, new Date().toISOString()).catch(() => undefined); return result; },
    growWorkflows: (workspaceId) => { void workflowPass(workspaceId, new Date().toISOString()).catch(() => undefined); },
    workflowAction: (workspaceId, id, action, service, viewport) => {
      if (action === "login") return openWorkflowLogin(analysisStore, workspaceId, id, service, browserProfilesRoot(workspaceId), {}, viewport);
      if (action === "login_done") return finishWorkflowLogin(analysisStore, workspaceId, id, service);
      const t = tOfWorkspace(analysisStore, workspaceId);
      const record = readGrownSkills(analysisStore, workspaceId).find((item) => item.id === id && item.status === "active");
      if (!record) return { ok: false, code: "WORKFLOW_NOT_ACTIVE", message: t("这个工作流还没启用。") };
      if (isPaused(analysisStore, workspaceId)) return { ok: false, code: "AGENT_PAUSED", message: t("助手已暂停。") };
      resumeByPerson(analysisStore, workspaceId, record);
      const started = startWorkflowRun(analysisStore, workspaceId, record, (input, after) => agentService.runFree(workspaceId, input, after), browserProfilesRoot(workspaceId));
      if (started.state === "started") markWorkflowRun(analysisStore, workspaceId, id, "started_by_person");
      return started.state === "started" ? { ok: true, taskId: started.taskId }
        : { ok: false, code: started.state === "blocked" ? started.code : "AGENT_CATEGORY_NOT_APPROVED", message: started.state === "blocked" ? started.message : t("助手还没获准做「{{label}}」这类工作。", { label: t(started.label) }) };
    },
    calendarWriteLogin: {
      start: (workspaceId: string) => calendarWriteLogin.start(workspaceId),
      status: (workspaceId: string) => calendarWriteLogin.status(workspaceId)
    },
    publishCalendar: async (workspaceId, blocks, scope) => {
      const session = await getCalendarWriteSession();
      if (!session) return { state: "blocked", code: "GRAPH_NOT_CONFIGURED", message: tOfWorkspace(analysisStore, workspaceId)("没有配置 Microsoft 日历（CROSSLINE_MS_CLIENT_ID）。") };
      return createCalendarPublisher(analysisStore, workspaceId, { credentialFor: (accountId) => session.credentialFor(accountId) })(blocks, scope);
    },
    explainPlan: (today, workspaceId, ranking) => getPlanExplainer(workspaceId)(today, readRanking(ranking)),
    runWeeklyInsight: (workspaceId) => getWeeklyInsight(workspaceId)(),
    // 立即同步日历 records its outcome like a tick does, so a read that works clears 「日历无法读取」 at once. A workspace that reads no
    // calendar at all is told so, and nothing is recorded (it is not a failure).
    syncCalendar: async (workspaceId: string) => {
      const outcome = await syncCalendarFor(workspaceId);
      if (!outcome) return { state: "blocked", code: "CALENDAR_NOT_CONNECTED", message: tOfWorkspace(analysisStore, workspaceId)("还没有接入任何日历。") };
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
  // The developer's model is chosen by measurement: candidates without a current record are tested shortly after start, and again
  // whenever a record goes stale (a new runtime, a changed list, thirty days); a model already measured is not tested again.
  if (sponsorService && process.env.CROSSLINE_RUN_ONCE !== "1") {
    let spentKey = false;
    const evaluateSponsor = () => void sponsorService?.evaluate().then((outcome) => { spentKey = outcome.exhausted || outcome.interrupted; }, (error: unknown) =>
      console.warn(JSON.stringify({ type: "sponsor.evaluate_failed", message: error instanceof Error ? error.message : String(error) })));
    setTimeout(evaluateSponsor, 2 * 60_000).unref();
    // The periodic re-check of stale candidates runs in the cheaper hours (one of the four daily calls falls in them); the one after a
    // start runs at once, since a deploy is when the prompts or the code it measures changed.
    setInterval(() => { if (sponsorOffPeak(new Date())) evaluateSponsor(); }, 6 * 60 * 60_000).unref();
    // A spent key, a measurement the runtime cut short, or nothing chosen at all: tried again every half hour (a spent key answers at once,
    // so a try costs nothing), and the measurement resumes as soon as the balance is topped up or the runtime is back.
    setInterval(() => { if (spentKey || !sponsorService?.chosen()) evaluateSponsor(); }, 30 * 60_000).unref();
  }
  // Other accounts' runtimes stop after a quiet spell (above), so an idle account holds no process.
  setInterval(() => codexSupervisor?.runtimes?.stopIdle(), 60_000).unref();
  // One model run at a time on the hosted beta, and none started above the memory high-water mark (model-gate.ts).
  // The candidates' measurement is no person's account (one tenant, `sponsor-eval`): it may use every background slot nobody else wants.
  configureModelGate({ probe: () => containerMemory(), reserved: heldMemory,
    // The owner's compute nodes add their capacity to the owner's share, and while one has room the owner's next run is not held by this
    // process's memory (docs/compute-node.md, 协同).
    ...(nodeHub ? {
      extraCapacity: (tenant: string) => tenant === runtimeOwner(analysisStore) ? nodeHub.capacity(tenant) : 0,
      nodeRoom: (tenant: string) => {
        if (tenant !== runtimeOwner(analysisStore)) return false;
        const load = codexSupervisor?.ownerPool?.load() ?? {};
        return nodeHub.members(tenant).some((member) => (load[member.id] ?? 0) < member.capacity);
      }
    } : {}),
    reclaim: () => codexSupervisor?.runtimes?.reclaim(), tenantLimits: { "sponsor-eval": Number.POSITIVE_INFINITY } });
  // What the health check and the logs read: memory in use, its ceiling and peak, and the gate's line, every five minutes.
  const mb = (bytes: number | undefined) => bytes === undefined ? null : Math.round(bytes / 1048576);
  setInterval(() => {
    const gate = modelGateStatus();
    console.info(JSON.stringify({ type: "worker.memory", usedMb: mb(gate.memory?.used), limitMb: mb(gate.memory?.limit), peakMb: mb(containerPeak()), heldMb: mb(heldMemory()),
      active: gate.active, queued: gate.queued }));
  }, 5 * 60_000).unref();
} catch {
  console.warn(JSON.stringify({ type: "worker.blocked", code: "CODEX_SUPERVISOR_START_FAILED" }));
}

const releaseWorkerLock = (): void => {
  try { rmSync(lockPath, { force: true }); } catch { /* a leftover lock goes stale on its own */ }
};

await tick({ waitForWorkspaces: process.env.CROSSLINE_RUN_ONCE === "1" });
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
    // The text is in the workspace's language; `lang` tells the phone's service worker which, for the button it adds itself.
    const sent = { ...message, lang: htmlLang(localeOf(analysisStore, workspaceId)) };
    const results = await Promise.all(devices.map((device) => sendWebPush(device, sent, keys)));
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
    // A login browser left open would hold its profile and lose its session cookies; closed the way 「取消」 closes it.
    await remoteBrowsers?.closeAll().catch(() => undefined);
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

