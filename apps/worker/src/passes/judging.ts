// Split out of index.ts (move only). The worker's singletons (store, supervisor, services) stay in index.ts, which runs the
// side effects in order; this module reads them from `../index` only inside functions, after index.ts has set them up.
import { enterUsageWorkspace } from "@crossline/codex";
import { spendAllows } from "@crossline/core";
import { deliverableCheckPass, newFolderFiles } from "../deliverable-check";
import { admissionGatePass, admissionPending, reconcileParked } from "../gates/admission";
import { attentionDue, attentionGatePass } from "../gates/attention";
import { completionDue, completionGatePass } from "../gates/completion";
import { drillGradePass, drillIssuePass, ungradedDrillAnswers } from "../gates/drill";
import { frontDue, frontGatePass } from "../gates/front";
import { nightWeekDue, nightWeekPass } from "../gates/night";
import { priorityGatePass, unlabelled } from "../gates/priority";
import { pendingSetbacks, setbackGatePass } from "../gates/setback";
import { accountClient, analysisStore, calendarZone, codexSupervisor, mailService, paused, repoRoot, spendFor } from "../index";

/**
 * The system's acceptance (deliverable-check.ts, attention ledger §7.2): new files in the authorized folders read against the open and
 * recently finished tasks. Acceptance is part of the core loop now that 完成 takes effect at once, so it runs while core work is allowed.
 */
const checkingDeliverables = new Set<string>();
export async function deliverablePass(workspaceId: string, checkedAt = new Date().toISOString()): Promise<void> {
  if (paused(workspaceId, "planning") || checkingDeliverables.has(workspaceId) || !codexSupervisor) return;
  if (!newFolderFiles(analysisStore, workspaceId).length) return;
  const client = accountClient(workspaceId);
  if (!client || !spendAllows(await spendFor(workspaceId), "core")) return;
  checkingDeliverables.add(workspaceId);
  try {
    enterUsageWorkspace(workspaceId);
    const judged = await deliverableCheckPass(analysisStore, workspaceId, client, repoRoot).catch((error) => {
      console.warn(JSON.stringify({ type: "deliverables.check_failed", workspaceId, error: String(error), checkedAt })); return 0; });
    if (judged) console.info(JSON.stringify({ type: "deliverables.judged", workspaceId, judged, checkedAt }));
  } finally { checkingDeliverables.delete(workspaceId); }
}

/**
 * The model-judged execution gates (docs/plans/execution-gates-1124.md §四). Each pass decides by its own record whether it is due
 * (`pendingGateSubjects`, or its trigger); they run one after another so a workspace never has two gate runs at once, and the tick does
 * not wait for them. Judgements are records (`gate.judged`); only J2a parks a milestone (undoable) and J6 holds a form, the rest change
 * nothing by themselves. Part of the core loop: they run while core work is allowed. Days and weeks are the person's, in their zone
 * (`calendarZone`); without one, UTC.
 */
const judgingGates = new Set<string>();
/** Excerpts of mail just read from the sent folders, held in memory only until the next completion pass (never stored). */
export const sentExcerptsByWorkspace = new Map<string, Map<string, string>>();
/** Issuing a drill is tried at most this often: without a simulator it can only log that one is missing. */
const DRILL_ISSUE_EVERY_MS = 3_600_000;
const drillTriedAt = new Map<string, number>();
export async function gatesPass(workspaceId: string, checkedAt = new Date().toISOString()): Promise<void> {
  if (paused(workspaceId, "planning") || judgingGates.has(workspaceId) || !codexSupervisor) return;
  reconcileParked(analysisStore, workspaceId);
  const client = accountClient(workspaceId);
  if (!client || !spendAllows(await spendFor(workspaceId), "core")) return;
  judgingGates.add(workspaceId);
  const now = new Date(checkedAt);
  const timeZone = calendarZone(workspaceId);
  const base = { store: analysisStore, workspaceId, client, cwd: repoRoot, now, ...(timeZone ? { timeZone } : {}) };
  const step = async (name: string, due: boolean, run: () => Promise<unknown>) => {
    if (!due) return;
    try {
      const result = await run();
      const count = Array.isArray(result) ? result.length : typeof result === "number" ? result : result ? 1 : 0;
      if (count) console.info(JSON.stringify({ type: `gates.${name}`, workspaceId, judged: count, checkedAt }));
    } catch (error) { console.warn(JSON.stringify({ type: `gates.${name}_failed`, workspaceId, error: String(error).slice(0, 300), checkedAt })); }
  };
  try {
    enterUsageWorkspace(workspaceId);
    await step("priority", unlabelled(analysisStore, workspaceId, now, timeZone).length > 0, () => priorityGatePass(base));
    const completion = completionDue(analysisStore, workspaceId, now);
    await step("completion", completion.due, async () => {
      const excerpts = sentExcerptsByWorkspace.get(workspaceId);
      sentExcerptsByWorkspace.delete(workspaceId);
      return completionGatePass({ ...base, full: completion.full, openMail: (accountId) => mailService.open(workspaceId, accountId), ...(excerpts ? { excerpts } : {}) });
    });
    await step("front", frontDue(analysisStore, workspaceId, now, timeZone), () => frontGatePass(base));
    await step("admission", admissionPending(analysisStore, workspaceId, now).length > 0, () => admissionGatePass(base));
    await step("setback", pendingSetbacks(analysisStore, workspaceId, now).length > 0, () => setbackGatePass(base));
    await step("attention", attentionDue(analysisStore, workspaceId, now, timeZone), () => attentionGatePass(base));
    await step("night", nightWeekDue(analysisStore, workspaceId, now, timeZone), () => nightWeekPass(base));
    await step("drill_grade", ungradedDrillAnswers(analysisStore, workspaceId).length > 0, () => drillGradePass(analysisStore, workspaceId, client, repoRoot, now));
    await step("drill_issue", now.getTime() - (drillTriedAt.get(workspaceId) ?? 0) >= DRILL_ISSUE_EVERY_MS, () => {
      drillTriedAt.set(workspaceId, now.getTime());
      return drillIssuePass(analysisStore, workspaceId, client, repoRoot, now, timeZone ? { timeZone } : {});
    });
  } finally { judgingGates.delete(workspaceId); }
}
