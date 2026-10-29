import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { WEEKLY_COMMIT_SETTING } from "@crossline/core";
vi.mock("server-only", () => ({}));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn(async () => ({})), CodexSupervisorRequestError: class extends Error {} }));
import { applyWeeklyCommit, loadWeeklyCommit } from "./weekly-commit";
import { answerAsk, collectAsks } from "./asks";
import { undoOp, withUndo } from "./undo";
import { TEST_CTX } from "./test-support";

/** The weekly commitment on a real store (docs/rituals.md): the week's work against its hours, 保 / 推 / 砍 suggested and applied as one undo. */
afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); });

const ws = TEST_CTX.workspaceId, owner = TEST_CTX.principalId;
const MONDAY = new Date("2026-10-12T14:00:00.000Z");

function setup() {
  vi.stubEnv("CROSSLINE_FIXED_NOW", MONDAY.toISOString());
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  const order = (id: string, minutes: number, payload: Record<string, unknown>) => store.saveWorkOrder({ id, ownerId: owner, workspaceId: ws, identityId: "research",
    projectId: "p", milestoneId: "", intent: id, state: "approved", riskTier: "routine",
    estimate: { p25Minutes: minutes, p50Minutes: minutes, p85Minutes: minutes * 1.5, source: "llm_prior", observationCount: 0, confidence: "high" }, payload });
  order("first", 1200, { dueDate: "2026-10-14" });
  order("second", 1500, { dueDate: "2026-10-16" });
  order("stale", 60, { dueDate: "2026-10-01" });
  order("someday", 60, {});
  return store;
}

test("the week's work is what is due by Sunday, started or placed this week; what does not fit is pushed and week-old untouched work is cut", () => {
  setup();
  const view = loadWeeklyCommit(TEST_CTX, MONDAY);
  expect(view).toMatchObject({ week: "2026-10-12", weekEnd: "2026-10-18", due: "weekly" });
  expect(view.capacityMinutes).toBeGreaterThan(1200);
  expect(view.capacityMinutes).toBeLessThan(2700);
  expect(view.demandMinutes).toBe(2760);
  expect(Object.fromEntries(view.rows.map((row) => [row.id, row.suggestion.group]))).toEqual({ first: "keep", second: "defer", stale: "drop" });
  expect(view.rows.find((row) => row.id === "stale")).toMatchObject({ overdueDays: 11, suggestion: { reason: "stale" } });
  const ask = collectAsks(TEST_CTX, MONDAY).find((item) => item.kind === "weekly_commit")!;
  expect(ask.options.map((option) => option.id)).toEqual(["suggested", "review", "keep"]);
  expect(ask.why).toContain("推 1 项");
});

test("「确认本周」 pushes, cuts and records in one undo; the week is not asked about again until it overloads anew", async () => {
  const store = setup();
  const result = await withUndo(TEST_CTX, "确认本周承诺", () => applyWeeklyCommit(TEST_CTX, { first: "keep" }, { now: MONDAY }));
  expect(result).toMatchObject({ ok: true, deferred: 1, dropped: 1 });
  const byId = (id: string) => store.listWorkOrders(ws).find((order) => order.id === id)!;
  expect(byId("second").payload).toMatchObject({ notBefore: "2026-10-19", dueDate: "2026-10-25" });
  expect(byId("stale").state).toBe("archived");
  expect(JSON.parse(store.getSetting(ws, WEEKLY_COMMIT_SETTING)!)).toMatchObject({ week: "2026-10-12", demandMinutes: 1200 });
  expect(collectAsks(TEST_CTX, MONDAY).some((item) => item.kind === "weekly_commit")).toBe(false);
  expect(undoOp(TEST_CTX, result.op!.id)).toMatchObject({ ok: true });
  expect(byId("second").payload).toEqual({ dueDate: "2026-10-16" });
  expect(byId("stale").state).toBe("approved");
  expect(store.getSetting(ws, WEEKLY_COMMIT_SETTING)).toBeFalsy();
});

test("「按建议确认」 on the card applies the suggestion; 「这周不调整」 keeps everything and counts the week as committed", async () => {
  const store = setup();
  const ask = collectAsks(TEST_CTX, MONDAY).find((item) => item.kind === "weekly_commit")!;
  expect(await answerAsk(TEST_CTX, ask.id, "keep", {}, MONDAY)).toMatchObject({ ok: true });
  expect(store.listWorkOrders(ws).every((order) => order.state === "approved")).toBe(true);
  expect(JSON.parse(store.getSetting(ws, WEEKLY_COMMIT_SETTING)!)).toMatchObject({ week: "2026-10-12", demandMinutes: 2760 });
  // Committed while over: the same overload is not asked about again.
  expect(collectAsks(TEST_CTX, MONDAY).some((item) => item.kind === "weekly_commit")).toBe(false);
  expect(applyWeeklyCommit(TEST_CTX, { first: "sideways" }, { now: MONDAY })).toEqual({ ok: false, code: "COMMIT_GROUP_INVALID" });
});

test("last week's line reads that week's commitment; a week with no commitment and nothing finished shows no line", () => {
  const store = setup();
  expect(loadWeeklyCommit(TEST_CTX, MONDAY).lastWeek).toBeUndefined();
  store.appendEvent({ ownerId: owner, workspaceId: ws, idempotencyKey: "week.committed:prev", type: "week.committed", entityId: ws,
    payload: { week: "2026-10-05", capacityMinutes: 1800, demandMinutes: 2000, keptMinutes: 1500, deferred: 2, dropped: 1, reason: "weekly" } });
  expect(loadWeeklyCommit(TEST_CTX, MONDAY).lastWeek).toMatchObject({ week: "2026-10-05", committed: true, keptMinutes: 1500, deferred: 2, dropped: 1 });
});
