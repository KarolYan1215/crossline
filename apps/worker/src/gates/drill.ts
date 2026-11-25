import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DRILL_ANSWERED, DRILL_GRADED, DRILL_ISSUE_FAILED, DRILL_ISSUED, GATE_JUDGED, weekStartOf,
  type DrillAnsweredPayload, type DrillFile, type DrillGradedPayload, type DrillIssuedPayload, type DrillKeyEntry, type GateJudgedPayload
} from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";
import { ownerOf } from "../owner";
import { localDay } from "./context";
import { runGate } from "./run";

/**
 * J7, the weekly bug-finding drill (docs/plans/execution-gates-1124.md §四 J7). The model writes a small RTL module, a self-checking
 * testbench and a few one-line bugs; code only simulates and feeds the simulator's output back (round 4: loops, not hard checks on
 * content). The clean design must pass its testbench, every bug must compile and make it print a `FAIL` line (that line is the key's
 * `failingCheck`), and all bugs together must compile. A part that fails goes back to the model with the simulator output, at most
 * `MAX_REPAIRS` times; a bug still failing is dropped. Fewer than `MIN_BUGS` left, or a clean design that never passes: nothing is
 * issued this pass, `drill.issue_failed` is recorded and the next pass tries once more. Without a simulator nothing is ever issued.
 * Grading is a gate judgement (`gate.judged`, gate `drill`) against the stored key, with a fixed file the person attached simulated
 * first and given as evidence.
 */
export const DRILL_SKILL = "crossline-gate-drill";
export const DRILL_PROMPT_VERSION = "crossline.gate.drill.v1";
/** The names the person's files carry; the model writes only their text. */
export const DESIGN_FILE = "dut.sv";
export const TESTBENCH_FILE = "tb.sv";
export const README_FILE = "README.md";
const MAX_REPAIRS = 3;
const MIN_BUGS = 3;
/** One failed week is tried again once on a later pass, then waits for next week. */
const ISSUE_ATTEMPTS = 2;
const OUTPUT_CHARS = 3000;


// ── the simulator ──

export type SimResult = { compiled: boolean; timedOut: boolean; exitCode: number | null; output: string };
export type Simulator = { available: () => Promise<boolean>; run: (files: DrillFile[]) => Promise<SimResult> };

type Exec = { code: number | null; out: string; timedOut: boolean; missing: boolean };
function exec(command: string, args: string[], cwd: string, timeoutMs: number): Promise<Exec> {
  return new Promise((resolve) => {
    // execFile, no shell: the file names are ours and nothing the model wrote reaches a command line.
    execFile(command, args, { cwd, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const failure = error as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
      resolve({ code: failure ? typeof failure.code === "number" ? failure.code : null : 0, out: `${stdout}${stderr}`,
        timedOut: Boolean(failure?.killed), missing: failure?.code === "ENOENT" });
    });
  });
}

/** Icarus Verilog on PATH: `iverilog -g2012` then `vvp -n`, each in a fresh temp directory and killed after its timeout. */
export function iverilogSimulator(options: { compileTimeoutMs?: number; simTimeoutMs?: number } = {}): Simulator {
  return {
    available: async () => {
      const dir = tmpdir();
      const [compiler, runner] = await Promise.all([exec("iverilog", ["-V"], dir, 10_000), exec("vvp", ["-V"], dir, 10_000)]);
      return !compiler.missing && !runner.missing;
    },
    run: async (files) => {
      const dir = await mkdtemp(path.join(tmpdir(), "crossline-drill-"));
      try {
        for (const file of files) await writeFile(path.join(dir, file.name), file.text, "utf8");
        const compile = await exec("iverilog", ["-g2012", "-o", "sim.vvp", ...files.map((file) => file.name)], dir, options.compileTimeoutMs ?? 30_000);
        if (compile.code !== 0 || compile.timedOut) return { compiled: false, timedOut: compile.timedOut, exitCode: compile.code, output: compile.out };
        const sim = await exec("vvp", ["-n", "sim.vvp"], dir, options.simTimeoutMs ?? 30_000);
        return { compiled: true, timedOut: sim.timedOut, exitCode: sim.code, output: `${compile.out}${sim.out}` };
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  };
}

const FAIL_LINE = /^FAIL\b.*$/m;
/** The testbench convention the Skill sets: a clean run finishes, prints `TB_RESULT PASS` and no `FAIL` line. */
export const simPassed = (result: SimResult) => result.compiled && !result.timedOut && result.exitCode === 0
  && /^TB_RESULT PASS\b/m.test(result.output) && !FAIL_LINE.test(result.output);
export const firstFailure = (result: SimResult) => result.output.match(FAIL_LINE)?.[0].trim().slice(0, 240) ?? "";
const clip = (text: string) => text.length > OUTPUT_CHARS ? `${text.slice(0, OUTPUT_CHARS)}\n…(truncated)` : text;

// ── issuing ──

type Bug = { id: string; line: number; original: string; replacement: string; description: string };
type Exercise = { title: string; topic: string; design: string; testbench: string; readme: string; bugs: Bug[] };

const str = { type: "string" } as const;
const EXERCISE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["title", "topic", "design", "testbench", "readme", "bugs"],
  properties: { title: str, topic: str, design: str, testbench: str, readme: str,
    bugs: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "line", "original", "replacement", "description"],
      properties: { id: str, line: { type: "integer" }, original: str, replacement: str, description: str } } } }
} as const;

/** One bug applied to the design's text, or what kept it from applying (said to the model as it is). */
function applyBug(design: string, bug: Bug): { text: string } | { problem: string } {
  const lines = design.split("\n");
  const at = bug.line - 1;
  const line = lines[at];
  if (line === undefined || at < 0) return { problem: `line ${bug.line} does not exist (the design has ${lines.length} lines)` };
  if (!bug.original || !line.includes(bug.original)) return { problem: `\`original\` is not on line ${bug.line}; that line reads: ${line}` };
  if (line.split(bug.original).length > 2) return { problem: `\`original\` occurs more than once on line ${bug.line}; quote enough of the line to make it unique` };
  if (bug.replacement.includes("\n")) return { problem: "`replacement` must be a single line" };
  if (bug.replacement === bug.original) return { problem: "`replacement` is the same as `original`" };
  lines[at] = line.replace(bug.original, () => bug.replacement);
  return { text: lines.join("\n") };
}

const filesOf = (design: string, testbench: string): DrillFile[] => [{ name: DESIGN_FILE, text: design }, { name: TESTBENCH_FILE, text: testbench }];

type Verdict = {
  goldenProblem?: { problem: string; output: string };
  valid: Array<Bug & { failingCheck: string }>;
  invalid: Array<{ id: string; problem: string; output: string }>;
  combinedProblem?: { problem: string; output: string };
};

async function verify(exercise: Exercise, sim: Simulator): Promise<Verdict> {
  const golden = await sim.run(filesOf(exercise.design, exercise.testbench));
  if (!simPassed(golden)) {
    const problem = !golden.compiled ? "the clean design and testbench do not compile"
      : golden.timedOut ? "the clean run did not finish (no $finish reached before the timeout)"
      : "the clean design does not pass its own testbench (expected `TB_RESULT PASS`, exit 0 and no `FAIL` line)";
    return { goldenProblem: { problem, output: clip(golden.output) }, valid: [], invalid: [] };
  }
  const valid: Verdict["valid"] = [];
  const invalid: Verdict["invalid"] = [];
  const usedLines = new Map<number, string>();
  for (const bug of exercise.bugs) {
    const other = usedLines.get(bug.line);
    if (other) { invalid.push({ id: bug.id, problem: `on the same line as ${other}; each bug needs its own line`, output: "" }); continue; }
    const applied = applyBug(exercise.design, bug);
    if ("problem" in applied) { invalid.push({ id: bug.id, problem: applied.problem, output: "" }); continue; }
    const run = await sim.run(filesOf(applied.text, exercise.testbench));
    if (!run.compiled) { invalid.push({ id: bug.id, problem: "with this bug the design does not compile", output: clip(run.output) }); continue; }
    const failing = firstFailure(run);
    if (!failing) { invalid.push({ id: bug.id, problem: "the testbench does not notice this bug (no line starting with `FAIL`)", output: clip(run.output) }); continue; }
    usedLines.set(bug.line, bug.id);
    valid.push({ ...bug, failingCheck: failing });
  }
  if (valid.length) {
    const together = valid.reduce((text, bug) => { const applied = applyBug(text, bug); return "text" in applied ? applied.text : text; }, exercise.design);
    const run = await sim.run(filesOf(together, exercise.testbench));
    if (!run.compiled) return { valid, invalid, combinedProblem: { problem: "with all valid bugs applied together the design does not compile", output: clip(run.output) } };
  }
  return { valid, invalid };
}

export const drillWeekOf = (now: Date, timeZone: string | undefined) => weekStartOf(localDay(now, timeZone));

export type DrillOptions = { simulator?: Simulator; timeZone?: string; log?: (event: Record<string, unknown>) => void };

function history(store: CrosslineStore, workspaceId: string) {
  const graded = new Map(store.listEvents(workspaceId, { type: DRILL_GRADED }).map((event) => [(event.payload as DrillGradedPayload).week, event.payload as DrillGradedPayload]));
  return store.listEvents(workspaceId, { type: DRILL_ISSUED }).map((event) => event.payload as DrillIssuedPayload)
    .sort((a, b) => b.week.localeCompare(a.week)).slice(0, 8)
    .map((drill) => ({ week: drill.week, title: drill.title, topic: drill.topic, found: graded.get(drill.week)?.found ?? "", total: drill.key.length }));
}

async function askModel(client: CodexRpcBoundary, cwd: string, input: Record<string, unknown>): Promise<Exercise | undefined> {
  const result = await runCodexSkill<Exercise>(client, input, {
    skillName: `crossline:${DRILL_SKILL}`, cwd,
    developerInstructions: "Write (or, with `feedback`, repair) this week's drill as the crossline-gate-drill Skill describes for mode `issue`, and return only the requested JSON.",
    outputSchema: EXERCISE_SCHEMA, prepareInput: () => input, stableKeys: ["version", "mode"],
    validateOutput: (output) => output as Exercise, onAudit: () => {}, timeoutMs: 30 * 60_000
  });
  return result.ok ? result.output : undefined;
}

/**
 * Issues this week's drill when none exists yet (weeks run Monday to Sunday in the person's zone, so any day of a week without one
 * qualifies). Returns whether one was issued.
 */
export async function drillIssuePass(store: CrosslineStore, workspaceId: string, client: CodexRpcBoundary, cwd: string, now = new Date(), options: DrillOptions = {}): Promise<boolean> {
  const log = options.log ?? ((event) => console.info(JSON.stringify(event)));
  const week = drillWeekOf(now, options.timeZone);
  if (store.listEvents(workspaceId, { type: DRILL_ISSUED, entityId: week }).length) return false;
  if (store.listEvents(workspaceId, { type: DRILL_ISSUE_FAILED, entityId: week }).length >= ISSUE_ATTEMPTS) return false;
  const sim = options.simulator ?? iverilogSimulator();
  // Never an exercise nobody simulated: without iverilog the drill simply waits.
  if (!await sim.available()) { log({ type: "drill.simulator_missing", workspaceId, week }); return false; }

  const base = { version: DRILL_PROMPT_VERSION, mode: "issue", history: history(store, workspaceId) };
  let exercise = await askModel(client, cwd, base);
  if (!exercise) return failed(store, workspaceId, week, "model_failed", 0, log);
  let verdict = await verify(exercise, sim);
  for (let round = 1; round <= MAX_REPAIRS; round += 1) {
    if (!verdict.goldenProblem && !verdict.invalid.length && !verdict.combinedProblem) break;
    const repaired = await askModel(client, cwd, { ...base, previous: exercise, feedback: {
      ...(verdict.goldenProblem ? { golden: verdict.goldenProblem } : {}),
      bugs: verdict.invalid, ...(verdict.combinedProblem ? { combined: verdict.combinedProblem } : {}) } });
    if (!repaired) break;
    exercise = repaired;
    verdict = await verify(exercise, sim);
  }
  if (verdict.goldenProblem) return failed(store, workspaceId, week, "golden_failed", verdict.valid.length, log);
  if (verdict.combinedProblem) return failed(store, workspaceId, week, "combined_uncompilable", verdict.valid.length, log);
  // A bug still failing after the repairs is dropped; the exercise stands on the ones that work.
  const bugs = verdict.valid;
  if (bugs.length < MIN_BUGS) return failed(store, workspaceId, week, "too_few_bugs", bugs.length, log);
  const buggy = bugs.reduce((text, bug) => { const applied = applyBug(text, bug); return "text" in applied ? applied.text : text; }, exercise.design);
  const payload: DrillIssuedPayload = {
    week, title: exercise.title, topic: exercise.topic, promptVersion: DRILL_PROMPT_VERSION,
    files: [{ name: DESIGN_FILE, text: buggy }, { name: TESTBENCH_FILE, text: exercise.testbench }, { name: README_FILE, text: exercise.readme }],
    key: [...bugs].sort((a, b) => a.line - b.line).map((bug) => ({ line: bug.line, description: bug.description, failingCheck: bug.failingCheck, original: bug.original, replacement: bug.replacement }))
  };
  const written = store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, type: DRILL_ISSUED, entityId: week, idempotencyKey: `${DRILL_ISSUED}:${week}`, payload });
  if (written.inserted) log({ type: "drill.issued", workspaceId, week, bugs: bugs.length, dropped: exercise.bugs.length - bugs.length });
  return written.inserted;
}

function failed(store: CrosslineStore, workspaceId: string, week: string, reason: string, bugs: number, log: (event: Record<string, unknown>) => void): false {
  const attempt = store.listEvents(workspaceId, { type: DRILL_ISSUE_FAILED, entityId: week }).length + 1;
  store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, type: DRILL_ISSUE_FAILED, entityId: week,
    idempotencyKey: `${DRILL_ISSUE_FAILED}:${week}:${attempt}`, payload: { week, reason, bugs, attempt } });
  log({ type: "drill.issue_failed", workspaceId, week, reason, bugs, attempt });
  return false;
}

// ── grading ──

const MATCH_SCHEMA = { type: "object", additionalProperties: false, required: ["bug", "verdict", "answer", "why"],
  properties: { bug: str, verdict: { type: "string", enum: ["found", "missed"] }, answer: str, why: str } } as const;
export const DRILL_DETAIL_SCHEMA = {
  type: "object", additionalProperties: false, required: ["found", "total", "falsePositives", "matches", "fixedFile"],
  properties: { found: { type: "integer" }, total: { type: "integer" }, falsePositives: { type: "integer" }, matches: { type: "array", items: MATCH_SCHEMA },
    fixedFile: { type: "string", enum: ["passes", "fails", "not_attached", "not_run"] } }
} as const;
export type DrillDetail = { found: number; total: number; falsePositives: number; matches: Array<{ bug: string; verdict: "found" | "missed"; answer: string; why: string }>;
  fixedFile: "passes" | "fails" | "not_attached" | "not_run" };

/** `drill.answered` events with no `drill.graded` yet, oldest first. */
export function ungradedDrillAnswers(store: CrosslineStore, workspaceId: string) {
  const graded = new Set(store.listEvents(workspaceId, { type: DRILL_GRADED }).map((event) => event.entityId));
  return store.listEvents(workspaceId, { type: DRILL_ANSWERED }).filter((event) => !graded.has(event.eventId));
}

function writeGraded(store: CrosslineStore, workspaceId: string, answeredId: string, week: string, total: number, judgedId: string, detail: DrillDetail | undefined) {
  const payload: DrillGradedPayload = { week, found: detail?.found ?? 0, total, falsePositives: detail?.falsePositives ?? 0, judgedId };
  store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, type: DRILL_GRADED, entityId: answeredId, idempotencyKey: `${DRILL_GRADED}:${answeredId}`, payload });
}

/** Grades every answered drill not graded yet in one gate run. Returns how many were graded. */
export async function drillGradePass(store: CrosslineStore, workspaceId: string, client: CodexRpcBoundary, cwd: string, now = new Date(), options: DrillOptions = {}): Promise<number> {
  const pending = ungradedDrillAnswers(store, workspaceId);
  if (!pending.length) return 0;
  const issued = new Map(store.listEvents(workspaceId, { type: DRILL_ISSUED }).map((event) => [event.entityId, event.payload as DrillIssuedPayload]));
  const judged = new Map(store.listEvents(workspaceId, { type: GATE_JUDGED }).filter((event) => (event.payload as GateJudgedPayload).gate === "drill"
    && (event.payload as GateJudgedPayload).run === 1).map((event) => [event.entityId, event]));
  const sim = options.simulator ?? iverilogSimulator();
  let simReady: boolean | undefined;
  let graded = 0;
  const drills: Array<Record<string, unknown>> = [];
  const subjects = new Map<string, { kind: "drill"; id: string }>();
  for (const event of pending) {
    const answer = event.payload as DrillAnsweredPayload;
    const drill = issued.get(answer.week);
    if (!drill) continue;
    // A judgement written before the summary was (a crash between the two): the summary is written from it, without another run.
    const prior = judged.get(event.eventId);
    if (prior) {
      writeGraded(store, workspaceId, event.eventId, answer.week, drill.key.length, prior.eventId, (prior.payload as GateJudgedPayload).output.detail as DrillDetail);
      graded += 1;
      continue;
    }
    let fixedFile: Record<string, unknown> = { state: "not_attached", passed: false, output: "" };
    if (answer.fixedFile) {
      simReady ??= await sim.available();
      const testbench = drill.files.find((file) => file.name === TESTBENCH_FILE)?.text ?? "";
      if (!simReady) fixedFile = { state: "not_run", passed: false, output: "" };
      else {
        const run = await sim.run(filesOf(answer.fixedFile.text, testbench));
        fixedFile = { state: "ran", passed: simPassed(run), output: clip(run.output) };
      }
    }
    const design = drill.files.find((file) => file.name === DESIGN_FILE)?.text ?? "";
    drills.push({ id: event.eventId, week: answer.week, title: drill.title,
      design: design.split("\n").map((line, index) => `${index + 1}: ${line}`),
      key: drill.key.map((entry, index) => ({ bug: `B${index + 1}`, ...entry })),
      answers: answer.answers.map((item, index) => ({ answer: `A${index + 1}`, line: item.line, description: item.description })),
      fixedFile });
    subjects.set(event.eventId, { kind: "drill", id: event.eventId });
  }
  if (!drills.length) return graded;
  const results = await runGate({
    store, workspaceId, client, cwd, gate: "drill", skill: DRILL_SKILL, promptVersion: DRILL_PROMPT_VERSION,
    input: { version: DRILL_PROMPT_VERSION, mode: "grade", drills },
    detail: DRILL_DETAIL_SCHEMA,
    subjects, summary: `drills ${drills.length}`, round: "1", now,
    developerInstructions: "Grade each drill in `drills` as the crossline-gate-drill Skill describes for mode `grade`: every key bug against all answers, and return only the requested JSON, one item per drill, `subject` copied from its id."
  });
  for (const result of results) {
    const answer = pending.find((event) => event.eventId === result.subject.id);
    const drill = answer ? issued.get((answer.payload as DrillAnsweredPayload).week) : undefined;
    if (!answer || !drill) continue;
    writeGraded(store, workspaceId, answer.eventId, drill.week, drill.key.length, result.eventId, result.output.detail as DrillDetail);
    graded += 1;
  }
  return graded;
}
