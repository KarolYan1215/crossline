import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { MAIL_EVENT_RULES_SETTING, MAIL_EVENTS_SETTING, readMailEventRules, type MailEvent } from "@crossline/core";
vi.mock("server-only", () => ({}));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn(async () => ({ state: "published" })), CodexSupervisorRequestError: class extends Error {} }));
import { answerAsk, collectAsks } from "./asks";
import { loadCurrentPlan, saveAvailability, saveSchedulePreferences } from "./crossline";
import { fixedEventsToPublish, inputEvents } from "./fixed-events";
import { mailEventRules, removeMailEventRule } from "./mail-events";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); });
const ws = TEST_CTX.workspaceId;
const NOW = new Date("2026-11-10T15:00:00.000Z"); // a Tuesday, 09:00 in Chicago
const ALWAYS = [{ days: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "20:00", energy: "high" as const }];

function setup() {
  vi.stubEnv("CROSSLINE_FIXED_NOW", NOW.toISOString());
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  saveSchedulePreferences(TEST_CTX, { timeZone: "America/Chicago", mode: "buffered", windows: ALWAYS, importance: {} });
  saveAvailability(TEST_CTX, ALWAYS);
  return store;
}
const event = (id: string, over: Partial<MailEvent> = {}): MailEvent => ({ id, title: id, date: "2026-11-12", start: "10:00", end: "11:00", location: "", lineId: "",
  relevance: 40, personal: false, from: "Prof Lin <lin@uni.edu>", subject: id, state: "asked", at: NOW.toISOString(), source: "lin@uni.edu", timing: "fixed", obligation: "likely",
  basis: "invitation", ...over });

test("a required event from mail is busy on Crossline's plan without a card, and on no calendar until the person says 去", async () => {
  const store = setup();
  store.setSetting(ws, MAIL_EVENTS_SETTING, JSON.stringify([event("exam", { title: "ECE 548 期中 2", state: "fixed", obligation: "required", basis: "rule" })]));
  const plan = await loadCurrentPlan(TEST_CTX);
  expect(plan.blocks.filter((block) => block.id.startsWith("event:mail-exam")).map((block) => [block.day, block.start, block.end])).toEqual([["2026-11-12", "10:00", "11:00"]]);
  // Nothing scheduled over it.
  expect(plan.blocks.some((block) => block.id.startsWith("scheduled:") && block.day === "2026-11-12" && block.start < "11:00" && "10:00" < block.end)).toBe(false);
  expect(collectAsks(TEST_CTX, NOW).filter((ask) => ask.kind === "mail_event")).toEqual([]);
  expect(inputEvents(TEST_CTX)).toEqual([]);
  expect(fixedEventsToPublish(TEST_CTX, NOW)).toEqual([]);
});

test("a required event from a new source is asked with 去 recommended and why; answers become rules the person can see and delete", async () => {
  const store = setup();
  store.setSetting(ws, MAIL_EVENTS_SETTING, JSON.stringify([event("review", { title: "论文审阅", obligation: "required", basis: "required_participant" }),
    event("talk1", { title: "Club talk 1", source: "club@uni.edu", relevance: 75, basis: "relevance", from: "Club <club@uni.edu>" }),
    event("talk2", { title: "Club talk 2", source: "club@uni.edu", relevance: 75, basis: "relevance", from: "Club <club@uni.edu>", date: "2026-11-13" })]));
  const asks = collectAsks(TEST_CTX, NOW).filter((ask) => ask.kind === "mail_event");
  const review = asks.find((ask) => ask.entityId === "review")!;
  expect(review.options[0]).toMatchObject({ id: "go", recommended: true });
  expect(review.why).toContain("本人在邀请里是必需参与者");
  expect(asks.find((ask) => ask.entityId === "talk1")!.options[0]!.recommended).toBe(true);
  expect((await answerAsk(TEST_CTX, "mail-event:review", "go", {}, NOW)).ok).toBe(true);
  expect(inputEvents(TEST_CTX).map((item) => item.id)).toEqual(["mail-review"]);
  await answerAsk(TEST_CTX, "mail-event:talk1", "skip", {}, NOW);
  await answerAsk(TEST_CTX, "mail-event:talk2", "skip", {}, new Date(NOW.getTime() + 60_000));
  expect(mailEventRules(TEST_CTX).map((rule) => [rule.source, rule.cap, rule.why])).toEqual([["lin@uni.edu", "required", "went"], ["club@uni.edu", "optional", "skipped_twice"]]);
  expect(removeMailEventRule(TEST_CTX, "club@uni.edu")).toBe(true);
  expect(removeMailEventRule(TEST_CTX, "nobody@uni.edu")).toBe(false);
  expect(readMailEventRules(store.getSetting(ws, MAIL_EVENT_RULES_SETTING)).map((rule) => rule.source)).toEqual(["lin@uni.edu"]);
});

/** A confirmed course whose syllabus gave its second midterm a day and no time (W-256: `ece548-20261124-midterm2`). */
function syllabus(store: CrosslineStore) {
  store.saveProject({ id: "ece548", ownerId: "o", workspaceId: ws, identityId: "research", name: "ECE 548", summary: "", status: "active", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" });
  store.appendEvent({ ownerId: "o", workspaceId: ws, idempotencyKey: "dates:1", type: "dates.extracted", entityId: "b1", payload: { documentIds: [], recurring: [],
    dates: [{ id: "midterm2", title: "Midterm-2", project: "ece548", date: "2026-11-24", startTime: "", endTime: "", kind: "exam", sourceRef: "src-1", quote: "Nov 24: Midterm-2", confidence: "high", note: "" },
      { id: "hw5", title: "HW5 due", project: "ece548", date: "2026-11-20", startTime: "", endTime: "", kind: "homework_due", sourceRef: "src-1", quote: "Nov 20: HW5 due", confidence: "high", note: "" },
      { id: "elsewhere", title: "Quiz", project: "unknown course", date: "2026-11-25", startTime: "", endTime: "", kind: "quiz", sourceRef: "src-1", quote: "Nov 25: Quiz", confidence: "high", note: "" }],
    undated: [] } });
  store.appendEvent({ ownerId: "o", workspaceId: ws, idempotencyKey: "dates:2", type: "dates.decided", entityId: "b1", payload: { included: ["midterm2", "hw5", "elsewhere"], excluded: [] } });
}

test("a syllabus exam with only a day is asked 「几点到几点」; the answer makes it a fixed block, 「没有固定时间」 leaves the day's reminder", async () => {
  const store = setup();
  syllabus(store);
  const asks = collectAsks(TEST_CTX, NOW).filter((ask) => ask.kind === "exam_time");
  // Only the known course's exam: a due date is a task, a course nobody confirmed is not required.
  expect(asks.map((ask) => [ask.entityId, ask.title])).toEqual([["b1:midterm2", "「ECE 548 Midterm-2」几点到几点？"]]);
  expect(asks[0]!.freeText).toBeDefined();
  expect((await answerAsk(TEST_CTX, "exam-time:b1:midterm2", { optionIds: ["set"], note: "下午" }, {}, NOW))).toMatchObject({ ok: false, code: "EXAM_TIME_INVALID" });
  expect((await answerAsk(TEST_CTX, "exam-time:b1:midterm2", { optionIds: ["set"], note: "12:45-13:15" }, {}, NOW)).ok).toBe(true);
  const plan = await loadCurrentPlan(TEST_CTX);
  expect(plan.blocks.filter((block) => block.id === "import:b1:midterm2").map((block) => [block.day, block.start, block.end, block.readOnly])).toEqual([["2026-11-24", "12:45", "13:15", true]]);
  expect(collectAsks(TEST_CTX, NOW).filter((ask) => ask.kind === "exam_time")).toEqual([]);
});

test("「没有固定时间」 is not asked again and writes no block", async () => {
  const store = setup();
  syllabus(store);
  expect((await answerAsk(TEST_CTX, "exam-time:b1:midterm2", "none", {}, NOW)).ok).toBe(true);
  expect(collectAsks(TEST_CTX, NOW).filter((ask) => ask.kind === "exam_time")).toEqual([]);
  expect((await loadCurrentPlan(TEST_CTX)).blocks.some((block) => block.id === "import:b1:midterm2")).toBe(false);
});
