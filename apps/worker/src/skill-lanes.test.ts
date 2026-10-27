import { afterEach, beforeEach, expect, test } from "vitest";
import { runCodexSkill, setSpendModeProvider, setUsageSink, enterUsageWorkspace, type SkillUsage } from "@crossline/codex";
import { fakeRuntime } from "./testing/fake-runtime";

const TOP = "crossline:crossline-onboarding";
const LOW = "crossline:crossline-plan-explainer";
const MID = "crossline:crossline-due-diligence";

const options = (skillName: string) => ({
  skillName, cwd: "C:\\repo", developerInstructions: "x", outputSchema: {}, prepareInput: (input: unknown) => input,
  validateOutput: (output: unknown) => output, onAudit: () => {}, timeoutMs: 5_000
});

let usage: SkillUsage[] = [];
beforeEach(() => { usage = []; setUsageSink((record) => usage.push(record)); });
afterEach(() => { setUsageSink(undefined); setSpendModeProvider(undefined); });

test("a quick low-tier run is not held behind a slow top-tier one", async () => {
  const slow = fakeRuntime(["{}"], TOP, { delayMs: 300 });
  const quick = fakeRuntime(["{}"], LOW);
  const finished: string[] = [];
  const heavy = runCodexSkill(slow.rpc, {}, options(TOP)).then(() => finished.push("top"));
  const light = runCodexSkill(quick.rpc, {}, options(LOW)).then(() => finished.push("low"));
  await Promise.all([heavy, light]);
  expect(finished).toEqual(["low", "top"]);
});

test("two runs of the same tier on one runtime still go one after the other", async () => {
  const runtime = fakeRuntime(["{}", "{}"], TOP, { delayMs: 120 });
  const finished: string[] = [];
  const a = runCodexSkill(runtime.rpc, {}, options(TOP)).then(() => finished.push("first"));
  const b = runCodexSkill(runtime.rpc, {}, options(TOP)).then(() => finished.push("second"));
  await Promise.all([a, b]);
  expect(finished).toEqual(["first", "second"]);
});

test("two accounts' own runtimes do not queue behind each other", async () => {
  const mine = fakeRuntime(["{}"], TOP, { delayMs: 300 });
  const theirs = fakeRuntime(["{}"], "crossline:crossline-milestone-architect");
  const finished: string[] = [];
  const a = runCodexSkill(mine.rpc, {}, options(TOP)).then(() => finished.push("mine"));
  const b = runCodexSkill(theirs.rpc, {}, options("crossline:crossline-milestone-architect")).then(() => finished.push("theirs"));
  await Promise.all([a, b]);
  expect(finished).toEqual(["theirs", "mine"]);
});

test("a run reports the model it ran on, its tokens, its turns and how long it took", async () => {
  const { rpc } = fakeRuntime(["{}"], MID, { usage: { input: 1200, cached: 200, output: 300, reasoning: 100 } });
  enterUsageWorkspace("ws-1");
  const result = await runCodexSkill(rpc, {}, options(MID));
  expect(result.ok).toBe(true);
  expect(usage).toHaveLength(1);
  expect(usage[0]).toMatchObject({ workspaceId: "ws-1", skillName: MID, tier: "mid", model: "gpt-5.6-terra", effort: "medium", spendMode: "normal",
    ok: true, turns: 1, inputTokens: 1200, cachedInputTokens: 200, outputTokens: 300, reasoningOutputTokens: 100, totalTokens: 1500 });
  expect(usage[0]!.durationMs).toBeGreaterThanOrEqual(0);
});

test("a failed run is reported too, with why", async () => {
  const { rpc } = fakeRuntime(["{}"], MID);
  const result = await runCodexSkill(rpc, {}, { ...options(MID), validateOutput: () => { throw new Error("SOME_CODE"); } });
  expect(result.ok).toBe(false);
  expect(usage[0]).toMatchObject({ ok: false, errorCode: "SOME_CODE" });
});

test("when the budget is tight the run steps down a tier, and the report says which mode it ran in", async () => {
  setSpendModeProvider(async () => "economy");
  const { rpc } = fakeRuntime(["{}"], TOP, { usage: { input: 10, output: 5 } });
  await runCodexSkill(rpc, {}, options(TOP));
  expect(usage[0]).toMatchObject({ spendMode: "economy", tier: "top", model: "gpt-5.6-terra", effort: "medium" });
});

test("the milestone gate never steps down, however tight the budget", async () => {
  setSpendModeProvider(async () => "economy");
  const gate = "crossline:crossline-milestone-gate";
  const { rpc } = fakeRuntime(["{}"], gate);
  await runCodexSkill(rpc, {}, options(gate));
  expect(usage[0]).toMatchObject({ spendMode: "economy", model: "gpt-5.6-terra" });
});

test("the time limit restarts for each turn, so a repair is not starved by how long the first turn took", async () => {
  // Each turn takes ~80 ms against a 120 ms limit: together they are over it, separately well under.
  const { rpc, turns } = fakeRuntime(["bad", "{}"], TOP, { delayMs: 80 });
  const strict = { ...options(TOP), timeoutMs: 120, validateOutput: (output: unknown) => { if (JSON.stringify(output) === "{}") return output; throw new Error("REJECTED"); } };
  const result = await runCodexSkill(rpc, {}, strict);
  expect(result).toMatchObject({ ok: true, audit: { repairs: 1 } });
  expect(turns()).toBe(2);

  // A single turn that really is too slow still ends the run.
  const slow = fakeRuntime(["{}"], MID, { delayMs: 300 });
  expect(await runCodexSkill(slow.rpc, {}, { ...options(MID), timeoutMs: 100 })).toMatchObject({ ok: false, blocker: { code: "SKILL_TIMEOUT" } });
});

test("a turn that goes completely silent is interrupted and sent again, and the run still finishes", async () => {
  // Turn 1 never answers (a hung backend, as a real run had for over an hour); the watchdog sends the same prompt again.
  const { rpc, turns, prompts, interrupts } = fakeRuntime(["{}"], TOP, { stallTurns: [1] });
  const result = await runCodexSkill(rpc, {}, { ...options(TOP), timeoutMs: 60_000, idleMs: 120 });
  expect(result).toMatchObject({ ok: true, audit: { stalls: 1 } });
  expect(turns()).toBe(2);
  expect(prompts()[1]).toBe(prompts()[0]);
  expect(interrupts()).toBe(1);
});

test("the interrupted turn's own late completion does not end the resent one as 「已取消」", async () => {
  // The real runtime answers turn/interrupt with turn/completed(status: interrupted) for the old turn, which can arrive before the resent
  // turn has its id; a real assistant run was ended as SKILL_CANCELED that way after 96 minutes.
  const { rpc, turns } = fakeRuntime(["{}"], TOP, { stallTurns: [1], completeOnInterrupt: true });
  const result = await runCodexSkill(rpc, {}, { ...options(TOP), timeoutMs: 60_000, idleMs: 120 });
  expect(result).toMatchObject({ ok: true, audit: { stalls: 1 } });
  expect(turns()).toBe(2);
});

test("a run that keeps going silent gives up with a name that says so, instead of waiting out the hour", async () => {
  const { rpc, turns } = fakeRuntime(["{}"], TOP, { stallTurns: [1, 2, 3] });
  const result = await runCodexSkill(rpc, {}, { ...options(TOP), timeoutMs: 60_000, idleMs: 100 });
  expect(result).toMatchObject({ ok: false, blocker: { code: "SKILL_STALLED" }, audit: { stalls: 2 } });
  expect(turns()).toBe(3);
});

test("slow work that keeps producing events is never mistaken for a hang", async () => {
  // The answer takes longer than the silence limit, but usage notifications arrive while it is produced.
  const { rpc } = fakeRuntime(["{}"], TOP, { delayMs: 300, usage: { input: 10, output: 10 } });
  const result = await runCodexSkill(rpc, {}, { ...options(TOP), timeoutMs: 60_000, idleMs: 500 });
  expect(result).toMatchObject({ ok: true });
});

test("one account's tight quota steps only its own runs down", async () => {
  setSpendModeProvider(async (workspaceId) => workspaceId === "ws-tight" ? "economy" : "normal");
  enterUsageWorkspace("ws-tight");
  await runCodexSkill(fakeRuntime(["{}"], TOP).rpc, {}, options(TOP));
  enterUsageWorkspace("ws-roomy");
  await runCodexSkill(fakeRuntime(["{}"], TOP).rpc, {}, options(TOP));
  expect(usage.map((record) => [record.workspaceId, record.spendMode])).toEqual([["ws-tight", "economy"], ["ws-roomy", "normal"]]);
});
