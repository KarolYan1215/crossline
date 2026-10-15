import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore, type StepPlanInput } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { loadCurrentPlan, toZonedInstant } from "./crossline";
import { nudgesFor, seenBlocksKey } from "./nudges";
import { confirmBlock, confirmView } from "./confirm";
import { TEST_CTX } from "./test-support";

/**
 * The completion check end to end on a real store: the scheduler places an ECE task's steps, the nudge pass sees a block under way,
 * asks once it has ended, and one tap writes the session, the step and — on the last step — the task and its duration observation.
 */
afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); });

const ws = TEST_CTX.workspaceId;
const ZONE = "America/Chicago";
const DAY = "2026-10-12"; // a Monday; the default pattern's hours start at 09:00
const estimate = { p25Minutes: 40, p50Minutes: 60, p85Minutes: 90, source: "llm_prior" as const, observationCount: 0, confidence: "high" as const };
const step = (id: string, title: string, dependsOn: string[] = []) => ({ id, role: "solve", title, deliverable: "解答", doneCriterion: "写完",
  share: 0.5, estimate: { p25Minutes: 30, p50Minutes: 45, p85Minutes: 60 }, dependsOn, notBefore: "", dueBy: "", schedulable: true, executor: "human" as const, tickOutcome: "" });
const plan = (steps: StepPlanInput["steps"]): StepPlanInput => ({ archetypeId: "problem_set", quantity: { basis: "题目数", amount: 4, unit: "题" }, rationale: "按题拆分", steps });

function setup(options: { milestoneId?: string; family?: string | null; steps?: number } = {}) {
  const at = (clock: string) => { vi.stubEnv("CROSSLINE_FIXED_NOW", toZonedInstant(DAY, clock, ZONE)); return new Date(toZonedInstant(DAY, clock, ZONE)); };
  at("08:30");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.saveWorkOrder({ id: "ece555-hw3", ownerId: TEST_CTX.principalId, workspaceId: ws, identityId: "research", projectId: "ece555",
    milestoneId: options.milestoneId ?? "", intent: "完成 ECE 555 作业 3", state: "approved", riskTier: "routine", estimate,
    payload: { dueDate: "2026-10-14", materialContract: [], ...(options.family === null ? {} : { family: options.family ?? "deep_work" }) } });
  const steps = [step("s1", "推导第 1–2 题"), step("s2", "推导第 3–4 题", ["s1"])].slice(0, options.steps ?? 2);
  store.saveStepPlan(ws, "ece555-hw3", plan(steps), TEST_CTX.principalId, "initial");
  return { store, at };
}

/** The first block of the task today, seen under way and then asked about after it ends: the confirm message's id and the block. */
async function askAboutFirstBlock(at: (clock: string) => Date) {
  const first = (await loadCurrentPlan(TEST_CTX)).blocks.filter((block) => block.id.startsWith("scheduled:ece555-hw3") && block.day === DAY)
    .sort((a, b) => a.start.localeCompare(b.start))[0]!;
  const plus = (clock: string, minutes: number) => { const total = Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3)) + minutes;
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`; };
  // As the two-minute pass does: once inside the commit window (the block is held at its time), once under way, once after its end.
  await nudgesFor(TEST_CTX, at(plus(first.start, -10)));
  await nudgesFor(TEST_CTX, at(plus(first.start, 1)));
  const said = await nudgesFor(TEST_CTX, at(plus(first.end, 2)));
  const confirm = said.find((item) => item.kind === "block_confirm");
  const store = globalThis.crosslineStore!;
  const message = store.listConversationMessages(ws, store.conversationFor(ws, DAY).id)
    .find((item) => (item.payload.nudge as { kind?: string } | undefined)?.kind === "block_confirm")!;
  return { first, confirm, message };
}

test("a block seen under way is asked about once after it ends; the question goes to the desktop and phone and opens the confirm page", async () => {
  const { store, at } = setup();
  const { first, confirm, message } = await askAboutFirstBlock(at);
  expect(confirm).toMatchObject({ kind: "block_confirm", block: { id: first.id, start: first.start, end: first.end } });
  expect(message.payload.nudge).toMatchObject({ kind: "block_confirm", delivery: "pending", block: { id: first.id } });
  const card = message.payload.card as { clarify: { options: Array<{ href?: string }> } };
  expect(card.clarify.options[0]!.href).toBe(`/confirm/${message.id}`);
  expect(JSON.parse(store.getSetting(ws, seenBlocksKey(DAY))!)[first.id]).toMatchObject({ began: true });
  // Asked once.
  expect((await nudgesFor(TEST_CTX, at("23:00"))).filter((item) => item.kind === "block_confirm")).toEqual([]);
});

test("a step that is not the last: 「超出预估 · 30 分钟」 writes one closed session over the block and marks the step done", async () => {
  const { store, at } = setup();
  const { first, message } = await askAboutFirstBlock(at);
  const view = confirmView(TEST_CTX, message.id)!;
  expect(view).toMatchObject({ title: "完成 ECE 555 作业 3", lastStep: false, milestoneBound: false });
  const outcome = confirmBlock(TEST_CTX, message.id, { kind: "over", minutes: 30 });
  expect(outcome).toEqual({ ok: true, done: "step", minutes: view.blockMinutes + 30 });
  const [session] = store.listExecutions(ws, "ece555-hw3");
  expect(session).toMatchObject({ startedAt: toZonedInstant(DAY, first.start, ZONE), endedAt: toZonedInstant(DAY, first.end, ZONE), outcome: "confirmed" });
  expect(store.getStepPlan(ws, "ece555-hw3")!.steps.find((item) => item.id === first.id.split(":")[2])!.status).toBe("done");
  expect(store.listWorkOrders(ws)[0]!.state).toBe("approved");
  // The same answer twice writes once.
  expect(confirmBlock(TEST_CTX, message.id, { kind: "over", minutes: 30 })).toMatchObject({ ok: true, already: true });
  expect(store.listExecutions(ws, "ece555-hw3")).toHaveLength(1);
  expect(confirmView(TEST_CTX, message.id)!.answered).toMatchObject({ outcome: "over", minutes: view.blockMinutes + 30 });
});

test("the last step finishes the task: accepted at once, with a one-tap duration observation", async () => {
  const { store, at } = setup({ steps: 1 });
  const { message } = await askAboutFirstBlock(at);
  expect(confirmView(TEST_CTX, message.id)!.lastStep).toBe(true);
  const outcome = confirmBlock(TEST_CTX, message.id, { kind: "as_planned" });
  expect(outcome).toMatchObject({ ok: true, done: "task" });
  expect(outcome).not.toHaveProperty("needsEvidence");
  expect(store.listWorkOrders(ws)[0]!.state).toBe("accepted");
  expect(store.listDurationObservations(ws, "research", "deep_work")[0]).toMatchObject({ actualSource: "one_tap", observedMinutes: (outcome as { minutes: number }).minutes });
});

test("a milestone-bound last step with no evidence is accepted all the same (2026-10-15); a task with no family still leaves an observation", async () => {
  const { store, at } = setup({ steps: 1, milestoneId: "ece555-hw-series", family: null });
  const { message } = await askAboutFirstBlock(at);
  const outcome = confirmBlock(TEST_CTX, message.id, { kind: "under", minutes: 15 });
  expect(outcome).toMatchObject({ ok: true, done: "task" });
  expect(outcome).not.toHaveProperty("needsEvidence");
  expect(store.listWorkOrders(ws)[0]).toMatchObject({ state: "accepted", payload: expect.objectContaining({ family: "preparation" }) });
  expect(store.listDurationObservations(ws, "research", "preparation")).toHaveLength(1);
});

test("未执行 writes no session and moves nothing", async () => {
  const { store, at } = setup();
  const { message } = await askAboutFirstBlock(at);
  expect(confirmBlock(TEST_CTX, message.id, { kind: "not_done" })).toEqual({ ok: true, done: "not_done" });
  expect(store.listExecutions(ws, "ece555-hw3")).toEqual([]);
  expect(store.getStepPlan(ws, "ece555-hw3")!.steps.every((item) => item.status === "planned")).toBe(true);
  expect(store.listEvents(ws, { type: "block.confirmed" })[0]!.payload).toMatchObject({ outcome: "not_done" });
});

test("a block moved elsewhere before it began is never asked about", async () => {
  const { store, at } = setup();
  await nudgesFor(TEST_CTX, at("08:30"));
  const seen = JSON.parse(store.getSetting(ws, seenBlocksKey(DAY)) ?? "{}") as Record<string, { began: boolean }>;
  expect(Object.values(seen).every((item) => !item.began)).toBe(true);
  store.saveWorkOrder({ ...store.listWorkOrders(ws)[0]!, state: "archived" });
  expect((await nudgesFor(TEST_CTX, at("21:00"))).filter((item) => item.kind === "block_confirm")).toEqual([]);
});
