import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { ruleMode } from "../packages/core/src/index";
import { ablate, extractGolden, firingsOf, type GoldenCase, type LedgerEvent } from "./eval-lib";
import { summarize } from "./pass-k";

const event = (eventId: string, type: string, entityId: string, payload: unknown, createdAt = "2026-11-20T00:00:00Z"): LedgerEvent => ({ eventId, type, entityId, payload, createdAt });

test("the person's corrections become golden cases, each with what the system said and what the person made of it", () => {
  const orders = new Map([
    ["wo-1", { id: "wo-1", intent: "写周报", payload: { title: "写第 47 周周报" } }],
    ["wo-2", { id: "wo-2", intent: "期中考试", payload: { completionMode: "needs_assessment" } }],
    ["wo-3", { id: "wo-3", intent: "交作业", payload: { completionMode: "self_evident", completion: { mode: "needs_assessment" } } }]
  ]);
  const cases = extractGolden([
    event("e1", "op.applied", "op-1", { label: "把任务移到明天", inverse: { kind: "work_order.restore", ids: ["wo-1"] }, bySystem: true }),
    event("e2", "op.undone", "op-1", { label: "把任务移到明天" }),
    event("e3", "gate.judged", "wo-1", { gate: "completion", output: { verdict: "done", reason: "有提交记录" } }),
    event("e4", "gate.changed", "wo-1", { judgedId: "e3", gate: "completion", subject: { kind: "task", id: "wo-1" }, from: "done", to: "not_done", note: "只交了一半", change: "overridden" }),
    event("e5", "person.decided", "wo-1", { stepId: null, before: 60, after: 120, subject: "estimate", decision: "adjusted" }),
    event("e6", "work_order.changed", "wo-1", { before: "2026-11-21", after: "2026-11-24", change: "due_changed" }),
    event("e7", "goal.changed", "m-1", { milestoneVersion: 2, change: "backplan_declined" }),
    event("e8", "task.changed", "wo-1", { by: "system", before: "a", title: "b", change: "renamed" }),
    event("e9", "task.changed", "wo-1", { by: "person", before: "写周报", title: "写第 47 周周报", change: "renamed" })
  ], orders);
  const byKind = Object.fromEntries(cases.map((item) => [item.kind === "completion" ? item.id : item.kind, item]));
  expect(byKind.undo).toMatchObject({ bySystem: true, personSaid: "undone", modelSaid: { kind: "work_order.restore" } });
  expect(byKind.gate).toMatchObject({ modelSaid: { verdict: "done", reason: "有提交记录" }, personSaid: "not_done", note: "只交了一半" });
  expect(byKind.duration).toMatchObject({ modelSaid: 60, personSaid: 120, context: { title: "写第 47 周周报" } });
  expect(byKind.date).toMatchObject({ modelSaid: "2026-11-21", personSaid: "2026-11-24" });
  expect(byKind.reject).toMatchObject({ source: "goal.changed:backplan_declined", personSaid: "rejected" });
  expect(cases.filter((item) => item.kind === "rename")).toHaveLength(1);
  expect(byKind["completion:wo-2"]).toMatchObject({ modelSaid: null, personSaid: "needs_assessment" });
  expect(byKind["completion:wo-3"]).toMatchObject({ modelSaid: "needs_assessment", personSaid: "self_evident" });
});

test("an ablation replays a fallback with and without its verdict and leaves the modes as they were", () => {
  const example = JSON.parse(readFileSync(path.join(import.meta.dirname, "../apps/worker/src/testing/golden/example-completion.json"), "utf8")) as { cases: GoldenCase[] };
  const report = ablate("completion.legacy-title", { golden: example.cases, fixtures: {} });
  expect(report).toMatchObject({ samples: 3, labelled: 3, changed: 2, agreeEnforce: 2, agreeRecord: 2 });
  expect(ruleMode("completion.legacy-title")).toBe("fallback");
  expect(ablate("money.veto", { golden: [], fixtures: {} })).toMatchObject({ refused: expect.stringContaining("never ablated") });
  expect(ablate("rough.window", { golden: [], fixtures: {} })).toMatchObject({ refused: expect.stringContaining("no ablation") });
});

test("firings are counted per rule and verdict from the telemetry lines", () => {
  const lines = [
    JSON.stringify({ type: "rule.fired", at: "2026-11-25T02:00:00Z", id: "completion.legacy-title", verdict: "quality", applied: true }),
    JSON.stringify({ type: "rule.fired", at: "2026-11-25T01:00:00Z", id: "completion.legacy-title", verdict: "quality", applied: false }),
    JSON.stringify({ type: "rule.fired", at: "2026-11-25T03:00:00Z", id: "rough.starts-words", verdict: "start", applied: true }),
    "not json"
  ];
  expect(firingsOf(lines, "completion.legacy-title")).toEqual({ total: 2, applied: 1, byVerdict: { quality: 2 }, since: "2026-11-25T01:00:00Z" });
});

test("pass^k counts a case only when all k runs pass; disagreement is any case whose k decisions differ", () => {
  const report = summarize("mail", 3, [
    { suite: "mail", name: "a", runs: [{ decision: "x", pass: true }, { decision: "x", pass: true }, { decision: "x", pass: true }], allPass: true, agree: true },
    { suite: "mail", name: "b", runs: [{ decision: "x", pass: true }, { decision: "y", pass: false }, { decision: "x", pass: true }], allPass: false, agree: false },
    { suite: "mail", name: "c", runs: [{ decision: "z", pass: false }, { decision: "z", pass: false }, { decision: "z", pass: false }], allPass: false, agree: true }
  ]);
  expect(report).toMatchObject({ cases: 3, passK: 0.333, pass1: 0.556, disagreement: 0.333 });
  expect(report.examples.map((item) => item.name)).toEqual(["b", "c"]);
});
