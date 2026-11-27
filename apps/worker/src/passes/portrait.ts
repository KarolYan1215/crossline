// Split out of index.ts (move only). The worker's singletons (store, supervisor, services) stay in index.ts, which runs the
// side effects in order; this module reads them from `../index` only inside functions, after index.ts has set them up.
import { enterUsageWorkspace, withUsagePurpose } from "@crossline/codex";
import { spendAllows, NON_CORE_PURPOSE } from "@crossline/core";
import { createPortraitWriter, PORTRAIT_GAP_AT, PORTRAIT_REWRITE_MARKER, portraitRewriteDue } from "../portrait-writer";
import { createPortraitIllustrator } from "../portrait-illustrator";
import { nonCoreAllowed } from "../spend";
import { accountClient, analysisStore, codexSupervisor, dataDir, repoRoot, spendFor } from "../index";

/**
 * Writes the portrait (the interview's end, 重新生成, or the one rewrite after the fixed dimensions shipped): `portrait.requested` first,
 * so the page shows it running, then `portrait.blocked` with the reason, or the figure drawn in the background after the words (kept
 * when one exists, `figureRedrawDue`).
 */
export async function writePortraitFor(workspaceId: string) {
  enterUsageWorkspace(workspaceId);
  const store = analysisStore;
  store.appendEvent({ ownerId: store.getWorkspaceOwnerId(workspaceId) ?? "", workspaceId, idempotencyKey: `portrait.requested:${Date.now()}`, type: "portrait.changed", entityId: workspaceId, payload: { change: "requested" } });
  const outcome = await createPortraitWriter(store, workspaceId, repoRoot, () => accountClient(workspaceId))();
  if (outcome.state === "blocked") store.appendEvent({ ownerId: store.getWorkspaceOwnerId(workspaceId) ?? "", workspaceId, idempotencyKey: `portrait.blocked:${Date.now()}`,
    type: "portrait.changed", entityId: workspaceId, payload: { code: outcome.code, message: outcome.message, change: "blocked" } });
  // The pictures follow the words, in the background: the report is readable at once and gains its illustrations as they land.
  else void createPortraitIllustrator(store, workspaceId, repoRoot, dataDir, () => accountClient(workspaceId))()
    .then((drawn) => console.info(JSON.stringify({ type: "portrait.illustrated", workspaceId, ...drawn })))
    .catch(() => undefined);
  return outcome;
}

/** The person's 「重画一版」 on the portrait page: a new figure only, the words stay as they are and the earlier figures are kept. */
export async function redrawFigureFor(workspaceId: string) {
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
export async function portraitPass(workspaceId: string, checkedAt: string, offPeakWait = false): Promise<void> {
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
