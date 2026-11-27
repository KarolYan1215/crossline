import "@crossline/i18n/catalog/worker";
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { accountConcurrency, breakdownOfResponsesUsage, codexProcessEnvironment, flushMeteredUsage, recordMeteredUsage, configureModelGate, enterUsageWorkspace, protectSkillFolders, guestRuntimeLimit, installLocalPlugin, installUndiciAssertionGuard, modelGateStatus, setDesignNoteProvider, setInstructionsProvider, setLocalLookupProvider, setPrivateGuardProvider, setWebAvailableProvider, webResearchBlocker, setEffortPreferenceProvider, setModelChoiceProvider, setLocaleProvider, setProviderResolver, setSpendModeProvider, setUsageLimitHandler, setUsageSink, startCodexSupervisor, startModelGateway, withUsagePurpose, type CodexSupervisor } from "@crossline/codex";
import { containerMemory, containerPeak, createCollectMemory, heldMemory } from "./memory";
import { createDpapiSecretStore } from "@crossline/connectors";
import { createModelProviderService } from "./model-provider";
import { createSponsorService, sponsorFromEnv, type SponsorService } from "./sponsor";
import { CrosslineStore, currentInstructionsOf, designSkillNote, readLocale, recordGrownLogin, backfillExtractWatermarks, backfillFactEvidence, isPaused, listPushSubscriptions, readGrownSkills, removePushSubscriptions, repairOwnCompletions, installRuleTelemetry, nodeComputeOn } from "@crossline/db";
import { createCaptureAnalyzer } from "./analysis";
import { closeInterruptedCollections, createFavouritesTopicsService, createTopicClassifier, refreshFavouritesTopicsText } from "./favourites-topics";
import { sweepLegacyDrills } from "./drill-sweep";
import { localLookupsFor } from "./local-lookups";
import { notifyPass } from "./notify";
import { createActivityTracker } from "./activity-recorder";
import { agentHistoryPass } from "./agent-history";
import { createDeviceLinkService, readDeviceLink, standardDeviceService } from "./device/link";
import { workerMode } from "./device/mode";
import { runDeviceWorker } from "./device/worker";
import { createWindowsActivitySource } from "./activity-source";
import { createNightlyFlywheel } from "./nightly";
import { createDiligenceRunner, linesDueForDiligence } from "./diligence";
import { createAgentService, defaultOutputRoot } from "./agent-service";
import { createMediaDescriber, realVideoTools } from "./note-media";
import { createCalendarPublisher } from "./calendar-publish";
import { publishGoogleCalendar } from "./google-calendar-publish";
import { repairDuplicateImports, repairFrozenRace } from "./calendar-repair";
import { repairLineAttributes } from "./attribute-repair";
import { hourly } from "./self-check-host";
import { createWriteLogin } from "./calendar-write-login";
import { AGENT_HISTORY_CONSENT, AGENT_HISTORY_SUMMARY, BACKGROUND_PAUSED, DEVICE_TOKEN_SETTING, NODE_COMPUTE_SETTING, NODE_STATUS_SETTING, NODE_TOKEN_SETTING, EVAL_HOLD_FILE, evalHoldActive, backgroundSpend, sponsorOffPeak, CALENDAR_SYNC_FAILURE, htmlLang, FIRST_DRAFTS_SETTING, pausedKinds, spendAllows, NON_CORE_PURPOSE, type BackgroundKind, type PlanRankingInput, MODEL_EFFORT_SETTING, effortPreferenceOf, MODEL_CHOICE_SETTING, modelChoiceFor, modelChoicesOf } from "@crossline/core";
import { createFlywheelExpander } from "./flywheel";
import { createManualbookBuilder } from "./manualbook";
import { guestCodexHomes, importCodexMemories } from "./codex-memory-import";
import { createPublicSkillInstaller } from "./public-skills";
import { browserProfilesRoot, configureFavouritesCollector, configureRemoteLogin, finishWorkflowLogin, growCandidates, loginBrowser, markWorkflowRun, openWorkflowLogin, resumeByPerson, startWorkflowRun, workflowCollecting, workflowLoginTarget } from "./workflow-smith";
import { loginMode } from "./browser-launch";
import { createFormService } from "./form-service";
import { localCommitPass } from "./git-commits";
import { createRemoteService } from "./remote-service";
import { computerInboxPass } from "./recording-inbox";
import { createRemoteBrowsers } from "./remote-browser";
import { localeOf, tOfWorkspace } from "./locale";
import { createConcierge, type ConciergeRequest } from "./concierge";
import { createMilestoneGate } from "./milestone-gate-runner";
import { createMilestoneConversation, createMilestoneProposer } from "./milestone-proposer";
import { createGoalBackplanner } from "./goal-backplanner";
import { createPlanExplainer } from "./plan-explainer-runner";
import { createWeeklyInsight } from "./weekly-insight-runner";
import { createOnboardingSessionRunner, enqueueInterview, finishInterview, steerInterview } from "./onboarding-session";
import { researchRunnerFor } from "./onboarding-research";
import { reextractForLayout } from "./extract";
import { readSourceText } from "./source-intake";
import { createTranscriber, createWhisperEngine, modelsDirectory } from "./transcribe";
import { recordingsOn } from "./recordings";
import { createBackgroundFactsExtractor } from "./background-facts-runner";
import { createGraphSync, type SyncOutcome } from "./graph-sync";
import { addSubscription, hasSubscriptions, removeSubscription, subscriptionSources } from "./calendar-subscriptions";
import { addFolder, configureFolderReading, personNames, previewFolder, removeFolder, setFolderLines, setFolderRules, type FolderDeps } from "./source-folders";
import { createFolderScreener } from "./folder-classifier";
import { homedir, tmpdir } from "node:os";
import { defaultSafeGetDeps } from "./safe-fetch";
import { PERSONAL_PLUGIN, REQUIRED_SKILLS } from "./required-skills";
import { privateGuardFor } from "./private-guard";
import { createMailService } from "./mailbox";
import { createImportService } from "./importer";
import { createDictationService } from "./dictation";
import { probeSandboxShell } from "./sandbox-probe";
import { automationPass, reconcileAutomationRuns, createAutomationService, designPending, onNewMail, suggestFromRepeats, type AutomationDeps } from "./automations";
import { createWorkflowThreadService } from "./workflow-thread";
import { monthSpend, ownerOf, runtimeOwner, runtimeTmpFor, runtimesDir } from "./owner";
import { createNodeHub, type NodeHub } from "./node/hub";
import { skillLibraryDir } from "./skill-library";
import { skillStoreFolders } from "./skill-lock";
import { createBackgroundSpend } from "./spend";
import { telemetryPass } from "./telemetry";
import { createWorkerTimers } from "./timers";
import {
  buildSources, calendarLabel, listCatalogue, readSelection, saveSelection, seedNewAccounts, sourceKey, mayUseGraphLogin, withdrawForeignCalendar } from "./calendar-sources";
import { createGraphAuthSession, GraphReadSource, loadVapidKeys, sendWebPush, type GraphCredentialProvider } from "@crossline/connectors";
import { afterConnected, autoAnalyzePass, autoBackplanPass, firstDraftsPass, goalSplitPass, milestoneRiskPass, stepPlanPass } from "./passes/planning";
import { sentExcerptsByWorkspace } from "./passes/judging";
import { methodResearchPass, publicSkillPass, workflowPass } from "./passes/skills";
import { runSelfCheck, tick } from "./tick";
import { redrawFigureFor, writePortraitFor } from "./passes/portrait";
import { calendarLinePass, extractDocument, folderPass, resumeWaitingRecordings } from "./passes/intake";

export const repoRoot = path.resolve(import.meta.dirname, "../../..");
// The worker runs with its own package as cwd, and nothing else here reads .env files — so without
// this the calendar client id was simply never present and the sync could never switch on, silently.
// Node has this built in; no dependency is added for it. Values already in the environment win.
for (const file of [".env.local", ".env"]) {
  const envFile = path.join(repoRoot, file);
  if (existsSync(envFile)) { try { process.loadEnvFile(envFile); } catch { /* malformed: fall through */ } }
}
// Only the worker writes skills: the owner's shell under MXC is denied the library, its quarantine and the repository's own skills.
protectSkillFolders([...skillStoreFolders(), path.join(repoRoot, "skills")]);

const intervalMinutes = Number(process.env.CROSSLINE_SYNC_INTERVAL_MINUTES ?? 15);
export const webHealthUrl = process.env.CROSSLINE_WEB_HEALTH_URL ?? "http://127.0.0.1:3210/api/health";
export const dataDir = path.resolve(process.env.CROSSLINE_DATA_DIR ?? path.join(repoRoot, "data"));
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

export const beat = (): void => {
  try {
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, heartbeatAt: new Date().toISOString() }));
  } catch { /* a missed heartbeat only costs a takeover after staleAfterMs; never worth crashing for */ }
};

/**
 * Whatever reads this computer itself — its folders, its screen, its idle stretches, its coding agents' logs — belongs to the machine
 * owner's account only. A guest reaches this app over the private network from another device; offering them these readings handed
 * them the owner's documents, window titles and working hours (found walking the app as an invitee, 2026-10-15).
 */
// On the hosted beta the machine is a shared server: nobody's account reads its folders, screen or logs, and nobody gets its shell.
const hostedBeta = process.env.CROSSLINE_PUBLIC_BETA === "1";
export const machineOwner = (workspaceId: string) => !hostedBeta && runtimeOwner(analysisStore) === workspaceId;
// A compute node of the account's own whose person allowed the shell assistant on it (docs/compute-node.md P3). The hub is created
// further down; read before that (a pass at start-up) it is not there yet.
export const nodeShell = (workspaceId: string) => { try { return nodeHub?.shellFor(workspaceId); } catch { return undefined; } };
/** Whether this account's assistant has a shell: the machine owner's own computer, or one of its own nodes with the shell allowed. */
export const shellAssistant = (workspaceId: string) => machineOwner(workspaceId) || Boolean(nodeShell(workspaceId));
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
export const heldForEval = (workspaceId: string) => machineOwner(workspaceId) && evalHeld();
const ownerOnlyFolder = (workspaceId: string) => ({ state: "blocked" as const, code: "FOLDER_OWNER_ONLY",
  message: tOfWorkspace(analysisStore, workspaceId)("文件夹在运行 Crossline 的那台电脑上，只有那台电脑的主人能授权。请改用「添加文件」上传。") });
const folderDeps: FolderDeps = { dataDir, home: homedir(), readText: (bytes, kind, locale, fileName) => readSourceText(bytes, kind, fileName ?? "", locale) };
/**
 * With 录音自动转写 on, the folder pass also queues the recordings it finds (recordings.ts). Folders are this computer's own (the pass runs
 * for the machine owner only): what a folder held when it was authorized is listed (D3, 2026-11-22), then screened by the model by name and
 * only the files it keeps are read in (the person's decision of 2026-11-23, docs/plans/desktop-window-1123.md §6); the interview can still
 * open any listed file when it needs it.
 */
export const folderDepsFor = (workspaceId: string): FolderDeps => ({ ...folderDeps, audio: recordingsOn(analysisStore, workspaceId), onDemand: true });
configureFolderReading({ deps: folderDeps, allowed: machineOwner });

export let codexSupervisor: CodexSupervisor | undefined;
mkdirSync(dataDir, { recursive: true });
if (!claimWorkerLock()) {
  // Exit 0: the watchdog re-runs the launcher on a schedule, and a healthy worker already running is
  // the success case, not a failure to report.
  console.info(JSON.stringify({ type: "worker.already_running", lockPath }));
  process.exit(0);
}
// A provider closing a stream mid-response can make undici assert from a socket event, outside every request's promise; that one
// assertion is logged and the worker stays up instead of taking every account's model runs with it (packages/codex/src/undici-guard.ts).
installUndiciAssertionGuard();
// Rule firings (packages/core/src/rule-spec.ts) go to `<data dir>/telemetry/rule-fired.jsonl`, never the ledger.
installRuleTelemetry(dataDir);
export const analysisStore = new CrosslineStore(path.join(dataDir, "crossline.db"));
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
// Every repeating clock started before the one-shot exit below goes through this, so that exit can stop them before the ledger closes.
const workerTimers = createWorkerTimers();
// The developer's model for accounts that redeemed an invite code (sponsor.ts): only when the server has a key and candidates.
let sponsorService: SponsorService | undefined;
// The shell assistant for every account inside Codex's Linux sandbox, when the server turned it on and a sandbox really starts here.
export const sandboxNow = hourly(() => probeSandboxShell());
const sandboxShell = sandboxNow();
console.info(JSON.stringify({ type: "worker.sandbox_shell", ...sandboxShell }));
export const modelProviders = createModelProviderService({
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
export const activityTracker = createActivityTracker(analysisStore, () => analysisStore.listWorkspaces().map((workspace) => workspace.id).filter(machineOwner), activityIntervalSeconds);
const activitySource = createWindowsActivitySource({ intervalSeconds: activityIntervalSeconds });
export let lastIdle: { idleMs: number; at: number } | undefined;
if (process.env.CROSSLINE_RUN_ONCE !== "1") activitySource.start((reading) => { lastIdle = { idleMs: reading.idleMs, at: Date.now() }; activityTracker.handle(reading); });
process.on("exit", () => activitySource.stop());
/** A workspace's own quota: the owner's runtime for the owner, the account's own for anyone else (which starts it when connected). */
export const readCost = async (workspaceId?: string) => codexSupervisor
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
// The person's own note for a Skill (「我的设计」, packages/core/src/personal-design.ts), read per run.
setDesignNoteProvider((workspaceId, skill) => workspaceId ? designSkillNote(analysisStore, workspaceId, skill) : undefined);
setInstructionsProvider((workspaceId) => workspaceId ? currentInstructionsOf(analysisStore, workspaceId).text || undefined : undefined);
// Every model has the web as needed and the person's own files first (2026-11-18, `withSourceDefaults` in skill-runner).
setWebAvailableProvider(() => !webResearchBlocker());
setLocalLookupProvider((workspaceId) => workspaceId ? localLookupsFor(analysisStore, workspaceId) : undefined);
// What a search may not carry out (docs/plans/harness-1125.md §10): the person's identifiers and private text, read per check, kept nowhere.
setPrivateGuardProvider((workspaceId) => workspaceId ? privateGuardFor(analysisStore, secrets, workspaceId) : undefined);
// The person's 模型强度 (Settings → 模型连接), read per run; only runs on the account's own Codex take it (skill-runner).
setEffortPreferenceProvider((workspaceId) => effortPreferenceOf(workspaceId ? analysisStore.getSetting(workspaceId, MODEL_EFFORT_SETTING) : null));
// The person's own model and effort per Skill (D19: the interview's picker, Settings → 模型), read per run; it wins over the route table.
setModelChoiceProvider((workspaceId, skillName) => workspaceId ? modelChoiceFor(modelChoicesOf(analysisStore.getSetting(workspaceId, MODEL_CHOICE_SETTING)), skillName) : undefined);
// The one quota gate for every background pass (core: keeps the person's own work moving; discretionary: nobody is waiting on it).
const readSpend = createBackgroundSpend(analysisStore, (workspaceId) => readCost(workspaceId));
export const spendFor = async (workspaceId: string) => {
  const spend = await readSpend(workspaceId);
  return heldForEval(workspaceId) ? { ...spend, held: true } : spend;
};
/** A kind of background work the person paused on the background tasks page (the assistant has its own `agent.paused`). */
export const paused = (workspaceId: string, kind: BackgroundKind): boolean => pausedKinds(analysisStore.getSetting(workspaceId, BACKGROUND_PAUSED)).has(kind);
const nightlies = new Map<string, ReturnType<typeof createNightlyFlywheel>>();
export const getNightly = (workspaceId: string) => {
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
export const transcriber = createTranscriber({ ...createWhisperEngine(modelsDirectory(dataDir)), modelsDir: modelsDirectory(dataDir) });

/** After the model arrives, every recording that was waiting for it starts. */
// Files read before columns were kept (a schedule table came out as a list nobody could tell the columns of) are read once more.
void (async () => {
  for (const workspace of analysisStore.listWorkspaces()) {
    const changed = await reextractForLayout(analysisStore, workspace.id, (uri) => new Uint8Array(readFileSync(fileURLToPath(uri)))).catch(() => 0);
    if (changed) console.info(JSON.stringify({ type: "extract.layout_reread", workspaceId: workspace.id, files: changed }));
  }
})();
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
export const accountClient = (workspaceId: string) => {
  const handle = codexSupervisor?.runtimes?.handle(workspaceId);
  if (handle) return handle.ok ? handle.client : undefined;
  return machineOwner(workspaceId) || !hostedBeta ? codexSupervisor?.clientFor(workspaceId) : undefined;
};
// Filling registration forms for the machine owner (docs/opportunity-agent.md §10): a visible window of Crossline's own profile per
// site where this computer has a screen; on the hosted server, in the browser of the owner's connected compute node (§10.1).
export const formService = createFormService({ store: analysisStore, secrets, cwd: repoRoot, dataDir, client: accountClient,
  timeZone: (workspaceId) => calendarZone(workspaceId),
  owner: () => runtimeOwner(analysisStore), screen: loginMode() === "local",
  // Any account that paired its own computer fills forms in that computer's browser (docs/compute-node.md 方案 C).
  nodeAccount: (workspaceId) => nodeComputeOn(analysisStore, workspaceId),
  // nodeHub is created further down; read before that (a pass at start-up) it is not there yet.
  nodeBrowser: (workspaceId) => {
    try { return nodeHub?.browserFor(workspaceId); } catch { return undefined; }
  },
  log: (event) => console.info(JSON.stringify({ ...event, checkedAt: new Date().toISOString() })) });
// The person's mailbox, read-only (docs/personal-agent.md): new mail read every quarter hour and sorted into the inbox; the assistant
// searches and reads it; matching mail fires the person's automations. Sorting is intake work (it runs while the person is around or
// cooling off); reading never needs the model.
export const mailService = createMailService({ store: analysisStore, secrets, cwd: repoRoot, client: accountClient, dataDir,
  sortAllowed: async (workspaceId) => !paused(workspaceId, "intake") && spendAllows(await spendFor(workspaceId), "intake"),
  onNewMail: (workspaceId, messages) => {
    const queued = onNewMail(analysisStore, workspaceId, messages);
    console.info(JSON.stringify({ type: "automation.mail", workspaceId, messages: messages.length, queued, checkedAt: new Date().toISOString() })); void formService.onNewMail(workspaceId, messages).catch(() => undefined); },
  // Sorting's to-dos are captures: analysed at once, not at the next tick's intake.
  onCaptured: (workspaceId) => { void autoAnalyzePass(workspaceId).catch(() => undefined); },
  // The completion gate's evidence (J1): sent mail read as metadata into the ledger; the excerpts stay in memory for one pass.
  readSent: true,
  onSent: (workspaceId, messages) => {
    const held = sentExcerptsByWorkspace.get(workspaceId) ?? new Map<string, string>();
    for (const message of messages) held.set(`${message.accountId}:${message.uid}`, message.excerpt);
    sentExcerptsByWorkspace.set(workspaceId, held);
  },
  log: (event) => console.info(JSON.stringify({ ...event, checkedAt: new Date().toISOString() })) });
// Lists brought from Todoist, TickTick, Notion, a paste, a CSV or a screenshot (docs/personal-agent.md §9): tokens in the secret store,
// sorting is intake work like mail's, a screenshot is read by the picture reader on the account's own Codex.
export const importService = createImportService({ store: analysisStore, secrets, dataDir, cwd: repoRoot, client: accountClient,
  sortAllowed: async (workspaceId) => !paused(workspaceId, "intake") && spendAllows(await spendFor(workspaceId), "intake"),
  describe: (workspaceId) => { const client = accountClient(workspaceId); return client ? createMediaDescriber(client, repoRoot) : undefined; },
  timeZone: (workspaceId) => calendarZone(workspaceId),
  onCaptured: (workspaceId) => { void autoAnalyzePass(workspaceId).catch(() => undefined); },
  log: (event) => console.info(JSON.stringify({ ...event, checkedAt: new Date().toISOString() })) });
// Voice input's own engine and its correction (dictation.ts): the server transcriber on the hosted beta, SenseVoice in this process on an
// installed copy once its model is downloaded; clips are deleted as they are read and any left behind are swept within two minutes.
const dictationService = createDictationService({ store: analysisStore, dataDir, cwd: repoRoot, client: accountClient,
  mode: hostedBeta || process.env.CROSSLINE_SERVER_TRANSCRIBE === "1" ? "server" : "local",
  log: (event) => console.info(JSON.stringify({ ...event, checkedAt: new Date().toISOString() })) });
workerTimers.every(() => dictationService.sweep(), 60_000);
// The person's Xiaohongshu favourites, read whole by a worker job in their own visible browser (favourites-reader.ts): pictures described
// on the account's own Codex, videos heard by the recordings' transcriber (ffmpeg on the PATH, or CROSSLINE_FFMPEG).
const classifyTopics = createTopicClassifier(analysisStore, repoRoot, (workspaceId) => accountClient(workspaceId));
configureFavouritesCollector({
  outputRoot: defaultOutputRoot(),
  // The account's own computer reads the favourites when a node of theirs offers a browser (node/browser.ts); the hub is set up further down.
  nodeBrowser: (workspaceId) => { try { return nodeHub?.browserFor(workspaceId); } catch { return undefined; } },
  // The hosted server never logs in to or reads the site itself (docs/hosted-hardening.md §4): only a node of the person's does.
  onServer: !hostedBeta,
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
if (remoteBrowsers) workerTimers.every(() => { void remoteBrowsers.sweep().catch(() => undefined); }, 30_000);
// A form window waiting for the person is watched every half minute (their own submission, a closed window), not at the 15-minute tick.
workerTimers.every(() => {
  const owner = runtimeOwner(analysisStore);
  for (const workspace of analysisStore.listWorkspaces()) {
    if (workspace.id === owner || nodeComputeOn(analysisStore, workspace.id)) void formService.pass(workspace.id).catch(() => undefined);
  }
}, 30_000);
export const agentService = createAgentService({
  // The owner's assistant (tools mode on the hosted site) runs through the pool too: its nodes add room for more at once.
  concurrency: (workspaceId) => workspaceConcurrency(workspaceId),
  // The shell assistant runs on the machine owner's runtime only: it works with the operating system user's files, and a guard is a
  // tripwire, not a sandbox, so it is not offered to other accounts on this machine (docs/model-providers.md).
  store: analysisStore, repoRoot, getClient: () => codexSupervisor?.client, readCost: () => readCost(), isOwner: machineOwner,
  // Everyone else's assistant works through Crossline's own functions on the account's own model (docs/personal-agent.md, 2026-10-19).
  // An account whose own computer runs a node with the shell allowed gets the shell assistant there (docs/compute-node.md P3).
  modeFor: (workspaceId) => machineOwner(workspaceId) ? "shell" : nodeShell(workspaceId) ? "node" : sandboxNow().ok ? "sandbox" : "tools",
  nodeShell,
  // What a sandboxed run may never read: the server's data and state (every account's ledger, files and runtime homes) — its own task
  // folder and inputs, which live under them, stay reachable because the more specific entry wins.
  // The account's own runtime keeps its sandbox helper (`codex-linux-sandbox`, linked at start) in its home under the denied state
  // folder; `runtimeTmp` reopens just that (see `AgentMode.sandbox`), or bwrap cannot start the helper and no thread opens (W-217).
  sandbox: (workspaceId) => ({
    readable: [path.dirname(process.env.CROSSLINE_CODEX_PATH ?? "/opt/codex/codex")],
    deny: [dataDir, process.env.CROSSLINE_STATE_DIR ?? path.join(dataDir, "..", "state")],
    runtimeTmp: runtimeTmpFor(workspaceId, runtimeOwner(analysisStore)) }),
  confine: { dataDir, stateDir: process.env.CROSSLINE_STATE_DIR ?? path.join(dataDir, "..", "state") },
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
  shell: (workspaceId) => shellAssistant(workspaceId) || sandboxNow().ok,
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
export async function automationTick(workspaceId: string): Promise<void> {
  await automationDesignPass(workspaceId);
  // The machine owner's repeated errands are grown into workflows (workflowPass); everyone else is offered an automation for them.
  if (!shellAssistant(workspaceId)) { try { suggestFromRepeats(analysisStore, workspaceId, growCandidates(analysisStore, workspaceId)); } catch { /* a courtesy */ } }
  await automationFire(workspaceId);
}
// Triggers are looked at from the intake tick too (2026-11-04): at the end of the workspace tick a mail-triggered automation waited
// behind gates, materials and tutorials, which can take hours, and the test mail had not fired it after ten minutes.
const firingAutomations = new Set<string>();
export async function automationFire(workspaceId: string): Promise<void> {
  if (firingAutomations.has(workspaceId)) return;
  firingAutomations.add(workspaceId);
  try {
    if (!codexSupervisor || paused(workspaceId, "assistant") || !spendAllows(await spendFor(workspaceId), "intake")) return;
    enterUsageWorkspace(workspaceId);
    reconcileAutomationRuns(analysisStore, workspaceId);
    const runs = await automationPass(automationDeps, workspaceId);
    if (runs.length) console.info(JSON.stringify({ type: "automation.pass", workspaceId, runs: runs.map((run) => `${run.automationId}:${run.state}`), checkedAt: new Date().toISOString() }));
  } finally { firingAutomations.delete(workspaceId); }
}
// 「按链接添加」 a public skill (docs/skills-library.md §2): the person's link goes through the scout's own fetch, scan and review.
const publicSkillInstaller = createPublicSkillInstaller({ store: analysisStore, cwd: repoRoot, client: accountClient,
  beforeRun: (workspaceId) => enterUsageWorkspace(workspaceId),
  log: (event) => console.info(JSON.stringify({ ...event, checkedAt: new Date().toISOString() })) });
const automationService = createAutomationService({ ...automationDeps, afterRequest: (workspaceId) => { void automationDesignPass(workspaceId).catch(() => undefined); } });
// Each workflow's own conversation on the 自动化 page (workflow-thread.ts): a turn starts at once and streams into the ledger.
const workflowThreadService = createWorkflowThreadService({ ...automationDeps, improveNow: (workspaceId) => { void workflowPass(workspaceId, new Date().toISOString()).catch(() => undefined); } });
for (const workspace of analysisStore.listWorkspaces()) {
  const lost = agentService.recoverLost(workspace.id);
  if (lost.length) console.info(JSON.stringify({ type: "agent.recovered_lost", workspaceId: workspace.id, lost, checkedAt: new Date().toISOString() }));
  reconcileAutomationRuns(analysisStore, workspace.id);
  // A collection the last worker was running when it stopped never wrote its end: closed, so the page does not show it running.
  const interrupted = closeInterruptedCollections(analysisStore, workspace.id);
  if (interrupted.length) console.info(JSON.stringify({ type: "collect.interrupted", workspaceId: workspace.id, interrupted, checkedAt: new Date().toISOString() }));
  try { refreshFavouritesTopicsText(analysisStore, workspace.id); } catch { /* the old text stays until the next start */ }
  const salvaged = agentService.salvageStopped(workspace.id);
  if (salvaged.length) console.info(JSON.stringify({ type: "agent.salvaged", workspaceId: workspace.id, salvaged, checkedAt: new Date().toISOString() }));
  // Once: the locks and 「deleted by the person」 marks that overlapping calendar publishes left behind (before the supervisor serves a publish).
  const repaired = repairFrozenRace(analysisStore, workspace.id, ownerOf(analysisStore, workspace.id));
  if (repaired && (repaired.released.length || repaired.republished.length))
    console.info(JSON.stringify({ type: "repair.frozen_race", workspaceId: workspace.id, released: repaired.released.length, republished: repaired.republished.length, checkedAt: new Date().toISOString() }));
  // Once: tasks and steps written before the drill-form rule (订正/错题本/背诵/打卡, 2026-11-10) get the same screen new plans get.
  try {
    const swept = sweepLegacyDrills(analysisStore, workspace.id);
    if (swept && (swept.archived.length || swept.skippedSteps || swept.rewrittenOrders.length))
      console.info(JSON.stringify({ type: "drill.swept", workspaceId: workspace.id, ...swept, checkedAt: new Date().toISOString() }));
  } catch (error) { console.warn(JSON.stringify({ type: "drill.sweep_failed", workspaceId: workspace.id, message: String(error) })); }
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
export function startDiligencePass(workspaceId: string, checkedAt: string): void {
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
export const getMaterialPreparer = (workspaceId: string) => {
  let preparer = materialPreparers.get(workspaceId);
  if (!preparer) {
    preparer = createManualbookBuilder(analysisStore, workspaceId, materialsDir, repoRoot, () => accountClient(workspaceId), { readCost: () => readCost(workspaceId) });
    materialPreparers.set(workspaceId, preparer);
  }
  return preparer;
};
const milestoneGates = new Map<string, ReturnType<typeof createMilestoneGate>>();
export const getMilestoneGate = (workspaceId: string) => {
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
export const getCaptureAnalyzer = (workspaceId: string) => {
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
export const calendarZone = (workspaceId: string): string | undefined => {
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
export const syncCalendarFor = async (workspaceId: string): Promise<SyncOutcome | null> => {
  if (calendar) return calendar.sync(workspaceId);
  return hasSubscriptions(analysisStore, workspaceId) ? subscriptionSync(workspaceId)() : null;
};

/**
 * How many runs of one workspace a pass starts at once: the account's share of the model gate, plus the runs its compute nodes take
 * (docs/compute-node.md, 协同: a node is far stronger than this server, so the account's planning and assistant work fan out across it).
 */
export function workspaceConcurrency(workspaceId: string): number {
  try { return accountConcurrency() + (nodeHub ? nodeHub.capacity(workspaceId) : 0); }
  catch { return accountConcurrency(); }
}

// The compute node (docs/compute-node.md): on the hosted site any account's own computer may connect out to `wss://<site>/node` (Caddy
// hands it to this port) and serve that account's model runs with its Codex (方案 C); with no node connected, or the switch off, nothing changes.
const nodePort = Number(process.env.CROSSLINE_NODE_PORT ?? (hostedBeta ? 3213 : 0));
const crosslineMarketplace = path.join(repoRoot, "skills", "marketplace", ".agents", "plugins", "marketplace.json");
// Remote control from the phone (docs/plans/remote-control-1122.md): carried to the person's computer over its node connection, recorded
// here, the waiting command pushed. The push is bound once the notifier exists, below.
let remotePush: ((workspaceId: string, message: { title: string; body: string; path: string; tag: string }) => Promise<boolean>) | undefined;
const remoteService = createRemoteService({ store: analysisStore, hub: () => nodeHub, push: (workspaceId, message) => remotePush ? remotePush(workspaceId, message) : Promise.resolve(false),
  forms: { handle: formService.handle, pass: formService.pass }, log: (event) => console.info(JSON.stringify({ ...event, checkedAt: new Date().toISOString() })) });
// Recordings uploaded from the phone go to the person's computer while it is online with 「替手机转写录音」 on (§6.4); the rest wait for the night.
let transcribingOnComputers = false;
workerTimers.every(() => {
  if (transcribingOnComputers || !nodeHub) return;
  transcribingOnComputers = true;
  void (async () => {
    for (const workspace of analysisStore.listWorkspaces()) {
      const link = nodeHub.remoteFor(workspace.id).find((item) => item.transcribe);
      if (!link) continue;
      const outcomes = await computerInboxPass(analysisStore, workspace.id, { dataDir, timeZone: calendarZone(workspace.id) ?? process.env.CROSSLINE_TIME_ZONE?.trim() ?? "America/Chicago",
        transcribe: async (bytes, name) => {
          const answer = await link.call({ op: "transcribe", name, data: bytes.toString("base64") }, 30 * 60_000) as { ok?: boolean; state?: string; text?: string; seconds?: number; speechSeconds?: number; workMs?: number } | undefined;
          return answer?.ok && answer.state ? { state: answer.state, text: answer.text ?? "", seconds: answer.seconds ?? 0, speechSeconds: answer.speechSeconds ?? 0, workMs: answer.workMs ?? 0 } : undefined;
        } }).catch(() => []);
      if (outcomes.length) console.info(JSON.stringify({ type: "remote.recordings", workspaceId: workspace.id, host: link.host, outcomes }));
    }
  })().finally(() => { transcribingOnComputers = false; });
}, 3 * 60_000);
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
  // The account the token belongs to, once it switched the node on (方案 C: every account, each its own computers only).
  allowed: (workspaceId) => analysisStore.getSetting(workspaceId, NODE_COMPUTE_SETTING) === "on",
  roots: (workspaceId) => [path.dirname(path.dirname(path.dirname(crosslineMarketplace))), skillLibraryDir(workspaceId)],
  // The input box's typed copies of uploads (concierge.ts `asTypedImage`) and everything under the data directory (favourites' pictures).
  imageRoots: () => [path.join(tmpdir(), "crossline-images"), dataDir],
  gateway: () => `http://127.0.0.1:${modelGateway.port}`,
  // A node's model requests go only to its own account's route, and are billed from the gateway's count, not the node's (方案 C).
  gatewayWorkspace: (requestPath) => modelGateway.workspaceOfPath(requestPath),
  meter: (workspaceId, named, usage) => {
    const tokens = breakdownOfResponsesUsage(usage);
    if (tokens) recordMeteredUsage({ workspaceId, ...named }, tokens);
  },
  serverCodex: () => codexSupervisor?.runtimeVersion ?? "",
  prepare: async (client, workspaceId) => {
    // A node with no sign-in of its own serves only an account whose model is a provider (the gateway's key); else every run would fail.
    const account = await client.request("account/read", { refreshToken: false }).catch(() => undefined) as { account?: unknown } | undefined;
    if (!account?.account && !modelProviders.hasProvider(workspaceId)) throw new Error("NODE_NOT_SIGNED_IN");
    const skills = await installLocalPlugin(client, { name: "crossline", marketplacePath: crosslineMarketplace, cwd: repoRoot, requiredSkills: REQUIRED_SKILLS, extraPlugins: [PERSONAL_PLUGIN] });
    const missing = REQUIRED_SKILLS.filter((name) => !skills.includes(name));
    if (missing.length) throw new Error(`CODEX_PLUGIN_SKILLS_MISSING ${missing.slice(0, 3).join(",")}`);
  },
  onStatus: (workspaceId, status) => analysisStore.setSetting(workspaceId, NODE_STATUS_SETTING, JSON.stringify(status)),
  onRemoteEvent: (workspaceId, host, event) => remoteService.onEvent(workspaceId, host, event),
  onRemoteChange: (workspaceId, host, online) => remoteService.onChange(workspaceId, host, online),
  remoteLedger: (workspaceId, host) => remoteService.ledgerFor(workspaceId, host),
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
      requiredSkills: REQUIRED_SKILLS,
      extraPlugins: [PERSONAL_PLUGIN]
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
    services: [{ prefix: "/v1/mail", handle: mailService.handle },
      // 系统体检's 「立即自检」.
      { prefix: "/v1/selfcheck", handle: async (method, pathname, workspaceId) => method === "POST" && pathname === "/v1/selfcheck/run"
        ? { status: 200, body: { results: await runSelfCheck(workspaceId, true) } } : undefined }, { prefix: "/v1/import", handle: importService.handle }, { prefix: "/v1/voice", handle: dictationService.handle }, { prefix: "/v1/automations", handle: automationService.handle }, { prefix: "/v1/workflow-threads", handle: workflowThreadService.handle },
      { prefix: "/v1/forms", handle: formService.handle }, { prefix: "/v1/remote/", handle: remoteService.handle }, { prefix: "/v1/apply-profile", handle: formService.handle },
      { prefix: "/v1/apply-logins", handle: formService.handle },
      { prefix: "/v1/skills/public", handle: publicSkillInstaller.handle },
      { prefix: "/v1/workflows/favourites-topics", handle: createFavouritesTopicsService(analysisStore).handle },
      // The login browser on the server, shown in a dialog on the page (remote-browser.ts); only where there is no screen of our own.
      ...(remoteBrowsers ? [{ prefix: "/v1/remote-browser", handle: remoteBrowsers.handle }] : []),
      // Linking this computer as a device of the hosted account (docs/device-mode.md); the worker restarts into device mode.
      // Only the machine owner, and never on the hosted beta (`standardDeviceService`).
      ...standardDeviceService(createDeviceLinkService({ dataDir, secrets, onChanged: restartForMode, localeFor: (workspaceId) => localeOf(analysisStore, workspaceId) }).handle,
        { hostedBeta, machineOwner })],
    monthSpend: (workspaceId) => monthSpend(analysisStore, workspaceId),
    // Each account's runs spread over this server's runtime and every compute node connected for that account (runtime-pool.ts).
    ...(nodeHub ? { nodes: (workspaceId: string) => nodeHub.members(workspaceId) } : {}),
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
    onboardingInsert: async (sessionId, text, mode, workspaceId) => mode === "steer"
      ? steerInterview(analysisStore, workspaceId, sessionId, text) : enqueueInterview(analysisStore, workspaceId, sessionId, text),
    onboardingTurn: (_client, sessionId, text, _signal, workspaceId, reread) =>
      createOnboardingSessionRunner(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId))({ sessionId, text, ...(reread ? { reread: true } : {}) })
        // The interview just finished: the first drafts start now, not at the next tick up to fifteen minutes later, while 主线 said
        // 「完成初始访谈后生成」 to someone who had (2026-10-17 walkthrough, W-12).
        .then((outcome) => {
          // The interview just finished: the first drafts, and the search for the lines' skills (lineSetupDue), start now, not at the next tick.
          if (outcome.state === "ready") { void firstDraftsPass(workspaceId).catch(() => undefined); void publicSkillPass(workspaceId, new Date().toISOString()).catch(() => undefined); }
          return outcome; }),
    onboardingFinish: async (_client, sessionId, workspaceId) => {
      const { outcome, complete } = finishInterview(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId), sessionId);
      if (outcome.state !== "finished") return outcome;
      // Marked as being written at once, so the page says so and the background pass does not write a report before the extraction finished.
      analysisStore.appendEvent({ ownerId: analysisStore.getWorkspaceOwnerId(workspaceId) ?? "", workspaceId, idempotencyKey: `portrait.requested:${Date.now()}`,
        type: "portrait.changed", entityId: workspaceId, payload: { via: "finish", change: "requested" } });
      void complete.then(() => writePortraitFor(workspaceId)).catch(() => undefined).finally(() => {
        void firstDraftsPass(workspaceId).catch(() => undefined); void publicSkillPass(workspaceId, new Date().toISOString()).catch(() => undefined);
        void methodResearchPass(workspaceId, new Date().toISOString()).catch(() => undefined); });
      return outcome;
    },
    onboardingResearch: async (_client, sessionId, threadId, text, workspaceId) =>
      researchRunnerFor(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId)).answer(sessionId, threadId, text),
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
      setLines: async (workspaceId: string, id: string, lines: string[]) => ({ saved: setFolderLines(analysisStore, workspaceId, id, lines) }),
      // Any account: a folder picked in its browser is screened by name before it goes up (the page falls back to the newest files without it).
      screen: async (workspaceId: string, folder: string, files: Array<{ path: string; size: number; modified: number }>, limit: number) => {
        if (!spendAllows(await spendFor(workspaceId), "intake")) return { blocked: "SPEND_LIMIT" };
        enterUsageWorkspace(workspaceId);
        return createFolderScreener(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId))(folder, files, limit);
      }
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
    publishGoogleCalendar: (client, workspaceId, blocks) => publishGoogleCalendar(analysisStore, workspaceId, client, blocks),
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
  // A deploy or the watchdog marks a restart (deploy/server/run.sh); serving again ends it, and the pages stop saying 「正在重启」.
  rmSync(path.join(dataDir, "worker.restarting"), { force: true });
  // The developer's model is chosen by measurement: candidates without a current record are tested shortly after start, and again
  // whenever a record goes stale (a new runtime, a changed list, thirty days); a model already measured is not tested again.
  if (sponsorService && process.env.CROSSLINE_RUN_ONCE !== "1") {
    let spentKey = false;
    const evaluateSponsor = () => void sponsorService?.evaluate().then((outcome) => { spentKey = outcome.exhausted || outcome.interrupted; }, (error: unknown) =>
      console.warn(JSON.stringify({ type: "sponsor.evaluate_failed", message: error instanceof Error ? error.message : String(error) })));
    setTimeout(evaluateSponsor, 2 * 60_000).unref();
    // The periodic re-check of stale candidates runs in the cheaper hours (one of the four daily calls falls in them); the one after a
    // start runs at once, since a deploy is when the prompts or the code it measures changed.
    workerTimers.every(() => { if (sponsorOffPeak(new Date())) evaluateSponsor(); }, 6 * 60 * 60_000);
    // A spent key, a measurement the runtime cut short, or nothing chosen at all: tried again every half hour (a spent key answers at once,
    // so a try costs nothing), and the measurement resumes as soon as the balance is topped up or the runtime is back.
    workerTimers.every(() => { if (spentKey || !sponsorService?.chosen()) evaluateSponsor(); }, 30 * 60_000);
  }
  // Other accounts' runtimes stop after a quiet spell (above), so an idle account holds no process.
  workerTimers.every(() => codexSupervisor?.runtimes?.stopIdle(), 60_000);
  // Gateway-counted tokens of node runs that no run took within half an hour are billed as rows of their own (usage.ts).
  workerTimers.every(() => flushMeteredUsage(30 * 60_000), 5 * 60_000);
  // One model run at a time on the hosted beta, and none started above the memory high-water mark (model-gate.ts).
  // The candidates' measurement is no person's account (one tenant, `sponsor-eval`): it may use every background slot nobody else wants.
  configureModelGate({ probe: () => containerMemory(), reserved: heldMemory,
    // An account's compute nodes add their capacity to its share, and while one has room its next run is not held by this process's
    // memory (docs/compute-node.md, 协同; every account's own nodes since 方案 C).
    ...(nodeHub ? {
      extraCapacity: (tenant: string) => nodeHub.capacity(tenant),
      nodeRoom: (tenant: string) => {
        const load = codexSupervisor?.loadFor(tenant) ?? {};
        return nodeHub.members(tenant).some((member) => (load[member.id] ?? 0) < member.capacity);
      }
    } : {}),
    reclaim: () => codexSupervisor?.runtimes?.reclaim(), tenantLimits: { "sponsor-eval": Number.POSITIVE_INFINITY } });
  // What the health check and the logs read: memory in use, its ceiling and peak, and the gate's line, every five minutes.
  const mb = (bytes: number | undefined) => bytes === undefined ? null : Math.round(bytes / 1048576);
  workerTimers.every(() => {
    const gate = modelGateStatus();
    console.info(JSON.stringify({ type: "worker.memory", usedMb: mb(gate.memory?.used), limitMb: mb(gate.memory?.limit), peakMb: mb(containerPeak()), heldMb: mb(heldMemory()),
      active: gate.active, queued: gate.queued }));
  }, 5 * 60_000);
} catch {
  console.warn(JSON.stringify({ type: "worker.blocked", code: "CODEX_SUPERVISOR_START_FAILED" }));
}

const releaseWorkerLock = (): void => {
  try { rmSync(lockPath, { force: true }); } catch { /* a leftover lock goes stale on its own */ }
};

await tick({ waitForWorkspaces: process.env.CROSSLINE_RUN_ONCE === "1" });
if (process.env.CROSSLINE_RUN_ONCE === "1") {
  // Clocks first, then everything that listens, then the ledger: the gateway's open socket kept the process alive past the close, and
  // the form watcher's next beat read a closed ledger (「The database connection is not open」, exit 1). With nothing left listening
  // the process ends on its own.
  workerTimers.stop();
  await codexSupervisor?.stop();
  await modelGateway.close();
  await nodeHub?.close();
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
  const pushToPhones = async (workspaceId: string, message: { title: string; body: string; path: string; tag: string; start?: string; step?: string; snooze?: string; confirm?: string }): Promise<boolean> => {
    const devices = listPushSubscriptions(analysisStore, workspaceId);
    if (!devices.length) return false;
    const keys = loadVapidKeys(dataDir);
    // The text is in the workspace's language; `lang` tells the phone's service worker which, for the button it adds itself.
    const sent = { ...message, lang: htmlLang(localeOf(analysisStore, workspaceId)) };
    const results = await Promise.all(devices.map((device) => sendWebPush(device, sent, keys)));
    removePushSubscriptions(analysisStore, workspaceId, devices.filter((_, index) => results[index] === "gone").map((device) => device.endpoint));
    return results.includes("sent");
  };
  remotePush = pushToPhones;
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
  // Commits in the repositories the person authorized on this computer (`git.repos`), as the completion gate's evidence: names and
  // subjects only, masked for 「仅本地」 and PDK terms (git-commits.ts). A device sends them up itself; this is the local install's own.
  let readingCommits = false;
  setInterval(() => {
    if (readingCommits) return;
    readingCommits = true;
    void Promise.all(analysisStore.listWorkspaces().map((workspace) => workspace.id).filter(machineOwner).map((workspaceId) => localCommitPass(analysisStore, workspaceId)
      .then((added) => { if (added) console.info(JSON.stringify({ type: "git.commits_seen", workspaceId, added })); })))
      .catch((error) => console.warn(JSON.stringify({ type: "git.commits_failed", message: error instanceof Error ? error.message : "" })))
      .finally(() => { readingCommits = false; });
  }, 15 * 60_000);
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
export function recordCalendarOutcome(store: CrosslineStore, workspaceId: string, outcome: SyncOutcome, at: string): void {
  // Not reading a calendar that belongs to another account on this install is not a failure to ask anyone about.
  const failure = outcome.state === "blocked" && outcome.code === "GRAPH_LOGIN_OTHER_ACCOUNT" ? undefined
    : outcome.state === "blocked" ? { code: outcome.code, message: outcome.message ?? "", sources: [] as string[] }
    : outcome.failed?.length ? { code: outcome.failed[0]!.code, message: "", sources: outcome.failed.map((item) => item.label) } : undefined;
  try { store.setSetting(workspaceId, CALENDAR_SYNC_FAILURE, failure ? JSON.stringify({ ...failure, at }) : ""); } catch { /* housekeeping */ }
}

