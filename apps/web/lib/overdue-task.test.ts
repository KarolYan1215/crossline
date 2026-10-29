import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn(async () => ({})), CodexSupervisorRequestError: class extends Error {} }));
import { answerAsk, collectAsks } from "./asks";
import { TEST_CTX } from "./test-support";

/** Started work past an external due day is asked about, not moved (docs/plans/closed-loop-1030.md §4). */
afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); });

const ws = TEST_CTX.workspaceId, owner = TEST_CTX.principalId;
const NOW = new Date("2026-11-05T15:00:00.000Z");
const estimate = { p25Minutes: 60, p50Minutes: 60, p85Minutes: 90, source: "llm_prior" as const, observationCount: 0, confidence: "high" as const };

function setup() {
  vi.stubEnv("CROSSLINE_FIXED_NOW", NOW.toISOString());
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  const order = (id: string, projectId: string, due: string, state: "active" | "approved") => store.saveWorkOrder({ id, ownerId: owner, workspaceId: ws, identityId: "research",
    projectId, milestoneId: "", intent: id, state, riskTier: "routine", estimate, payload: { dueDate: due } });
  order("hw3", "ece555", "2026-11-02", "active");
  order("notstarted", "ece555", "2026-11-02", "approved");
  order("later", "ece555", "2026-11-20", "active");
  store.appendEvent({ ownerId: owner, workspaceId: ws, idempotencyKey: "batch", type: "dates.extracted", entityId: "batch", payload: { dates: [{ project: "ece555", kind: "homework_due" }] } });
  return store;
}

test("a started course homework past its due day is asked: can it still be handed in, by when; the date given is the new due day", async () => {
  const store = setup();
  const asks = collectAsks(TEST_CTX, NOW).filter((ask) => ask.kind === "overdue_task");
  expect(asks.map((ask) => ask.entityId)).toEqual(["hw3"]);
  expect(asks[0]!.options.map((option) => option.id)).toEqual(["extend", "drop"]);
  expect(await answerAsk(TEST_CTX, asks[0]!.id, { optionIds: ["extend"] }, { date: "2026-11-08" }, NOW)).toMatchObject({ ok: true });
  expect(store.getWorkOrder(ws, "hw3")!.payload).toMatchObject({ dueDate: "2026-11-08" });
  expect(collectAsks(TEST_CTX, NOW).some((ask) => ask.kind === "overdue_task")).toBe(false);
});

test("不能补交 archives the task (recoverable)", async () => {
  const store = setup();
  const ask = collectAsks(TEST_CTX, NOW).find((item) => item.kind === "overdue_task")!;
  expect(await answerAsk(TEST_CTX, ask.id, { optionIds: ["drop"] }, {}, NOW)).toMatchObject({ ok: true });
  expect(store.getWorkOrder(ws, "hw3")!.state).toBe("archived");
});
