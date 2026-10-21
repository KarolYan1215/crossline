import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn(async () => ({ state: "published" })), CodexSupervisorRequestError: class extends Error {} }));
import { answerAsk, collectAsks } from "./asks";
import { fixedEventsToPublish } from "./fixed-events";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); });
const ws = TEST_CTX.workspaceId;
const NOW = new Date("2026-10-12T13:00:00.000Z");

function setup(calendar: Array<{ title: string; day: string; start: string; end: string }> = []) {
  vi.stubEnv("CROSSLINE_FIXED_NOW", NOW.toISOString());
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.saveProject({ id: "ece555", ownerId: "o", workspaceId: ws, identityId: "research", name: "ECE 555", summary: "", status: "active", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" });
  store.savePlanVersion({ id: "plan-1", ownerId: "o", workspaceId: ws, version: 1, status: "draft", payload: { blocks: calendar.map((block, index) => ({
    id: `graph_calendar:${index}`, lane: "human", ...block, source: "日历", readOnly: true })) } });
  store.appendEvent({ ownerId: "o", workspaceId: ws, idempotencyKey: "dates:1", type: "dates.extracted", entityId: "b1", payload: { documentIds: [],
    recurring: [{ id: "class", title: "上课", project: "ECE 555", weekdays: [1, 5], startTime: "14:30", endTime: "15:45", from: "2026-09-04", to: "2026-12-07", exceptions: [], location: "Plant Sci 108", sourceRef: "src-2" }],
    dates: [{ id: "exam", title: "期中考试", project: "ECE 555", date: "2026-10-27", startTime: "14:30", endTime: "15:45", kind: "exam", sourceRef: "src-1" },
      { id: "due", title: "作业截止", project: "ECE 555", date: "2026-10-20", startTime: "", endTime: "", kind: "homework_due", sourceRef: "src-1" }], undated: [] } });
  store.appendEvent({ ownerId: "o", workspaceId: ws, idempotencyKey: "dates:2", type: "dates.decided", entityId: "b1", payload: { included: ["class", "exam", "due"], excluded: [] } });
  store.setSetting(ws, "portrait.report", JSON.stringify({ version: 1 }));
  // Offered only where there is a Crossline calendar to write to (2026-10-15).
  store.setSetting(ws, "calendar.write.account", "acct");
  return store;
}

test("without an account to write the Crossline calendar with, nothing is offered: 「创建」 could only fail", async () => {
  setup().deleteSetting(ws, "calendar.write.account");
  expect(collectAsks(TEST_CTX, NOW).filter((ask) => ask.kind === "event_propose")).toEqual([]);
});

test("after the report, confirmed fixed arrangements the calendar lacks are offered — the class as weekly, the exam as one day; untimed items are not events", async () => {
  setup();
  const asks = collectAsks(TEST_CTX, NOW).filter((ask) => ask.kind === "event_propose");
  expect(asks.map((ask) => ask.title)).toEqual(["日历中没有「ECE 555 上课」，要创建吗？", "日历中没有「ECE 555 期中考试」，要创建吗？"]);
  expect(asks[0]!.why).toContain("周期性日程：每周一、五 14:30–15:45");
  expect(asks[0]!.why).toContain("每周重复的系列");
  expect(asks[1]!.why).toContain("一次性日程：10/27 周二 14:30–15:45");
  expect(await answerAsk(TEST_CTX, asks[0]!.id, "create", {}, NOW)).toMatchObject({ ok: true });
  const published = fixedEventsToPublish(TEST_CTX, NOW);
  expect(published).toHaveLength(1);
  expect(published[0]).toMatchObject({ id: "fixed:batch:b1:class", title: "ECE 555 上课", recurrence: { daysOfWeek: ["monday", "friday"], startDate: "2026-10-12", endDate: "2026-12-07" } });
  expect(collectAsks(TEST_CTX, NOW).filter((ask) => ask.kind === "event_propose")).toHaveLength(1);
});

test("a timed day heard in a recording is offered as a one-off event the person decides on; a day with no time stays a fact only", async () => {
  const store = setup();
  const fact = { workspaceId: ws, identityId: "research", projectId: "", status: "inferred" as const, sourceRef: "recording:rec-a", sourceQuote: "下周三下午三点在 2310 开会", updatedAt: "2026-10-12T00:00:00Z" };
  store.upsertProfileFact({ ...fact, slot: "date_heard_ab12cd34", value: "2026-10-28 15:00 组会" });
  store.upsertProfileFact({ ...fact, slot: "date_heard_ffff0000", value: "2026-10-30 提交报告" });
  const asks = collectAsks(TEST_CTX, NOW).filter((ask) => ask.kind === "event_propose");
  const heard = asks.find((ask) => ask.title === "日历中没有「组会」，要创建吗？");
  expect(heard?.why).toContain("一次性日程：10/28 周三 15:00–16:00");
  expect(heard?.why).toContain("录音里听到的话");
  expect(asks.some((ask) => ask.title.includes("提交报告"))).toBe(false);
  expect(await answerAsk(TEST_CTX, heard!.id, "create", {}, NOW)).toMatchObject({ ok: true });
  expect(fixedEventsToPublish(TEST_CTX, NOW)).toMatchObject([{ id: "fixed:heard:rec-a:ab12cd34", title: "组会", start: expect.stringContaining("2026-10-28") }]);
  // The fact is untouched by the answer.
  expect(store.listProfileFacts(ws).find((item) => item.slot === "date_heard_ab12cd34")).toMatchObject({ status: "inferred", value: "2026-10-28 15:00 组会" });
});

test("an arrangement the person's own calendar already holds is not offered again", () => {
  setup([{ title: "ECE555 Lecture", day: "2026-10-12", start: "14:30", end: "15:45" }]);
  expect(collectAsks(TEST_CTX, NOW).filter((ask) => ask.kind === "event_propose").map((ask) => ask.title)).toEqual(["日历中没有「ECE 555 期中考试」，要创建吗？"]);
});
