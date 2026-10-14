import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { DELAY_SETTING } from "@crossline/core";
vi.mock("server-only", () => ({}));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn(async () => ({})), CodexSupervisorRequestError: class extends Error {} }));
vi.mock("./capture-followups", () => ({ analyzeNewCapturesInBackground: vi.fn() }));
import { executeAction } from "./actions";
import { commitSoon, loadCurrentPlan, lockBlock, readFrozen, saveSchedulePreferences } from "./crossline";
import { TEST_CTX } from "./test-support";
import { recentOps, undoOp } from "./undo";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); });

const NOW = "2026-09-18T13:00:00.000Z"; // 08:00 in Chicago
const ALWAYS = [{ days: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "20:00", energy: "high" as const }];
const shift = (minutes: number) => ({ action: "schedule.shift" as const, summary: `后面都推 ${minutes} 分钟`, args: { minutes } });

// Chicago is UTC−5 in September.
const utc = (clock: string) => `2026-09-18T${String(Number(clock.slice(0, 2)) + 5).padStart(2, "0")}:${clock.slice(3, 5)}:00.000Z`;
const later = (clock: string, minutes: number) => { const total = Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5)) + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`; };
const seed = (store: CrosslineStore) => {
  saveSchedulePreferences(TEST_CTX, { timeZone: "America/Chicago", mode: "buffered", windows: ALWAYS, importance: {} });
  store.saveWorkOrder({ id: "hw", ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId, identityId: "research", projectId: "p", milestoneId: "",
    intent: "完成作业 2", state: "ready_for_human", riskTier: "routine",
    estimate: { p25Minutes: 60, p50Minutes: 90, p85Minutes: 120, source: "llm_prior", observationCount: 0, confidence: "low" }, payload: { dueDate: "2026-09-19" } });
};
const hwBlocks = async () => (await loadCurrentPlan(TEST_CTX)).blocks.filter((block) => block.id.startsWith("scheduled:hw") && block.day === "2026-09-18");

test("「后面都推 30 分钟」: the block about to start moves, nothing new is placed before then, and 撤销 puts it all back", async () => {
  vi.stubEnv("CROSSLINE_FIXED_NOW", NOW);
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  seed(store);
  const first = (await hwBlocks())[0]!;
  // Five minutes before it starts: the commit window holds it.
  const now = new Date(Date.parse(utc(first.start)) - 5 * 60_000);
  vi.stubEnv("CROSSLINE_FIXED_NOW", now.toISOString());
  expect((await hwBlocks())[0]).toMatchObject({ id: first.id, start: first.start });
  expect(commitSoon(TEST_CTX, [first], now)).toBe(1);

  expect(await executeAction(TEST_CTX, shift(10.5))).toMatchObject({ ok: false });
  expect(await executeAction(TEST_CTX, shift(30))).toMatchObject({ ok: true, message: "今天之后的安排顺延 30 分钟" });
  expect(readFrozen(TEST_CTX, now)[0]).toMatchObject({ blockId: first.id, reason: "commit", start: utc(later(first.start, 30)) });
  expect(store.getSetting(TEST_CTX.workspaceId, DELAY_SETTING)).toBe(new Date(now.getTime() + 30 * 60_000).toISOString());
  const shifted = await hwBlocks();
  expect(shifted.find((block) => block.id === first.id)).toMatchObject({ start: later(first.start, 30) });
  // Nothing new before the delay ends (five minutes before the old start, plus thirty).
  expect(shifted.every((block) => block.start >= later(first.start, 25))).toBe(true);

  const [op] = recentOps(TEST_CTX);
  expect(op?.label).toContain("整体顺延");
  expect(undoOp(TEST_CTX, op!.id)).toMatchObject({ ok: true });
  expect(store.getSetting(TEST_CTX.workspaceId, DELAY_SETTING)).toBeUndefined();
  expect(readFrozen(TEST_CTX, now)[0]).toMatchObject({ blockId: first.id, start: utc(first.start) });
  expect((await hwBlocks()).find((block) => block.id === first.id)).toMatchObject({ start: first.start });
});

test("a block the person started stays where it is; only the rest of the day moves", async () => {
  vi.stubEnv("CROSSLINE_FIXED_NOW", NOW);
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  seed(store);
  const first = (await hwBlocks())[0]!;
  expect(lockBlock(TEST_CTX, first.id, { day: first.day!, start: first.start, end: first.end }, "pinned")).toEqual({ ok: true });
  expect(await executeAction(TEST_CTX, shift(15))).toMatchObject({ ok: true, message: "今天之后的安排顺延 15 分钟，已锁定的 1 块不动" });
  expect(readFrozen(TEST_CTX, new Date(NOW))[0]).toMatchObject({ blockId: first.id, reason: "pinned", start: utc(first.start) });
});
