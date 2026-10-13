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
  const asks = collectAsks(TEST_CTX, SOON);
  expect(asks.find((ask) => ask.kind === "interview_open")).toMatchObject({ title: "访谈未完成", options: [{ label: "回到访谈", href: "/onboarding" }] });
  expect(asks.filter((ask) => ask.kind === "interview_question").map((ask) => ask.title)).toEqual(["组会和导师 1V1 的固定时间？", "「ECE 555」每周什么时候上课、在哪里？", "「ECE 548」每周什么时候上课、在哪里？"]);
  expect(asks.filter((ask) => ask.kind === "source_project").map((ask) => ask.entityId).sort()).toEqual(["a", "b"]);

  expect(await answerAsk(TEST_CTX, "iq:q-meetings", "free", { other: "周三 10:00 组会" })).toMatchObject({ ok: true });
  expect(await answerAsk(TEST_CTX, "iq:gap-meetings-ece555", "file", {})).toMatchObject({ ok: true });
  expect(supervisor).not.toHaveBeenCalled();
  expect(await answerAsk(TEST_CTX, "iq:gap-meetings-ece548", "write", { other: "周二、四 11:00–12:15" })).toMatchObject({ ok: true });
  expect(supervisor).toHaveBeenCalledTimes(1);
  const sent = JSON.parse(String((supervisor.mock.calls[0] as unknown as [unknown, string, { body: string }])[2].body)) as { sessionId: string; text: string };
  expect(sent.sessionId).toBe("s1");
  expect(sent.text.split("\n")).toEqual(["【组会和导师 1V1 的固定时间？】补充：周三 10:00 组会", "【「ECE 555」每周什么时候上课、在哪里？】选择：上传的课程文件里有",
    "【「ECE 548」每周什么时候上课、在哪里？】选择：我来写上课时间。补充：周二、四 11:00–12:15"]);
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
