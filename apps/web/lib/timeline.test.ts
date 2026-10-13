import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";

vi.mock("server-only", () => ({}));
const { quietRanges, loadTimeline } = await import("./timeline");
const { countPending } = await import("./pending");
const { TEST_CTX } = await import("./test-support");

beforeEach(() => { globalThis.crosslineStore = new CrosslineStore(":memory:"); });
afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });

test("the quiet stretches of a day are whatever no availability window covers", () => {
  const windows = [
    { days: [1, 2, 3, 4, 5], start: "09:00", end: "12:00", energy: "high" as const },
    { days: [1, 2, 3, 4, 5], start: "14:00", end: "23:00", energy: "medium" as const }
  ];
  expect(quietRanges(windows, 1)).toEqual([["00:00", "09:00"], ["12:00", "14:00"], ["23:00", "24:00"]]);
  expect(quietRanges(windows, 0)).toEqual([["00:00", "24:00"]]);
});

test("the calendar carries milestone deadlines and confirmed dated facts as flags, and archived milestones as nothing", async () => {
  const store = globalThis.crosslineStore!;
  const base = { ownerId: "o", workspaceId: TEST_CTX.workspaceId, identityId: "research", projectId: "p", version: 1 };
  store.saveMilestone({ ...base, id: "m1", title: "西湖论文投出", status: "draft" });
  store.saveMilestone({ ...base, id: "m2", title: "旧的", status: "archived" });
  for (const id of ["m1", "m2"]) {
    store.saveMilestoneAnchor({ workspaceId: TEST_CTX.workspaceId, milestoneId: id, stage: 1, deadline: "2026-10-31", baseline: "-", target: "-", stakeholders: [], sourceFactIds: [], dependsOn: [], updatedAt: "2026-10-02T00:00:00.000Z" });
  }
  store.upsertProfileFact({ workspaceId: TEST_CTX.workspaceId, identityId: "research", projectId: "ece555", slot: "date_20261207_exam", value: "2026-12-07 ECE 555 期末考试",
    status: "confirmed", sourceRef: "src-1", sourceQuote: "12/7 Final Exam", updatedAt: "2026-10-02T00:00:00.000Z" });
  const timeline = await loadTimeline(TEST_CTX);
  expect(timeline.deadlines.map((deadline) => [deadline.day, deadline.title]).sort()).toEqual([["2026-10-31", "西湖论文投出"], ["2026-12-07", "ECE 555 期末考试"]]);
  expect(timeline.labels.research).toBe("研究者");
  expect(Object.keys(timeline.quietByWeekday)).toHaveLength(7);
});

test("what is waiting is counted by kind; the total is today's decisions, without what the weekly review decides", () => {
  const store = globalThis.crosslineStore!;
  const base = { ownerId: "o", workspaceId: TEST_CTX.workspaceId, identityId: "research", projectId: "p", version: 1 };
  store.saveMilestone({ ...base, id: "d1", title: "草稿一", status: "draft" });
  store.saveMilestone({ ...base, id: "d2", title: "草稿二", status: "draft" });
  store.saveMilestone({ ...base, id: "a1", title: "已批准", status: "approved" });
  store.saveDiligenceReport({ id: "r", ownerId: "o", workspaceId: TEST_CTX.workspaceId, scope: "startup", question: "q", status: "done", runAt: "2026-10-02T00:00:00.000Z",
    findings: [], sources: [], proposals: [{ id: "p1", title: "x", why: "y", kind: "task", dueDate: "", findingIds: [], status: "pending" }, { id: "p2", title: "z", why: "y", kind: "task", dueDate: "", findingIds: [], status: "accepted" }] });
  const counts = countPending(TEST_CTX);
  expect(counts).toMatchObject({ milestoneDrafts: 2, research: 1, dates: 0 });
  // Research proposals and candidate relations are counted, and decided in the weekly review: they are not in the day's total.
  expect(counts.total).toBe(counts.workOrders + counts.milestoneDrafts + counts.dates + counts.targets + counts.assistantKinds + counts.assistantQuestions
    + counts.assistantReviews + counts.asks + counts.questions);
});

test("a proposal's preview block is its own kind and still links to its task", async () => {
  const { itemsFromPlan } = await import("../app/timeline/model");
  const [item] = itemsFromPlan([{ id: "proposed:wo-1", lane: "human", title: "预览·待批准 · 画图", day: "2026-10-07", start: "09:00", end: "10:00",
    source: "预览·待你批准", readOnly: true }], "2026-10-06", { "wo-1": { identityId: "research" } });
  expect(item).toMatchObject({ kind: "proposed", workOrderId: "wo-1", identityId: "research" });
});

test("a calendar event takes the line it was filed under, and none once the lines it was filed against have changed", async () => {
  const store = globalThis.crosslineStore!;
  const { CALENDAR_LINES, calendarLinesBasis } = await import("@crossline/core");
  const { identityLines } = await import("./lines");
  const { planToday } = await import("./crossline");
  const day = planToday(TEST_CTX);
  store.savePlanVersion({ id: "plan-1", ownerId: "o", workspaceId: TEST_CTX.workspaceId, version: 1, status: "approved", payload: { blocks: [
    { id: "graph_calendar:a", lane: "human", title: "ECE 555 Lecture", day, start: "10:00", end: "11:00", source: "日历", readOnly: true },
    { id: "graph_calendar:b", lane: "human", title: "Dentist", day, start: "15:00", end: "16:00", source: "日历", readOnly: true }] } });
  const filing = (basis: string) => store.setSetting(TEST_CTX.workspaceId, CALENDAR_LINES, JSON.stringify({ basis,
    entries: { "ece 555 lecture": { lineId: "research", why: "课程", at: "" }, dentist: { lineId: "", why: "个人", at: "" } } }));
  filing(calendarLinesBasis(identityLines(TEST_CTX)));
  const lineOf = async (title: string) => (await loadTimeline(TEST_CTX)).items.find((item) => item.title === title)?.identityId;
  expect(await lineOf("ECE 555 Lecture")).toBe("research");
  expect(await lineOf("Dentist")).toBeUndefined();
  filing("research=旧名");
  expect(await lineOf("ECE 555 Lecture")).toBeUndefined();
});
