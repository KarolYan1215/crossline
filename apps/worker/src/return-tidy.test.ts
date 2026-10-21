import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { goalSettingKey } from "@crossline/core";
import { CrosslineStore } from "@crossline/db";
import { RETURN_TIDY_SETTING, absenceToTidy, returnTidy } from "./return-tidy";

let store: CrosslineStore;
let ws: string;
let owner: string;
const estimate = { p25Minutes: 30, p50Minutes: 45, p85Minutes: 90, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  store = new CrosslineStore(":memory:");
  const created = store.createPrincipalWithWorkspace("user-1", "w");
  ws = created.workspace.id; owner = created.principal.id;
  store.setSetting(ws, "schedule.preferences", JSON.stringify({ timeZone: "UTC", mode: "buffered", importance: {} }));
});
afterEach(() => { store.close(); vi.useRealTimers(); });

/** One own action of the person's at `at` (an undo counts). */
const act = (at: string) => { vi.setSystemTime(new Date(at)); store.appendEvent({ ownerId: owner, workspaceId: ws, idempotencyKey: `act:${at}`, type: "op.undone", entityId: "x", payload: {} }); };
const milestone = (id: string, projectId: string, deadline: string) => {
  store.saveMilestone({ id, ownerId: owner, workspaceId: ws, identityId: "media", projectId, title: id, status: "approved", version: 1 });
  store.saveMilestoneAnchor({ workspaceId: ws, milestoneId: id, stage: 1, deadline, baseline: "", target: "", stakeholders: [], sourceFactIds: [], dependsOn: [], updatedAt: "2026-10-01T00:00:00Z" });
};
const order = (id: string, milestoneId: string, state: string, payload: Record<string, unknown> = {}, projectId = "xhs") =>
  store.saveWorkOrder({ id, ownerId: owner, workspaceId: ws, identityId: "media", projectId, milestoneId, intent: id, state: state as never, riskTier: "routine", estimate, payload });

test("back after five days: the person's overdue milestones move with the chain, old work is archived, a course's dates stay, all in one undo", async () => {
  milestone("pack", "xhs", "2026-10-17");
  milestone("feedback", "xhs", "2026-10-19");
  milestone("launch", "xhs", "2026-10-29");
  milestone("far", "xhs", "2026-11-30");
  milestone("exam", "ece555", "2026-10-16");
  milestone("gone", "xhs", "2026-12-01");
  store.saveMilestone({ id: "gone", ownerId: owner, workspaceId: ws, identityId: "media", projectId: "xhs", title: "gone", status: "archived", version: 2 });
  store.upsertProfileFact({ workspaceId: ws, identityId: "research", projectId: "ece555", slot: "grading", value: "作业 30%", status: "confirmed", sourceRef: "doc", sourceQuote: "", updatedAt: "2026-10-01T00:00:00Z" });
  order("t-pack", "pack", "approved");
  order("t-feedback", "feedback", "approved");
  order("t-launch", "launch", "approved");
  order("t-exam", "exam", "approved", {}, "ece555");
  order("t-orphan", "gone", "approved");
  order("t-old-due", "", "approved", { dueDate: "2026-10-01" });
  act("2026-10-15T19:00:00Z");
  expect(absenceToTidy(store, ws, new Date("2026-10-16T19:00:00Z"))).toBeUndefined();
  act("2026-10-20T20:00:00Z");
  vi.setSystemTime(new Date("2026-10-20T20:10:00Z"));
  const merge = vi.fn(async () => 2);
  const outcome = (await returnTidy(store, ws, { mergeNow: merge }))!;
  expect(merge).toHaveBeenCalledOnce();
  // Six days away (5 days 1 hour, rounded up): each overdue one moves by six days; the launch (10/29) still comes after them and stays.
  expect(Object.fromEntries(outcome.shifted.map((item) => [item.id, `${item.from}→${item.to}`]))).toEqual({
    pack: "2026-10-17→2026-10-23", feedback: "2026-10-19→2026-10-25" });
  expect(JSON.parse(store.getSetting(ws, goalSettingKey("pack"))!)).toMatchObject({ confirmedDeadline: "2026-10-23" });
  // The course's exam keeps its date; the far milestone is not touched.
  expect(store.getSetting(ws, goalSettingKey("exam"))).toBeUndefined();
  expect(store.getSetting(ws, goalSettingKey("far"))).toBeUndefined();
  expect(store.getSetting(ws, goalSettingKey("launch"))).toBeUndefined();
  expect(outcome.archived.map((item) => [item.id, item.why]).sort()).toEqual([["t-old-due", "截止 2026-10-01 已过 14 天以上且未开始"], ["t-orphan", "所服务的里程碑已不在"]]);
  expect(store.listWorkOrders(ws).find((item) => item.id === "t-orphan")!.state).toBe("archived");
  expect(outcome.merged).toBe(2);
  // One undo for dates and archives, written by the system (so it is not the person's own action).
  const op = store.listEvents(ws, { type: "op.applied" }).at(-1)!;
  expect(op.payload).toMatchObject({ bySystem: true, inverse: { kind: "batch" } });
  expect(store.lastPersonActivity(ws)).toBe("2026-10-20T20:00:00.000Z");
  // Said once, with the return page to confirm progress; never twice for the same absence.
  expect(store.getSetting(ws, RETURN_TIDY_SETTING)).toBe("2026-10-15T19:00:00.000Z");
  expect(await returnTidy(store, ws, { mergeNow: merge })).toBeUndefined();
});

test("a return more than three days ago is not tidied", async () => {
  act("2026-10-01T10:00:00Z");
  act("2026-10-05T10:00:00Z");
  vi.setSystemTime(new Date("2026-10-09T10:00:00Z"));
  expect(await returnTidy(store, ws)).toBeUndefined();
});

test("daily use with no gap of two days is not a return", () => {
  for (const day of ["2026-10-09", "2026-10-10", "2026-10-11"]) act(`${day}T09:00:00Z`);
  vi.setSystemTime(new Date("2026-10-11T10:00:00Z"));
  expect(absenceToTidy(store, ws)).toBeUndefined();
});
