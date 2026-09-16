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
import { createMilestoneProposer } from "./milestone-proposer";
import { createGraphSync, type SyncOutcome } from "./graph-sync";
import { createGraphAuthSession, GraphReadSource } from "@crossline/connectors";

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
  // Material preparation is the one background job that writes into the project directory, so it only
  // ever runs for work orders the human already approved into `preparing`.
  if (prepareMaterials) {
    for (const workOrderId of pendingMaterialWorkOrders(analysisStore, "personal-crossline")) {
      const outcome = await prepareMaterials(workOrderId).catch(() => undefined);
      if (outcome) console.info(JSON.stringify({ type: `materials.${outcome.state}`, checkedAt, ...outcome }));
    }
  }
  // The milestone gate. Without this it existed only inside `scripts/gate-loop-check.ts`, so on the
  // real ledger a milestone-bound work order reached `evidence_review`, the approvals page said
  // 「等待里程碑闸门」 — and nothing was ever going to judge it. A verdict other than `pass` holds the
  // order for a person, so a held order is skipped rather than re-judged every fifteen minutes.
  if (judgeMilestone) {
    for (const workOrderId of pendingMilestoneGates(analysisStore, "personal-crossline")) {
      const outcome = await judgeMilestone(workOrderId).catch(() => undefined);
      if (outcome) console.info(JSON.stringify({ type: `milestone_gate.${outcome.state}`, checkedAt, ...outcome }));
    }
  }
  // Calendar reality is pulled every tick. It never rewrites an approved plan — a change there becomes
  // a new draft whose diffs are conflicts for the person to look at.
  if (syncCalendar) {
    const outcome = await syncCalendar().catch((error): SyncOutcome =>
      ({ state: "blocked", code: "GRAPH_SYNC_FAILED", message: error instanceof Error ? error.message : "" }));
    if (outcome.state === "blocked" || outcome.changes > 0 || outcome.resynced) {
      console.info(JSON.stringify({ type: `graph.${outcome.state}`, checkedAt, ...outcome }));
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
const prepareMaterials = createMaterialPreparer(analysisStore, "personal-crossline", repoRoot,
  () => codexSupervisor?.client, readCost);
const judgeMilestone = createMilestoneGate(analysisStore, "personal-crossline", repoRoot,
  () => codexSupervisor?.client);
/**
 * Calendar sync only exists when a client id is configured. Without one there is nothing to read, and
 * inventing a connector that always fails would put a permanent blocker on every tick.
 */
const syncCalendar = await (async () => {
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
    return createGraphSync(analysisStore, "personal-crossline", {
      reader: new GraphReadSource({ credential }),
      ...(process.env.CROSSLINE_TIME_ZONE ? { timeZone: process.env.CROSSLINE_TIME_ZONE } : {})
    });
  } catch {
    console.warn(JSON.stringify({ type: "worker.blocked", code: "GRAPH_AUTH_UNAVAILABLE" }));
    return undefined;
  }
})();

try {
  codexSupervisor = await startCodexSupervisor({
    port: supervisorPort,
    plugin: {
      name: "crossline",
      marketplacePath: path.join(repoRoot, "skills", "marketplace", ".agents", "plugins", "marketplace.json"),
      cwd: repoRoot,
      requiredSkills: [
        "crossline:crossline", "crossline:crossline-automation-stripper", "crossline:crossline-milestone-gate",
        "crossline:crossline-flywheel-scout", "crossline:crossline-material-preparer", "crossline:crossline-milestone-architect",
        "crossline:crossline-onboarding", "crossline:crossline-plan-explainer", "crossline:crossline-weekly-insight"
      ]
    },
    analyzeCapture: createCaptureAnalyzer(analysisStore, repoRoot),
    proposeMilestones: (_client, request, signal) =>
      createMilestoneProposer(analysisStore, "personal-crossline", repoRoot, () => codexSupervisor?.client)(request, signal),
    // The same preparer the tick loop uses, exposed so a person's retry gets an answer now rather than
    // at the next tick. `pendingMaterialWorkOrders` still governs which orders the loop picks up.
    prepareMaterials: (workOrderId) => prepareMaterials(workOrderId),
    judgeMilestone: (workOrderId) => judgeMilestone(workOrderId),
    // Undefined when no client id is configured or nobody has signed in, in which case the route is
    // simply not mounted and the button says the connector is unavailable rather than lying.
    ...(syncCalendar ? { syncCalendar: () => syncCalendar() } : {})
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
