import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
const supervisor = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: supervisor, CodexSupervisorRequestError: class extends Error {} }));
import { answerAsk, collectAsks } from "./asks";
import { interviewStatus, questionsOwnedElsewhere, takePendingAnswers } from "./interview-status";
import { seedReadyToStart, TEST_CTX } from "./test-support";

afterEach(() => { vi.unstubAllEnvs(); globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; supervisor.mockClear(); });
const ws = TEST_CTX.workspaceId;
const SOON = new Date("2026-10-08T02:00:00Z"), DAY_LATER = new Date("2026-10-09T03:00:00Z");

function setup(nextAction: "ask" | "ready_for_milestones" = "ask") {
  // The example board meets the start standard; these tests set it up themselves.
  vi.stubEnv("CROSSLINE_SEED_EXAMPLES", "");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  for (const [id, name] of [["ece555", "ECE 555"], ["ece548", "ECE 548"]] as const) {
    store.saveProject({ id, ownerId: "o", workspaceId: ws, identityId: "research", name, summary: "", status: "active", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" });
    store.upsertProfileFact({ workspaceId: ws, identityId: "research", projectId: id, slot: "deadline", value: "2026-12-15", status: "confirmed", sourceRef: "reply-1", sourceQuote: "2026-12-15", updatedAt: "2026-10-01T00:00:00Z" });
  }
  for (const [id, fileName, text] of [["a", "Course Overview.docx", "Fermi-Dirac Statistics"], ["b", "TENTATIVE_Lecture Plan for Fall 2026.docx", "Week-1"]] as const)
    store.saveSourceDocument({ id, ownerId: "o", workspaceId: ws, kind: "text", fileName, mediaType: "text/plain", sha256: id, uri: `file://${id}`,
      extractedText: text, extractionStatus: "done", createdAt: "2026-10-01T00:00:00Z" });
  store.upsertProfileFact({ workspaceId: ws, identityId: "research", projectId: "", slot: "what", value: "博士研究", status: "confirmed", sourceRef: "reply-1", sourceQuote: "博士研究", updatedAt: "2026-10-01T00:00:00Z" });
  store.saveOnboardingSession({ id: "s1", ownerId: "o", workspaceId: ws, state: "active", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z", coverage: { stage: "lines",
    coverage: [{ identityId: "research", filled: [], missing: ["ECE 548 固定课时", "组会时段"] }] } });
  const questions = [
    { id: "q-course-map", text: "两份半导体器件课程文件与 ECE 548 的关系？", kind: "single", allowOther: true, identityId: "research", projectId: "",
      options: [{ id: "both", label: "均属于 ECE 548", detail: "《Course Overview》和《TENTATIVE Lecture Plan》均为 ECE 548 材料。" }, { id: "no", label: "都不是", detail: "" }] },
    { id: "q-meetings", text: "组会和导师 1V1 的固定时间？", kind: "free", allowOther: true, identityId: "research", projectId: "", options: [] }];
  store.appendOnboardingMessage({ workspaceId: ws, sessionId: "s1", role: "assistant", createdAt: "2026-10-08T00:00:00Z",
    content: { reply: "…", questions, nextAction, stage: "lines" } });
  return { store, questions };
}

test("a model question about which project a file belongs to gives way to the app's own question about the file", () => {
  const { questions } = setup();
  expect([...questionsOwnedElsewhere(TEST_CTX, questions)]).toEqual(["q-course-map"]);
});

test("while the interview runs its questions stay in it; nothing about it is on 待决事项", () => {
  setup();
  const status = interviewStatus(TEST_CTX);
  expect(status).toMatchObject({ started: true, complete: false, parked: false, readyToStart: false, stage: "lines", stageIndex: 2, stageCount: 6 });
  // The model's round (its file question left out) and the app's own questions: both courses' class times.
  expect(status.questions.map((question) => question.id)).toEqual(["q-meetings", "gap-meetings-ece555", "gap-meetings-ece548"]);
  const asks = collectAsks(TEST_CTX, SOON);
  expect(asks.some((ask) => ["interview_open", "interview_question", "source_project"].includes(ask.kind))).toBe(false);
});

test("未达可开始时访谈问题不进待决事项，哪怕一天没回复", () => {
  setup();
  expect(interviewStatus(TEST_CTX)).toMatchObject({ parked: false, readyToStart: false });
  expect(interviewStatus(TEST_CTX).startMissing.length).toBeGreaterThan(0);
  const asks = collectAsks(TEST_CTX, DAY_LATER);
  expect(asks.some((ask) => ["interview_open", "interview_question", "source_project"].includes(ask.kind))).toBe(false);
});

test("a course's class times the round already asks about are not asked again in the app's own words", () => {
  const { store } = setup();
  store.appendOnboardingMessage({ workspaceId: ws, sessionId: "s1", role: "assistant", createdAt: "2026-10-08T01:00:00Z",
    content: { reply: "…", nextAction: "ask", stage: "lines", questions: [
      { id: "ece548-fixed-class", text: "ECE 548 每周固定上课的星期、起止时间和地点？", kind: "free", allowOther: true, identityId: "research", projectId: "ece548", options: [] }] } });
  expect(interviewStatus(TEST_CTX).questions.map((question) => question.id)).toEqual(["ece548-fixed-class", "gap-meetings-ece555"]);
});

test("used without finishing it, the interview's questions are asked on 待决事项, and the round goes to the interview once all are answered", async () => {
  const { store } = setup();
  // Ready to start and the portrait not finished: the interview's questions are listed on 待决事项 as well.
  seedReadyToStart(store, ws);
  expect(interviewStatus(TEST_CTX)).toMatchObject({ readyToStart: true, parked: true });
  // One card for the whole round (W-21): the first question, naming how many are left; answering it brings up the next.
  const asks = collectAsks(TEST_CTX, SOON);
  expect(asks.some((ask) => ask.kind === "interview_open")).toBe(false);
  expect(asks.filter((ask) => ask.kind === "interview_question").map((ask) => ask.title)).toEqual(["访谈还有 3 个问题：组会和导师 1V1 的固定时间？"]);
  expect(asks.filter((ask) => ask.kind === "source_project").map((ask) => ask.entityId).sort()).toEqual(["a", "b"]);

  expect(await answerAsk(TEST_CTX, "iq:q-meetings", "free", { other: "周三 10:00 组会" })).toMatchObject({ ok: true });
  expect(collectAsks(TEST_CTX, SOON).filter((ask) => ask.kind === "interview_question").map((ask) => ask.title)).toEqual(["访谈还有 2 个问题：「ECE 555」每周什么时候上课？"]);
  expect(await answerAsk(TEST_CTX, "iq:gap-meetings-ece555", "file", {})).toMatchObject({ ok: true });
  expect(supervisor).not.toHaveBeenCalled();
  expect(await answerAsk(TEST_CTX, "iq:gap-meetings-ece548", "write", { other: "周二、四 11:00–12:15" })).toMatchObject({ ok: true });
  expect(supervisor).toHaveBeenCalledTimes(1);
  const sent = JSON.parse(String((supervisor.mock.calls[0] as unknown as [unknown, string, { body: string }])[2].body)) as { sessionId: string; text: string };
  expect(sent.sessionId).toBe("s1");
  expect(sent.text.split("\n")).toEqual(["【组会和导师 1V1 的固定时间？】补充：周三 10:00 组会", "【「ECE 555」每周什么时候上课？】选择：上传的课程文件里有",
    "【「ECE 548」每周什么时候上课？】选择：我来写上课时间。补充：周二、四 11:00–12:15"]);
});

test("answers given on 待决事项 but not yet sent go in front of the next reply in the interview itself", async () => {
  seedReadyToStart(setup().store, ws);
  await answerAsk(TEST_CTX, "iq:q-meetings", "free", { other: "周三 10:00 组会" });
  expect(takePendingAnswers(TEST_CTX, "s1")).toBe("【组会和导师 1V1 的固定时间？】补充：周三 10:00 组会");
  expect(takePendingAnswers(TEST_CTX, "s1")).toBe("");
});

test("the model saying it is ready does not finish the interview while the list is open", () => {
  setup("ready_for_milestones");
  expect(interviewStatus(TEST_CTX).complete).toBe(false);
});

// The real account's round of 2026-10-15: a goal question the card offered as a single choice, a room asked for, a question about which
// calendar events repeat, and three dead questions (one TBD date twice, answered; a portrait already confirmed) holding the round.
test("several options and the person's own words go to the interview; questions not theirs to answer neither show nor hold the round", async () => {
  const { store } = setup();
  seedReadyToStart(store, ws);
  store.upsertProfileFact({ workspaceId: ws, identityId: "research", projectId: "ece548", slot: "meeting_time", value: "每周二、周四 13:00–14:15。", status: "confirmed",
    sourceRef: "reply-1", sourceQuote: "每周二周四下午一点到2.15", updatedAt: "2026-10-01T00:00:00Z" });
  store.upsertProfileFact({ workspaceId: ws, identityId: "research", projectId: "ece555", slot: "meeting_time", value: "周一和周五 14:30–15:45。", status: "confirmed",
    sourceRef: "reply-1", sourceQuote: "周一周五", updatedAt: "2026-10-01T00:00:00Z" });
  const options = (...labels: string[]) => labels.map((label, index) => ({ id: `o${index}`, label, detail: "" }));
  store.appendOnboardingMessage({ workspaceId: ws, sessionId: "s1", role: "assistant", createdAt: "2026-10-08T01:00:00Z",
    content: { reply: "…", nextAction: "ask", stage: "details", questions: [
      { id: "q-goal", text: "ECE 548 本学期最重要的目标？", kind: "single", allowOther: true, identityId: "research", projectId: "ece548", options: options("总评达到 A", "真正掌握器件物理", "期末考进前 10%") },
      { id: "q-location", text: "ECE 548 每周上课地点？", kind: "free", allowOther: true, identityId: "research", projectId: "ece548", options: [] },
      { id: "q-calendar", text: "日历中的两项活动，哪些属于持续安排？", kind: "multi", allowOther: true, identityId: "startup", projectId: "", options: options("Build Nights 每周", "DEJA-VU 每月") }] } });
  const status = interviewStatus(TEST_CTX);
  expect(status.questions.map((question) => [question.id, question.kind])).toEqual([["q-goal", "multi"]]);
  expect(status.screened.map((item) => item.reason)).toEqual(["location", "calendar_inferable"]);
  const ask = collectAsks(TEST_CTX, SOON).find((item) => item.id === "iq:q-goal")!;
  expect(ask).toMatchObject({ select: "many", important: false, freeText: { placeholder: expect.stringContaining("总评达到 A") } });
  // The single-option shape still answers, and a single-choice question refuses two.
  expect(await answerAsk(TEST_CTX, "iq:q-goal", { optionIds: ["o0", "o1"], note: "顺便把课程项目做成论文素材" }, {})).toMatchObject({ ok: true });
  const sent = JSON.parse(String((supervisor.mock.calls[0] as unknown as [unknown, string, { body: string }])[2].body)) as { text: string };
  const lines = sent.text.split("\n");
  expect(lines[0]).toBe("【ECE 548 本学期最重要的目标？】选择：总评达到 A；真正掌握器件物理。补充：顺便把课程项目做成论文素材");
  expect(lines[1]).toMatch(/^（系统说明，不是本人的回答：以下问题未交给本人——「ECE 548 每周上课地点？」/);
  expect(store.listEvents(ws, { type: "ask.answered" }).at(-1)!.payload).toMatchObject({ askId: "iq:q-goal", optionIds: ["o0", "o1"], note: "顺便把课程项目做成论文素材" });
});

test("a single-choice question takes one option; answers left waiting by dead questions are sent once nothing is left to answer", async () => {
  const { store } = setup();
  seedReadyToStart(store, ws);
  expect(await answerAsk(TEST_CTX, "iq:gap-meetings-ece548", { optionIds: ["write", "file"] }, {})).toMatchObject({ ok: false, code: "ASK_SINGLE_CHOICE" });
  // The person answered one question; the other two then stop being asked (the class times turn up in a file).
  expect(await answerAsk(TEST_CTX, "iq:q-meetings", "free", { other: "周三 10:00 组会" })).toMatchObject({ ok: true });
  for (const project of ["ece548", "ece555"]) store.upsertProfileFact({ workspaceId: ws, identityId: "research", projectId: project, slot: "meeting_times",
    value: "周二四", status: "confirmed", sourceRef: "src-1", sourceQuote: "周二四", updatedAt: "2026-10-08T00:00:00Z" });
  expect(interviewStatus(TEST_CTX).questions).toEqual([]);
  expect(supervisor).not.toHaveBeenCalled();
  const { flushPendingAnswers } = await import("./interview-status");
  const sends: string[] = [];
  expect(await flushPendingAnswers(TEST_CTX, async (_session, text) => { sends.push(text); })).toBe(true);
  expect(sends).toEqual(["【组会和导师 1V1 的固定时间？】补充：周三 10:00 组会"]);
  expect(await flushPendingAnswers(TEST_CTX, async (_session, text) => { sends.push(text); })).toBe(false);
});

test("the same TBD date twice in one batch is one card, and an answered one is not asked again", () => {
  const { store } = setup();
  seedReadyToStart(store, ws);
  const undated = { id: "x", kind: "project_due", title: "ECE 555 期末课程项目报告截止", project: "ECE 555", sourceRef: "src-1", quote: "TBD" };
  store.appendEvent({ ownerId: "o", workspaceId: ws, idempotencyKey: "dates:1", type: "dates.extracted", entityId: "batch-1",
    payload: { dates: [], recurring: [], undated: [undated, { ...undated, id: "y", sourceRef: "reply-21", quote: "还不知道" }] } });
  const cards = interviewStatus(TEST_CTX).questions.filter((question) => question.id.startsWith("gap-undated-"));
  expect(cards).toHaveLength(1);
  store.upsertProfileFact({ workspaceId: ws, identityId: "research", projectId: "ece555", slot: "undated_6uyhx6",
    value: "「ECE 555」的「ECE 555 期末课程项目报告截止」文件里写的是待定，不是日期。还不知道", status: "confirmed", sourceRef: "reply-21", sourceQuote: "还不知道", updatedAt: "2026-10-08T00:00:00Z" });
  expect(interviewStatus(TEST_CTX).questions.some((question) => question.id.startsWith("gap-undated-"))).toBe(false);
});

test("answers given before the screen to questions it now keeps from the person are dropped; with nothing left, nothing is sent", async () => {
  const { store } = setup();
  seedReadyToStart(store, ws);
  for (const project of ["ece548", "ece555"]) store.upsertProfileFact({ workspaceId: ws, identityId: "research", projectId: project, slot: "meeting_times",
    value: "周二四", status: "confirmed", sourceRef: "src-1", sourceQuote: "周二四", updatedAt: "2026-10-08T00:00:00Z" });
  const options = (...labels: string[]) => labels.map((label, index) => ({ id: `o${index}`, label, detail: "" }));
  const seq = store.appendOnboardingMessage({ workspaceId: ws, sessionId: "s1", role: "assistant", createdAt: "2026-10-08T01:00:00Z",
    content: { reply: "…", nextAction: "ask", stage: "details", questions: [
      { id: "q-room", text: "ECE 548 每周上课地点？", kind: "free", allowOther: true, identityId: "research", projectId: "ece548", options: [] },
      { id: "q-calendar", text: "日历中的两项活动，哪些属于持续安排？", kind: "single", allowOther: true, identityId: "startup", projectId: "", options: options("Build Nights 每周", "DEJA-VU 每月") },
      { id: "q-data", text: "MoS₂ 真实测量数据处于什么状态？", kind: "single", allowOther: true, identityId: "research", projectId: "", options: options("仍未收到", "已收到") }] } });
  const answers = { "q-room": "【ECE 548 每周上课地点？】补充：engineering hall 3418", "q-calendar": "【日历中的两项活动，哪些属于持续安排？】选择：DEJA-VU 每月" };
  store.setSetting(ws, "onboarding.pendingAnswers", JSON.stringify({ sessionId: "s1", afterSeq: seq, answers }));
  const { flushPendingAnswers } = await import("./interview-status");
  const sends: string[] = [];
  // Only the screened answers wait, and one question is still open: nothing to flush yet.
  expect(await flushPendingAnswers(TEST_CTX, async (_session, text) => { sends.push(text); })).toBe(false);
  expect(await answerAsk(TEST_CTX, "iq:q-data", "o0", {})).toMatchObject({ ok: true });
  const sent = JSON.parse(String((supervisor.mock.calls[0] as unknown as [unknown, string, { body: string }])[2].body)) as { text: string };
  expect(sent.text).toContain("【MoS₂ 真实测量数据处于什么状态？】选择：仍未收到");
  expect(sent.text).not.toContain("engineering hall");
  expect(sent.text).not.toContain("选择：DEJA-VU 每月");
  // A round whose waiting answers were all to screened questions sends nothing and starts no interview round.
  store.setSetting(ws, "onboarding.pendingAnswers", JSON.stringify({ sessionId: "s1", afterSeq: seq, answers }));
  store.appendOnboardingMessage({ workspaceId: ws, sessionId: "s1", role: "assistant", createdAt: "2026-10-08T02:00:00Z",
    content: { reply: "…", nextAction: "ask", stage: "details", questions: [
      { id: "q-room", text: "ECE 548 每周上课地点？", kind: "free", allowOther: true, identityId: "research", projectId: "ece548", options: [] },
      { id: "q-calendar", text: "日历中的两项活动，哪些属于持续安排？", kind: "single", allowOther: true, identityId: "startup", projectId: "", options: options("Build Nights 每周", "DEJA-VU 每月") }] } });
  const last = store.listOnboardingMessages(ws, "s1").at(-1)!.seq;
  store.setSetting(ws, "onboarding.pendingAnswers", JSON.stringify({ sessionId: "s1", afterSeq: last, answers }));
  expect(await flushPendingAnswers(TEST_CTX, async (_session, text) => { sends.push(text); })).toBe(false);
  expect(sends).toEqual([]);
  expect(store.getSetting(ws, "onboarding.pendingAnswers")).toBe("null");
});

// W-13: the badge counted the profile's blocking gaps unscreened, so it showed 「访谈问题 1」 that no page listed.
// 2026-10-29 (scenarios.md §3.8): the interview's questions are answered in the interview; 待确认 links there with the count, outside the total.
test("the interview's questions are counted as the interview page shows them, outside the total and the listed asks", async () => {
  const { store } = setup();
  const { countPending } = await import("./pending");
  const { listed } = await import("./asks");
  const status = interviewStatus(TEST_CTX);
  expect(countPending(TEST_CTX).questions).toBe(status.openQuestions);
  seedReadyToStart(store, ws);
  const parked = countPending(TEST_CTX);
  expect(parked.questions).toBe(interviewStatus(TEST_CTX).openQuestions);
  expect(parked.questions).toBeGreaterThan(0);
  const { questions, relations, research, later, total, ...counted } = parked;
  expect(total).toBe(Object.values(counted).reduce((sum, value) => sum + value, 0));
  // Still raised (an answer typed into the box goes through), never listed.
  expect(collectAsks(TEST_CTX, SOON).filter((ask) => ask.kind.startsWith("interview_"))).toHaveLength(1);
  expect(listed(collectAsks(TEST_CTX, SOON)).filter((ask) => ask.kind.startsWith("interview_"))).toHaveLength(0);
});

test("a snoozed interview question gives way to the next one; answering a question not listed still works", async () => {
  const { store } = setup();
  seedReadyToStart(store, ws);
  const { snoozeAsk } = await import("./asks");
  expect(snoozeAsk(TEST_CTX, "iq:q-meetings", "tomorrow", SOON)).toMatchObject({ ok: true });
  expect(collectAsks(TEST_CTX, SOON).filter((ask) => ask.kind === "interview_question").map((ask) => ask.entityId)).toEqual(["gap-meetings-ece555"]);
  expect(await answerAsk(TEST_CTX, "iq:gap-meetings-ece548", "write", { other: "周二、四 11:00–12:15" }, SOON)).toMatchObject({ ok: true });
});
