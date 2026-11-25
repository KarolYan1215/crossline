import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { AGENT_HISTORY_SUMMARY, GATE_ATTEMPTED, GATE_JUDGED, GATE_OVERRIDDEN, MILESTONE_PARKED, type GateJudgedPayload, type StoredFormRun } from "@crossline/core";
import { fakeRuntime } from "../testing/fake-runtime";
import { admissionGatePass } from "./admission";
import { attentionBlocks, attentionHours } from "./attention";
import { previousWeek } from "./context";
import { COMPLETION_SKILL, completionGatePass } from "./completion";
import { FRONT_SKILL, frontDue, frontGatePass } from "./front";
import { NIGHT_HOLD, nightHoldForForm } from "./night";
import { PRIORITY_SKILL, priorityGatePass } from "./priority";

/** The execution gates' worker passes (docs/plans/execution-gates-1124.md §四), against the shared Codex fake. */
let store: CrosslineStore;
let ws: string;
const NOW = new Date("2026-11-24T15:00:00.000Z");
const estimate = { p25Minutes: 40, p50Minutes: 60, p85Minutes: 90, source: "llm_prior" as const, observationCount: 0, confidence: "high" as const };
const order = (id: string, extra: { milestoneId?: string; state?: string; payload?: Record<string, unknown> } = {}) => store.saveWorkOrder({ id, ownerId: "user-1", workspaceId: ws,
  identityId: "research", projectId: "paper", milestoneId: extra.milestoneId ?? "", intent: id, state: extra.state ?? "approved", riskTier: "routine", estimate, payload: extra.payload ?? {} });
const item = (subject: string, verdict: string, detail: Record<string, unknown> = {}, ifWrong = { harm: "quality", fixable: "before_step" }) =>
  ({ subject, verdict, confidence: "medium", evidence: [{ kind: "event", ref: subject, quote: subject, at: NOW.toISOString() }], reason: "理由", ifWrong, detail });
const judged = (gate: string) => store.listEvents(ws, { type: GATE_JUDGED }).map((event) => event.payload as GateJudgedPayload).filter((payload) => payload.gate === gate);

beforeEach(() => {
  store = new CrosslineStore(":memory:");
  ws = store.createPrincipalWithWorkspace("user-1", "个人 workspace").workspace.id;
});
afterEach(() => store.close());

test("a P1 outward task is judged twice with the evidence reversed; when the runs disagree the judgement is put to the person", async () => {
  order("send-draft"); order("read-paper");
  const priority = fakeRuntime([JSON.stringify({ items: [item("send-draft", "p1_external"), item("read-paper", "normal")] })], `crossline:${PRIORITY_SKILL}`);
  expect(await priorityGatePass({ store, workspaceId: ws, client: priority.rpc, cwd: "C:\\repo", now: NOW })).toHaveLength(2);

  const first = JSON.stringify({ items: [item("send-draft", "done", { waitingOn: "", criteriaMet: [] }, { harm: "external", fixable: "after_submit" })] });
  const second = JSON.stringify({ items: [item("send-draft", "planned", { waitingOn: "", criteriaMet: [] }, { harm: "external", fixable: "after_submit" })] });
  const runtime = fakeRuntime([first, second], `crossline:${COMPLETION_SKILL}`);
  const results = await completionGatePass({ store, workspaceId: ws, client: runtime.rpc, cwd: "C:\\repo", now: NOW, full: true });
  expect(runtime.turns()).toBe(2);
  // The model never sees the task's state or whether the person pressed 完成.
  expect(runtime.prompts()[0]).not.toContain("\"state\"");
  expect(runtime.prompts()[0]).not.toContain("human.completed");
  expect(results.find((result) => result.subject.id === "send-draft")).toMatchObject({ disagrees: true, asked: true });
  const runs = judged("completion").filter((payload) => payload.subject.id === "send-draft");
  expect(runs.map((payload) => [payload.run, payload.output.verdict])).toEqual([[1, "done"], [2, "planned"]]);
  expect(runs[1]).toMatchObject({ disagrees: true, promptVersion: "crossline.gate.completion.v1" });
  expect(runs[0]!.inputDigest.sha256).toMatch(/^[0-9a-f]{64}$/);
});

test("a milestone in series with an open one is parked: back to draft, its unstarted worked-back tasks put away, one undo", async () => {
  const milestone = (id: string, status: "approved" | "draft") => store.saveMilestone({ id, ownerId: "user-1", workspaceId: ws, identityId: "research", projectId: "paper", title: id, version: 1, status });
  milestone("first", "approved");
  // The first pass only records what was approved before the gate existed.
  const idle = fakeRuntime([JSON.stringify({ items: [] })], "crossline:crossline-gate-admission");
  expect(await admissionGatePass({ store, workspaceId: ws, client: idle.rpc, cwd: "C:\\repo", now: NOW })).toEqual([]);
  expect(idle.turns()).toBe(0);

  milestone("second", "approved");
  order("second-step", { milestoneId: "second", payload: { backplan: { milestoneId: "second" } } });
  const runtime = fakeRuntime([JSON.stringify({ items: [item("second", "park", { closeOrPark: "", unparkWhen: "first" })] })], "crossline:crossline-gate-admission");
  const results = await admissionGatePass({ store, workspaceId: ws, client: runtime.rpc, cwd: "C:\\repo", now: NOW });
  expect(results.map((result) => result.output.verdict)).toEqual(["park"]);
  expect(store.listMilestones(ws).find((item) => item.id === "second")!.status).toBe("draft");
  expect(store.listWorkOrders(ws).find((item) => item.id === "second-step")!.state).toBe("archived");
  expect(store.listEvents(ws, { type: MILESTONE_PARKED })[0]!.payload).toMatchObject({ milestoneId: "second", unparkWhen: "first", archivedTasks: ["second-step"] });
  const op = store.listEvents(ws, { type: "op.applied" }).at(-1)!.payload as { bySystem: boolean; inverse: { kind: string; items: Array<{ kind: string }> } };
  expect(op.bySystem).toBe(true);
  expect(op.inverse.items.map((entry) => entry.kind)).toEqual(["milestones.status", "work_order.restore"]);
  // Judged once: the next pass asks nothing.
  expect(await admissionGatePass({ store, workspaceId: ws, client: runtime.rpc, cwd: "C:\\repo", now: NOW })).toEqual([]);
});

test("the attention audit counts a minute once (timer, then agent, then screen) and sums hours from the model's classes", () => {
  order("paper-draft");
  const week = previousWeek(NOW);
  const at = (hours: number) => new Date(week.from.getTime() + hours * 3_600_000).toISOString();
  store.recordInferredSession(ws, "paper-draft", "user-1", { startedAt: at(10), endedAt: at(11), minutes: 60, key: "s1" });
  store.setSetting(ws, AGENT_HISTORY_SUMMARY, JSON.stringify({ folderSpans: [{ folder: "Multi-ID", tool: "claude", start: at(10.5), end: at(12) }] }));
  store.upsertDeviceActivitySegments(ws, [{ start: at(10), end: at(13), app: "Code", category: "work", idle: false, title: "page.tsx — Multi-ID" }], at(-100));
  const blocks = attentionBlocks(store, ws, week.from, week.until);
  expect(blocks.map((block) => [block.source, block.minutes])).toEqual([["timer", 60], ["screen", 60], ["agent", 60]]);
  const output = { verdict: "crowded_out", confidence: "medium" as const, evidence: [], reason: "", ifWrong: { harm: "quality" as const, fixable: "before_step" as const },
    detail: { classes: [{ id: blocks[0]!.id, class: "execution", crossline: false }, { id: blocks[2]!.id, class: "meta", crossline: true }], unclear: "" } };
  // The screen block the model left out counts as `other`.
  expect(attentionHours(blocks, output)).toMatchObject({ hours: { execution: 1, meta: 1, other: 1, outside_gate: 0 }, crossline: 1, totalHours: 3, unclassifiedHours: 1 });
});

test("a form is judged at night only: by day it goes, at night an irreversible or unjudged one waits for the morning", async () => {
  const run = { id: "form-1", host: "lu.ma", checklist: [{ pageNo: 1, field: "Email", source: "profile", shown: "a***@x" }],
    opportunity: { title: "Meetup", organizer: "Org", kind: "event", cost: null, consents: [] } } as unknown as StoredFormRun;
  const deps = (client: ReturnType<typeof fakeRuntime>["rpc"] | undefined, now: Date) => ({ store, workspaceId: ws, client, cwd: "C:\\repo", timeZone: "America/Chicago", now });
  const day = fakeRuntime([JSON.stringify({ items: [] })], "crossline:crossline-gate-night");
  expect(await nightHoldForForm(deps(day.rpc, new Date("2026-11-24T18:00:00.000Z")), run)).toBeUndefined();
  expect(day.turns()).toBe(0);
  const night = new Date("2026-11-24T08:30:00.000Z"); // 02:30 in Chicago
  expect(await nightHoldForForm(deps(undefined, night), run)).toBe(NIGHT_HOLD);
  const reversible = fakeRuntime([JSON.stringify({ items: [item("form-1", "reversible", { undo: "确认页可取消" })] })], "crossline:crossline-gate-night");
  expect(await nightHoldForForm(deps(reversible.rpc, night), run)).toBeUndefined();
  const irreversible = fakeRuntime([JSON.stringify({ items: [item("form-1", "irreversible", { undo: "" })] })], "crossline:crossline-gate-night");
  expect(await nightHoldForForm(deps(irreversible.rpc, new Date("2026-11-24T08:31:00.000Z")), run)).toBe(NIGHT_HOLD);
  // Without a known zone every submission is judged, as if at night.
  const unknown = fakeRuntime([JSON.stringify({ items: [item("form-1", "reversible", { undo: "确认页可取消" })] })], "crossline:crossline-gate-night");
  expect(await nightHoldForForm({ store, workspaceId: ws, client: unknown.rpc, cwd: "C:\repo", now: new Date("2026-11-24T18:02:00.000Z") }, run)).toBeUndefined();
  expect(unknown.turns()).toBe(1);
});

test("a gate call that gives no answer throws, is recorded, and stops for the day after three tries", async () => {
  order("send-draft");
  // Attempts are stamped with the wall clock, so this test runs on it.
  const now = new Date();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const broken = fakeRuntime(["not json"], `crossline:${PRIORITY_SKILL}`);
    await expect(priorityGatePass({ store, workspaceId: ws, client: broken.rpc, cwd: "C:\repo", now })).rejects.toThrow("GATE_RUN_FAILED");
  }
  expect(store.listEvents(ws, { type: GATE_ATTEMPTED })).toHaveLength(3);
  const fourth = fakeRuntime([JSON.stringify({ items: [item("send-draft", "p1")] })], `crossline:${PRIORITY_SKILL}`);
  expect(await priorityGatePass({ store, workspaceId: ws, client: fourth.rpc, cwd: "C:\repo", now })).toEqual([]);
  expect(fourth.turns()).toBe(0);
  // The next day it is tried again.
  const nextDay = fakeRuntime([JSON.stringify({ items: [item("send-draft", "p1")] })], `crossline:${PRIORITY_SKILL}`);
  expect(await priorityGatePass({ store, workspaceId: ws, client: nextDay.rpc, cwd: "C:\repo", now: new Date(now.getTime() + 86_400_000 + 60_000) })).toHaveLength(1);
});

test("today's front task is picked once a local day", async () => {
  order("email-office");
  const runtime = fakeRuntime([JSON.stringify({ items: [item("today", "front", { task: "email-office", minutes: 20, costOfDelay: "每晚一天，工作许可晚一天" })] })], `crossline:${FRONT_SKILL}`);
  expect(frontDue(store, ws, NOW, "America/Chicago")).toBe(true);
  await frontGatePass({ store, workspaceId: ws, client: runtime.rpc, cwd: "C:\\repo", timeZone: "America/Chicago", now: NOW });
  expect(judged("front")[0]).toMatchObject({ subject: { kind: "day", id: "2026-11-24" }, output: { verdict: "front", detail: { task: "email-office" } } });
  expect(frontDue(store, ws, NOW, "America/Chicago")).toBe(false);
});

test("the person's overrides of a gate ride along with its next run as calibration, not evidence", async () => {
  order("send-draft");
  const first = fakeRuntime([JSON.stringify({ items: [item("send-draft", "p1")] })], `crossline:${PRIORITY_SKILL}`);
  await priorityGatePass({ store, workspaceId: ws, client: first.rpc, cwd: "C:\repo", now: NOW });
  expect(first.prompts()[0]).not.toContain("corrections");
  const judgedId = store.listEvents(ws, { type: GATE_JUDGED })[0]!.eventId;
  store.appendEvent({ ownerId: "user-1", workspaceId: ws, type: GATE_OVERRIDDEN, entityId: judgedId, idempotencyKey: "o1",
    payload: { judgedId, gate: "priority", subject: { kind: "task", id: "send-draft" }, from: "p1", to: "p1_external", note: "要发给导师" } });
  order("read-paper");
  const next = fakeRuntime([JSON.stringify({ items: [item("read-paper", "normal")] })], `crossline:${PRIORITY_SKILL}`);
  await priorityGatePass({ store, workspaceId: ws, client: next.rpc, cwd: "C:\repo", now: new Date(NOW.getTime() + 8 * 86_400_000) });
  expect(next.prompts()[0]).toContain("\"corrections\"");
  expect(next.prompts()[0]).toContain("要发给导师");
});
