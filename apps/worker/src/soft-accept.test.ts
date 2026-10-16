import { expect, test } from "vitest";
import { runCodexSkill } from "@crossline/codex";
import { keepAnalysisProposal, keepMilestoneProposal, MILESTONE_SOFT_CODES } from "@crossline/core";
import { fakeRuntime } from "./testing/fake-runtime";

const SKILL = "crossline:crossline-step-planner";
const refuse = (code: string) => { throw Object.assign(new Error(code), { detail: "说明" }); };

test("a quality refusal still standing after the repairs keeps the answer when the caller says so, and reports it as a warning", async () => {
  const { rpc, turns } = fakeRuntime(['{"v":1}', '{"v":2}', '{"v":3}'], SKILL);
  const result = await runCodexSkill<{ v: number }>(rpc, {}, { skillName: SKILL, cwd: "C:\repo", developerInstructions: "", outputSchema: {},
    prepareInput: (input) => input, validateOutput: () => refuse("SOME_QUALITY"), onAudit: () => {},
    softAccept: (rejection, output) => rejection.message === "SOME_QUALITY" ? output as { v: number } : undefined });
  expect(turns()).toBe(3);
  expect(result).toMatchObject({ ok: true, output: { v: 3 }, audit: { repairs: 2, warnings: [{ code: "SOME_QUALITY", detail: "说明" }] } });
});

test("a refusal the caller does not soften, or a Skill that stopped and said why, still blocks", async () => {
  const hard = fakeRuntime(['{"v":1}', '{"v":2}', '{"v":3}'], SKILL);
  const refused = await runCodexSkill(hard.rpc, {}, { skillName: SKILL, cwd: "C:\repo", developerInstructions: "", outputSchema: {},
    prepareInput: (input) => input, validateOutput: () => refuse("SAFETY_LINE"), onAudit: () => {}, softAccept: () => undefined });
  expect(refused).toMatchObject({ ok: false, blocker: { code: "SAFETY_LINE" } });
  const stopped = fakeRuntime(['{"v":1}'], SKILL);
  const blocked = await runCodexSkill(stopped.rpc, {}, { skillName: SKILL, cwd: "C:\repo", developerInstructions: "", outputSchema: {},
    prepareInput: (input) => input, validateOutput: () => refuse("ANYTHING_BLOCKED"), onAudit: () => {}, softAccept: (_r, output) => output });
  expect(blocked).toMatchObject({ ok: false, blocker: { code: "ANYTHING_BLOCKED" } });
});

test("only quality codes are soft for the milestone architect, and an analysis margin is corrected rather than refused", () => {
  expect(MILESTONE_SOFT_CODES.has("MILESTONE_NO_MARGIN")).toBe(true);
  expect(MILESTONE_SOFT_CODES.has("MILESTONE_DEPENDENCY_UNKNOWN")).toBe(false);
  expect(keepMilestoneProposal({}, { identities: [], existingMilestones: [], templates: [] } as never, "MILESTONE_DEPENDENCY_UNKNOWN")).toBeUndefined();
  expect(keepAnalysisProposal({}, {} as never, "ANALYSIS_POLICY_BLOCKED")).toBeUndefined();
});

test("keepEarly keeps a small fix at the first rejection, with no repair turn; when it declines, the repairs go on as before", async () => {
  const early = fakeRuntime(['{"v":1}', '{"v":2}'], SKILL);
  const kept = await runCodexSkill<{ v: number }>(early.rpc, {}, { skillName: SKILL, cwd: "C:\repo", developerInstructions: "", outputSchema: {},
    prepareInput: (input) => input, validateOutput: () => refuse("ONE_BAD_ITEM"), onAudit: () => {},
    keepEarly: (_rejection, output) => output as { v: number } });
  expect(early.turns()).toBe(1);
  expect(kept).toMatchObject({ ok: true, output: { v: 1 }, audit: { warnings: [{ code: "ONE_BAD_ITEM" }] } });

  const declined = fakeRuntime(['{"v":1}', '{"v":2}'], SKILL);
  let calls = 0;
  const repaired = await runCodexSkill<{ v: number }>(declined.rpc, {}, { skillName: SKILL, cwd: "C:\repo", developerInstructions: "", outputSchema: {},
    prepareInput: (input) => input, validateOutput: (output) => (output as { v: number }).v === 2 ? output as { v: number } : refuse("TOO_MUCH"),
    onAudit: () => {}, keepEarly: () => { calls += 1; return undefined; } });
  expect(declined.turns()).toBe(2);
  expect(calls).toBe(1);
  expect(repaired).toMatchObject({ ok: true, output: { v: 2 }, audit: { repairs: 1 } });
});
