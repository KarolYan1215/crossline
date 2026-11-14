import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CrosslineStore, writeExtractState } from "@crossline/db";
import { cardWordsHead, ONBOARDING_PROGRESS_SETTING, PROFILE_INSTRUMENTS_SETTING, PROFILE_ITEMS, readInstrumentAnswers, scaleAnswerLine,
  DEPTH_PACE, type OnboardingProgress, type ProfileCard } from "@crossline/core";
import { cardsForRound, closingQuestion, createOnboardingSessionRunner as createRunner, finishInterview, INSTRUCTIONS, ONBOARDING_SKILL, paceDeepRound, shownOrOpen, stageOrderFor, stagePace, withChecklist, withFreshOpenQuestion, withoutEndHint } from "./onboarding-session";
import { INSTRUCTIONS as EXTRACT_INSTRUCTIONS } from "./onboarding-extract";
import { ONBOARDING_EXTRACT_SKILL } from "./onboarding-extract";
import { fakeRuntime as runtimeWithRoutes } from "./testing/fake-runtime";

/**
 * Both layers of a turn are answered from the same list: the dialogue reads its fields of each answer, the extraction (a thread of its
 * own, told apart by its context's version) reads the rest. Unless a test says otherwise the round waits for the extraction, so the
 * ledger can be read right after a turn.
 */
const EXTRACT = "crossline.onboarding.extract.v1";
const sharedRuntime = (answers: Array<string | ((prompts: string[]) => string)>, _skill: string, options: Parameters<typeof runtimeWithRoutes>[2] = {}) =>
  runtimeWithRoutes(answers, [ONBOARDING_SKILL, ONBOARDING_EXTRACT_SKILL], { routes: [{ match: EXTRACT, answers }], ...options });
const fakeRuntime = (answers: string[], options: { lostThreads?: string[] } = {}) => sharedRuntime(answers, ONBOARDING_SKILL, options);
/** The prompts of one layer: the dialogue's thread, or the extraction's fresh threads (each first prompt carries its version). */
const dialogue = (prompts: () => string[]) => prompts().filter((prompt) => !prompt.includes(EXTRACT) && !prompt.includes("search_evidence"));
const extraction = (prompts: () => string[]) => prompts().filter((prompt) => prompt.includes(EXTRACT));
const createOnboardingSessionRunner = (...args: Parameters<typeof createRunner>) =>
  createRunner(args[0], args[1], args[2], args[3], { extract: "await", lanes: false, ...(args[4] ?? {}) });
let store: CrosslineStore;
let workspaceId: string;

beforeEach(() => {
  store = new CrosslineStore(":memory:");
  workspaceId = store.createPrincipalWithWorkspace("user-1", "个人 workspace").workspace.id;
});
afterEach(() => { store.close(); vi.unstubAllEnvs(); });

const turn = (over: object = {}) => JSON.stringify({
  reply: "收到，我先确认几件事。",
  questions: [{ id: "q1", text: "项目 A 的图表清单在哪？", kind: "single", allowOther: true, identityId: "research", projectId: "westlake",
    options: [{ id: "a", label: "师兄给的文档", detail: "" }, { id: "b", label: "只在聊天记录里", detail: "" }] }],
  slotUpdates: [], projectsDetected: [], flywheelCandidates: [], coverage: [], nextAction: "ask", ...over
});

const firstAnswer = turn({
  projectsDetected: [{ id: "westlake", identityId: "research", name: "西湖合作：MoS2 忆阻器片上训练", summary: "负责仿真和算法" }],
  slotUpdates: [{ identityId: "research", projectId: "westlake", slot: "deadline", value: "10/31 前投出", status: "confirmed",
    refs: [1] }],
  flywheelCandidates: [{ fromIdentityId: "research", toIdentityId: "media", kind: "informs", explanation: "研究过程是自媒体的选题来源",
    refs: [], status: "inferred" }],
  coverage: [{ identityId: "research", filled: ["deadline"], missing: ["stage"] }]
});

test("a first turn opens a thread, saves the reply, and writes the projects and facts it learned", async () => {
  const { rpc } = fakeRuntime([firstAnswer]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
  const outcome = await run({ sessionId: "s1", text: "西湖那篇 10/31 前要投出，数据下周到。" });
  expect(outcome).toEqual({ state: "asked", sessionId: "s1" });

  expect(store.listProjects(workspaceId).map((project) => project.name)).toEqual(["西湖合作：MoS2 忆阻器片上训练"]);
  const facts = store.listProfileFacts(workspaceId);
  // The model cited sentence [1]; the quote is the person's own words, filled in from the ledger.
  expect(facts.find((fact) => fact.slot === "deadline")).toMatchObject({ value: "10/31 前投出", status: "confirmed", sourceRef: "reply-1",
    sourceQuote: "西湖那篇 10/31 前要投出，数据下周到。", sourceSentences: [1] });
  // A connection between lines is only ever a guess at this point.
  expect(facts.find((fact) => fact.slot === "flywheel_media_informs")).toMatchObject({ status: "inferred" });

  const messages = store.listOnboardingMessages(workspaceId, "s1");
  expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  expect(store.getOnboardingSession(workspaceId, "s1")).toMatchObject({ codexThreadId: expect.any(String), state: "active" });
});

test("while a turn is written the page can read what it holds so far, and nothing is left behind when it ends", async () => {
  let seen: OnboardingProgress | undefined;
  const key = `${ONBOARDING_PROGRESS_SETTING}:s1`;
  const { rpc } = sharedRuntime([firstAnswer], ONBOARDING_SKILL, { script: async ({ threadId, turnId, emit }) => {
    // The runtime streams the answer as it writes it: here, up to the middle of the facts.
    emit({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "m1", delta: firstAnswer.slice(0, firstAnswer.indexOf("flywheelCandidates")) } });
    seen = JSON.parse(store.getSetting(workspaceId, key) ?? "null") as OnboardingProgress;
  } });
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
  await run({ sessionId: "s1", text: "西湖那篇 10/31 前要投出，数据下周到。" });
  expect(seen).toMatchObject({ sessionId: "s1", phase: "writing", reply: "收到，我先确认几件事。", questions: 1, facts: 1, dates: 0, repairs: 0 });
  expect(store.getSetting(workspaceId, key)).toBeUndefined();
});

test("a connected calendar's coming week goes to the interview on the first turn, and again only when it changed", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const plan = (title: string) => store.savePlanVersion({ id: "plan-1", ownerId: "user-1", workspaceId, version: 1, status: "current", payload: { blocks: [
    { id: "graph_calendar:ical:s1:class@x:1", day: today, title, start: "11:00", end: "12:15", source: "课表", lane: "human", readOnly: true }] } });
  plan("ECE 548 Lecture");
  const { rpc, prompts } = fakeRuntime([firstAnswer, turn(), turn()]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
  expect(await run({ sessionId: "s1", text: "西湖那篇 10/31 前要投出，数据下周到。" })).toEqual({ state: "asked", sessionId: "s1" });
  await run({ sessionId: "s1", text: "好的" });
  plan("ECE 548 Lecture (room 1610)");
  await run({ sessionId: "s1", text: "继续" });
  const sent = dialogue(prompts).map((prompt) => prompt.includes("\"calendar\""));
  expect(sent).toEqual([true, false, true]);
  expect(dialogue(prompts)[0]).toContain("ECE 548 Lecture");
});

test("the second turn continues the same thread and only carries what is new, with what the extraction recorded since", async () => {
  const { rpc, prompts, threadStarts } = fakeRuntime([firstAnswer, turn()]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
  await run({ sessionId: "s1", text: "西湖那篇 10/31 前要投出，数据下周到。" });
  await run({ sessionId: "s1", text: "图表清单在师兄给的文档里" });
  // One dialogue thread; each extraction on a thread of its own.
  expect(dialogue(prompts)).toHaveLength(2);
  expect(extraction(prompts)).toHaveLength(2);
  expect(threadStarts()).toHaveLength(3);
  expect(dialogue(prompts)[1]).not.toContain("identities");
  expect(dialogue(prompts)[1]).toContain("reply-3");
  // The first turn's extraction wrote the deadline; the dialogue hears of it on the next turn.
  expect(dialogue(prompts)[1]).toContain("research/westlake · deadline = 10/31 前投出（确认）");
  expect(store.listOnboardingMessages(workspaceId, "s1").map((message) => message.seq)).toEqual([1, 2, 3, 4]);
});

test("a file reaches the dialogue once as text and the extraction once as numbered sentences, and a fact citing two of them gets their words", async () => {
  store.saveSourceDocument({ id: "d1", ownerId: "o", workspaceId, kind: "docx", fileName: "Lecture Plan.docx",
    mediaType: "application/octet-stream", sha256: "x", uri: "file:///x", extractedText: "Week-8: 27th Oct.\nL15: Mid-term-1",
    extractionStatus: "done", createdAt: "2026-10-02T00:00:00.000Z" });
  const answer = turn({ questions: [], nextAction: "ready_for_milestones", slotUpdates: [{ identityId: "research", projectId: "", slot: "midterm", value: "10/27 期中 1", status: "confirmed",
    refs: [2, 3] }] });
  const { rpc, prompts } = fakeRuntime([answer, turn()]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
  await run({ sessionId: "s", text: "我上传了课程文件" });
  expect(dialogue(prompts)[0]).toContain("Lecture Plan.docx");
  expect(dialogue(prompts)[0]).toContain("Week-8: 27th Oct.\\nL15: Mid-term-1");
  expect(dialogue(prompts)[0]).not.toContain("[2]");
  expect(extraction(prompts)[0]).toContain("[2] Week-8: 27th Oct.\\n[3] L15: Mid-term-1");
  expect(store.listProfileFacts(workspaceId).find((fact) => fact.slot === "midterm")).toMatchObject({ sourceRef: "src-1", status: "confirmed",
    sourceQuote: "Week-8: 27th Oct.\nL15: Mid-term-1", sourceSentences: [2, 3] });
  await run({ sessionId: "s", text: "继续" });
  // Already announced and extracted: not sent again to either.
  expect(dialogue(prompts)[1]).not.toContain("Lecture Plan.docx");
  expect(extraction(prompts)[1]).not.toContain("Lecture Plan.docx");
});

test("a fact citing a sentence number the extraction was not shown is dropped without a repair; the round still reaches the person", async () => {
  const bad = turn({ slotUpdates: [{ identityId: "research", projectId: "", slot: "deadline", value: "10/15", status: "confirmed", refs: [99] }] });
  const { rpc, prompts } = fakeRuntime([bad]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
  expect(await run({ sessionId: "s", text: "10/31 前要投出" })).toMatchObject({ state: "asked" });
  // One bad item is dropped at once (`keepEarly`) instead of a full rewrite; nothing invented is kept.
  expect(extraction(prompts)).toHaveLength(1);
  expect(prompts()).toHaveLength(2);
  expect(store.listProfileFacts(workspaceId)).toEqual([]);
  expect(store.listEvents(workspaceId, { type: "onboarding.extracted" })[0]?.payload).toMatchObject({ replies: 1, facts: 0 });
  expect(store.listOnboardingMessages(workspaceId, "s").map((message) => message.role)).toEqual(["user", "assistant"]);
});

test("retrying after a failure does not save the person's message a second time", async () => {
  // Three bad answers: the first try and both repairs.
  const { rpc } = fakeRuntime(["not json", "not json", "not json", firstAnswer]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
  const failed = await run({ sessionId: "s", text: "西湖那篇 10/31 前要投出" });
  expect(failed.state).toBe("blocked");
  const retried = await run({ sessionId: "s", text: "" });
  expect(retried.state).toBe("asked");
  expect(store.listOnboardingMessages(workspaceId, "s").filter((message) => message.role === "user")).toHaveLength(1);
});

test("the main interview never ends itself: a model that is done asks whether there is more, and only the person's finish ends it", async () => {
  const { rpc } = fakeRuntime([turn({ questions: [], nextAction: "ready_for_milestones" })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { checklist: false, extract: "off" });
  expect(await run({ sessionId: "s", text: "都说完了" })).toEqual({ state: "asked", sessionId: "s" });
  const last = store.listOnboardingMessages(workspaceId, "s").at(-1)!.content as { nextAction: string; questions: Array<{ id: string; text: string }> };
  expect(last.nextAction).toBe("ask");
  expect(last.questions.map((question) => question.id)).toEqual(["closing-open"]);
  expect(last.questions[0]!.text).toContain("结束并出报告");
  expect(store.getOnboardingSession(workspaceId, "s")?.state).toBe("active");
  const { outcome } = finishInterview(store, workspaceId, "C:\\repo", () => rpc, "s", { extract: false });
  expect(outcome).toEqual({ state: "finished", sessionId: "s" });
  expect(store.getOnboardingSession(workspaceId, "s")?.state).toBe("complete");
  expect(store.listEvents(workspaceId, { type: "onboarding.finish_requested" })).toHaveLength(1);
});

test("after 「结束并出报告」 the portrait waits for the extraction only so long: a provider that never answers settles it as late", async () => {
  const now = new Date().toISOString();
  store.saveOnboardingSession({ id: "s", ownerId: "user-1", workspaceId, state: "active", coverage: {}, createdAt: now, updatedAt: now });
  store.appendOnboardingMessage({ sessionId: "s", workspaceId, role: "user", content: { text: "都说完了" }, createdAt: now });
  const silent = { request: () => new Promise(() => {}), onNotification: () => () => {} } as never;
  const { settled } = finishInterview(store, workspaceId, "C:\\repo", () => silent, "s", { lanes: false, budgetMs: 50 });
  expect(await settled).toBe("late");
  expect(store.getOnboardingSession(workspaceId, "s")?.state).toBe("complete");
});

test("before the start standard stands, a model that is done is not shown 「可以按结束」: the round asks what is still owed", async () => {
  const { rpc, prompts } = fakeRuntime([turn({ questions: [], nextAction: "ready_for_milestones" })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\repo", () => rpc, { extract: "off" });
  expect(await run({ sessionId: "s", text: "都说完了" })).toEqual({ state: "asked", sessionId: "s" });
  const last = store.listOnboardingMessages(workspaceId, "s").at(-1)!.content as { questions: Array<{ id: string; text: string }> };
  expect(last.questions.length).toBeGreaterThan(0);
  expect(last.questions[0]!.id).toMatch(/^checklist-open-/);
  expect(last.questions.some((question) => question.text.includes("结束并出报告"))).toBe(false);
  // The model is told outright that the lower bound does not stand yet, and what it lacks.
  expect(dialogue(prompts)[0]).toContain('"startStandard":{"met":false,"missing":[');
});

test("once every open question is used up, the round asks whether there is more instead of the stage's own question again", () => {
  const round = { reply: "记下了。", stage: "lines", nextAction: "ask", coverage: [],
    questions: [{ id: "open-lines", text: "哪条主线你最想先说清楚：现在在做什么、想做成什么样？", kind: "free", allowOther: true, identityId: "", projectId: "", options: [] }] };
  const used = () => false;
  const closing = closingQuestion();
  expect((withFreshOpenQuestion(round as never, used, undefined, closing) as typeof round).questions.map((question) => question.id)).toEqual(["closing-open"]);
  // Without the closing question (a line's own interview, or before the start standard) the stage's own stands, as before.
  expect((withFreshOpenQuestion(round as never, used) as typeof round).questions.map((question) => question.id)).toEqual(["open-lines"]);
  // One still unused is asked first.
  const fresh = (withFreshOpenQuestion(round as never, (text) => text.startsWith("说说你现在的处境"), undefined, closing) as typeof round).questions;
  expect(fresh.map((question) => question.id)).toEqual(["open-situation"]);
});

test("before the start standard stands the reply does not point at the end button", () => {
  const reply = "课表这一段已经按你说的记下。要用的几样都在了，这周先开口找导师的顺序不变。按页面上的「结束并出报告」就会出报告。";
  expect(withoutEndHint(reply)).toBe("课表这一段已经按你说的记下。要用的几样都在了，这周先开口找导师的顺序不变。");
  expect(withoutEndHint("访谈问到这里，可以按页面上的「结束并出报告」生成报告。\n\n还缺课表。")).toBe("还缺课表。");
  expect(withoutEndHint("开始要用的几项齐了。你可以开始使用应用了，访谈这边还可以继续。最后核对一次现状。")).toBe("开始要用的几项齐了。最后核对一次现状。");
  // A reply that is nothing but the hint stays as it is rather than going blank.
  expect(withoutEndHint("按「结束并出报告」就会出报告。")).toBe("按「结束并出报告」就会出报告。");
});

test("with no Codex runtime the turn is a blocker and saves nothing", async () => {
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => undefined);
  expect(await run({ sessionId: "s", text: "你好" })).toMatchObject({ state: "blocked", code: "CODEX_SUPERVISOR_UNAVAILABLE" });
  expect(store.getOnboardingSession(workspaceId, "s")).toBeUndefined();
});

test("a thread the runtime has forgotten is replaced, and the new one is told what was said before", async () => {
  const { rpc, prompts } = fakeRuntime([turn()], { lostThreads: ["gone-thread"] });
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { checklist: false });
  const now = "2026-10-02T00:00:00.000Z";
  const ownerId = store.getWorkspaceOwnerId(workspaceId)!;
  store.saveOnboardingSession({ id: "s1", ownerId, workspaceId, state: "active", coverage: {}, codexThreadId: "gone-thread", createdAt: now, updatedAt: now });
  store.saveProject({ id: "westlake", ownerId, workspaceId, identityId: "research", name: "西湖合作", status: "active", summary: "", createdAt: now, updatedAt: now });
  store.appendOnboardingMessage({ sessionId: "s1", workspaceId, role: "user", content: { text: "西湖那篇 10/31 前要投出" }, createdAt: now });
  store.appendOnboardingMessage({ sessionId: "s1", workspaceId, role: "assistant", content: JSON.parse(turn()), createdAt: now });

  expect(await run({ sessionId: "s1", text: "图表清单在师兄给的文档里" })).toEqual({ state: "asked", sessionId: "s1" });

  const saved = store.getOnboardingSession(workspaceId, "s1");
  expect(saved?.codexThreadId).toMatch(/^thread-\d$/);
  // The new thread's first prompt carries the earlier lines, with the user's own reply id.
  const prompt = dialogue(prompts).find((item) => item.includes("history")) ?? "";
  expect(prompt).toContain("history");
  expect(prompt).toContain("西湖那篇 10/31 前要投出");
  expect(prompt).toContain("reply-1");
  expect(store.listOnboardingMessages(workspaceId, "s1").map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
});

/** The day these date tests were written on: the files' 27 October must still lie ahead, or it is dropped as past. */
const pinBeforeExam = () => vi.stubEnv("CROSSLINE_FIXED_NOW", "2026-10-19T12:00:00.000Z");
const withDates = (fileDates: object) => turn({ fileDates, questions: [], nextAction: "ready_for_milestones" });
/** The portrait's sections closed, so a test about dates is not also asked for the sections a finished interview owes (P3). */
const sectionsClosed = () => store.setSetting(workspaceId, "profile.sections", JSON.stringify(Object.fromEntries(["narrative", "situation", "compass", "energy", "synthesis"]
  .map((section) => [section, { sentences: [1], final: true, at: "2026-10-19T00:00:00.000Z" }]))));
const dateItem = (over: object = {}) => ({ id: "d1", date: "2027-10-27", startMinute: null, endMinute: null, kind: "exam", title: "ECE 548 期中 1", project: "",
  refs: [2, 3], confidence: "high", note: "", ...over });

test("dates the model read out of a file become one verified batch, and what cannot be verified is dropped and counted", async () => {
  pinBeforeExam();
  store.saveSourceDocument({ id: "doc-1", ownerId: "o", workspaceId, kind: "docx", fileName: "Lecture Plan.docx", mediaType: "x", sha256: "1", uri: "file:///1",
    extractedText: "Week-8: 27th Oct.\nL15: Mid-term-1\nExam: 17th December Wednesday", extractionStatus: "done", createdAt: "2026-10-02T00:00:00.000Z" });
  const { rpc } = fakeRuntime([withDates({
    // [2] says 27 October: a date of 3 November citing it is dropped.
    dates: [dateItem(), dateItem({ id: "d2", title: "编造的考试", date: "2027-11-03", refs: [2] })],
    recurring: [], questions: ["这些材料是哪门课的？"]
  })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { checklist: false });
  expect((await run({ sessionId: "s1", text: "我添加了文件" })).state).toBe("asked");
  const [batch] = store.listEvents(workspaceId, { type: "dates.extracted" });
  const payload = batch!.payload as { documentIds: string[]; dates: Array<{ id: string; title: string }>; questions: string[]; dropped: Array<{ id: string }> };
  expect(payload.documentIds).toEqual(["doc-1"]);
  // Stored under an id made from what the date is, so a later run's own d1 can never replace it.
  expect(payload.dates.map((item) => item.title)).toEqual(["ECE 548 期中 1"]);
  expect(payload.dates[0]!.id).toMatch(/^d-[0-9a-z]+$/);
  expect(payload.dropped.map((item) => item.id)).toEqual(["d2"]);
  expect(payload.questions).toEqual(["这些材料是哪门课的？"]);
});

test("a turn with no dates writes no batch, and a newer batch retires one nobody answered", async () => {
  pinBeforeExam();
  sectionsClosed();
  // Each extraction runs on a fresh thread and may cite only what it is shown: here, the reply of its own turn ([1], [2], [3]).
  const empty = { dates: [], recurring: [], questions: [] };
  const { rpc } = fakeRuntime([withDates(empty), withDates({ ...empty, dates: [dateItem({ refs: [2] })] }), withDates({ ...empty, dates: [dateItem({ refs: [3], title: "ECE 548 期中 2" })] })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { checklist: false });
  await run({ sessionId: "s1", text: "没有日期" });
  expect(store.listEvents(workspaceId, { type: "dates.extracted" })).toHaveLength(0);
  await run({ sessionId: "s1", text: "ECE 548 期中 10/27" });
  await run({ sessionId: "s1", text: "另一场也在 10/27" });
  expect(store.listEvents(workspaceId, { type: "dates.extracted" })).toHaveLength(2);
  const retired = store.listEvents(workspaceId, { type: "dates.decided" });
  expect(retired).toHaveLength(1);
  expect(retired[0]!.payload).toMatchObject({ superseded: true });
  // A later turn adds to the batch nobody answered; it does not throw the earlier dates away, though both runs called theirs d1.
  const latest = store.listEvents(workspaceId, { type: "dates.extracted" }).at(-1)!.payload as { dates: Array<{ title: string }> };
  expect(latest.dates.map((item) => item.title).sort()).toEqual(["ECE 548 期中 1", "ECE 548 期中 2"]);
});

test("a re-read of the files replaces the unanswered batch; meals outside the stated hours never become a batch", async () => {
  pinBeforeExam();
  sectionsClosed();
  store.saveSourceDocument({ id: "doc-1", ownerId: "o", workspaceId, kind: "docx", fileName: "Lecture Plan.docx", mediaType: "x", sha256: "1", uri: "file:///1",
    extractedText: "Week-8: 27th Oct.\nL15: Mid-term-1", extractionStatus: "done", createdAt: "2026-10-02T00:00:00.000Z" });
  const empty = { dates: [], recurring: [], questions: [] };
  const meal = { id: "lunch", title: "午饭", project: "个人安排", weekdays: [0, 1, 2, 3, 4, 5, 6], startMinute: 720, endMinute: 840, from: "2026-10-12",
    to: "2026-12-31", exceptions: [], location: "", refs: [4], confidence: "medium" };
  const hours = { windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMinute: 540, endMinute: 720, energy: "high" }, { days: [0, 1, 2, 3, 4, 5, 6], startMinute: 840, endMinute: 1080, energy: "medium" }], why: "本人所述" };
  const { rpc } = fakeRuntime([withDates({ ...empty, dates: [dateItem()] }),
    turn({ fileDates: { ...empty, recurring: [meal] }, availability: hours, questions: [], nextAction: "ready_for_milestones" }),
    withDates({ ...empty, dates: [dateItem({ title: "ECE 548 期中 1（重读）" })] })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { checklist: false });
  await run({ sessionId: "s1", text: "我添加了文件" });
  // The meals are what the hours already leave out: no batch, and the course's date still waits for an answer.
  await run({ sessionId: "s1", text: "上午 9–12 点效率最高，12–14 点午饭" });
  expect(store.listEvents(workspaceId, { type: "dates.extracted" })).toHaveLength(1);
  expect(store.getSetting(workspaceId, "schedule.availability.proposed")).toContain("09:00");
  await run({ sessionId: "s1", text: "请重新读一遍日期", reread: true });
  const latest = store.listEvents(workspaceId, { type: "dates.extracted" }).at(-1)!.payload as { dates: Array<{ title: string }> };
  expect(latest.dates.map((item) => item.title)).toEqual(["ECE 548 期中 1（重读）"]);
});

const course = turn({
  projectsDetected: [{ id: "ece555", identityId: "research", name: "ECE 555", summary: "课程" }],
  slotUpdates: [
    { identityId: "research", projectId: "ece555", slot: "grading", value: "作业 20%、小测 30%、项目 25%、期末 25%", status: "confirmed", refs: [1] },
    { identityId: "research", projectId: "ece555", slot: "goal", value: "拿高分", status: "confirmed", refs: [1] },
    { identityId: "research", projectId: "ece555", slot: "deadline", value: "2026-12-15", status: "confirmed", refs: [1] }
  ],
  questions: [], nextAction: "ready_for_milestones"
});

test("a course's target grade is not asked: the architect proposes one later, so a finished interview stays finished", async () => {
  const { rpc } = fakeRuntime([course]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { checklist: false });
  expect(await run({ sessionId: "s", text: "ECE 555 评分：作业 20%、小测 30%、项目 25%、期末 25%，我想拿高分，期末 2026-12-15" })).toEqual({ state: "asked", sessionId: "s" });
  expect(store.listProfileFacts(workspaceId).some((fact) => fact.slot === "target_grade")).toBe(false);
});

const guessOnly = turn({
  slotUpdates: [{ identityId: "startup", projectId: "", slot: "what", value: "可能在做某个产品", status: "inferred", refs: [] }],
  questions: [], nextAction: "ready_for_milestones"
});

test("the model saying it is done does not make it so: a line resting only on its own guesses turns it back into a question", async () => {
  const { rpc } = fakeRuntime([guessOnly]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { checklist: false });
  expect(await run({ sessionId: "s", text: "随便聊聊" })).toEqual({ state: "asked", sessionId: "s" });
  const asked = store.listOnboardingMessages(workspaceId, "s").at(-1)!.content as { questions: Array<{ id: string }>; nextAction: string };
  expect(asked.nextAction).toBe("ask");
  expect(asked.questions.map((question) => question.id)).toContain("gap-line-startup");
});

test("declining the line is recorded by the app itself", async () => {
  const { rpc } = fakeRuntime([guessOnly, turn({ questions: [], nextAction: "ready_for_milestones" })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { checklist: false });
  await run({ sessionId: "s", text: "随便聊聊" });
  const question = (store.listOnboardingMessages(workspaceId, "s").at(-1)!.content as { questions: Array<{ id: string; text: string }> }).questions.find((item) => item.id === "gap-line-startup")!;
  expect(await run({ sessionId: "s", text: `【${question.text}】选择：目前没有在做的事` })).toEqual({ state: "asked", sessionId: "s" });
  expect(store.listProfileFacts(workspaceId).find((fact) => fact.slot === "skipped")).toMatchObject({ identityId: "startup", status: "confirmed", sourceRef: "reply-3" });
});

test("with the completion list on, a 「ready」 goes back to asking, and the checklist's labels never reach the person", async () => {
  const { rpc } = fakeRuntime([turn({ questions: [], nextAction: "ready_for_milestones" })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
  expect(await run({ sessionId: "s", text: "都说完了" })).toEqual({ state: "asked", sessionId: "s" });
  expect(store.getOnboardingSession(workspaceId, "s")?.state).toBe("active");
  const last = store.listOnboardingMessages(workspaceId, "s").at(-1)!.content as { reply: string; questions: unknown[] };
  // What is still owed is asked as questions; the checklist's labels never reach the person.
  expect(last.reply).not.toMatch(/已收集|硬约束|定语|还缺/);
  expect(last.questions.length).toBeGreaterThan(0);
});

const attributes = ["神经形态计算", "器件物理", "严谨", "独立", "持续产出", "被同行认可"]
  .map((text, index) => ({ text, kind: index < 2 ? "domain" : index < 4 ? "ability" : "state", refs: [1] }));

test("a line card's turn is that line's own interview: attributes refresh by line, and a goal change waits for the person", async () => {
  store.setSetting(workspaceId, "lines.profiles", JSON.stringify({ research: { description: "旧描述",
    attributes: [{ text: "类脑芯片方向能带队", kind: "domain", sourceRef: "goal" }, { text: "旧候选", kind: "domain", sourceRef: "reply-0" }] },
    media: { description: "自媒体描述", goalCandidates: ["成为有影响力的科普创作者"] } }));
  const answer = turn({ questions: [], nextAction: "ready_for_milestones",
    lineProfiles: [{ lineId: "research", description: "以器件物理为底的神经形态计算研究", attributeCandidates: attributes }],
    goalEdits: [{ lineId: "research", parts: [{ text: "器件物理", kind: "domain" }, { text: "能独立立项", kind: "ability" }], refs: [1] }] });
  const { rpc, prompts } = fakeRuntime([answer]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
  expect(await run({ sessionId: "line-research", text: "把目标改成器件物理方向能独立立项的研究者" })).toEqual({ state: "ready", sessionId: "line-research" });
  expect(prompts()[0]).toContain("\"focusLine\":{\"id\":\"research\"");
  const profiles = JSON.parse(store.getSetting(workspaceId, "lines.profiles")!) as Record<string, { description: string; attributes?: Array<{ text: string; sourceRef: string }>; goalCandidates?: string[] }>;
  // The new candidates replace the old ones, but what was split from the adopted goal stays; the other line is untouched.
  expect(profiles.research!.description).toBe("以器件物理为底的神经形态计算研究");
  expect(profiles.research!.attributes!.map((item) => item.text)).toEqual([...attributes.map((item) => item.text), "类脑芯片方向能带队"]);
  expect(profiles.media).toEqual({ description: "自媒体描述", goalCandidates: ["成为有影响力的科普创作者"] });
  // Not applied: recorded for the card to show, in the person's order.
  expect(JSON.parse(store.getSetting(workspaceId, "lines.goalEdits")!)).toMatchObject({ research: { parts: ["器件物理", "能独立立项"], sourceRef: "reply-1" } });
  expect(store.getSetting(workspaceId, "lines.v1")).toBeUndefined();
});

test("a turn that leaves a line's candidates empty keeps those on record and only refines its description", async () => {
  const stored = attributes.map(({ refs: _refs, ...item }) => ({ ...item, sourceRef: "reply-1" }));
  store.setSetting(workspaceId, "lines.profiles", JSON.stringify({ research: { description: "旧描述", attributes: stored } }));
  const { rpc } = fakeRuntime([turn({ questions: [], nextAction: "ready_for_milestones", lineProfiles: [{ lineId: "research", description: "新描述", attributeCandidates: [] }] })]);
  await createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc)({ sessionId: "line-research", text: "补充一点" });
  const profiles = JSON.parse(store.getSetting(workspaceId, "lines.profiles")!) as Record<string, { description: string; attributes: unknown[] }>;
  expect(profiles.research).toMatchObject({ description: "新描述", attributes: stored });
});

test("先读材料：首轮把已读出的文件全部带上，清单标出可开始项，新访谈从画像模块的经历阶段开始", async () => {
  for (const [id, fileName, text] of [["d1", "Resume.md", "博士二年级，研究忆阻器"], ["d2", "ECE555 Syllabus.md", "Final Exam: Dec 15"]] as const)
    store.saveSourceDocument({ id, ownerId: "o", workspaceId, kind: "text", fileName, mediaType: "text/markdown", sha256: id, uri: `file:///${id}`,
      extractedText: text, extractionStatus: "done", createdAt: "2026-10-02T00:00:00.000Z" });
  const { rpc, prompts } = fakeRuntime([turn()]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
  await run({ sessionId: "s", text: "材料已添加，请先从材料里读出能读的，再问还缺的。" });
  const prompt = dialogue(prompts)[0]!;
  const context = JSON.parse(prompt.slice(prompt.indexOf("{"), prompt.lastIndexOf("}") + 1)) as {
    sources: unknown[]; checklist: Array<{ start?: boolean }>; stage: string };
  expect(context.sources).toHaveLength(2);
  expect(context.checklist.some((item) => item.start === true)).toBe(true);
  expect(context.stage).toBe("narrative");
  expect(store.getOnboardingSession(workspaceId, "s")!.coverage).toMatchObject({ flow: "v2" });
});

test("the profile module's cards: added by the app beside the model's questions (they take none of its slots), taps scored, words left for the extraction", async () => {
  const texts: Record<string, string> = { q1: "小时候最佩服谁？", q2: "常看哪些账号？", q3: "最喜欢哪个故事？", q4: "为什么工作？", q5: "什么让生活值得？" };
  const free = (id: string) => ({ id, text: texts[id]!, kind: "free", allowOther: true, identityId: "person", projectId: "", options: [] });
  // The one interview there is asks the full card set.
  const { rpc } = fakeRuntime([turn({ stage: "compass", questions: [free("q1"), free("q2"), free("q3")] }),
    turn({ stage: "energy", questions: [free("q4")] }), turn({ stage: "energy", questions: [free("q5")] })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { checklist: false });
  await run({ sessionId: "s", text: "先从经历说起吧" });
  const lastCards = () => ((store.listOnboardingMessages(workspaceId, "s").filter((message) => message.role === "assistant").at(-1)!.content) as
    { cards?: ProfileCard[]; questions: Array<{ id: string }> });
  const first = lastCards();
  expect(first.cards!.length).toBeGreaterThan(0);
  expect(first.questions.map((question) => question.id)).toEqual(["q1", "q2", "q3"]);
  const [tapped] = first.cards!;
  await run({ sessionId: "s", text: tapped!.items.map((item) => scaleAnswerLine(item, 4)).join("\n") });
  const answers = () => readInstrumentAnswers(store.getSetting(workspaceId, PROFILE_INSTRUMENTS_SETTING));
  expect(tapped!.items.map((item) => answers()[item.id])).toEqual(tapped!.items.map(() => expect.objectContaining({ by: "tapped", score: 4 })));
  // The compass items the first round had no room for come before the energy part's own, three items at most.
  // The next round's cards are new items, never the ones already tapped, six at most.
  const second = lastCards();
  const tappedIds = new Set(tapped!.items.map((item) => item.id));
  expect(second.cards!.flatMap((card) => card.items).some((item) => tappedIds.has(item.id))).toBe(false);
  expect(second.cards!.flatMap((card) => card.items).length).toBeLessThanOrEqual(6);
  const [worded] = second.cards!;
  await run({ sessionId: "s", text: `${cardWordsHead(worded!)}：看人，熟了才放开` });
  expect(worded!.items.map((item) => answers()[item.id]!.by)).toEqual(worded!.items.map(() => "pending"));
  // Past the module, what is left comes one card a round.
  expect(cardsForRound("lines", new Set())).toHaveLength(1);
  expect(cardsForRound("lines", new Set(PROFILE_ITEMS.map((item) => item.id)))).toEqual([]);
  // Back at an earlier module stage with only later stages' items left: those still come.
  const later = new Set(PROFILE_ITEMS.filter((item) => item.stage !== "energy").map((item) => item.id));
  expect(cardsForRound("compass", later).flatMap((card) => card.items).every((item) => item.stage === "energy")).toBe(true);
  expect(cardsForRound("compass", later)).toHaveLength(1);
});
test("a round keeps independent questions together, at most three in any stage", () => {
  const two = JSON.parse(turn({ stage: "compass", questions: [
    { id: "q1", text: "工作对你意味着什么？", kind: "free", allowOther: true, identityId: "person", projectId: "", options: [] },
    { id: "q2", text: "人生的意义？", kind: "free", allowOther: true, identityId: "person", projectId: "", options: [] }] }));
  expect(paceDeepRound(two, false)).toMatchObject({ deep: true, output: { questions: [{ id: "q1" }, { id: "q2" }] } });
  const six = { ...two, questions: Array.from({ length: 6 }, (_, index) => ({ ...two.questions[0], id: `q${index + 1}` })) };
  expect(paceDeepRound(six, false).output.questions.map((question: { id: string }) => question.id)).toEqual(["q1", "q2", "q3"]);
  // A fact stage is capped the same way (five a round read as a form nobody finished, 2026-10-31); a line's own interview is not.
  expect(paceDeepRound({ ...six, stage: "lines" }, false)).toMatchObject({ deep: false });
  expect(paceDeepRound({ ...six, stage: "lines" }, false).output.questions).toHaveLength(3);
  expect(paceDeepRound(six, true).output.questions).toHaveLength(6);
  // A deeper tier keeps more of them (onboarding-depth.ts).
  expect(paceDeepRound(six, false, DEPTH_PACE.thorough.roundQuestions).output.questions).toHaveLength(5);
});

test("there are no tiers: a stored choice is ignored, no part is told to move on and there is no per-project details part", async () => {
  expect(stageOrderFor("v1", DEPTH_PACE.open)).not.toContain("details");
  const long = Array.from({ length: 40 }, () => ({ role: "assistant", content: { stage: "compass" } }));
  expect(stagePace(long, { startOpen: false, after: DEPTH_PACE.open.moveOnAfter }).moveOn).toBeUndefined();
  store.setSetting(workspaceId, "onboarding.depth", "quick");
  const { rpc, prompts } = fakeRuntime([firstAnswer]);
  await createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc)({ sessionId: "s1", text: "开始" });
  expect(dialogue(prompts)[0]).toContain('"depth":"open"');
  expect(dialogue(prompts)[0]).not.toContain('"details"]');
});
test("one voice: whatever tone an account stored, every turn is written in it", async () => {
  // Decision 10 of the 2026-11-12 redesign: 「直接犀利」 is built in; the 2026-10-18 choices (neutral, warm) read as it.
  store.setSetting(workspaceId, "onboarding.tone", "warm");
  const { rpc, prompts } = fakeRuntime([firstAnswer, turn()]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
  await run({ sessionId: "s1", text: "开始" });
  store.setSetting(workspaceId, "onboarding.tone", "neutral");
  await run({ sessionId: "s1", text: "继续" });
  expect(dialogue(prompts).every((prompt) => prompt.includes('"tone":"direct"'))).toBe(true);
});

test("a round keeps from the person what is not theirs to answer, writes the calendar's recurrence as an assumption, and reads a goal question as multiple choice", async () => {
  const options = (...labels: string[]) => labels.map((label, index) => ({ id: `o${index}`, label, detail: "" }));
  const { rpc } = fakeRuntime([turn({ questions: [
    { id: "q-goal", text: "西湖合作这学期最重要的目标？", kind: "single", allowOther: true, identityId: "research", projectId: "", options: options("投出论文", "跑通片上训练") },
    { id: "q-room", text: "组会在哪个房间？", kind: "free", allowOther: true, identityId: "research", projectId: "", options: [] },
    { id: "q-cal", text: "日历中的两项活动，哪些属于持续安排？", kind: "single", allowOther: true, identityId: "research", projectId: "", options: options("Build Nights 每周", "DEJA-VU 每月") }] })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\repo", () => rpc);
  await run({ sessionId: "s1", text: "西湖那篇 10/31 前要投出，数据下周到。" });
  const stored = store.listOnboardingMessages(workspaceId, "s1").at(-1)!.content as { questions: Array<{ id: string; kind: string }> };
  expect(stored.questions.filter((question) => question.id.startsWith("q-")).map((question) => [question.id, question.kind])).toEqual([["q-goal", "multi"]]);
  expect(store.listProfileFacts(workspaceId).find((fact) => fact.slot.startsWith("assumed_")))
    .toMatchObject({ status: "inferred", sourceRef: "inference", value: expect.stringMatching(/^假设：日历中的两项活动/) });
});

test("a 「符合」 for the portrait holds for the portrait the same turn rewrites, so it is not asked again next round", async () => {
  // The hosted walkthrough of 2026-10-16 answered 「符合」 four rounds running: each turn rewrote the portrait after the answer was
  // recorded against the old one, and the interview never reached 「已完成」.
  const { readFileSync } = await import("node:fs");
  const written = JSON.parse(readFileSync(new URL("./testing/fixtures/onboarding-profile.json", import.meta.url), "utf8")) as Record<string, unknown>;
  store.setSetting(workspaceId, "profile.model", JSON.stringify(written));
  // The three deep stages are over, so this run writes the synthesis (P3), the part a confirmation is about.
  const at = "2026-10-19T00:00:00.000Z";
  store.setSetting(workspaceId, "profile.sections", JSON.stringify({ narrative: { sentences: [1], final: true, at }, situation: { sentences: [1], final: true, at },
    compass: { sentences: [1], final: true, at }, energy: { sentences: [1], final: true, at } }));
  const rewritten = { ...written, portrait: "一位在毕业前同时押注研究与产品的工程师，靠打球和讨论充电，最怕的是五件事都停在七成。",
    coreConflict: "想把两条未来都留着，代价落在睡眠和周日下午上。" };
  const { rpc } = fakeRuntime([turn({ profileSections: { situation: null, compass: null, energy: null,
    synthesis: { portrait: rewritten.portrait, coreConflict: rewritten.coreConflict, allocation: written.allocation ?? "", refs: [] } },
    questions: [{ id: "q", text: "这周最想先收口哪件事？", kind: "free", options: [], allowOther: true, identityId: "", projectId: "" }] })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
  expect(await run({ sessionId: "s", text: "【「当前画像」写的是否符合本人？】选择：符合" })).toEqual({ state: "asked", sessionId: "s" });
  const { PROFILE_CONFIRMED, portraitStillConfirmed } = await import("@crossline/core");
  const confirmed = JSON.parse(store.getSetting(workspaceId, PROFILE_CONFIRMED) ?? "{}") as { fingerprint?: string };
  expect(JSON.parse(store.getSetting(workspaceId, "profile.model")!)).toMatchObject({ portrait: rewritten.portrait });
  expect(portraitStillConfirmed(confirmed.fingerprint, rewritten)).toBe(true);
});

test("the question ledger: a round's questions are numbered, an answer is recorded with its sentences, and asking it again is dropped", async () => {
  const ask = (repeats = 0) => ({ id: "q1", text: "西湖合作的图表清单由谁提供？", kind: "single", allowOther: true, identityId: "research", projectId: "",
    options: [{ id: "a", label: "师兄", detail: "" }, { id: "b", label: "导师", detail: "" }], repeats });
  const { rpc, prompts } = fakeRuntime([turn({ questions: [ask()] }), turn({ questions: [], nextAction: "ready_for_milestones" }), turn({ questions: [{ ...ask(), id: "q9" }] })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { checklist: false });
  await run({ sessionId: "s1", text: "西湖那篇 10/31 前要投出，数据下周到。" });
  const asked = store.questionByKey(workspaceId, "iq:s1:2:q1")!;
  expect(asked).toMatchObject({ status: "open", text: "西湖合作的图表清单由谁提供？" });
  await run({ sessionId: "s1", text: "【西湖合作的图表清单由谁提供？】选择：师兄" });
  expect(store.questionByKey(workspaceId, "iq:s1:2:q1")).toMatchObject({ status: "answered", answer: "选择：师兄" });
  expect(store.questionByKey(workspaceId, "iq:s1:2:q1")!.answerSentences.length).toBeGreaterThan(0);
  // The next prompt shows the ledger with that answer; a round asking it again in the same words loses that question.
  await run({ sessionId: "s1", text: "继续" });
  expect(prompts()[2]).toContain(`#${asked.id} [已答] 西湖合作的图表清单由谁提供？`);
  const last = store.listOnboardingMessages(workspaceId, "s1").at(-1)!.content as { questions: Array<{ id: string }> };
  expect(last.questions.map((question) => question.id)).not.toContain("q9");
  expect(store.listEvents(workspaceId, { type: "onboarding.questions_repeated" })[0]?.payload).toMatchObject({ dropped: [{ repeats: asked.id, why: "similar" }] });
});

test("an app question the model asks in its own words, naming its number, is not added beside it", async () => {
  const { rpc } = fakeRuntime([guessOnly, turn({ questions: [] })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { checklist: false });
  await run({ sessionId: "s", text: "随便聊聊" });
  const gap = store.questionByKey(workspaceId, "gap:gap-line-startup")!;
  expect(gap.status).toBe("open");
  const own = { id: "q-startup", text: "创业这条线你现在具体在做什么？", kind: "free", allowOther: true, identityId: "startup", projectId: "", options: [], repeats: gap.id };
  const { rpc: rpc2 } = fakeRuntime([turn({ questions: [own], nextAction: "ask" })]);
  // A second runner on the same ledger, so the second answer is the model's own question.
  await createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc2, { checklist: false })({ sessionId: "s2", text: "继续" });
  const round = store.listOnboardingMessages(workspaceId, "s2").at(-1)!.content as { questions: Array<{ id: string }> };
  expect(round.questions.map((question) => question.id)).toEqual(["q-startup"]);
});

test("a file read again since it was shown is shown to the dialogue again and extracted again with its new numbers", async () => {
  store.saveSourceDocument({ id: "d1", ownerId: "o", workspaceId, kind: "text", fileName: "Plan.txt", mediaType: "text/plain", sha256: "x", uri: "file:///x",
    extractedText: "Week-8: 27th Oct.", extractionStatus: "done", createdAt: "2026-10-02T00:00:00.000Z" });
  const done = turn({ questions: [], nextAction: "ready_for_milestones" });
  const { rpc, prompts } = fakeRuntime([done, done, done]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { checklist: false });
  await run({ sessionId: "s", text: "我上传了文件" });
  await run({ sessionId: "s", text: "继续" });
  expect(dialogue(prompts)[1]).not.toContain("Plan.txt");
  // Extraction ran again (a layout re-read): the next turn hands the file over again, numbered anew for the extraction.
  store.setSourceDocumentExtraction(workspaceId, "d1", { status: "done", text: "Week-8: 28th Oct." });
  await run({ sessionId: "s", text: "再继续" });
  const latest = store.sentencesOf(workspaceId, "document", "d1")[0]!;
  expect(dialogue(prompts)[2]).toContain("Week-8: 28th Oct.");
  expect(extraction(prompts).at(-1)).toContain(`[${latest.id}] Week-8: 28th Oct.`);
});

test("a re-read still accepts the numbers of files an earlier turn of the thread showed", async () => {
  store.saveSourceDocument({ id: "d1", ownerId: "o", workspaceId, kind: "text", fileName: "Plan.txt", mediaType: "text/plain", sha256: "x", uri: "file:///x",
    extractedText: "Week-8: 27th Oct.", extractionStatus: "done", createdAt: "2026-10-02T00:00:00.000Z" });
  const done = turn({ questions: [], nextAction: "ready_for_milestones" });
  const cite = (id: number) => turn({ questions: [], nextAction: "ready_for_milestones", slotUpdates: [{ identityId: "research", projectId: "", slot: "midterm", value: "10/27", status: "confirmed", refs: [id] }] });
  const { rpc } = fakeRuntime([done, cite(2)]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { checklist: false });
  await run({ sessionId: "s", text: "我上传了文件" });
  expect(store.sentencesOf(workspaceId, "document", "d1")[0]!.id).toBe(2);
  expect((await run({ sessionId: "s", text: "请重新读一遍", reread: true })).state).toBe("asked");
  expect(store.listProfileFacts(workspaceId).find((fact) => fact.slot === "midterm")).toMatchObject({ sourceRef: "src-1", sourceSentences: [2] });
});

test("a compacted conversation is not a forbidden tool; a round that stops says why and keeps saying it until the next attempt", async () => {
  const { ONBOARDING_LAST_FAILURE, readOnboardingFailure } = await import("@crossline/core");
  const compacting = sharedRuntime([turn(), turn()], ONBOARDING_SKILL, { script: async ({ emit, threadId, turnId }) => {
    emit({ method: "item/completed", params: { threadId, turnId, item: { type: "contextCompaction", id: "c1" } } });
  } });
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => compacting.rpc, { checklist: false, extract: "off" });
  expect(await run({ sessionId: "s", text: "我在读研。" })).toMatchObject({ state: "asked" });

  const acting = sharedRuntime([turn(), turn(), turn()], ONBOARDING_SKILL, { script: async ({ emit, threadId, turnId }) => {
    emit({ method: "item/completed", params: { threadId, turnId, item: { type: "commandExecution", id: "x1" } } });
  } });
  const refused = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => acting.rpc, { checklist: false, extract: "off" });
  const outcome = await refused({ sessionId: "s2", text: "第二段对话。" });
  expect(outcome).toMatchObject({ state: "blocked", code: "SKILL_TOOL_FORBIDDEN", detail: "item:commandExecution" });
  expect(readOnboardingFailure(store.getSetting(workspaceId, `${ONBOARDING_LAST_FAILURE}s2`))).toMatchObject({ code: "SKILL_TOOL_FORBIDDEN" });
  // The retry starts: the old reason goes, whatever the retry then does.
  await createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => sharedRuntime([turn(), turn()], ONBOARDING_SKILL).rpc, { checklist: false, extract: "off" })({ sessionId: "s2", text: "" });
  expect(store.getSetting(workspaceId, `${ONBOARDING_LAST_FAILURE}s2`)).toBeUndefined();
});

test("the progress record goes back to the model next round, and an observation is kept only when its quotes are the person's", async () => {
  const progress = { part: "energy", covered: ["心流时刻"], open: ["耗能的事"], partDone: false, next: "问什么事做完很累" };
  const insight = (quote: string) => ({ text: "你说投入的两次都是和人一起赶东西；底座主线是一个人做的研究。",
    refs: [{ replyId: "reply-1", quote: "和同学一起赶比赛" }, { replyId: "reply-3", quote }], falsifier: "如果独自做研究时也常投入到忘了时间" });
  const { rpc, prompts } = fakeRuntime([turn({ stage: "energy", progress, insight: { text: "", refs: [] } }),
    turn({ stage: "energy", progress: { ...progress, covered: ["心流时刻", "耗能的事"], open: [] }, insight: insight("一个人做研究") }),
    turn({ stage: "energy", progress, insight: insight("一个人做实验") })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { checklist: false, extract: "off" });
  await run({ sessionId: "s", text: "最投入的是和同学一起赶比赛的时候。" });
  await run({ sessionId: "s", text: "底座是我一个人做研究。" });
  expect(dialogue(prompts)[1]).toContain("上轮判断：第 3/6 部分「能量」未完成");
  expect(dialogue(prompts)[1]).toContain("abstract");
  const kept = store.listOnboardingMessages(workspaceId, "s").at(-1)!.content as { insight?: { refs: unknown[] }; progress?: { covered: string[] } };
  expect(kept.insight?.refs).toHaveLength(2);
  expect(kept.progress?.covered).toEqual(["心流时刻", "耗能的事"]);
  expect((store.getOnboardingSession(workspaceId, "s")!.coverage as { progress?: unknown }).progress).toMatchObject({ covered: ["心流时刻", "耗能的事"] });
  // A quote the person never wrote: the card goes, the round stays.
  await run({ sessionId: "s", text: "还有别的吗" });
  expect((store.listOnboardingMessages(workspaceId, "s").at(-1)!.content as { insight?: unknown }).insight).toBeUndefined();
});

test("observations come as often as there is evidence, never the same one twice", async () => {
  const insight = { text: "你说投入的两次都是和人一起赶东西；底座主线是一个人做的研究。",
    refs: [{ replyId: "reply-1", quote: "和同学一起赶比赛" }, { replyId: "reply-3", quote: "一个人做研究" }], falsifier: "如果独自做研究时也常投入到忘了时间" };
  const { rpc } = fakeRuntime([turn({ stage: "energy", insight: { text: "", refs: [] } }), turn({ stage: "energy", insight }),
    turn({ stage: "energy", insight }), turn({ stage: "compass", insight })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\repo", () => rpc, { checklist: false, extract: "off" });
  const kept = async (text: string) => {
    await run({ sessionId: "s", text });
    return Boolean((store.listOnboardingMessages(workspaceId, "s").at(-1)!.content as { insight?: unknown }).insight);
  };
  expect(await kept("最投入的是和同学一起赶比赛的时候。")).toBe(false);
  expect(await kept("底座是我一个人做研究。")).toBe(true);
  // The same words again are left out, in any part.
  expect(await kept("还有别的吗")).toBe(false);
  expect(await kept("看重的是把事做完。")).toBe(false);
});

test("a card's hypothesis is marked asked when it is shown, rated or not; one picked from the log keeps its id, a new one never takes an id on record", async () => {
  const refs = [{ replyId: "reply-1", quote: "和同学一起赶比赛" }, { replyId: "reply-3", quote: "一个人做研究" }];
  const fromLog = { text: "你说投入的两次都是和人一起赶东西。", refs, falsifier: "如果独自时也常投入", hypothesisId: "h1" };
  const fresh = { text: "你说底座主线是一个人做的研究。", refs, falsifier: "如果独自做研究时也常投入" };
  const { rpc } = fakeRuntime([turn({ stage: "energy", insight: { text: "", refs: [] } }), turn({ stage: "energy", insight: fromLog }),
    turn({ stage: "energy", insight: fresh })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\repo", () => rpc, { checklist: false, extract: "off" });
  await run({ sessionId: "s", text: "最投入的是和同学一起赶比赛的时候。" });
  store.setSetting(workspaceId, "profile.model", JSON.stringify({ hypotheses: [{ id: "h1", dimension: "D2", statement: "和人一起时投入",
    basis: [], falsifier: "", alternative: "", status: "open" }, { id: "c5", dimension: "D2", statement: "旧卡", basis: [], falsifier: "", alternative: "", status: "open" }] }));
  await run({ sessionId: "s", text: "底座是我一个人做研究。" });
  const shown = store.listOnboardingMessages(workspaceId, "s").at(-1)!;
  const log = () => (JSON.parse(store.getSetting(workspaceId, "profile.model")!) as { hypotheses: Array<{ id: string; cardKey?: string }> }).hypotheses;
  expect(log().find((item) => item.id === "h1")?.cardKey).toBe(`s#${shown.seq}`);
  await run({ sessionId: "s", text: "还有别的吗" });
  const card = (store.listOnboardingMessages(workspaceId, "s").at(-1)!.content as { insight?: { hypothesisId?: string } }).insight;
  expect(card?.hypothesisId).toBe("c5-2");
  expect(log().find((item) => item.id === "c5-2")?.cardKey).toBe(`s#${store.listOnboardingMessages(workspaceId, "s").at(-1)!.seq}`);
  expect(log().find((item) => item.id === "c5")?.cardKey).toBeUndefined();
});

test("no observation card beside the safety check, and none built on the disclosure or the answer to the check", async () => {
  const card = (refs: Array<{ replyId: string; quote: string }>) => ({ text: "你说投入的时候身边都有人。", refs, falsifier: "如果独自时也常投入" });
  const { rpc } = fakeRuntime([turn({ stage: "narrative" }),
    turn({ stage: "narrative", reply: "谢谢你愿意说出来。全国心理援助热线 12356。", insight: card([{ replyId: "reply-1", quote: "和同学一起赶比赛" }, { replyId: "reply-3", quote: "没人可说" }]) }),
    turn({ stage: "narrative", insight: card([{ replyId: "reply-1", quote: "和同学一起赶比赛" }, { replyId: "reply-5", quote: "现在没有了" }]) }),
    turn({ stage: "energy", insight: card([{ replyId: "reply-1", quote: "和同学一起赶比赛" }, { replyId: "reply-7", quote: "一个人做研究" }]) })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { checklist: false, extract: "off" });
  const shown = async (text: string) => {
    await run({ sessionId: "s", text });
    return (store.listOnboardingMessages(workspaceId, "s").at(-1)!.content as { insight?: unknown }).insight;
  };
  await shown("我最投入的是和同学一起赶比赛的时候。");
  expect(await shown("大三有一段没人可说，有过不想活的念头。")).toBeUndefined();
  expect(await shown("现在没有了。")).toBeUndefined();
  expect(await shown("一个人做研究时最慢。")).toMatchObject({ text: "你说投入的时候身边都有人。" });
});

test("as the person reads a round: the safety reply ends at its help lines, a card is not said twice, a told story is excluded", async () => {
  const help = "全国心理援助热线 12356；身处危险时打 120 或 110，或去最近的医院急诊。";
  const card = { text: "你最投入的两次都是有人一起、每天有反馈的事，一个人做的研究推得最慢。", falsifier: "如果独自时也常投入",
    refs: [{ replyId: "reply-1", quote: "和同学一起赶比赛" }, { replyId: "reply-7", quote: "一个人做研究" }] };
  const { rpc } = fakeRuntime([turn({ stage: "narrative", questions: [{ id: "q1", text: "讲一件到目前为止最有成就感的事？", kind: "free", allowOther: true, identityId: "", projectId: "", options: [] }] }),
    turn({ stage: "narrative", reply: `谢谢你愿意说出来。${help}回到前面：你敬佩的人和那段时间正好相对。` }), turn({ stage: "energy" }),
    turn({ stage: "energy", reply: "记下了。你最投入的两次都是有人一起、每天有反馈的事，一个人的研究推得最慢。周末先排整块时间。", insight: card,
      questions: [{ id: "q1", text: "近一年最骄傲的一件事是什么？", kind: "free", allowOther: true, identityId: "", projectId: "", options: [] }] })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { checklist: false, extract: "off" });
  const last = async (text: string) => {
    await run({ sessionId: "s", text });
    return store.listOnboardingMessages(workspaceId, "s").at(-1)!.content as { reply: string; insight?: { text: string }; questions: Array<{ text: string }> };
  };
  await last("我最有成就感的是和同学一起赶比赛的时候。");
  expect((await last("有过一段情绪很低的时候，现在没有了。")).reply).toBe(`谢谢你愿意说出来。${help}`);
  await last("现在没有了，继续吧。");
  const round = await last("一个人做研究时最慢。");
  expect(round.insight?.text).toBe(card.text);
  expect(round.reply).toBe("记下了。周末先排整块时间。");
  expect(round.questions[0]!.text).toBe("除了前面讲过的那件，近一年最骄傲的一件事是什么？");
});

test("once the person said there is nothing more, the next round does not ask the closing question again", async () => {
  const { rpc } = fakeRuntime([turn({ questions: [], nextAction: "ready_for_milestones" }),
    turn({ reply: "好，按页面上的「结束并出报告」就会出报告。", questions: [{ id: "q9", text: "还有什么想聊的吗？", kind: "free", allowOther: true, identityId: "", projectId: "", options: [] }] })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { checklist: false, extract: "off" });
  await run({ sessionId: "s", text: "都说完了" });
  const closing = store.listOnboardingMessages(workspaceId, "s").at(-1)!.content as { questions: Array<{ id: string; text: string }> };
  expect(closing.questions.map((question) => question.id)).toEqual(["closing-open"]);
  expect(await run({ sessionId: "s", text: `【${closing.questions[0]!.text}】选择：没有了` })).toEqual({ state: "asked", sessionId: "s" });
  const after = store.listOnboardingMessages(workspaceId, "s").at(-1)!.content as { reply: string; nextAction: string; questions: unknown[] };
  expect(after).toMatchObject({ nextAction: "ask", questions: [] });
  expect(after.reply).toContain("结束并出报告");
  expect(store.getOnboardingSession(workspaceId, "s")?.state).toBe("active");
});

test("a reply listing a finished research thread's figures is sent back once; the rewrite keeps one conclusion", async () => {
  store.setSetting(workspaceId, "onboarding.research:s", JSON.stringify([{ id: "r1", question: "寒假实习何时截止？", why: "", dimension: "D0", status: "done",
    conclusion: "事务所寒假实习网申多在 7 月底到 10 月，安永 10 月 16 日截止；银行分行多在 12 月底到 1 月初截止。", messages: [] }]));
  const { rpc, prompts } = fakeRuntime([
    turn({ reply: "查到了：事务所网申在 7 月到 10 月，安永 10 月 16 日已截止；银行分行 12 月底截止。" }),
    turn({ reply: "事务所的寒假批次已经过了，银行分行还在窗口内，先投它。" })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { checklist: false, extract: "off" });
  await run({ sessionId: "s", text: "想找寒假实习。" });
  expect(dialogue(prompts).some((prompt) => prompt.includes("reply 逐条列了调研线程的细节"))).toBe(true);
  expect((store.listOnboardingMessages(workspaceId, "s").at(-1)!.content as { reply: string }).reply).toBe("事务所的寒假批次已经过了，银行分行还在窗口内，先投它。");
});

test("the dialogue is told which lines still have no goal candidates, so it asks what the person wants to become only there", async () => {
  store.setSetting(workspaceId, "lines.profiles", JSON.stringify({ media: { description: "小红书科普",
    attributes: [{ text: "有趣", kind: "ability", sourceRef: "reply-0" }, { text: "值得信赖", kind: "state", sourceRef: "reply-0" }] } }));
  const { rpc, prompts } = fakeRuntime([turn()]);
  await createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { extract: "off" })({ sessionId: "s", text: "开始吧" });
  const first = dialogue(prompts)[0]!;
  expect(first).toContain("goalPicker");
  expect(first).toMatch(/：已给出 2 个长期目标的候选词/);
  expect(first).toMatch(/：还没有长期目标的候选词/);
});

test("a line's goal is chosen inside the conversation: its candidates come as a question, and the taps adopt the goal", async () => {
  store.setSetting(workspaceId, "lines.v1", JSON.stringify([{ id: "media", label: "创作者", color: "media", goal: "", createdAt: "2026-10-30T00:00:00.000Z" }]));
  store.setSetting(workspaceId, "lines.profiles", JSON.stringify({ media: { description: "小红书科普",
    attributes: [{ text: "有趣", kind: "ability", sourceRef: "reply-0" }, { text: "值得信赖", kind: "state", sourceRef: "reply-0" }] } }));
  const round = turn({ stage: "lines", questions: [{ id: "q1", text: "每周大概花几小时做内容？", kind: "single", allowOther: true, identityId: "media",
    projectId: "", options: [{ id: "a", label: "5 小时以内", detail: "" }, { id: "b", label: "5 小时以上", detail: "" }] }] });
  const { rpc } = fakeRuntime([round, round]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { extract: "off" });
  await run({ sessionId: "s", text: "开始吧" });
  const asked = (store.listOnboardingMessages(workspaceId, "s").at(-1)!.content as { questions: Array<{ id: string; text: string; options: Array<{ label: string }> }> })
    .questions.find((question) => question.id === "gap-goal-media");
  expect(asked?.options.map((option) => option.label)).toEqual(["有趣", "值得信赖"]);
  await run({ sessionId: "s", text: `【${asked!.text}】选择：有趣；值得信赖` });
  const lines = JSON.parse(store.getSetting(workspaceId, "lines.v1")!) as Array<{ id: string; goalParts?: string[] }>;
  expect(lines.find((line) => line.id === "media")?.goalParts).toEqual(["有趣", "值得信赖"]);
  expect(store.listEvents(workspaceId, { type: "line.updated" }).at(-1)?.payload).toMatchObject({ via: "interview" });
});

test("the runners carry only the scenario: the Skill holds the rules, and the language comes from the shared style", () => {
  for (const text of [INSTRUCTIONS, EXTRACT_INSTRUCTIONS]) {
    expect(text.length).toBeLessThan(900);
    expect(text).not.toMatch(/in Chinese/i);
  }
});

test("a question the app took out of a round is named to the model next round, and recorded for debugging", async () => {
  const { rpc, prompts } = fakeRuntime([turn({ questions: [
    { id: "q-room", text: "组会在哪个房间？", kind: "free", allowOther: true, identityId: "research", projectId: "", options: [] },
    { id: "q1", text: "项目 A 的图表清单在哪？", kind: "single", allowOther: true, identityId: "research", projectId: "",
      options: [{ id: "a", label: "师兄给的文档", detail: "" }] }] }), turn()]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
  await run({ sessionId: "s1", text: "西湖那篇 10/31 前要投出，数据下周到。" });
  const [edited] = store.listEvents(workspaceId, { type: "onboarding.round_edited" });
  expect(edited?.payload).toMatchObject({ removed: [{ text: "组会在哪个房间？", why: expect.any(String) }] });
  await run({ sessionId: "s1", text: "图表清单在师兄给的文档里" });
  const second = dialogue(prompts)[1]!;
  expect(second).toContain("lastRound");
  expect(second).toContain("组会在哪个房间？");
});

test("replies the extraction has not recorded yet are named to the dialogue, so it does not take the abstract as complete", async () => {
  const { rpc, prompts } = fakeRuntime([firstAnswer, turn()]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
  await run({ sessionId: "s1", text: "西湖那篇 10/31 前要投出，数据下周到。" });
  // The extraction fell behind: nothing of the first reply is on record yet.
  writeExtractState(store, workspaceId, "s1", { upTo: 0, failures: 1 });
  await run({ sessionId: "s1", text: "图表清单在师兄给的文档里" });
  const second = dialogue(prompts)[1]!;
  expect(second).toContain("unrecorded");
  expect(second).toContain("reply-1");
});

test("what the extraction could not record is named to the next round with why, so it is asked again, never called noted (W-228)", async () => {
  const { rpc, prompts } = fakeRuntime([firstAnswer, turn()]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
  await run({ sessionId: "s1", text: "每周四 16:00 组会。" });
  store.appendEvent({ ownerId: "user-1", workspaceId, idempotencyKey: "u1", type: "dates.unrecorded", entityId: "s1",
    payload: { dropped: [{ title: "周四组会", code: "DATE_TIME_INVALID" }, { title: "午饭", code: "OFF_HOURS" }] } });
  await run({ sessionId: "s1", text: "好的" });
  const second = dialogue(prompts)[1]!;
  expect(second).toContain("notRecorded");
  expect(second).toContain("周四组会 — its time is incomplete");
  expect(second).not.toContain("午饭 —");
});

test("a round the page would list as empty gets the stage's open question; a checklist ask carries its line", () => {
  const base = { reply: "记下了。", nextAction: "ready_for_milestones" as const, stage: "lines", coverage: [], questions: [] } as unknown as Parameters<typeof withChecklist>[0];
  const turned = withChecklist(base, [{ id: "line_desc:line-a", label: "", detail: "", owner: "interview", ask: "在「设计」这条线上，三五年后你希望成为什么样的人？" }]);
  expect(turned.nextAction).toBe("ask");
  expect(turned.questions[0]?.identityId).toBe("line-a");
  const screen = { projects: [], meetings: [], goalPickerLines: ["line-a"] };
  const shown = shownOrOpen(turned, screen);
  expect(shown.questions).toHaveLength(1);
  expect(shown.questions[0]?.text).not.toContain("三五年后");
  // A line without a picker keeps its own question.
  expect(shownOrOpen(turned, { ...screen, goalPickerLines: ["line-b"] }).questions[0]?.text).toContain("三五年后");
});

test("every weekly arrangement reaches the dialogue each round as its own weekday and time, not as a count (W-183)", async () => {
  const meeting = (id: string, weekday: number, startTime: string, endTime: string) =>
    ({ id, title: "ECE 548", project: "", kind: "class", weekdays: [weekday], startTime, endTime, from: "2026-09-01", to: "2099-12-31", sourceRef: "reply-1" });
  store.appendEvent({ ownerId: "o", workspaceId, idempotencyKey: "dates:extracted:b1", type: "dates.extracted", entityId: "b1",
    payload: { dates: [], recurring: [meeting("w-1", 4, "09:00", "11:30"), meeting("w-2", 2, "14:00", "16:30")] } });
  const { rpc, prompts } = fakeRuntime([turn(), turn()]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { checklist: false, extract: "off" });
  await run({ sessionId: "s", text: "周二 14:00–16:30 和周四 09:00–11:30 上课。" });
  await run({ sessionId: "s", text: "继续" });
  for (const prompt of dialogue(prompts)) {
    expect(prompt).toContain("fixedSchedule");
    expect(prompt).toContain("周二 14:00–16:30 ECE 548");
    expect(prompt).toContain("周四 09:00–11:30 ECE 548");
  }
});

test("the cards' start item counts the short set whatever tier an account once chose: the start standard is unchanged by the tiers' removal (W-186)", async () => {
  const { interviewChecklistFor } = await import("@crossline/db");
  const { cardBank } = await import("@crossline/core");
  const at = "2026-11-03T00:00:00.000Z";
  store.saveOnboardingSession({ id: "s", ownerId: "o", workspaceId, state: "active", coverage: { flow: "v2" }, createdAt: at, updatedAt: at });
  store.setSetting(workspaceId, PROFILE_INSTRUMENTS_SETTING, JSON.stringify(Object.fromEntries(cardBank("short").map((item) => [item.id, { itemId: item.id, score: 3, by: "tapped", at }]))));
  const cardsItem = () => interviewChecklistFor(store, workspaceId, [], { unfiledFiles: 0 }).find((item) => item.id === "profile_cards");
  expect(cardsItem()).toMatchObject({ done: true });
  store.setSetting(workspaceId, "onboarding.depth", "standard");
  expect(cardsItem()).toMatchObject({ done: true });
});

test("the stage's open question is not asked again once answered: the next part's open question takes its place (W-184)", async () => {
  const at = "2026-10-30T00:00:00.000Z";
  // The profile module's compass part, as in the walkthrough, with every card already answered: the app's own fact questions wait.
  store.saveOnboardingSession({ id: "s", ownerId: "o", workspaceId, state: "active", coverage: { flow: "v2" }, createdAt: at, updatedAt: at });
  store.setSetting(workspaceId, PROFILE_INSTRUMENTS_SETTING, JSON.stringify(Object.fromEntries(PROFILE_ITEMS.map((item) => [item.id, { itemId: item.id, by: "skipped", at }]))));
  // Twice running, the model's only question in the compass part is not the person's to answer (a room): the app adds its open question.
  const empty = turn({ stage: "compass", questions: [{ id: "q-room", text: "组会在哪个房间？", kind: "free", allowOther: true, identityId: "research", projectId: "", options: [] }] });
  const { rpc } = fakeRuntime([empty, empty]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { checklist: false, extract: "off" });
  const shown = () => (store.listOnboardingMessages(workspaceId, "s").at(-1)!.content as { questions: Array<{ id: string; text: string }> }).questions;
  await run({ sessionId: "s", text: "继续" });
  const [asked] = shown();
  expect(asked).toMatchObject({ id: "open-compass", text: "做这些事，你最终想得到什么？" });
  await run({ sessionId: "s", text: `【${asked!.text}】补充：想要能自己安排时间的自由` });
  expect(store.questionByKey(workspaceId, "iq:s:2:open-compass")).toMatchObject({ status: "answered" });
  expect(shown().map((question) => question.text)).not.toContain(asked!.text);
  expect(shown().map((question) => question.id)).toEqual(["open-energy"]);
});
