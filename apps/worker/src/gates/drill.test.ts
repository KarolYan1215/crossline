import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { DRILL_ANSWERED, DRILL_GRADED, DRILL_ISSUE_FAILED, DRILL_ISSUED, GATE_JUDGED, type DrillIssuedPayload } from "@crossline/core";
import { fakeRuntime } from "../testing/fake-runtime";
import { DESIGN_FILE, DRILL_SKILL, drillGradePass, drillIssuePass, iverilogSimulator, type Simulator } from "./drill";

/** J7 (docs/plans/execution-gates-1124.md §四 J7): the drill is simulated before it is issued, repaired from the simulator's output, graded as a gate. */
let store: CrosslineStore;
let ws: string;
const NOW = new Date("2026-11-24T15:00:00.000Z");
const WEEK = "2026-11-23";
const SKILL = `crossline:${DRILL_SKILL}`;

beforeEach(() => {
  store = new CrosslineStore(":memory:");
  ws = store.createPrincipalWithWorkspace("user-1", "个人 workspace").workspace.id;
});
afterEach(() => store.close());

/**
 * A stand-in for iverilog + vvp that reads the design: `SYNTAX` does not compile, `BROKEN` fails the clean run, every `BAD<n>` makes the
 * testbench print `FAIL check<n>`; anything else passes. `runs` records what was simulated.
 */
function fakeSim(available = true): Simulator & { runs: string[] } {
  const runs: string[] = [];
  return {
    runs,
    available: async () => available,
    run: async (files) => {
      const design = files[0]!.text;
      runs.push(design);
      if (design.includes("SYNTAX")) return { compiled: false, timedOut: false, exitCode: 1, output: "dut.sv:3: syntax error" };
      const fails = [...design.matchAll(/BAD(\d)/g)].map((match) => `FAIL check${match[1]} t=10 expected=1 got=0`);
      if (design.includes("BROKEN")) fails.push("FAIL golden t=5 expected=0 got=1");
      return { compiled: true, timedOut: false, exitCode: 0, output: fails.length ? `${fails.join("\n")}\nTB_RESULT FAIL ${fails.length}\n` : "TB_RESULT PASS\n" };
    }
  };
}

const DESIGN = ["module m(input a, output y1, output y2, output y3, output y4);", "assign y1 = a;", "assign y2 = a;", "assign y3 = a;", "assign y4 = a;", "endmodule"].join("\n");
const bug = (n: number, replacement = `BAD${n}`) => ({ id: `B${n}`, line: n + 1, original: "= a", replacement: `= ${replacement}`, description: `第 ${n} 处错误` });
const exercise = (overrides: Record<string, unknown> = {}) => JSON.stringify({ title: "四路直通找错", topic: "pass through", design: DESIGN,
  testbench: "module tb; initial begin $display(\"TB_RESULT PASS\"); $finish; end endmodule", readme: "# 说明", bugs: [bug(1), bug(2), bug(3)], ...overrides });
const issued = () => store.listEvents(ws, { type: DRILL_ISSUED }).map((event) => event.payload as DrillIssuedPayload);

test("a clean design that fails its own testbench goes back with the simulator output, and the repaired one is issued with its key", async () => {
  const runtime = fakeRuntime([exercise({ design: DESIGN.replace("endmodule", "// BROKEN\nendmodule") }), exercise()], SKILL);
  const sim = fakeSim();
  expect(await drillIssuePass(store, ws, runtime.rpc, "C:\\repo", NOW, { simulator: sim, log: () => {} })).toBe(true);
  expect(runtime.turns()).toBe(2);
  expect(runtime.prompts()[1]).toContain("does not pass its own testbench");
  expect(runtime.prompts()[1]).toContain("FAIL golden");
  const [drill] = issued();
  expect(drill).toMatchObject({ week: WEEK, title: "四路直通找错", promptVersion: "crossline.gate.drill.v1" });
  expect(drill!.files.map((file) => file.name)).toEqual(["dut.sv", "tb.sv", "README.md"]);
  // The issued design carries every bug at once; the key names each line and the check it trips.
  expect(drill!.files[0]!.text).toContain("assign y1 = BAD1;");
  expect(drill!.files[0]!.text).toContain("assign y3 = BAD3;");
  expect(drill!.key).toEqual([1, 2, 3].map((n) => ({ line: n + 1, description: `第 ${n} 处错误`, failingCheck: `FAIL check${n} t=10 expected=1 got=0`, original: "= a", replacement: `= BAD${n}` })));
  // Once issued, the week is done: another pass runs nothing.
  expect(await drillIssuePass(store, ws, runtime.rpc, "C:\\repo", NOW, { simulator: sim, log: () => {} })).toBe(false);
  expect(runtime.turns()).toBe(2);
});

test("a bug the testbench never notices is sent back three times, then dropped; the exercise stands on the rest", async () => {
  const runtime = fakeRuntime([exercise({ bugs: [bug(1), bug(2), bug(3), bug(4, "WEAK")] })], SKILL);
  expect(await drillIssuePass(store, ws, runtime.rpc, "C:\\repo", NOW, { simulator: fakeSim(), log: () => {} })).toBe(true);
  expect(runtime.turns()).toBe(4);
  for (const prompt of runtime.prompts().slice(1)) expect(prompt).toContain("does not notice this bug");
  const [drill] = issued();
  expect(drill!.key.map((entry) => entry.line)).toEqual([2, 3, 4]);
  expect(drill!.files[0]!.text).not.toContain("WEAK");
});

test("a bug that does not compile or does not apply is fed back; one that is fixed on the repair is kept", async () => {
  const runtime = fakeRuntime([exercise({ bugs: [bug(1), bug(2), { ...bug(3), replacement: "= SYNTAX" }, { ...bug(4), original: "zzz" }] }),
    exercise({ bugs: [bug(1), bug(2), bug(3), bug(4)] })], SKILL);
  expect(await drillIssuePass(store, ws, runtime.rpc, "C:\\repo", NOW, { simulator: fakeSim(), log: () => {} })).toBe(true);
  expect(runtime.prompts()[1]).toContain("does not compile");
  expect(runtime.prompts()[1]).toContain("is not on line 5");
  expect(issued()[0]!.key).toHaveLength(4);
});

test("without a simulator nothing is issued and no model runs", async () => {
  const runtime = fakeRuntime([exercise()], SKILL);
  const logs: Array<Record<string, unknown>> = [];
  expect(await drillIssuePass(store, ws, runtime.rpc, "C:\\repo", NOW, { simulator: fakeSim(false), log: (event) => logs.push(event) })).toBe(false);
  expect(runtime.turns()).toBe(0);
  expect(issued()).toEqual([]);
  expect(logs).toEqual([expect.objectContaining({ type: "drill.simulator_missing" })]);
});

test("fewer than three working bugs: nothing issued, tried once more on a later pass, then the week waits", async () => {
  const runtime = fakeRuntime([exercise({ bugs: [bug(1), bug(2, "WEAK"), bug(3, "WEAK")] })], SKILL);
  const pass = () => drillIssuePass(store, ws, runtime.rpc, "C:\\repo", NOW, { simulator: fakeSim(), log: () => {} });
  expect(await pass()).toBe(false);
  expect(await pass()).toBe(false);
  const turns = runtime.turns();
  expect(await pass()).toBe(false);
  expect(runtime.turns()).toBe(turns);
  expect(store.listEvents(ws, { type: DRILL_ISSUE_FAILED }).map((event) => event.payload)).toEqual([
    { week: WEEK, reason: "too_few_bugs", bugs: 1, attempt: 1 }, { week: WEEK, reason: "too_few_bugs", bugs: 1, attempt: 2 }]);
  expect(issued()).toEqual([]);
});

test("an answer is graded once as a gate judgement against the key, a fixed file simulated first, and summarized", async () => {
  await drillIssuePass(store, ws, fakeRuntime([exercise()], SKILL).rpc, "C:\\repo", NOW, { simulator: fakeSim(), log: () => {} });
  const answered = store.appendEvent({ ownerId: "user-1", workspaceId: ws, type: DRILL_ANSWERED, entityId: WEEK, idempotencyKey: `${DRILL_ANSWERED}:${WEEK}`,
    payload: { week: WEEK, issuedId: "x", answers: [{ line: 2, description: "y1 接错了" }, { line: 6, description: "多余的 endmodule" }],
      fixedFile: { name: DESIGN_FILE, text: DESIGN } } });
  const detail = { found: 1, total: 3, falsePositives: 1, fixedFile: "passes", matches: [
    { bug: "B1", verdict: "found", answer: "A1", why: "行号与原因一致" }, { bug: "B2", verdict: "missed", answer: "", why: "未提及" }, { bug: "B3", verdict: "missed", answer: "", why: "未提及" }] };
  const runtime = fakeRuntime([JSON.stringify({ items: [{ subject: answered.eventId, verdict: "graded", confidence: "high", reason: "找到 1/3",
    evidence: [{ kind: "file", ref: "dut.sv:2", quote: "assign y1 = BAD1;", at: WEEK }], ifWrong: { harm: "none", fixable: "before_step" }, detail }] })], SKILL);
  const sim = fakeSim();
  expect(await drillGradePass(store, ws, runtime.rpc, "C:\\repo", NOW, { simulator: sim })).toBe(1);
  const prompt = runtime.prompts()[0]!;
  expect(prompt).toContain("\"mode\":\"grade\"");
  expect(prompt).toContain("FAIL check1");
  expect(prompt).toContain("\"state\":\"ran\"");
  expect(prompt).toContain("\"passed\":true");
  expect(sim.runs.at(-1)).toBe(DESIGN);
  const judged = store.listEvents(ws, { type: GATE_JUDGED });
  expect(judged).toHaveLength(1);
  expect(judged[0]!.payload).toMatchObject({ gate: "drill", subject: { kind: "drill", id: answered.eventId }, run: 1, asked: false, output: { verdict: "graded", detail } });
  expect(store.listEvents(ws, { type: DRILL_GRADED }).map((event) => event.payload)).toEqual([
    { week: WEEK, found: 1, total: 3, falsePositives: 1, judgedId: judged[0]!.eventId }]);
  expect(await drillGradePass(store, ws, runtime.rpc, "C:\\repo", NOW, { simulator: sim })).toBe(0);
  expect(runtime.turns()).toBe(1);
});

const hasIverilog = (() => { try { execFileSync("iverilog", ["-V"], { stdio: "ignore" }); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT" && (error as { status?: number }).status !== undefined; } })();

test.skipIf(!hasIverilog)("the real simulator: a clean counter passes, an off-by-one fails with the convention's FAIL line", async () => {
  const sim = iverilogSimulator();
  const design = "module counter(input clk, input rst, output reg [3:0] q);\n  always @(posedge clk) if (rst) q <= 0; else q <= q + 1;\nendmodule\n";
  const tb = ["module tb;", "  reg clk = 0, rst = 1; wire [3:0] q; integer errors = 0;", "  counter dut(.clk(clk), .rst(rst), .q(q));", "  always #5 clk = ~clk;",
    "  initial begin", "    @(posedge clk); #1 rst = 0;", "    repeat (3) @(posedge clk); #1;",
    "    if (q !== 3) begin errors = errors + 1; $display(\"FAIL count t=%0t expected=3 got=%0d\", $time, q); end",
    "    if (errors == 0) $display(\"TB_RESULT PASS\"); else $display(\"TB_RESULT FAIL %0d\", errors);", "    $finish;", "  end", "endmodule", ""].join("\n");
  expect(await sim.available()).toBe(true);
  const clean = await sim.run([{ name: "dut.sv", text: design }, { name: "tb.sv", text: tb }]);
  expect(clean.output).toContain("TB_RESULT PASS");
  const buggy = await sim.run([{ name: "dut.sv", text: design.replace("q + 1", "q + 2") }, { name: "tb.sv", text: tb }]);
  expect(buggy.output).toMatch(/^FAIL count/m);
}, 60_000);
