import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore, type StepPlanInput } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { loadCurrentPlan, toZonedInstant } from "./crossline";
import { nudgesFor } from "./nudges";
import { answerWrapBlock, finishWrap, loadWrap } from "./wrap";
import { TEST_CTX } from "./test-support";

/**
 * The evening wrap-up end to end (docs/rituals.md): a block of work not due by tomorrow is not asked about on its own when it ends; the
 * day's one wrap-up message comes at the end of the last available hours, and one tap per block writes what the completion check writes.
 */
afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); });

const ws = TEST_CTX.workspaceId;
const ZONE = "America/Chicago";
const DAY = "2026-10-12";
const estimate = { p25Minutes: 40, p50Minutes: 60, p85Minutes: 90, source: "llm_prior" as const, observationCount: 0, confidence: "high" as const };
const step = (id: string, title: string, dependsOn: string[] = []) => ({ id, role: "solve", title, deliverable: "解答", doneCriterion: "写完",
  share: 0.5, estimate: { p25Minutes: 30, p50Minutes: 45, p85Minutes: 60 }, dependsOn, notBefore: "", dueBy: "", schedulable: true, executor: "human" as const, tickOutcome: "" });
const plan = (steps: StepPlanInput["steps"]): StepPlanInput => ({ archetypeId: "problem_set", quantity: { basis: "题目数", amount: 4, unit: "题" }, rationale: "按题拆分", steps });
const at = (clock: string) => { vi.stubEnv("CROSSLINE_FIXED_NOW", toZonedInstant(DAY, clock, ZONE)); return new Date(toZonedInstant(DAY, clock, ZONE)); };
const plus = (clock: string, minutes: number) => { const total = Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3)) + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`; };

test("`/wrap?day=` reaches back seven days and no further, and an earlier day's block is written under that day's key", async () => {
  at("08:30");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.saveWorkOrder({ id: "hw", ownerId: TEST_CTX.principalId, workspaceId: ws, identityId: "research", projectId: "ece555", milestoneId: "",
    intent: "完成 ECE 555 作业 3", state: "approved", riskTier: "routine", estimate, payload: { dueDate: "2026-10-16", materialContract: [], family: "deep_work" } });
  store.saveStepPlan(ws, "hw", plan([step("s1", "推导第 1–2 题"), step("s2", "推导第 3–4 题", ["s1"])]), TEST_CTX.principalId, "initial");
  const first = (await loadCurrentPlan(TEST_CTX)).blocks.filter((block) => block.id.startsWith("scheduled:hw") && block.day === DAY)
    .sort((a, b) => a.start.localeCompare(b.start))[0]!;
  await nudgesFor(TEST_CTX, at(plus(first.start, -10)));
  await nudgesFor(TEST_CTX, at(plus(first.start, 1)));

  // The next morning: today's own wrap-up is empty, yesterday's still holds the block, with its line.
  const nextMorning = new Date(Date.parse(toZonedInstant("2026-10-13", "09:00", ZONE)));
  vi.stubEnv("CROSSLINE_FIXED_NOW", nextMorning.toISOString());
  const { wrapDayOf } = await import("./wrap");
  expect(wrapDayOf(TEST_CTX, DAY, nextMorning)).toBe(DAY);
  expect(wrapDayOf(TEST_CTX, "2026-10-05", nextMorning)).toBe("2026-10-13");
  expect(wrapDayOf(TEST_CTX, "2026-10-06", nextMorning)).toBe("2026-10-06");
  expect(wrapDayOf(TEST_CTX, "2026-10-14", nextMorning)).toBe("2026-10-13");
  expect(wrapDayOf(TEST_CTX, "nonsense", nextMorning)).toBe("2026-10-13");
  expect(loadWrap(TEST_CTX, nextMorning).rows).toEqual([]);
  const yesterday = loadWrap(TEST_CTX, nextMorning, DAY);
  expect(yesterday).toMatchObject({ day: DAY, today: false, open: 1 });
  expect(yesterday.rows).toEqual([expect.objectContaining({ blockId: first.id, line: "research", timedMinutes: 0 })]);

  expect(answerWrapBlock(TEST_CTX, first.id, "not_done", nextMorning, DAY)).toMatchObject({ ok: true, done: "not_done" });
  expect(store.listEvents(ws, { type: "block.confirmed" })).toEqual([expect.objectContaining({ entityId: `wrap:${DAY}:${first.id}`,
    payload: expect.objectContaining({ blockId: first.id, day: DAY, outcome: "not_done" }) })]);
  expect(loadWrap(TEST_CTX, nextMorning, DAY).open).toBe(0);
});

test("a block due later waits for the wrap-up; 部分 keeps the step open with half done, and 收工 ends the day's message", async () => {
  at("08:30");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.saveWorkOrder({ id: "hw", ownerId: TEST_CTX.principalId, workspaceId: ws, identityId: "research", projectId: "ece555", milestoneId: "",
    intent: "完成 ECE 555 作业 3", state: "approved", riskTier: "routine", estimate, payload: { dueDate: "2026-10-16", materialContract: [], family: "deep_work" } });
  store.saveStepPlan(ws, "hw", plan([step("s1", "推导第 1–2 题"), step("s2", "推导第 3–4 题", ["s1"])]), TEST_CTX.principalId, "initial");
  const first = (await loadCurrentPlan(TEST_CTX)).blocks.filter((block) => block.id.startsWith("scheduled:hw") && block.day === DAY)
    .sort((a, b) => a.start.localeCompare(b.start))[0]!;
  await nudgesFor(TEST_CTX, at(plus(first.start, -10)));
  await nudgesFor(TEST_CTX, at(plus(first.start, 1)));
  expect((await nudgesFor(TEST_CTX, at(plus(first.end, 2)))).map((item) => item.kind)).not.toContain("block_confirm");

  const view = loadWrap(TEST_CTX, at(plus(first.end, 2)));
  expect(view.rows).toEqual([expect.objectContaining({ blockId: first.id, orderId: "hw", start: first.start, end: first.end })]);
  expect(view).toMatchObject({ open: 1, done: false });
  expect(view.at).toBeTruthy();
  const wrapped = await nudgesFor(TEST_CTX, at(plus(view.at!, 5)));
  expect(wrapped.filter((item) => item.kind === "day_wrap")).toHaveLength(1);

  expect(answerWrapBlock(TEST_CTX, first.id, "partial", at(plus(view.at!, 6)))).toMatchObject({ ok: true, done: "partial" });
  expect(store.listEvents(ws, { type: "block.confirmed" }).map((event) => event.payload)).toEqual([expect.objectContaining({ blockId: first.id, day: DAY, outcome: "partial" })]);
  const stepId = first.id.split(":")[2]!;
  expect(store.getStepPlan(ws, "hw")!.steps.find((item) => item.id === stepId)).toMatchObject({ status: "planned", progressQuarter: 2 });
  expect(store.listExecutions(ws, "hw")).toHaveLength(1);
  // Once: a second tap writes nothing more.
  expect(answerWrapBlock(TEST_CTX, first.id, "done", at(plus(view.at!, 7)))).toMatchObject({ ok: true, already: true });
  expect(store.listEvents(ws, { type: "block.confirmed" })).toHaveLength(1);
  expect(loadWrap(TEST_CTX, at(plus(view.at!, 7))).open).toBe(0);

  finishWrap(TEST_CTX, at(plus(view.at!, 8)));
  expect(loadWrap(TEST_CTX, at(plus(view.at!, 8))).done).toBe(true);
  expect(answerWrapBlock(TEST_CTX, "scheduled:none", "done", at(plus(view.at!, 9)))).toMatchObject({ ok: false, code: "CONFIRM_NOT_FOUND" });
});
