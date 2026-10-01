import { get } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startCodexSupervisor, type CodexSupervisor } from "@crossline/codex";
import { CrosslineStore } from "@crossline/db";
import { createCaptureAnalyzer } from "./analysis";
import { createActivityRecorder } from "./activity-recorder";
import { createNightlyFlywheel } from "./nightly";
import { createFlywheelExpander } from "./flywheel";
import { createMaterialPreparer, pendingMaterialWorkOrders } from "./material-runner";
import { createMilestoneGate, pendingMilestoneGates } from "./milestone-gate-runner";
import { createMilestoneConversation, createMilestoneProposer } from "./milestone-proposer";
import { createGoalBackplanner } from "./goal-backplanner";
import { createPlanExplainer } from "./plan-explainer-runner";
import { createWeeklyInsight } from "./weekly-insight-runner";
import { createOnboardingProposer, createOnboardingConversation } from "./onboarding-runner";
import { createBackgroundFactsExtractor } from "./background-facts-runner";
import { createAssistantTurn } from "./assistant-runner";
import { scanPersonalCodexHistory } from "./codex-history";
import { createGraphSync, type SyncOutcome } from "./graph-sync";
import {
  buildSources, calendarLabel, listCatalogue, readSelection, saveSelection, seedNewAccounts, sourceKey
} from "./calendar-sources";
import { createGraphAuthSession, GraphReadSource, type GraphCredentialProvider } from "@crossline/connectors";

const WORKSPACE_ID = "personal-crossline";
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

async function tick(): Promise<void> {
  const checkedAt = new Date().toISOString();
  mkdirSync(dataDir, { recursive: true });
  beat();
  // Consent is re-read every tick, so turning collection off takes effect without a restart.
  if (recordActivity) await recordActivity().catch(() => undefined);
  // Every real workspace, not one hardcoded id — a real account's own work orders and calendar state
  // used to be structurally invisible to all three of these jobs no matter how long the worker ran.
  const workspaces = analysisStore.listWorkspaces();
  // Material preparation is the one background job that writes into the project directory, so it only
  // ever runs for work orders the human already approved into `preparing`.
  for (const workspace of workspaces) {
    for (const workOrderId of pendingMaterialWorkOrders(analysisStore, workspace.id)) {
      const outcome = await getMaterialPreparer(workspace.id)(workOrderId).catch(() => undefined);
      if (outcome) console.info(JSON.stringify({ type: `materials.${outcome.state}`, checkedAt, workspaceId: workspace.id, ...outcome }));
    }
  }
  // The milestone gate. Without this it existed only inside `scripts/gate-loop-check.ts`, so on the
  // real ledger a milestone-bound work order reached `evidence_review`, the approvals page said
  // 「等待里程碑闸门」 — and nothing was ever going to judge it. A verdict other than `pass` holds the
  // order for a person, so a held order is skipped rather than re-judged every fifteen minutes.
  for (const workspace of workspaces) {
    for (const workOrderId of pendingMilestoneGates(analysisStore, workspace.id)) {
      const outcome = await getMilestoneGate(workspace.id)(workOrderId).catch(() => undefined);
      if (outcome) console.info(JSON.stringify({ type: `milestone_gate.${outcome.state}`, checkedAt, workspaceId: workspace.id, ...outcome }));
    }
  }
  // Calendar reality is pulled every tick. It never rewrites an approved plan — a change there becomes
  // a new draft whose diffs are conflicts for the person to look at.
  if (calendar) {
    for (const workspace of workspaces) {
      const outcome = await calendar.sync(workspace.id).catch((error): SyncOutcome =>
        ({ state: "blocked", code: "GRAPH_SYNC_FAILED", message: error instanceof Error ? error.message : "" }));
      if (outcome.state === "blocked" || outcome.changes > 0 || outcome.resynced) {
        console.info(JSON.stringify({ type: `graph.${outcome.state}`, checkedAt, workspaceId: workspace.id, ...outcome }));
      }
    }
  }
  // The nightly expansion decides for itself whether this tick is its moment; most ticks are not.
  if (runNightly) {
    const decision = await runNightly().catch(() => undefined);
    if (decision && !decision.run && decision.code !== "BEFORE_PLANNED_TIME" && decision.code !== "ALREADY_RAN_TODAY") {
      console.info(JSON.stringify({ type: "flywheel.nightly.skipped", checkedAt, code: decision.code }));
    }
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
const recordActivity = createActivityRecorder(analysisStore, "personal-crossline", intervalMinutes);
const expandFlywheel = createFlywheelExpander(analysisStore, "personal-crossline", repoRoot,
  () => codexSupervisor?.client);
const readCost = async () => codexSupervisor
  ? await codexSupervisor.readCostSignal()
  : { available: false as const, reason: "CODEX_SUPERVISOR_UNAVAILABLE" };
const runNightly = createNightlyFlywheel({
  store: analysisStore,
  workspaceId: "personal-crossline",
  readCost,
  expand: expandFlywheel
});
// Material preparation and the milestone gate used to be created once, bound to a single hardcoded
// workspace — every real account's own `preparing`/`evidence_review` work orders were invisible to
// both the automatic tick and the manual "重新准备材料"/"现在判定" buttons, since neither ever operated
// on any workspace but that one. `createMaterialPreparer`/`createMilestoneGate`'s other arguments (the
// store, repoRoot, the Codex client getter, the cost reader) are not workspace-specific, so a per-real-
// workspace closure is cheap to build and safe to cache.
const materialPreparers = new Map<string, ReturnType<typeof createMaterialPreparer>>();
const getMaterialPreparer = (workspaceId: string) => {
  let preparer = materialPreparers.get(workspaceId);
  if (!preparer) {
    preparer = createMaterialPreparer(analysisStore, workspaceId, repoRoot, () => codexSupervisor?.client, readCost);
    materialPreparers.set(workspaceId, preparer);
  }
  return preparer;
};
const milestoneGates = new Map<string, ReturnType<typeof createMilestoneGate>>();
const getMilestoneGate = (workspaceId: string) => {
  let gate = milestoneGates.get(workspaceId);
  if (!gate) {
    gate = createMilestoneGate(analysisStore, workspaceId, repoRoot, () => codexSupervisor?.client);
    milestoneGates.set(workspaceId, gate);
  }
  return gate;
};
// Same fix, same reason: `createCaptureAnalyzer` used to close over a hardcoded workspace id (and an
// `ownerId === "local-owner"` read filter on top of it), so a real account's own captures and approved
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
const planExplainers = new Map<string, ReturnType<typeof createPlanExplainer>>();
const getPlanExplainer = (workspaceId: string) => {
  let explainer = planExplainers.get(workspaceId);
  if (!explainer) {
    explainer = createPlanExplainer(analysisStore, workspaceId, repoRoot, () => codexSupervisor?.client);
    planExplainers.set(workspaceId, explainer);
  }
  return explainer;
};
const weeklyInsights = new Map<string, ReturnType<typeof createWeeklyInsight>>();
const getWeeklyInsight = (workspaceId: string) => {
  let insight = weeklyInsights.get(workspaceId);
  if (!insight) {
    insight = createWeeklyInsight(analysisStore, workspaceId, repoRoot, () => codexSupervisor?.client);
    weeklyInsights.set(workspaceId, insight);
  }
  return insight;
};
/**
 * Calendar sync only exists when a client id is configured. Without one there is nothing to read, and
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
          // Resolved per tick, so unticking a calendar takes effect on the next sync with no restart.
          sources: () => buildSources(analysisStore, workspaceId, credential, reader),
          timeZone: () => {
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
          }
        });
        syncers.set(workspaceId, syncer);
      }
      return syncer;
    };

    return {
      sync: async (workspaceId: string) => { await ensureCatalogueSeeded(workspaceId); return getSyncer(workspaceId)(); },
      listSources: async (workspaceId: string) => {
        await ensureCatalogueSeeded(workspaceId);
        const fresh = await listCatalogue(credential, analysisStore, workspaceId, reader);
        seedNewAccounts(analysisStore, workspaceId, fresh);
        // Re-read rather than reuse: seeding may have ticked a calendar that the first pass showed
        // unticked, and showing the person a list that is already one step stale is how a checkbox
        // ends up disagreeing with what the next sync actually reads.
        return listCatalogue(credential, analysisStore, workspaceId, reader);
      },
      saveSources: async (workspaceId: string, keys: string[]) => {
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
      requiredSkills: [
        "crossline:crossline", "crossline:crossline-automation-stripper", "crossline:crossline-milestone-gate",
        "crossline:crossline-flywheel-scout", "crossline:crossline-material-preparer", "crossline:crossline-milestone-architect",
        "crossline:crossline-goal-backplanner", "crossline:crossline-background-facts", "crossline:crossline-assistant",
        "crossline:crossline-onboarding", "crossline:crossline-plan-explainer", "crossline:crossline-weekly-insight"
      ]
    },
    analyzeCapture: (client, id, signal, workspaceId) => getCaptureAnalyzer(workspaceId)(client, id, signal),
    // `workspaceId` is the real caller's, from its own verified capability token — not a hardcoded
    // constant, which is what left milestone proposal and goal backplanning invisible to any real
    // account the same way material prep/the milestone gate/calendar sync were (see `getMaterialPreparer`
    // above for the fuller explanation; this is the same bug, same fix, in the same file).
    proposeMilestones: (_client, request, signal, workspaceId) =>
      createMilestoneProposer(analysisStore, workspaceId, repoRoot, () => codexSupervisor?.client)(request, signal),
    continueMilestoneConversation: (_client, threadId, message, signal, workspaceId) =>
      createMilestoneConversation(analysisStore, workspaceId, repoRoot, () => codexSupervisor?.client)(threadId, message, signal),
    proposeOnboarding: (_client, answers, sources, signal, workspaceId) =>
      createOnboardingProposer(analysisStore, workspaceId, repoRoot, () => codexSupervisor?.client)(answers, sources, signal),
    continueOnboardingConversation: (_client, threadId, message, focusIdentityId, signal, workspaceId) =>
      createOnboardingConversation(analysisStore, workspaceId, repoRoot, () => codexSupervisor?.client)(threadId, message, focusIdentityId, signal),
    extractBackgroundFacts: (_client, captureTitle, captureContext, signal, workspaceId) =>
      createBackgroundFactsExtractor(analysisStore, workspaceId, repoRoot, () => codexSupervisor?.client)(captureTitle, captureContext, signal),
    assistantTurn: (_client, threadId, message, history, attachments, workOrderId, signal, workspaceId) =>
      createAssistantTurn(analysisStore, workspaceId, repoRoot, () => codexSupervisor?.client)(threadId, message, history, attachments, workOrderId, signal),
    scanCodexHistory: () => scanPersonalCodexHistory(),
    backplanGoal: (_client, milestoneId, signal, workspaceId) =>
      createGoalBackplanner(analysisStore, workspaceId, repoRoot, () => codexSupervisor?.client)(milestoneId, signal),
    // The same preparer/gate the tick loop uses, exposed so a person's retry gets an answer now rather
    // than at the next tick. `pendingMaterialWorkOrders`/`pendingMilestoneGates` still govern which
    // orders the loop itself picks up.
    prepareMaterials: (workOrderId, workspaceId) => getMaterialPreparer(workspaceId)(workOrderId),
    judgeMilestone: (workOrderId, workspaceId) => getMilestoneGate(workspaceId)(workOrderId),
    explainPlan: (today, workspaceId) => getPlanExplainer(workspaceId)(today),
    runWeeklyInsight: (workspaceId) => getWeeklyInsight(workspaceId)(),
    // Undefined when no client id is configured or nobody has signed in, in which case the route is
    // simply not mounted and the button says the connector is unavailable rather than lying.
    ...(calendar ? {
      syncCalendar: (workspaceId: string) => calendar.sync(workspaceId),
      listCalendarSources: (workspaceId: string) => calendar.listSources(workspaceId),
      saveCalendarSources: (workspaceId: string, keys: string[]) => calendar.saveSources(workspaceId, keys)
    } : {})
  });
  console.info(JSON.stringify({ type: "codex.supervisor.ready", url: codexSupervisor.url }));
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
