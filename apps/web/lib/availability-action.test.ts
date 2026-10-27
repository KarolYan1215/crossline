import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { AVAILABILITY_SETTING, actionProblem } from "@crossline/core";
vi.mock("server-only", () => ({}));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn(async () => ({})), CodexSupervisorRequestError: class extends Error {} }));
vi.mock("./capture-followups", () => ({ analyzeNewCapturesInBackground: vi.fn() }));
import { executeAction } from "./actions";
import { weeklyPattern } from "./conversation";
import { resolvedAvailability } from "./crossline";
import { TEST_CTX } from "./test-support";
import { recentOps, undoOp } from "./undo";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });

// 「我其实每天能工作 10 小时左右，周六也上班，周日休息，帮我改一下可用时段」 (2026-10-17 walkthrough, W-15): Monday to Saturday, no Sunday.
const tenHours = { action: "availability.set" as const, summary: "周一至周六 9–12、13:30–18:30、20–22", args: { windows: [
  { days: "1,2,3,4,5,6", start: "09:00", end: "12:00", energy: "high" as const },
  { days: "1,2,3,4,5,6", start: "13:30", end: "18:30", energy: "medium" as const },
  { days: "1,2,3,4,5,6", start: "20:00", end: "22:00", energy: "low" as const }] } };

test("the input box can replace the weekly hours: the plan uses them, the card says how many, and 撤销 restores the old pattern", async () => {
  globalThis.crosslineStore = new CrosslineStore(":memory:");
  const before = resolvedAvailability(TEST_CTX);
  expect(await executeAction(TEST_CTX, tenHours)).toMatchObject({ ok: true, message: "每周可用时段改为约 60 小时", href: "/plan" });
  const after = resolvedAvailability(TEST_CTX);
  expect(after.source).toBe("saved");
  expect(after.windows.some((window) => window.days.includes(0))).toBe(false);
  expect(weeklyPattern(after.windows)[0]).toBe("周一 周二 周三 周四 周五 周六 09:00–12:00 高");
  const [op] = recentOps(TEST_CTX);
  expect(undoOp(TEST_CTX, op!.id)).toMatchObject({ ok: true });
  expect(globalThis.crosslineStore.getSetting(TEST_CTX.workspaceId, AVAILABILITY_SETTING)).toBeUndefined();
  expect(resolvedAvailability(TEST_CTX).windows).toEqual(before.windows);
});

test("a band with no days, a bad time or an end before its start is sent back to the model with what to fix", () => {
  const refs = {} as never;
  expect(actionProblem({ ...tenHours, args: { windows: [] } }, refs)).toContain("至少一个时段");
  expect(actionProblem({ ...tenHours, args: { windows: [{ days: "", start: "09:00", end: "12:00", energy: "high" }] } }, refs)).toContain("days");
  expect(actionProblem({ ...tenHours, args: { windows: [{ days: "1", start: "22:00", end: "01:00", energy: "low" }] } }, refs)).toContain("跨午夜");
  expect(actionProblem(tenHours, refs)).toBe("");
});
