/**
 * What the last N days of real use actually looked like, read out of the ledger.
 *
 *   pnpm exec tsx scripts/trial-report.ts        # last 14 days
 *   pnpm exec tsx scripts/trial-report.ts 28
 *
 * Gates 6–7 ask for a 14-day comparison and a 4-week trial, and neither had any data behind it. The
 * ledger has recorded every piece of it since the beginning — transitions, gate verdicts, repair
 * counts, interruption reasons — so what was missing was never instrumentation, only a reader.
 *
 * Every number here is counted from rows. Nothing is modelled, averaged into a score, or estimated:
 * a question the ledger cannot answer is printed as unanswerable rather than filled in.
 */
// Relative import, not @crossline/db: the repo root is not a workspace package, so it has no such deps.
import { CrosslineStore } from "../packages/db/src/index.js";
import path from "node:path";

const WORKSPACE_ID = process.env.CROSSLINE_WORKSPACE_ID ?? "personal-crossline";
const days = Number(process.argv[2] ?? 14);
const store = new CrosslineStore(path.resolve(process.env.CROSSLINE_DATA_DIR ?? "data", "crossline.db"));
const since = new Date(Date.now() - days * 86_400_000).toISOString();

const events = store.listEvents(WORKSPACE_ID).filter((event) => event.createdAt >= since);
const countBy = (type: string) => events.filter((event) => event.type === type).length;

const transitions = events.filter((event) => event.type === "work_order.transitioned")
  .map((event) => (event.payload as { to?: string }).to ?? "");
const reached = (state: string) => transitions.filter((to) => to === state).length;

// Gate verdicts, split the way the design splits them: did this work order deliver, versus how far
// the milestone moved. Collapsing the two is the mistake the gate itself used to make.
const judged = events.filter((event) => event.type === "milestone_gate.judged")
  .map((event) => event.payload as { verdict?: string; criteriaVerdict?: Array<{ met: string }> });
const verdicts = judged.reduce<Record<string, number>>((tally, item) => {
  tally[item.verdict ?? "?"] = (tally[item.verdict ?? "?"] ?? 0) + 1;
  return tally;
}, {});
const criteriaMet = judged.flatMap((item) => item.criteriaVerdict ?? [])
  .reduce<Record<string, number>>((tally, item) => {
    tally[item.met] = (tally[item.met] ?? 0) + 1;
    return tally;
  }, {});

// Real minutes, with interrupted time held apart from work — the whole reason executions record both.
const executions = store.listExecutions(WORKSPACE_ID).filter((run) => run.startedAt >= since);
const finished = executions.filter((run) => run.endedAt && run.durationObserved);
const workedMinutes = finished.reduce((total, run) =>
  total + Math.round((Date.parse(run.endedAt!) - Date.parse(run.startedAt)) / 60_000) - run.pauseMinutes, 0);
const interruptions = executions.flatMap((run) => run.interruptions.map((item) => item.reason));

// How often the model had to be asked to fix its own answer. Consistently above zero means the
// schema or the prompt needs work, not more retries.
const repairs = store.listCaptures(WORKSPACE_ID)
  .map((capture) => capture.audit.repairs ?? 0).filter((count) => count > 0);

console.log(JSON.stringify({
  windowDays: days,
  since,
  captured: countBy("capture.created"),
  discarded: countBy("capture.discarded") + countBy("work_order.archived"),
  analysed: reached("awaiting_plan_approval"),
  started: reached("active"),
  submitted: reached("evidence_review"),
  accepted: reached("accepted"),
  gate: {
    runs: judged.length,
    verdicts,
    // Delivered is not achieved. An `unmet` here is the normal case, not a failure.
    milestoneCriteria: criteriaMet
  },
  execution: {
    finishedRuns: finished.length,
    workedMinutes,
    interruptedMinutes: executions.reduce((total, run) => total + run.pauseMinutes, 0),
    interruptionReasons: interruptions
  },
  modelRepairs: { runsNeedingRepair: repairs.length, total: repairs.reduce((a, b) => a + b, 0) },
  // Named rather than guessed at: these need observations this ledger does not hold.
  unanswerable: [
    "净节省时间 —— 需要一个没有本系统的对照期才能算",
    "模型使用成本 —— 需要按次的用量与计费记录"
  ]
}, null, 2));
store.close();
