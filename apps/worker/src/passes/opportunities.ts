// Split out of index.ts (move only). The worker's singletons (store, supervisor, services) stay in index.ts, which runs the
// side effects in order; this module reads them from `../index` only inside functions, after index.ts has set them up.
import { enterUsageWorkspace } from "@crossline/codex";
import { isPaused, opportunityCosts, retireQuietWatches, settleOpportunityOutcomes } from "@crossline/db";
import { spendAllows } from "@crossline/core";
import { deriveWatches, opportunityAgentOn, runWatch, todayFor, watchesDeriveDue, watchesToRun } from "../opportunities";
import { opportunityScoutDue, startScout } from "../opportunity-scout";
import { discoveryFeasibility, timeSpacePass } from "../time-space";
import { accountClient, agentService, analysisStore, codexSupervisor, paused, repoRoot, spendFor } from "../index";

/**
 * The opportunity agent (docs/opportunity-agent.md §17), on the machine owner's workspace and accounts that paired their own computer as a node. Every tick, without a model: outcomes the
 * ledger shows by itself are written and quiet watches retired. Then, while core work may: one line's watches derived when due (its
 * setup, a changed goal or milestones, a node it reached, monthly), and up to two due watches run. The weekly scout starts through the
 * assistant when discretionary work may and exploration has not had its share. Planning work: it stops with the 规划 pause. Detached, so
 * an hour-long run never holds the tick; one at a time per workspace.
 */
const discovering = new Set<string>();
export async function opportunityPass(workspaceId: string, checkedAt: string): Promise<void> {
  if (!opportunityAgentOn(analysisStore, workspaceId) || paused(workspaceId, "planning") || !codexSupervisor || discovering.has(workspaceId)) return;
  const now = new Date();
  try {
    settleOpportunityOutcomes(analysisStore, workspaceId, todayFor(analysisStore, workspaceId, now), now);
    const retired = retireQuietWatches(analysisStore, workspaceId, now);
    if (retired.length) console.info(JSON.stringify({ type: "opportunity.watches_retired", checkedAt, workspaceId, ids: retired.map((watch) => watch.id) }));
  } catch { /* housekeeping */ }
  const lines = watchesDeriveDue(analysisStore, workspaceId, now);
  const runs = watchesToRun(analysisStore, workspaceId, now);
  const scout = opportunityScoutDue(analysisStore, workspaceId, now) && !isPaused(analysisStore, workspaceId);
  if (!lines.length && !runs.length && !scout) return;
  const spend = await spendFor(workspaceId);
  discovering.add(workspaceId);
  try {
    enterUsageWorkspace(workspaceId);
    // Each find is judged in time and space before it is kept (§17.6): what cannot be reached never reaches the person.
    const feasibility = discoveryFeasibility({ client: () => spendAllows(spend, "core") ? accountClient(workspaceId) : undefined, cwd: repoRoot });
    const deps = { client: () => accountClient(workspaceId), cwd: repoRoot, feasibility };
    if (spendAllows(spend, "core")) {
      for (const lineId of lines.slice(0, 1)) {
        const outcome = await deriveWatches(analysisStore, workspaceId, lineId, deps).catch((error: unknown) => ({ blocked: error instanceof Error ? error.message : "FAILED" }));
        console.info(JSON.stringify({ type: "opportunity.watches_derived", checkedAt, workspaceId, lineId, ...outcome }));
      }
      for (const watch of runs.slice(0, 2)) {
        const outcome = await runWatch(analysisStore, workspaceId, watch, deps).catch((error: unknown) => ({ blocked: error instanceof Error ? error.message : "FAILED" }));
        console.info(JSON.stringify({ type: "opportunity.watch_run", checkedAt, workspaceId, watchId: watch.id, ...outcome }));
      }
    }
    if (scout && spendAllows(spend, "discretionary")) {
      const started = startScout(analysisStore, workspaceId, (input, after) => agentService.runFree(workspaceId, input, after),
        { feasibility, costSince: (store, ws, purpose, since) => opportunityCosts(store, ws, since).filter((row) => row.purpose === purpose).reduce((sum, row) => sum + row.weighted, 0) });
      console.info(JSON.stringify({ type: "opportunity.scout", checkedAt, workspaceId, state: started.state }));
    }
  } finally { discovering.delete(workspaceId); }
}

/**
 * The time–space engine (docs/opportunity-agent.md §17.6–17.7): places geocoded, visas looked up, and a clash with a fixed arrangement told
 * at once, for the opportunities still open. Same workspace and pause as discovery; the visa lookup is a model run, so it needs core spend
 * (geocoding does not). Detached and one at a time per workspace: pacing Nominatim and a visa run can take minutes.
 */
const placing = new Set<string>();
export async function placePass(workspaceId: string, checkedAt: string): Promise<void> {
  if (!opportunityAgentOn(analysisStore, workspaceId) || paused(workspaceId, "planning") || placing.has(workspaceId)) return;
  placing.add(workspaceId);
  try {
    enterUsageWorkspace(workspaceId);
    const models = codexSupervisor && spendAllows(await spendFor(workspaceId), "core");
    const outcome = await timeSpacePass(analysisStore, workspaceId, { client: () => models ? accountClient(workspaceId) : undefined, cwd: repoRoot });
    if (outcome.judged) console.info(JSON.stringify({ type: "opportunity.placed", checkedAt, workspaceId, ...outcome }));
  } finally { placing.delete(workspaceId); }
}
