// Aggregates the month simulation's JSON (scripts/month-sim.ts) into the report's tables.
//   node docs/reports/2026-10-30-overnight/sim-data/analyze.mjs <dir with diligent.json procrastinator.json overloaded.json>
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const dir = process.argv[2] ?? path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1"));
const strategies = ["diligent", "procrastinator", "overloaded"];
const num = (v) => (typeof v === "number" ? v : 0);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const r1 = (x) => Math.round(x * 10) / 10, r2 = (x) => Math.round(x * 100) / 100;
const summary = {};
for (const strategy of strategies) {
  const file = path.join(dir, `${strategy}.json`);
  if (!existsSync(file)) continue;
  const run = JSON.parse(readFileSync(file, "utf8"));
  const days = run.daysOut;
  const weeks = [];
  for (let w = 0; w * 7 < days.length; w++) {
    const slice = days.slice(w * 7, w * 7 + 7);
    weeks.push({
      week: w + 1, from: slice[0].day,
      scheduledH: r1(slice.reduce((s, d) => s + num(d.scheduledMin), 0) / 60),
      availableH: r1(slice.reduce((s, d) => s + num(d.availableMin), 0) / 60),
      workedH: r1(slice.reduce((s, d) => s + num(d.workedMin), 0) / 60),
      started: slice.reduce((s, d) => s + num(d.started), 0),
      skipped: slice.reduce((s, d) => s + num(d.skipped), 0),
      blocks: slice.reduce((s, d) => s + num(d.blocksToday), 0),
      decisions: slice.reduce((s, d) => s + num(d.decisions), 0),
      decisionMin: r1(slice.reduce((s, d) => s + num(d.decisionS), 0) / 60),
      nudgesCounted: slice.reduce((s, d) => s + num(d.nudgesCounted), 0),
      nudgesAll: slice.reduce((s, d) => s + num(d.nudges), 0),
      pendingEnd: slice.at(-1).pendingTotal, asksOpenEnd: slice.at(-1).asksOpenAll,
      churnShare: r2(slice.reduce((s, d) => s + num(d.churnMoved), 0) / Math.max(1, slice.reduce((s, d) => s + num(d.churnCompared), 0))),
      falseDone: slice.reduce((s, d) => s + num(d.falseDone), 0),
      captureBacklogEnd: slice.at(-1).captureBacklog,
      usesAppDays: slice.filter((d) => d.usesApp).length
    });
  }
  const deadlines = run.deadlines;
  const met = deadlines.filter((d) => d.acceptedDay && d.acceptedDay <= d.due).length;
  const metMoved = deadlines.filter((d) => d.acceptedDay && d.acceptedDay > d.due && d.finalDue && d.acceptedDay <= d.finalDue).length;
  const late = deadlines.filter((d) => d.acceptedDay && (!d.finalDue || d.acceptedDay > d.finalDue)).length;
  const archived = deadlines.filter((d) => d.state === "archived").length;
  const open = deadlines.filter((d) => !d.acceptedDay && d.state !== "archived").length;
  const moved = deadlines.filter((d) => d.finalDue && d.finalDue !== d.due).length;
  const errors = run.events.filter((e) => e.kind === "error" || e.kind.endsWith("_error"));
  const kinds = {};
  for (const e of run.events.filter((e) => e.kind.startsWith("nudge:"))) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
  const fa = days.filter((d) => d.firstActionCoverage !== null && d.firstActionCoverage !== undefined).map((d) => d.firstActionCoverage);
  summary[strategy] = {
    runtimeS: run.runtimeS, refusedFetches: run.refusedFetches,
    feasibilityMedian: r2(median(days.filter((d) => d.feasibility !== null).map((d) => d.feasibility))),
    realization: r2(days.reduce((s, d) => s + num(d.workedMin), 0) / Math.max(1, days.reduce((s, d) => s + num(d.scheduledMin), 0))),
    startRate: r2(days.reduce((s, d) => s + num(d.started), 0) / Math.max(1, days.reduce((s, d) => s + num(d.started) + num(d.skipped), 0))),
    decisionsPerDay: r1(mean(days.map((d) => num(d.decisions)))), decisionMinPerDay: r1(mean(days.map((d) => num(d.decisionS))) / 60),
    decisionMinMax: r1(Math.max(...days.map((d) => num(d.decisionS))) / 60),
    nudgesCountedPerDay: r1(mean(days.map((d) => num(d.nudgesCounted)))), nudgesPerDay: r1(mean(days.map((d) => num(d.nudges)))), nudgeKinds: kinds,
    pendingStart: days[0].pendingTotal, pendingEnd: days.at(-1).pendingTotal, pendingMax: Math.max(...days.map((d) => num(d.pendingTotal))),
    asksStart: days[0].asksOpenAll, asksEnd: days.at(-1).asksOpenAll,
    churnShare: r2(days.reduce((s, d) => s + num(d.churnMoved), 0) / Math.max(1, days.reduce((s, d) => s + num(d.churnCompared), 0))),
    firstActionCoverageToday: r2(mean(fa)),
    firstActionCoverageAllOpen: days.at(-1).openPersonSteps ? r2(days.at(-1).openPersonStepsWithFirstAction / days.at(-1).openPersonSteps) : null,
    gatedViolations: days.reduce((s, d) => s + num(d.gatedViolations), 0),
    todayCharsMedian: median(days.filter((d) => d.todayChars).map((d) => d.todayChars)),
    todayItemsMedian: median(days.filter((d) => d.todayTimelineItems !== undefined).map((d) => num(d.todayTimelineItems) + num(d.todayAsks) + num(d.todayReminders))),
    switchesPerDay: r1(mean(days.map((d) => num(d.switchesToday)))), distinctTasksPerDay: r1(mean(days.map((d) => num(d.distinctTasksToday)))),
    blocksUnder30PerDay: r1(mean(days.map((d) => num(d.blocksUnder30)))),
    falseDone: days.reduce((s, d) => s + num(d.falseDone), 0), wrapLeftOpen: days.reduce((s, d) => s + num(d.wrapLeftOpen), 0),
    promiseKept: r2(days.reduce((s, d) => s + num(d.promiseKept), 0) / Math.max(1, days.reduce((s, d) => s + num(d.promiseShown), 0))),
    promiseShown: days.reduce((s, d) => s + num(d.promiseShown), 0),
    stepsAllThree: r2(days.reduce((s, d) => s + num(d.stepsAllThree), 0) / Math.max(1, days.reduce((s, d) => s + num(d.stepsToday), 0))),
    stepsInputKnown: r2(days.reduce((s, d) => s + num(d.stepsInputKnown), 0) / Math.max(1, days.reduce((s, d) => s + num(d.stepsToday), 0))),
    stepsOutputKnown: r2(days.reduce((s, d) => s + num(d.stepsOutputKnown), 0) / Math.max(1, days.reduce((s, d) => s + num(d.stepsToday), 0))),
    farStepsAbilityShare: r2(days.reduce((s, d) => s + num(d.farStepsAbility), 0) / Math.max(1, days.reduce((s, d) => s + num(d.farSteps), 0))),
    firstActionLenMedian: median(days.filter((d) => d.firstActionLenMedian).map((d) => d.firstActionLenMedian)),
    standIns: run.standIns ?? null,
    weeklyCommitNumbers: days.filter((d) => d.weekday === 1 || d.weekday === 0).map((d) => `${d.day} ${d.wcDue || "-"} demand ${d.wcDemand}/cap ${d.wcCapacity} defer ${d.wcDefer} drop ${d.wcDrop} committed ${d.wcCommitted}`),
    wrapDays: days.filter((d) => d.wrapped).length, returnPages: run.events.filter((e) => e.kind === "return_page").length,
    weeklyCommit: days.filter((d) => d.wcDue).map((d) => `${d.day} ${d.wcDue} ${d.wcDemand}/${d.wcCapacity} defer ${d.wcDefer} drop ${d.wcDrop}`),
    weeklyCommitAnswered: days.reduce((s, d) => s + num(d.ans_weekly_commit), 0),
    deadlines: { total: deadlines.length, met, metMoved, late, archived, open, moved },
    truth: run.truth, errors: errors.length, errorSamples: [...new Set(errors.map((e) => e.detail.slice(0, 160)))].slice(0, 6),
    weeks
  };
}
console.log(JSON.stringify(summary, null, 1));
