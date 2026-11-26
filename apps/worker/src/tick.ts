// Split out of index.ts (move only). The worker's singletons (store, supervisor, services) stay in index.ts, which runs the
// side effects in order; this module reads them from `./index` only inside functions, after index.ts has set them up.
import { get } from "node:http";
import { mkdirSync } from "node:fs";
import { enterUsageWorkspace, withUsagePurpose, withUsageWorkspace } from "@crossline/codex";
import { lessonsPass } from "@crossline/db";
import { autoApproveEligible } from "./auto-approval";
import { retireShadowedDemos } from "./demo-cleanup";
import { defaultOutputRoot } from "./agent-service";
import { returnTidy } from "./return-tidy";
import { workSplitRepair } from "./work-split-repair";
import { MAIL_INTAKE_REPAIR, mailIntakeRepair } from "./mail-intake-repair";
import { mailRecordsRepair } from "./mail-records-repair";
import { moneyReportPass } from "./money-report";
import { codexQuoteReader, wealthPricePass } from "./wealth-prices";
import { dateAdvancePass } from "./date-advance";
import { outputsProbe, selfCheckPass, type Probe } from "./self-check";
import { agentQuestionsProbe } from "./self-check-agent";
import { workflowsProbe } from "./self-check-workflows";
import { automationsProbe, mailProbe } from "./self-check-mail";
import { nodeProbe, remoteBrowserProbe, sandboxProbe } from "./self-check-host";
import { hoursToOffPeakEnd, spendAllows, NON_CORE_PURPOSE } from "@crossline/core";
import { pendingMaterialWorkOrders, pendingTutorials, prepareMaterialsAhead } from "./manualbook";
import { startingWithin } from "./schedule-window";
import { energyAdvicePass } from "./energy-advice";
import { dedupePass } from "./dedupe";
import { fileSourceDocuments } from "./source-filing";
import { pendingMilestoneGates } from "./milestone-gate-runner";
import type { SyncOutcome } from "./graph-sync";
import { nonCoreAllowed } from "./spend";
import { calendarLinePass, digestPass, fileProjectPass, folderPass, timeDraftPass, versionPass } from "./passes/intake";
import { accountClient, activityTracker, agentService, analysisStore, automationFire, automationTick, beat, codexSupervisor, dataDir, formService, getMaterialPreparer, getMilestoneGate, getNightly, importService, mailService, nodeShell, paused, recordCalendarOutcome, repoRoot, sandboxNow, spendFor, startDiligencePass, syncCalendarFor, webHealthUrl } from "./index";
import { autoAnalyzePass, autoBackplanPass, curatorPass, firstDraftsPass, goalSplitPass, milestoneRiskPass, onboardingExtractPass, stepPlanPass, titlePass, waitsForOffPeak } from "./passes/planning";
import { deliverablePass, gatesPass } from "./passes/judging";
import { methodResearchPass, minePass, publicSkillPass, workflowPass } from "./passes/skills";
import { opportunityPass, placePass } from "./passes/opportunities";
import { portraitPass } from "./passes/portrait";

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
  // Files read since the last tick are compared with the others for older versions of one document.
  void versionPass(workspace.id).catch(() => undefined);
  // Uploaded files are filed under the project their own name or opening names; what stays unclear is asked about on 待确认.
  try {
    const filed = fileSourceDocuments(analysisStore, workspace.id);
    if (filed.length) console.info(JSON.stringify({ type: "source.project_inferred", checkedAt, workspaceId: workspace.id, filed }));
  } catch { /* housekeeping */ }
  // What no name written out settles goes to the folder classifier once per file before anyone is asked (2026-11-22).
  void fileProjectPass(workspace.id).catch(() => undefined);
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
  // Untimed work from the screen record, drafted for the person to confirm on the wrap-up (拟计时).
  await timeDraftPass(workspace.id, checkedAt);
  // The mailbox (docs/personal-agent.md): new mail read and sorted; to-dos and dates it finds become captures, analysed just below.
  await mailService.pass(workspace.id).catch(() => undefined);
  // The automations' triggers, new mail's included: firing only starts the assistant, so this does not hold the intake up.
  await automationFire(workspace.id).catch(() => undefined);
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

const selfCheckProbes = (): Probe[] => [outputsProbe(analysisStore, defaultOutputRoot()), agentQuestionsProbe(analysisStore), workflowsProbe(analysisStore),
  sandboxProbe(analysisStore, sandboxNow), nodeProbe(analysisStore, nodeShell), remoteBrowserProbe(analysisStore), mailProbe(analysisStore, dataDir), automationsProbe(analysisStore)];
export async function runSelfCheck(workspaceId: string, force = false) {
  const results = await selfCheckPass(analysisStore, workspaceId, selfCheckProbes(), { force });
  const notOk = results?.filter((result) => result.status === "repaired" || result.status === "failing");
  if (notOk?.length) console.info(JSON.stringify({ type: "selfcheck.ran", workspaceId, results: notOk.map((result) => `${result.id}:${result.status}:${result.code}`) }));
  return results;
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
  // Once: bookkeeping read from mail before its rules is tidied (mail-records repair).
  try {
    const records = mailRecordsRepair(analysisStore, workspace.id);
    if (records.voided || records.refunds || records.merged) console.info(JSON.stringify({ type: "repair.mail_records", workspaceId: workspace.id, ...records, checkedAt }));
  } catch (error) { console.warn(JSON.stringify({ type: "repair.mail_reminders_failed", workspaceId: workspace.id, error: String(error), checkedAt })); }
  // Once: tasks mail made before the ledger brief are judged again with it (mail-intake-repair.ts, 2026-11-20).
  if (!analysisStore.getSetting(workspace.id, MAIL_INTAKE_REPAIR) && spendAllows(await spendFor(workspace.id), "intake")) {
    const cleaned = await mailIntakeRepair(analysisStore, workspace.id, accountClient(workspace.id), repoRoot)
      .catch((error) => { console.warn(JSON.stringify({ type: "repair.mail_intake_failed", workspaceId: workspace.id, error: String(error), checkedAt })); return []; });
    if (cleaned.length) console.info(JSON.stringify({ type: "repair.mail_intake", workspaceId: workspace.id, archived: cleaned.length, checkedAt }));
  }
  // FX rates, coin prices and brokerage quotes once a day, then holdings valued (wealth-prices.ts, docs/ledger-wealth.md §2–3).
  try {
    const client = accountClient(workspace.id);
    const priced = await withUsagePurpose(NON_CORE_PURPOSE, () => wealthPricePass(analysisStore, workspace.id,
      { readQuotes: client ? (symbols, today) => { enterUsageWorkspace(workspace.id); return codexQuoteReader(client, repoRoot)(symbols, today); } : undefined }));
    if (priced.fx || priced.crypto || priced.quotes || priced.valued) console.info(JSON.stringify({ type: "wealth.priced", workspaceId: workspace.id, ...priced, checkedAt }));
  } catch (error) { console.warn(JSON.stringify({ type: "wealth.price_pass_failed", workspaceId: workspace.id, error: String(error), checkedAt })); }
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
  // Once a day: every feature checks itself; what it can put right it does, what it cannot is said once (self-check.ts).
  await runSelfCheck(workspace.id).catch((error) => console.warn(JSON.stringify({ type: "selfcheck.failed", workspaceId: workspace.id, message: String(error) })));
  await dedupePass({ store: analysisStore, workspaceId: workspace.id, cwd: repoRoot, client: () => accountClient(workspace.id), spend: () => spendFor(workspace.id), paused: (kind) => paused(workspace.id, kind), enterUsage: enterUsageWorkspace }).catch(() => undefined);
  await titlePass(workspace.id, checkedAt);
  await goalSplitPass(workspace.id, checkedAt);
  await milestoneRiskPass(workspace.id, checkedAt);
  await deliverablePass(workspace.id, checkedAt);
  void gatesPass(workspace.id, checkedAt).catch((error) => console.warn(JSON.stringify({ type: "gates.pass_failed", workspaceId: workspace.id, error: String(error).slice(0, 300), checkedAt })));
  void firstDraftsPass(workspace.id, checkedAt).catch(() => undefined);
  void methodResearchPass(workspace.id, checkedAt).catch(() => undefined);
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
  // Work starting within a day gets its materials now, not when the person presses 开始 (docs/plans/closed-loop-1030.md §5).
  try { prepareMaterialsAhead(analysisStore, workspace.id, new Date()); } catch { /* next tick */ }
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
  void opportunityPass(workspace.id, checkedAt).catch(() => undefined);
  void placePass(workspace.id, checkedAt).catch(() => undefined);
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

export async function tick(options: { waitForWorkspaces?: boolean } = {}): Promise<void> {
  const checkedAt = new Date().toISOString();
  mkdirSync(dataDir, { recursive: true });
  beat();
  // Readings arrive from the source on their own clock; the tick only does the retention sweep.
  try { activityTracker.prune(); } catch { /* retention is housekeeping, never worth a failed tick */ }
  // Every real workspace, not one hardcoded id — a real account's own work orders and calendar state
  // used to be structurally invisible to all three of these jobs no matter how long the worker ran.
  const workspaces = analysisStore.listWorkspaces();
  for (const workspace of workspaces) {
    // Registration forms: queued runs started, windows waiting for the person watched, late receipts asked about (owner only).
    void formService.pass(workspace.id).catch(() => undefined);
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
