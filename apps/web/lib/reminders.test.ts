import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import type { Ask } from "@crossline/core";
vi.mock("server-only", () => ({}));
import { loadReminders, unplacedTasks, weekClashes } from "./reminders";
import { TEST_CTX } from "./test-support";
import type { PersistedPlan } from "./crossline";
import type { TimelineItem } from "../app/timeline/model";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); });

const ws = TEST_CTX.workspaceId, owner = TEST_CTX.principalId;
const estimate = { p25Minutes: 30, p50Minutes: 45, p85Minutes: 90, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const };
const block = (id: string, day: string, start: string, end: string) => ({ id, lane: "human" as const, title: id, day, start, end, source: "scheduler", readOnly: false });
const item = (id: string, kind: TimelineItem["kind"], day: string, start: string, end: string, extra: Partial<TimelineItem> = {}): TimelineItem =>
  ({ id, title: id, day, start, end, kind, source: "x", readOnly: false, ...extra });

test("unplaced work is counted per task as the plan page counts it, wholly and in part", () => {
  const plan = { blocks: [block("scheduled:a:v1s1", "2026-10-15", "09:00", "10:00")],
    schedule: { blockers: [{ taskId: "a#v1s2", code: "x", message: "" }, { taskId: "b", code: "x", message: "" }] } } as unknown as PersistedPlan;
  expect(unplacedTasks(plan)).toEqual({ none: 1, partial: 1 });
});

test("a clash is a work block sharing time with something this week, not one whose overlap was accepted or that an ask already covers", () => {
  const items = [item("scheduled:a", "scheduled", "2026-10-16", "09:00", "10:00"), item("graph_calendar:m", "calendar", "2026-10-16", "09:30", "10:30"),
    item("scheduled:b", "scheduled", "2026-10-17", "09:00", "10:00", { overlapOk: true }), item("graph_calendar:n", "calendar", "2026-10-17", "09:00", "10:00"),
    item("scheduled:c", "scheduled", "2026-10-30", "09:00", "10:00"), item("graph_calendar:o", "calendar", "2026-10-30", "09:00", "10:00")];
  expect(weekClashes(items, "2026-10-15", new Set())).toEqual({ count: 1, firstDay: "2026-10-16" });
  expect(weekClashes(items, "2026-10-15", new Set(["scheduled:a"]))).toEqual({ count: 0 });
});

test("Today's reminders gather what other pages flag, one line each with where to go, and leave out what an ask already covers", () => {
  vi.stubEnv("CROSSLINE_FIXED_NOW", "2026-10-15T15:00:00.000Z");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  const order = (id: string, dueDate: string) => store.saveWorkOrder({ id, ownerId: owner, workspaceId: ws, identityId: "research", projectId: "p", milestoneId: "",
    intent: id, state: "approved", riskTier: "routine", estimate, payload: { dueDate } });
  order("作业 2", "2026-10-12");
  order("作业 3", "2026-10-13");
  store.saveMilestone({ id: "late", ownerId: owner, workspaceId: ws, identityId: "research", projectId: "p", title: "投出初稿", status: "approved", version: 1 });
  store.saveMilestoneAnchor({ workspaceId: ws, milestoneId: "late", stage: 1, deadline: "2026-10-10", baseline: "", target: "", stakeholders: [],
    sourceFactIds: [], dependsOn: [], updatedAt: "2026-10-01T00:00:00Z" });
  store.saveMilestone({ id: "d1", ownerId: owner, workspaceId: ws, identityId: "media", projectId: "", title: "第一篇笔记", status: "draft", version: 1 });
  const plan = { blocks: [], schedule: { blockers: [{ taskId: "作业 3", code: "x", message: "" }] } } as unknown as PersistedPlan;
  const items = [item("scheduled:x", "scheduled", "2026-10-16", "09:00", "10:00"), item("graph_calendar:m", "calendar", "2026-10-16", "09:30", "10:30")];
  const reminders = loadReminders(TEST_CTX, plan, items, []);
  expect(reminders.map((reminder) => [reminder.id, reminder.text, reminder.href])).toEqual([
    ["overdue", "2 个任务已过截止，最早 10/12", "/workbench"],
    ["unplaced", "1 个任务未排进日历", "/plan#why"],
    ["clash", "1 个工作时段与日程时间冲突，最早 10/16", "#today-timeline"],
    // A milestone whose deadline passed is the overdue question's, not a risk; the 主线 page's rule estimate is no longer counted here.
    ["drafts", "1 个里程碑草稿待批准", "/milestones"]
  ]);
  // What an open ask is about is not said twice.
  const asks = [{ entityId: "作业 2" }, { entityId: "late" }] as Ask[];
  const left = loadReminders(TEST_CTX, plan, items, asks);
  expect(left.find((reminder) => reminder.id === "overdue")).toMatchObject({ text: "「作业 3」已过截止 2 天", href: "/workbench/%E4%BD%9C%E4%B8%9A%203" });
});

test("the risk line counts the weekly card's set, and is left out while a risk card is in the stack (one risk number, 2026-10-28)", () => {
  vi.stubEnv("CROSSLINE_FIXED_NOW", "2026-10-15T15:00:00.000Z");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.saveMilestone({ id: "paper", ownerId: owner, workspaceId: ws, identityId: "research", projectId: "p", title: "投出初稿", status: "approved", version: 1 });
  store.saveMilestoneAnchor({ workspaceId: ws, milestoneId: "paper", stage: 1, deadline: "2026-10-23", baseline: "", target: "", stakeholders: [],
    sourceFactIds: [], dependsOn: [], updatedAt: "2026-10-01T00:00:00Z" });
  store.saveWorkOrder({ id: "draft", ownerId: owner, workspaceId: ws, identityId: "research", projectId: "p", milestoneId: "paper", intent: "写完初稿",
    state: "approved", riskTier: "milestone", estimate: { ...estimate, p50Minutes: 6000, p85Minutes: 9000 }, payload: {} });
  const plan = { blocks: [], schedule: { blockers: [] } } as unknown as PersistedPlan;
  expect(loadReminders(TEST_CTX, plan, [], []).find((reminder) => reminder.id === "risk")).toMatchObject({ text: "1 个里程碑有风险，每周汇总一次", href: "/plan" });
  expect(loadReminders(TEST_CTX, plan, [], [{ entityId: "weekly", kind: "risk_digest" }] as Ask[]).some((reminder) => reminder.id === "risk")).toBe(false);
});
