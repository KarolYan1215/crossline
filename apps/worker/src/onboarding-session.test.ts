import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CrosslineStore, interviewChecklistFor, rateInsight, writeExtractState } from "@crossline/db";
import { cardWordsHead, documentsByRef, DISCLOSURE_PLACEHOLDER, LESSON_QUESTION, PROFILE_SECTIONS_SETTING, ONBOARDING_STAGES, PROFILE_FRAMEWORK, ONBOARDING_PROGRESS_SETTING, PROFILE_INSTRUMENTS_SETTING, PROFILE_ITEMS, readInstrumentAnswers, scaleAnswerLine,
  type OnboardingProgress, type ProfileCard } from "@crossline/core";
import { createOnboardingSessionRunner as createRunner, enqueueInterview, finishInterview, INSTRUCTIONS, interviewQueueKey, ONBOARDING_SKILL, readQueued, stageGuide,
  steerInterview } from "./onboarding-session";
import { correctedSince, correctionUnread, INSTRUCTIONS as EXTRACT_INSTRUCTIONS } from "./onboarding-extract";
import { ONBOARDING_EXTRACT_SKILL } from "./onboarding-extract";
import { fakeRuntime as runtimeWithRoutes, type AgentScript } from "./testing/fake-runtime";

/**
 * Both layers of a turn are answered from the same list: the dialogue reads its fields of each answer, the extraction (a thread of its
 * own, told apart by its context's version) reads the rest. Unless a test says otherwise the round waits for the extraction, so the
 * ledger can be read right after a turn.
 */
const EXTRACT = "crossline.onboarding.extract.v1";
/**
 * Since 2026-11-22 a later round's input is the person's words and one line; the dialogue reads the round's state with
 * `read_interview_state`. The fake dialogue reads it every turn, and `prompts()` shows each turn's prompt with what it read, so the tests
 * can still ask whether the state a round could see holds a thing.
 */
const sharedRuntime = (answers: Array<string | ((prompts: string[]) => string)>, _skill: string, options: Parameters<typeof runtimeWithRoutes>[2] = {}) => {
  const states = new Map<string, string>();
  const other = new Set<string>();
  let made: ReturnType<typeof runtimeWithRoutes> | undefined;
  const script: AgentScript = async (tools) => {
    for (const params of made!.turnParams()) {
      const text = JSON.stringify(params.input ?? "");
      if (text.includes(EXTRACT) || text.includes("search_evidence")) other.add(String(params.threadId));
    }
    if (!other.has(tools.threadId)) {
      const answer = await tools.ask("item/tool/call", { callId: `state-${tools.turnId}`, tool: "read_interview_state", arguments: {} });
      const items = answer.contentItems as Array<{ text?: string }> | undefined;
      if (answer.success === true && items?.[0]?.text) states.set(tools.turnId, items[0].text);
    }
    await options.script?.(tools);
  };
  made = runtimeWithRoutes(answers, [ONBOARDING_SKILL, ONBOARDING_EXTRACT_SKILL], { routes: [{ match: EXTRACT, answers }], ...options, script });
  const runtime = made;
  return { ...runtime, rawPrompts: runtime.prompts,
    prompts: () => runtime.prompts().map((prompt, at) => states.has(`turn-${at + 1}`) ? `${prompt}\n${states.get(`turn-${at + 1}`)}` : prompt) };
};
const fakeRuntime = (answers: string[], options: Parameters<typeof runtimeWithRoutes>[2] = {}) => sharedRuntime(answers, ONBOARDING_SKILL, options);
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
afterEach(() => { store.close(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

// A test round's `insight` is the dialogue's one card (`insights`, 2026-11-14): an empty one is none. Its question is the same every
// round, so it is marked a follow-up: the repeat check comes back to the model (onboarding-cards.test.ts), which these tests are not about.
const turn = ({ insight, ...over }: { insight?: { text: string; [key: string]: unknown } } & Record<string, unknown> = {}) => JSON.stringify({
  ...(insight ? { insights: insight.text ? [insight] : [] } : {}),
  reply: "收到，我先确认几件事。",
  questions: [{ id: "q1", text: "项目 A 的图表清单在哪？", kind: "single", allowOther: true, identityId: "research", projectId: "westlake", followUp: true,
    options: [{ id: "a", label: "师兄给的文档", detail: "" }, { id: "b", label: "只在聊天记录里", detail: "" }] }],
  slotUpdates: [], projectsDetected: [], flywheelCandidates: [], coverage: [], nextAction: "ask", next: "接着问项目 A 的图表清单。", ...over
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
  const { rpc, prompts, rawPrompts } = fakeRuntime([firstAnswer, turn(), turn()]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
  expect(await run({ sessionId: "s1", text: "西湖那篇 10/31 前要投出，数据下周到。" })).toEqual({ state: "asked", sessionId: "s1" });
  await run({ sessionId: "s1", text: "好的" });
  plan("ECE 548 Lecture (room 1610)");
  await run({ sessionId: "s1", text: "继续" });
  // The first round carries the week; a later round's line says when it changed, and the week is read with `read_interview_state`.
  const said = dialogue(rawPrompts).map((prompt) => prompt.includes("日历本周有变化"));
  expect(said).toEqual([false, false, true]);
  expect(dialogue(rawPrompts)[0]).toContain("ECE 548 Lecture");
  expect(dialogue(prompts)[2]).toContain("ECE 548 Lecture (room 1610)");
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
  // The dialogue and the extraction both carry the one portrait framework (D0–D9).
  for (const start of threadStarts()) expect(String(start.developerInstructions)).toContain(PROFILE_FRAMEWORK);
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
  expect(store.listEvents(workspaceId, { type: "job.ran", job: "onboarding.extract", state: "done" })[0]?.payload).toMatchObject({ replies: 1, facts: 0 });
  expect(store.listOnboardingMessages(workspaceId, "s").map((message) => message.role)).toEqual(["user", "assistant"]);
});

test("retrying after a failure does not save the person's message a second time", async () => {
  // Two empty answers fail the round (free text is a reply now, 2026-11-22, so "not json" no longer does; one empty answer is asked
  // for again in the same run since 2026-11-23).
  const { rpc } = fakeRuntime(["", "", firstAnswer]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
  const failed = await run({ sessionId: "s", text: "西湖那篇 10/31 前要投出" });
  expect(failed.state).toBe("blocked");
  const retried = await run({ sessionId: "s", text: "" });
  expect(retried).toEqual({ state: "asked", sessionId: "s" });
  expect(store.listOnboardingMessages(workspaceId, "s").filter((message) => message.role === "user")).toHaveLength(1);
});

test("the main interview never ends itself: a model that is done says so in its reply, the app adds no question, and only the person's finish ends it", async () => {
  const { rpc } = fakeRuntime([turn({ questions: [], nextAction: "ready_for_milestones" })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { extract: "off" });
  expect(await run({ sessionId: "s", text: "都说完了" })).toEqual({ state: "asked", sessionId: "s" });
  const last = store.listOnboardingMessages(workspaceId, "s").at(-1)!.content as { nextAction: string; questions: Array<{ id: string; text: string }> };
  expect(last.nextAction).toBe("ask");
  // The closing question the app used to add is gone (2026-11-14 audit): the box stays open for whatever the person still wants to say.
  expect(last.questions).toEqual([]);
  expect(store.getOnboardingSession(workspaceId, "s")?.state).toBe("active");
  const { outcome } = finishInterview(store, workspaceId, "C:\\repo", () => rpc, "s", { extract: false });
  expect(outcome).toEqual({ state: "finished", sessionId: "s" });
  expect(store.getOnboardingSession(workspaceId, "s")?.state).toBe("complete");
  expect(store.listEvents(workspaceId, { type: "onboarding.changed", change: "finish_requested" })).toHaveLength(1);
});

test("before the start standard stands, the model is told what is still owed, and the app adds no question of its own", async () => {
  const { rpc, prompts } = fakeRuntime([turn({ questions: [], nextAction: "ready_for_milestones" })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\repo", () => rpc, { extract: "off" });
  expect(await run({ sessionId: "s", text: "都说完了" })).toEqual({ state: "asked", sessionId: "s" });
  const last = store.listOnboardingMessages(workspaceId, "s").at(-1)!.content as { questions: Array<{ id: string; text: string }> };
  // The start items' questions the app used to add (2026-11-14 audit) are the model's to ask, from `startStandard` and `openItems`.
  expect(last.questions).toEqual([]);
  // The model is told outright that the lower bound does not stand yet, and what it lacks.
  expect(dialogue(prompts)[0]).toContain('"startStandard":{"met":false,"missing":[');
});

// W-269's minimum per deep part held the start from 2026-11-14; D10 (2026-11-22) lets the person decide when to start, and only a line and
// a milestone are hard gates (`partsUncovered` returns none).
test("no deep part of the interview is listed as owed before the start (D10, 2026-11-22)", async () => {
  const { rpc, prompts } = fakeRuntime([turn({ stage: "narrative" })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { extract: "off" });
  await run({ sessionId: "s", text: "我在读大三" });
  const [first] = dialogue(prompts);
  for (const part of ["处境", "指南针", "能量", "经历"]) expect(first).not.toContain(`访谈的「${part}」部分`);
  expect(first).not.toContain("stageOrder");
  expect(first).toContain('"startStandard":{"met":false');
});

test("every round's input opens with the progress header, counted from the rounds already in the ledger", async () => {
  const { rpc, prompts } = fakeRuntime([turn({ stage: "narrative" }), turn({ stage: "narrative" })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { extract: "off" });
  await run({ sessionId: "s", text: "我在读研二" });
  await run({ sessionId: "s", text: "导师管得松" });
  const [first, second] = dialogue(prompts);
  // First in the object, before the context it summarises (docs/onboarding-agent-session.md 「状态头怎么收」).
  expect(first).toContain('{"standing":["这是第 1 轮；');
  // A later round reads it with `read_interview_state` (2026-11-22); its input is the person's words and one line.
  expect(second).toContain('{"standing":["这是第 2 轮；当前部分 narrative 连这一轮已经 2 轮。"');
  // The ledger snapshot leads it (2026-11-25), rendered after the last round wrote the ledger; then the person's words and the note.
  expect(second!.startsWith("〔账本快照 · 第 2 轮开始前")).toBe(true);
  expect(second).toContain("\n\n导师管得松\n\n〔reply-3｜");
  expect(second).toContain("开始标准：还没齐，缺 ");
  expect(store.getOnboardingSession(workspaceId, "s")?.coverage).not.toHaveProperty("startMetRound");
});

test("a reply saying the app can be used before the start standard stands is not sent back or cut (2026-11-22, IR-035 retired)", async () => {
  const reply = "要用的几样都在了，你可以开始使用应用了。周末一般怎么过？";
  const { rpc, prompts } = fakeRuntime([turn({ reply })]);
  await createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { extract: "off" })({ sessionId: "s", text: "差不多了吧" });
  expect(dialogue(prompts)).toHaveLength(1);
  expect((store.listOnboardingMessages(workspaceId, "s").at(-1)!.content as { reply: string }).reply).toBe(reply);
});

test("with no Codex runtime the turn is a blocker and saves nothing", async () => {
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => undefined);
  expect(await run({ sessionId: "s", text: "你好" })).toMatchObject({ state: "blocked", code: "CODEX_SUPERVISOR_UNAVAILABLE" });
  expect(store.getOnboardingSession(workspaceId, "s")).toBeUndefined();
});

test("a thread the runtime has forgotten is replaced, and the new one is told what was said before", async () => {
  const { rpc, prompts, threadStarts } = fakeRuntime([turn()], { lostThreads: ["gone-thread"] });
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
  const now = "2026-10-02T00:00:00.000Z";
  const ownerId = store.getWorkspaceOwnerId(workspaceId)!;
  store.saveOnboardingSession({ id: "s1", ownerId, workspaceId, state: "active", coverage: {}, codexThreadId: "gone-thread", createdAt: now, updatedAt: now });
  store.saveProject({ id: "westlake", ownerId, workspaceId, identityId: "research", name: "西湖合作", status: "active", summary: "", createdAt: now, updatedAt: now });
  store.appendOnboardingMessage({ sessionId: "s1", workspaceId, role: "user", content: { text: "西湖那篇 10/31 前要投出" }, createdAt: now });
  store.appendOnboardingMessage({ sessionId: "s1", workspaceId, role: "assistant", createdAt: now,
    content: { ...JSON.parse(turn()), insight: { text: "你说投入的两次都是和人一起赶东西。", hypothesisId: "h1" } } });

  expect(await run({ sessionId: "s1", text: "图表清单在师兄给的文档里" })).toEqual({ state: "asked", sessionId: "s1" });

  const saved = store.getOnboardingSession(workspaceId, "s1");
  expect(saved?.codexThreadId).toMatch(/^thread-\d$/);
  // The new thread's first prompt carries the earlier lines, with the user's own reply id.
  const prompt = dialogue(prompts).find((item) => item.includes("history")) ?? "";
  expect(prompt).toContain("history");
  expect(prompt).toContain("西湖那篇 10/31 前要投出");
  expect(prompt).toContain("reply-1");
  // P3: the round as the person saw it — the options and the card with the hypothesis it asked — not the question text alone.
  expect(prompt).toContain("（选项：师兄给的文档 / 只在聊天记录里）");
  expect(prompt).toContain("【观察卡 h1】你说投入的两次都是和人一起赶东西。");
  // The new thread gets the card and read tools, and the compaction prompt that keeps what only the thread holds.
  const start = threadStarts().at(-1)!;
  expect((start.dynamicTools as Array<{ name: string }>).map((tool) => tool.name)).toEqual(expect.arrayContaining(["ask_question", "read_ledger", "read_file"]));
  expect(JSON.stringify(start)).toContain("compact_prompt");
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
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
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
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
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
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
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
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
  expect(await run({ sessionId: "s", text: "ECE 555 评分：作业 20%、小测 30%、项目 25%、期末 25%，我想拿高分，期末 2026-12-15" })).toEqual({ state: "asked", sessionId: "s" });
  expect(store.listProfileFacts(workspaceId).some((fact) => fact.slot === "target_grade")).toBe(false);
});

const guessOnly = turn({
  slotUpdates: [{ identityId: "startup", projectId: "", slot: "what", value: "可能在做某个产品", status: "inferred", refs: [] }],
  questions: [], nextAction: "ready_for_milestones"
});

// 2026-11-14 audit: the app no longer puts its own questions into a round. They reach the dialogue as `openItems`, and go out as the
// app wrote them (so a tap settles the fact) when the dialogue names them.
test("a line resting only on its own guesses reaches the dialogue as the app's own question, which goes out as written once named", async () => {
  const { rpc, prompts } = fakeRuntime([guessOnly, turn({ questions: [], openItems: ["gap-line-startup"] }), turn()]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\repo", () => rpc);
  expect(await run({ sessionId: "s", text: "随便聊聊" })).toEqual({ state: "asked", sessionId: "s" });
  // The model's 「ready」 adds nothing of the app's own.
  expect((store.listOnboardingMessages(workspaceId, "s").at(-1)!.content as { questions: unknown[] }).questions).toEqual([]);
  await run({ sessionId: "s", text: "还有吗" });
  expect(dialogue(prompts)[1]).toContain('"openItems":[{"id":"gap-line-startup"');
  const asked = store.listOnboardingMessages(workspaceId, "s").at(-1)!.content as { questions: Array<{ id: string; text: string }> };
  expect(asked.questions.map((question) => question.id)).toEqual(["gap-line-startup"]);
  // Declining the line is recorded by the app itself, from the tap.
  await run({ sessionId: "s", text: `【${asked.questions[0]!.text}】选择：目前没有在做的事` });
  expect(store.listProfileFacts(workspaceId).find((fact) => fact.slot === "skipped")).toMatchObject({ identityId: "startup", status: "confirmed", sourceRef: "reply-5" });
});

// Replay 2026-11-26: 「十一月中旬，已经过了」 typed under a deadline card was not read by the code, and the same card went out the next round.
test("an app question answered in words the code did not read is not offered again before the extraction has read that answer", async () => {
  const { rpc, prompts } = fakeRuntime([guessOnly, turn({ questions: [], openItems: ["gap-line-startup"] }), turn(), turn()]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
  await run({ sessionId: "s", text: "随便聊聊" });
  await run({ sessionId: "s", text: "还有吗" });
  const asked = store.listOnboardingMessages(workspaceId, "s").at(-1)!.content as { questions: Array<{ id: string; text: string }> };
  await run({ sessionId: "s", text: `【${asked.questions[0]!.text}】选择：其他。补充：在做一个记账的小程序，还没上线` });
  expect(store.listProfileFacts(workspaceId).some((fact) => fact.slot === "skipped")).toBe(false);
  expect(dialogue(prompts).at(-1)).not.toContain('"id":"gap-line-startup"');
});

test("with the completion list on, a 「ready」 goes back to asking, and the checklist's labels never reach the person", async () => {
  const { rpc } = fakeRuntime([turn({ questions: [], nextAction: "ready_for_milestones" })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
  expect(await run({ sessionId: "s", text: "都说完了" })).toEqual({ state: "asked", sessionId: "s" });
  expect(store.getOnboardingSession(workspaceId, "s")?.state).toBe("active");
  const last = store.listOnboardingMessages(workspaceId, "s").at(-1)!.content as { reply: string; questions: unknown[] };
  // The checklist's labels never reach the person; what is still owed is the model's to ask (`startStandard`, `openItems`).
  expect(last.reply).not.toMatch(/已收集|硬约束|定语|还缺/);
  expect(last.questions).toEqual([]);
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
  // The new candidates come first and the old ones stay after them (replay 13: a one-word list wiped the rest), with what was split from
  // the adopted goal last; the other line is untouched.
  expect(profiles.research!.description).toBe("以器件物理为底的神经形态计算研究");
  expect(profiles.research!.attributes!.map((item) => item.text)).toEqual([...attributes.map((item) => item.text), "旧候选", "类脑芯片方向能带队"]);
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
  const { rpc, rawPrompts } = fakeRuntime([turn()]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
  await run({ sessionId: "s", text: "材料已添加，请先从材料里读出能读的，再问还缺的。" });
  const prompt = dialogue(rawPrompts)[0]!;
  const context = JSON.parse(prompt.slice(prompt.indexOf("{"), prompt.lastIndexOf("}") + 1)) as {
    sources: unknown[]; checklist: Array<{ start?: boolean }>; stage: string };
  expect(context.sources).toHaveLength(2);
  expect(context.checklist.some((item) => item.start === true)).toBe(true);
  expect(context.stage).toBe("narrative");
  expect(store.getOnboardingSession(workspaceId, "s")!.coverage).toMatchObject({ flow: "v2" });
});

test("no rating card is put beside a round any more: the scale is a page of its own (2026-11-22)", async () => {
  const { rpc } = fakeRuntime([turn({ stage: "compass" }), turn({ stage: "energy" })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
  const lastCards = () => ((store.listOnboardingMessages(workspaceId, "s").filter((message) => message.role === "assistant").at(-1)!.content) as { cards?: ProfileCard[] }).cards;
  await run({ sessionId: "s", text: "先从经历说起吧" });
  expect(lastCards()).toBeUndefined();
  await run({ sessionId: "s", text: "周末一般在家。" });
  expect(lastCards()).toBeUndefined();
});
test("there are no tiers: a stored choice is never read, no tier, tone or stage count is sent, and there is no per-project details part", async () => {
  store.setSetting(workspaceId, "onboarding.depth", "quick");
  store.setSetting(workspaceId, "onboarding.tone", "warm");
  const { rpc, prompts } = fakeRuntime([firstAnswer]);
  await createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc)({ sessionId: "s1", text: "开始" });
  for (const field of ['"depth"', '"tone"', '"stageRounds"', '"moveOn"']) expect(dialogue(prompts)[0]).not.toContain(field);
  expect(dialogue(prompts)[0]).not.toContain('"details"]');
});
test("one voice: whatever tone an account stored, no turn carries one (the Skill has the only voice)", async () => {
  // Decision 10 of the 2026-11-12 redesign: 「直接犀利」 is built in; the 2026-10-18 choices (neutral, warm) are never read (P0, 2026-11-14).
  store.setSetting(workspaceId, "onboarding.tone", "warm");
  const { rpc, prompts } = fakeRuntime([firstAnswer, turn()]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
  await run({ sessionId: "s1", text: "开始" });
  store.setSetting(workspaceId, "onboarding.tone", "neutral");
  await run({ sessionId: "s1", text: "继续" });
  expect(dialogue(prompts)).toHaveLength(2);
  expect(dialogue(prompts).some((prompt) => prompt.includes('"tone"'))).toBe(false);
});

// 2026-11-14 audit: the screen read 「你在哪里最容易进入专注状态？」 as a question about a place and 「朋友会用哪些词形容你？」 as a goal
// question, and dropped both. What can be inferred is the Skill's rule; nothing is taken out or assumed behind the person's back.
test("a round's questions reach the person as the model wrote them: none screened out, no assumption written for them, the kind its own", async () => {
  const options = (...labels: string[]) => labels.map((label, index) => ({ id: `o${index}`, label, detail: "" }));
  const { rpc } = fakeRuntime([turn({ questions: [
    { id: "q-goal", text: "西湖合作这学期最重要的目标？", kind: "single", allowOther: true, identityId: "research", projectId: "", options: options("投出论文", "跑通片上训练") },
    { id: "q-room", text: "组会在哪个房间？", kind: "free", allowOther: true, identityId: "research", projectId: "", options: [] },
    { id: "q-cal", text: "日历中的两项活动，哪些属于持续安排？", kind: "single", allowOther: true, identityId: "research", projectId: "", options: options("Build Nights 每周", "DEJA-VU 每月") }] })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\repo", () => rpc);
  await run({ sessionId: "s1", text: "西湖那篇 10/31 前要投出，数据下周到。" });
  const stored = store.listOnboardingMessages(workspaceId, "s1").at(-1)!.content as { questions: Array<{ id: string; kind: string }> };
  expect(stored.questions.filter((question) => question.id.startsWith("q-")).map((question) => [question.id, question.kind]))
    .toEqual([["q-goal", "single"], ["q-room", "free"], ["q-cal", "single"]]);
  expect(store.listProfileFacts(workspaceId).some((fact) => fact.slot.startsWith("assumed_"))).toBe(false);
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

test("the question ledger: a round's questions are numbered, an answer is recorded with its sentences, and one the model marks as asked again comes back", async () => {
  const ask = (repeats = 0) => ({ id: "q1", text: "西湖合作的图表清单由谁提供？", kind: "single", allowOther: true, identityId: "research", projectId: "",
    options: [{ id: "a", label: "师兄", detail: "" }, { id: "b", label: "导师", detail: "" }], repeats });
  const { rpc, prompts } = fakeRuntime([turn({ questions: [ask()] }), turn({ questions: [], nextAction: "ready_for_milestones" }), turn({ questions: [{ ...ask(1), id: "q9" }] })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
  await run({ sessionId: "s1", text: "西湖那篇 10/31 前要投出，数据下周到。" });
  const asked = store.questionByKey(workspaceId, "iq:s1:2:q1")!;
  expect(asked.id).toBe(1);
  expect(asked).toMatchObject({ status: "open", text: "西湖合作的图表清单由谁提供？" });
  await run({ sessionId: "s1", text: "【西湖合作的图表清单由谁提供？】选择：师兄" });
  expect(store.questionByKey(workspaceId, "iq:s1:2:q1")).toMatchObject({ status: "answered", answer: "选择：师兄" });
  expect(store.questionByKey(workspaceId, "iq:s1:2:q1")!.answerSentences.length).toBeGreaterThan(0);
  // The next round's snapshot shows that answer. A round that names it as the question it asks again (`repeats`), not deeper, is sent back
  // with the answer the person gave; kept without `followUp`, it is left out once the repairs run out, and told so next round.
  await run({ sessionId: "s1", text: "继续" });
  expect(dialogue(prompts).some((prompt) => prompt.includes(`#${asked.id} 已答｜西湖合作的图表清单由谁提供？ → 「选择：师兄」`))).toBe(true);
  expect(dialogue(prompts).some((prompt) => prompt.includes(`#${asked.id}「西湖合作的图表清单由谁提供？」是同一个问题，本人答过：「选择：师兄」`))).toBe(true);
  const last = store.listOnboardingMessages(workspaceId, "s1").at(-1)!.content as { questions: Array<{ id: string }> };
  expect(last.questions.map((question) => question.id)).not.toContain("q9");
  expect(store.listEvents(workspaceId, { type: "onboarding.changed", change: "round_edited" }).at(-1)?.payload).toMatchObject({ removed: [{ why: expect.stringContaining("followUp") }] });
});

test("an app question the model asks in its own words, naming its number, comes back: it goes out by id so its tap settles the fact", async () => {
  const { rpc } = fakeRuntime([guessOnly, guessOnly]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
  await run({ sessionId: "s", text: "随便聊聊" });
  await run({ sessionId: "s", text: "还有吗" });
  const gap = store.questionByKey(workspaceId, "gap:gap-line-startup")!;
  expect(gap.status).toBe("pending");
  const own = { id: "q-startup", text: "创业这条线你现在具体在做什么？", kind: "free", allowOther: true, identityId: "startup", projectId: "", options: [], repeats: gap.id };
  const { rpc: rpc2 } = fakeRuntime([turn({ questions: [own], nextAction: "ask" })]);
  // A second runner on the same ledger, so the second answer is the model's own question.
  await createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc2)({ sessionId: "s2", text: "继续" });
  const round = store.listOnboardingMessages(workspaceId, "s2").at(-1)!.content as { questions: Array<{ id: string }> };
  expect(round.questions).toEqual([]);
  expect(store.listEvents(workspaceId, { type: "onboarding.changed", change: "round_edited" }).at(-1)?.payload)
    .toMatchObject({ removed: [{ why: expect.stringContaining("把「gap-line-startup」放进 openItems") }] });
});

test("a file read again since it was shown is shown to the dialogue again and extracted again with its new numbers", async () => {
  store.saveSourceDocument({ id: "d1", ownerId: "o", workspaceId, kind: "text", fileName: "Plan.txt", mediaType: "text/plain", sha256: "x", uri: "file:///x",
    extractedText: "Week-8: 27th Oct.", extractionStatus: "done", createdAt: "2026-10-02T00:00:00.000Z" });
  const done = turn({ questions: [], nextAction: "ready_for_milestones" });
  const { rpc, prompts } = fakeRuntime([done, done, done]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
  await run({ sessionId: "s", text: "我上传了文件" });
  await run({ sessionId: "s", text: "继续" });
  expect(dialogue(prompts)[1]).not.toContain("Plan.txt");
  // Extraction ran again (a layout re-read): the next turn hands the file over again, numbered anew for the extraction.
  store.setSourceDocumentExtraction(workspaceId, "d1", { status: "done", text: "Week-8: 28th Oct." });
  await run({ sessionId: "s", text: "再继续" });
  const latest = store.sentencesOf(workspaceId, "document", "d1")[0]!;
  // A later round names the file and reads it whole with `read_file` (2026-11-22).
  expect(dialogue(prompts)[2]).toContain("新文件 1 份：《Plan.txt》");
  expect(extraction(prompts).at(-1)).toContain(`[${latest.id}] Week-8: 28th Oct.`);
});

// R2-B (2026-11-22): a folder file the model opens with `read_folder_file` becomes a stored document during the turn; the next turn used
// to announce it as 「新文件」 although the model had just read it. The same holds for any file it opened with `read_file`.
test("a file the model opened itself with a read tool during a turn is not announced as new on the next turn", async () => {
  let turns = 0;
  const answers: Array<Record<string, unknown>> = [];
  const made = fakeRuntime([turn({ questions: [] }), turn({ questions: [] }), turn({ questions: [] })], {
    script: async ({ threadId, ask }) => {
      const dialogueThreads = made.threadStarts().flatMap((params, index) =>
        (params.dynamicTools as Array<{ name: string }> | undefined)?.some((tool) => tool.name === "read_file") ? [`thread-${index + 1}`] : []);
      if (!dialogueThreads.includes(threadId) || (turns += 1) !== 2) return;
      // What `read_folder_file` does: the file is read into the ledger while the turn runs, then shown to the model.
      store.saveSourceDocument({ id: "d-folder", ownerId: "o", workspaceId, kind: "text", fileName: "Notes/Plan.txt", mediaType: "text/plain", sha256: "f", uri: "file:///f",
        extractedText: "Week-8: 27th Oct.", extractionStatus: "done", createdAt: "2026-10-02T00:00:00.000Z" });
      answers.push(await ask("item/tool/call", { callId: "read-1", tool: "read_file", arguments: { id: "d-folder" } }));
    } });
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => made.rpc);
  await run({ sessionId: "s", text: "先聊聊" });
  await run({ sessionId: "s", text: "看看我的文件夹" });
  expect(answers[0]).toMatchObject({ success: true });
  await run({ sessionId: "s", text: "继续" });
  expect(dialogue(made.rawPrompts).at(-1)).not.toContain("新文件");
  const ref = [...documentsByRef(store.listSourceDocuments(workspaceId))].find(([, doc]) => doc.fileName === "Notes/Plan.txt")![0];
  expect((store.getOnboardingSession(workspaceId, "s")!.coverage as { announcedSources?: string[] }).announcedSources).toContain(ref);
});

test("a re-read still accepts the numbers of files an earlier turn of the thread showed", async () => {
  store.saveSourceDocument({ id: "d1", ownerId: "o", workspaceId, kind: "text", fileName: "Plan.txt", mediaType: "text/plain", sha256: "x", uri: "file:///x",
    extractedText: "Week-8: 27th Oct.", extractionStatus: "done", createdAt: "2026-10-02T00:00:00.000Z" });
  const done = turn({ questions: [], nextAction: "ready_for_milestones" });
  const cite = (id: number) => turn({ questions: [], nextAction: "ready_for_milestones", slotUpdates: [{ identityId: "research", projectId: "", slot: "midterm", value: "10/27", status: "confirmed", refs: [id] }] });
  const { rpc } = fakeRuntime([done, cite(2)]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
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
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => compacting.rpc, { extract: "off" });
  expect(await run({ sessionId: "s", text: "我在读研。" })).toMatchObject({ state: "asked" });

  const acting = sharedRuntime([turn(), turn(), turn()], ONBOARDING_SKILL, { script: async ({ emit, threadId, turnId }) => {
    emit({ method: "item/completed", params: { threadId, turnId, item: { type: "commandExecution", id: "x1" } } });
  } });
  const refused = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => acting.rpc, { extract: "off" });
  const outcome = await refused({ sessionId: "s2", text: "第二段对话。" });
  expect(outcome).toMatchObject({ state: "blocked", code: "SKILL_TOOL_FORBIDDEN", detail: "item:commandExecution" });
  expect(readOnboardingFailure(store.getSetting(workspaceId, `${ONBOARDING_LAST_FAILURE}s2`))).toMatchObject({ code: "SKILL_TOOL_FORBIDDEN" });
  // The retry starts: the old reason goes, whatever the retry then does.
  await createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => sharedRuntime([turn(), turn()], ONBOARDING_SKILL).rpc, { extract: "off" })({ sessionId: "s2", text: "" });
  expect(store.getSetting(workspaceId, `${ONBOARDING_LAST_FAILURE}s2`)).toBeUndefined();
});

test("the progress record goes back to the model next round, and an observation is kept only when its quotes are the person's", async () => {
  const progress = { part: "energy", covered: ["心流时刻"], open: ["耗能的事"], partDone: false, next: "问什么事做完很累" };
  const insight = (quote: string) => ({ text: "你说投入的两次都是和人一起赶东西；底座主线是一个人做的研究。",
    refs: [{ replyId: "reply-1", quote: "和同学一起赶比赛" }, { replyId: "reply-5", quote }], falsifier: "如果独自做研究时也常投入到忘了时间" });
  // A card joins what was said at different times: the round after a first one cites the reply before the latest two (2026-11-15).
  const { rpc, prompts } = fakeRuntime([turn({ stage: "energy", progress, insight: { text: "", refs: [] } }), turn({ stage: "energy", progress }),
    turn({ stage: "energy", progress: { ...progress, covered: ["心流时刻", "耗能的事"], open: [] }, insight: insight("一个人做研究") }),
    turn({ stage: "energy", progress, insight: insight("一个人做实验") })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { extract: "off" });
  await run({ sessionId: "s", text: "最投入的是和同学一起赶比赛的时候。" });
  await run({ sessionId: "s", text: "周末一般在家。" });
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

test("observations come as often as there is evidence; a repeat is the Skill's to avoid, not refused (2026-11-27)", async () => {
  const insight = { text: "你说投入的两次都是和人一起赶东西；底座主线是一个人做的研究。",
    refs: [{ replyId: "reply-1", quote: "和同学一起赶比赛" }, { replyId: "reply-5", quote: "一个人做研究" }], falsifier: "如果独自做研究时也常投入到忘了时间" };
  const { rpc } = fakeRuntime([turn({ stage: "energy", insight: { text: "", refs: [] } }), turn({ stage: "energy" }), turn({ stage: "energy", insight }),
    turn({ stage: "energy", insight }), turn({ stage: "compass", insight })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\repo", () => rpc, { extract: "off" });
  const kept = async (text: string) => {
    await run({ sessionId: "s", text });
    return Boolean((store.listOnboardingMessages(workspaceId, "s").at(-1)!.content as { insight?: unknown }).insight);
  };
  expect(await kept("最投入的是和同学一起赶比赛的时候。")).toBe(false);
  expect(await kept("周末一般在家。")).toBe(false);
  expect(await kept("底座是我一个人做研究。")).toBe(true);
  // The same words again are no longer refused by the app (docs/plans/condense-1127.md A5): the Skill says each card says one new thing.
  expect(await kept("还有别的吗")).toBe(true);
});

test("a card's hypothesis is marked asked when it is shown, rated or not; one picked from the log keeps its id, a new one never takes an id on record", async () => {
  const refs = [{ replyId: "reply-1", quote: "和同学一起赶比赛" }, { replyId: "reply-5", quote: "一个人做研究" }];
  const fromLog = { text: "你说投入的两次都是和人一起赶东西。", refs, falsifier: "如果独自时也常投入", hypothesisId: "h1" };
  const fresh = { text: "你说底座主线是一个人做的研究。", refs, falsifier: "如果独自做研究时也常投入" };
  const { rpc } = fakeRuntime([turn({ stage: "energy", insight: { text: "", refs: [] } }), turn({ stage: "energy" }), turn({ stage: "energy", insight: fromLog }),
    turn({ stage: "energy", insight: fresh })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\repo", () => rpc, { extract: "off" });
  await run({ sessionId: "s", text: "最投入的是和同学一起赶比赛的时候。" });
  await run({ sessionId: "s", text: "周末一般在家。" });
  store.setSetting(workspaceId, "profile.model", JSON.stringify({ hypotheses: [{ id: "h1", dimension: "D2", statement: "和人一起时投入",
    basis: [], falsifier: "", alternative: "", status: "open" }, { id: "c7", dimension: "D2", statement: "旧卡", basis: [], falsifier: "", alternative: "", status: "open" }] }));
  await run({ sessionId: "s", text: "底座是我一个人做研究。" });
  const shown = store.listOnboardingMessages(workspaceId, "s").at(-1)!;
  const log = () => (JSON.parse(store.getSetting(workspaceId, "profile.model")!) as { hypotheses: Array<{ id: string; cardKey?: string }> }).hypotheses;
  expect(log().find((item) => item.id === "h1")?.cardKey).toBe(`s#${shown.seq}`);
  await run({ sessionId: "s", text: "还有别的吗" });
  const card = (store.listOnboardingMessages(workspaceId, "s").at(-1)!.content as { insight?: { hypothesisId?: string } }).insight;
  expect(card?.hypothesisId).toBe("c7-2");
  expect(log().find((item) => item.id === "c7-2")?.cardKey).toBe(`s#${store.listOnboardingMessages(workspaceId, "s").at(-1)!.seq}`);
  expect(log().find((item) => item.id === "c7")?.cardKey).toBeUndefined();
});

test("cards ready together come in one round: each is kept, keyed and rated on its own, and a correction holds the next cards back", async () => {
  const refs = [{ replyId: "reply-1", quote: "和同学一起赶比赛" }, { replyId: "reply-5", quote: "一个人做研究" }];
  const card = (id: string, text: string) => ({ text, refs, falsifier: "如果独自时也常投入", hypothesisId: id, dimension: "D2" });
  const { rpc } = fakeRuntime([turn({ stage: "energy", insight: { text: "", refs: [] } }), turn({ stage: "energy" }),
    turn({ stage: "energy", insights: [card("h1", "你说投入的两次都是和人一起赶东西。"), card("h2", "你说底座主线是一个人做的研究。"),
      card("h3", "你说周末一般在家。")] })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\repo", () => rpc, { extract: "off" });
  await run({ sessionId: "s", text: "最投入的是和同学一起赶比赛的时候。" });
  await run({ sessionId: "s", text: "周末一般在家。" });
  const hypothesis = (id: string) => ({ id, dimension: "D2", statement: id, basis: [], falsifier: "", alternative: "", status: "open" });
  store.setSetting(workspaceId, "profile.model", JSON.stringify({ hypotheses: [hypothesis("h1"), hypothesis("h2"), hypothesis("h3")] }));
  await run({ sessionId: "s", text: "底座是我一个人做研究。" });
  const shown = store.listOnboardingMessages(workspaceId, "s").at(-1)!;
  const content = shown.content as { insight?: { text: string }; moreInsights?: Array<{ text: string }> };
  expect([content.insight?.text, ...(content.moreInsights ?? []).map((item) => item.text)])
    .toEqual(["你说投入的两次都是和人一起赶东西。", "你说底座主线是一个人做的研究。", "你说周末一般在家。"]);
  const log = () => (JSON.parse(store.getSetting(workspaceId, "profile.model")!) as { hypotheses: Array<{ id: string; cardKey?: string; rated?: string }> }).hypotheses;
  expect(log().map((item) => item.cardKey)).toEqual([`s#${shown.seq}`, `s#${shown.seq}.1`, `s#${shown.seq}.2`]);
  // The second card is rated under its own key; a 部分对 newer than the inferences' last read goes beside the next cards (`cardsCheck`).
  expect(correctionUnread(store, workspaceId, "s")).toBe(false);
  expect(rateInsight(store, workspaceId, { sessionId: "s", seq: shown.seq, index: 1, verdict: "partial", correction: "是一个人做，但常和导师讨论" }))
    .toMatchObject({ ok: true, hypothesisId: "h2" });
  expect(log().find((item) => item.id === "h2")?.rated).toBe("partial");
  expect(rateInsight(store, workspaceId, { sessionId: "s", seq: shown.seq, index: 3, verdict: "fits" })).toEqual({ ok: false, code: "INSIGHT_NOT_FOUND" });
  expect(correctionUnread(store, workspaceId, "s")).toBe(true);
  expect(correctedSince(store, workspaceId, "s", "2999-01-01T00:00:00Z")).toBe(false);
  // Never held back any more (replay 14: a nine-minute lane held the cards for ten rounds; 2026-11-14 audit): the correction stays
  // beside the cards until the lane has read it, a later round included.
  store.appendOnboardingMessage({ sessionId: "s", workspaceId, role: "assistant", content: { reply: "next" }, createdAt: "2999-01-01T00:00:00Z" });
  expect(correctionUnread(store, workspaceId, "s")).toBe(true);
});

test("a card may cite one reply: how many replies it joins is the Skill's (2026-11-27)", async () => {
  // Replay 13 (2026-11-14): with only open hypotheses on two replies offered, nine rounds had no card. The extraction's uncertain ones fill in.
  const one = [{ replyId: "reply-3", quote: "一个人做研究" }];
  // The one reply is older than the latest two: a card does not rest on what was just said alone (2026-11-15).
  const { rpc } = fakeRuntime([turn({ stage: "energy", insight: { text: "", refs: [] } }), turn({ stage: "energy" }), turn({ stage: "energy" }),
    turn({ stage: "energy", insights: [{ text: "你说「一个人做研究」，我猜是你更喜欢自己定节奏；也可能只是那学期课多。", refs: one, falsifier: "如果课少时也常约人一起做", hypothesisId: "h7", dimension: "D3" },
      { text: "你说一个人做研究时最慢。", refs: one, falsifier: "如果独自时也很快", hypothesisId: "h8", dimension: "D1" }] })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { extract: "off" });
  await run({ sessionId: "s", text: "最投入的是和同学一起赶比赛的时候。" });
  const basis = [{ kind: "quote", text: "一个人做研究", ref: "reply-3" }];
  store.setSetting(workspaceId, "profile.model", JSON.stringify({ hypotheses: [
    { id: "h7", dimension: "D3", statement: "更喜欢自己定节奏", basis, falsifier: "", alternative: "只是那学期课多", status: "supported" },
    { id: "h8", dimension: "D1", statement: "独处时慢", basis, falsifier: "", alternative: "", status: "open" }] }));
  await run({ sessionId: "s", text: "底座是我一个人做研究。" });
  await run({ sessionId: "s", text: "周末一般在家。" });
  await run({ sessionId: "s", text: "还有别的吗" });
  const content = store.listOnboardingMessages(workspaceId, "s").at(-1)!.content as { insight?: { text: string; hypothesisId?: string }; moreInsights?: unknown[] };
  expect(content.insight).toMatchObject({ hypothesisId: "h7" });
  expect(content.moreInsights).toEqual([expect.objectContaining({ hypothesisId: "h8" })]);
});

test("no observation card beside the safety check, and none built on the disclosure or the answer to the check", async () => {
  const card = (refs: Array<{ replyId: string; quote: string }>) => ({ text: "你说投入的时候身边都有人。", refs, falsifier: "如果独自时也常投入" });
  const { rpc } = fakeRuntime([turn({ stage: "narrative" }),
    turn({ stage: "narrative", reply: "谢谢你愿意说出来。全国心理援助热线 12356。", insight: card([{ replyId: "reply-1", quote: "和同学一起赶比赛" }, { replyId: "reply-3", quote: "没人可说" }]) }),
    turn({ stage: "narrative", insight: card([{ replyId: "reply-1", quote: "和同学一起赶比赛" }, { replyId: "reply-5", quote: "现在没有了" }]) }),
    turn({ stage: "energy", insight: card([{ replyId: "reply-1", quote: "和同学一起赶比赛" }, { replyId: "reply-7", quote: "一个人做研究" }]) })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { extract: "off" });
  const shown = async (text: string) => {
    await run({ sessionId: "s", text });
    return (store.listOnboardingMessages(workspaceId, "s").at(-1)!.content as { insight?: unknown }).insight;
  };
  await shown("我最投入的是和同学一起赶比赛的时候。");
  expect(await shown("大三有一段没人可说，有过不想活的念头。")).toBeUndefined();
  expect(await shown("现在没有了。")).toBeUndefined();
  expect(await shown("一个人做研究时最慢。")).toMatchObject({ text: "你说投入的时候身边都有人。" });
});

test("a reply naming self-harm is sent back once when the round is not the safety reply; the model's `safety` mark keeps cards away (2026-11-14 audit)", async () => {
  // The floor reads the person's words (`mentionsSelfHarm`); the model decides whether they are the person's own (`safetyRound`).
  const card = { text: "你说投入的时候身边都有人。", falsifier: "如果独自时也常投入",
    refs: [{ replyId: "reply-1", quote: "和同学一起赶比赛" }, { replyId: "reply-3", quote: "写综述" }] };
  const { rpc, prompts } = fakeRuntime([turn({ stage: "narrative" }),
    turn({ stage: "narrative", reply: "综述的题目很少见。" }), turn({ stage: "narrative", reply: "综述的题目很少见。", safety: false }),
    turn({ stage: "narrative", reply: "谢谢你愿意说出来。现在还有这样的念头吗？", safety: true, insight: card })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\repo", () => rpc, { extract: "off" });
  const last = async (text: string) => {
    await run({ sessionId: "s", text });
    return store.listOnboardingMessages(workspaceId, "s").at(-1)!.content as { reply: string; safety?: boolean; insight?: unknown };
  };
  await last("我最投入的是和同学一起赶比赛的时候。");
  // A research topic: the model answers it as it was, and its second answer stands.
  expect(await last("我在写综述，题目是大学生自杀预防。")).toMatchObject({ reply: "综述的题目很少见。" });
  expect(dialogue(prompts).filter((prompt) => prompt.includes("自伤或不想活的字眼"))).toHaveLength(1);
  // Marked by the model without the hotline numbers: still the safety round, so no card beside it.
  const safe = await last("我写综述的时候，自己也有过不想活的念头。");
  expect(safe.safety).toBe(true);
  expect(safe.insight).toBeUndefined();
});

test("a disclosure's words leave the dialogue's thread once answered, a card retelling it is not sent back, and the lesson is asked once by the app (2026-11-15)", async () => {
  const good = { text: "你最投入的时候身边都有人，一个人做研究推得最慢。", falsifier: "如果独自时也常投入",
    refs: [{ replyId: "reply-1", quote: "和同学一起赶比赛" }, { replyId: "reply-7", quote: "一个人做研究" }] };
  // Replay 15: the card retold the disclosure in its own words; here it uses the disclosure's 「没人可说」.
  const echo = { ...good, text: "那时没人可说，你最投入的时候身边都有人。" };
  const { rpc, prompts, threadStarts } = fakeRuntime([turn({ stage: "narrative" }),
    turn({ stage: "narrative", reply: "谢谢你愿意说出来。全国心理援助热线 12356。现在还有这样的念头吗？", safety: true }),
    turn({ stage: "narrative" }),
    turn({ stage: "energy", insight: echo }),
    turn({ stage: "energy", askLesson: true }),
    turn({ stage: "energy" })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { extract: "off" });
  const last = async (text: string) => {
    await run({ sessionId: "s", text });
    return store.listOnboardingMessages(workspaceId, "s").at(-1)!.content as { insight?: { text: string }; questions: Array<{ id: string }> };
  };
  await last("我最投入的是和同学一起赶比赛的时候。");
  await last("大二有一段压力很大，自残过，没人可说。");
  expect(threadStarts()).toHaveLength(1);
  // The answer to the safety check: the thread is rebuilt with the disclosure's words replaced.
  await last("现在没有了。");
  expect(threadStarts()).toHaveLength(2);
  const rebuilt = dialogue(prompts).at(-1)!;
  expect(rebuilt).toContain(DISCLOSURE_PLACEHOLDER);
  expect(rebuilt).not.toContain("自残过");
  expect(rebuilt).toContain("本人在 reply-3 谈到过一段艰难时期");
  // A card using the disclosure's words is the model's to avoid (the snapshot says where the disclosure is); it is not sent back
  // (2026-11-25). The snapshot carries the disclosure's note.
  expect((await last("一个人做研究时最慢。")).insight).toMatchObject({ text: echo.text });
  expect(dialogue(prompts).filter((prompt) => prompt.includes("那段经历不作观察卡的材料"))).toHaveLength(0);
  expect(dialogue(prompts).at(-1)).toContain("四、本人在 reply-3");
  expect(dialogue(prompts).some((prompt) => prompt.includes("自残过") || prompt.includes("现在没有了"))).toBe(true);
  expect(dialogue(prompts).at(-1)).not.toContain("自残过");
  // The model asks for the lesson question; the app puts it as written, and reads the answer next round.
  expect((await last("周末一般在家。")).questions.map((question) => question.id)).toContain(LESSON_QUESTION.id);
  await last(`【${LESSON_QUESTION.text}】选择：可以聊聊`);
  expect(dialogue(prompts).at(-1)).toContain("本人愿意谈那段时期");
  expect(store.getOnboardingSession(workspaceId, "s")!.coverage).toMatchObject({ lesson: "yes", redacted: ["reply-3", "reply-5"] });
});

test("the extraction never reads a disclosure's words: the reply goes to it as the placeholder, unnumbered (2026-11-15)", async () => {
  const safety = turn({ stage: "narrative", reply: "谢谢你愿意说出来。全国心理援助热线 12356。", safety: true });
  const { rpc, prompts } = fakeRuntime([safety, safety]);
  await createOnboardingSessionRunner(store, workspaceId, "C:\repo", () => rpc)({ sessionId: "s", text: "大二自残过，没人可说。" });
  expect(extraction(prompts).length).toBeGreaterThan(0);
  expect(extraction(prompts).some((prompt) => prompt.includes("自残过"))).toBe(false);
  expect(extraction(prompts).some((prompt) => prompt.includes(DISCLOSURE_PLACEHOLDER))).toBe(true);
});

test("the dialogue reads the scale as readings, never taps; a reply quoting scores is not sent back (2026-11-22, IR-136 retired)", async () => {
  const { rpc, prompts } = fakeRuntime([turn({ stage: "energy", reply: "你尽责性 5/5，很有条理。" })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { extract: "off" });
  await run({ sessionId: "s", text: "【我做事有条理】点选：5/5（非常符合）\n周末一般在家。" });
  expect(dialogue(prompts)).toHaveLength(1);
  expect(dialogue(prompts)[0]).toContain("【我做事有条理】已点选（读数见 scaleReadings）");
  expect(dialogue(prompts)[0]).not.toContain("点选：5/5");
});

test("a reply saying what the card beside it says is no longer sent back (2026-11-22, IR-133 retired)", async () => {
  const insight = { text: "你说投入的两次都是和人一起赶东西，底座却是一个人做的研究。", falsifier: "如果独自做研究时也常投入",
    refs: [{ replyId: "reply-1", quote: "和同学一起赶比赛" }, { replyId: "reply-5", quote: "一个人做研究" }] };
  const said = "投入的两次都是和人一起赶东西，底座却是一个人做的，这很明显。";
  const { rpc, prompts } = fakeRuntime([turn({ stage: "energy" }), turn({ stage: "energy" }), turn({ stage: "energy", reply: said, insight })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { extract: "off" });
  await run({ sessionId: "s", text: "最投入的是和同学一起赶比赛的时候。" });
  await run({ sessionId: "s", text: "周末一般在家。" });
  await run({ sessionId: "s", text: "底座是我一个人做研究。" });
  const content = store.listOnboardingMessages(workspaceId, "s").at(-1)!.content as { reply: string; insight?: { text: string } };
  expect(content).toMatchObject({ reply: said, insight: { text: insight.text } });
  expect(dialogue(prompts)).toHaveLength(3);
});

test("a round needs no proposed next step and no question card: its one question is in the reply (2026-11-22, IR-139 and IR-052 retired)", async () => {
  const { rpc, prompts } = fakeRuntime([turn({ questions: [], reply: "周末在家，那周末做研究吗？" })]);
  await createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { extract: "off" })({ sessionId: "s", text: "周末一般在家。" });
  expect(dialogue(prompts)).toHaveLength(1);
  const content = store.listOnboardingMessages(workspaceId, "s").at(-1)!.content as { reply: string; next?: string; questions: unknown[] };
  expect(content.reply).toBe("周末在家，那周末做研究吗？");
  expect(content.questions).toEqual([]);
});

test("free text is the round's reply, with the cards and marks the tools handed in; no turn after the first is bound to a schema (2026-11-22)", async () => {
  const marks: AgentScript = async ({ ask }) => {
    await ask("item/tool/call", { callId: "m1", tool: "mark_round", arguments: { stage: "compass", safety: false } });
  };
  const { rpc, prompts, turnParams } = fakeRuntime([turn(), "你说周末在家。那周末的时间给了哪条线？"], { script: marks });
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { extract: "off" });
  await run({ sessionId: "s", text: "先说经历" });
  await run({ sessionId: "s", text: "周末一般在家。" });
  const content = store.listOnboardingMessages(workspaceId, "s").at(-1)!.content as { reply: string; stage: string };
  expect(content).toMatchObject({ reply: "你说周末在家。那周末的时间给了哪条线？", stage: "compass" });
  expect(turnParams().filter((params) => params.outputSchema !== undefined)).toEqual([]);
  expect(dialogue(prompts)[1]!.startsWith("〔账本快照 · 第 2 轮开始前")).toBe(true);
  expect(dialogue(prompts)[1]).toContain("\n\n周末一般在家。\n\n〔reply-3｜");
});

// 2026-11-25 (「访谈账本驱动」): the ledger is the model's external memory. What a round judged and asked is written when it ends, the
// person's next reply is written as the answer before the next round reads anything, and the next round opens with it rendered.
test("a round's verdicts and the reply's own questions are in the ledger before the next round, whose snapshot shows them", async () => {
  let calls = 0;
  const marks: AgentScript = async ({ ask }) => {
    calls += 1;
    await ask("item/tool/call", { callId: `m${calls}`, tool: "mark_round", arguments: calls === 1 ? { stage: "energy" } : { stage: "energy",
      checklist: [{ id: "portrait:method", status: "answered", basis: [{ ref: "reply-3", quote: "先做往年题" }], note: "" }],
      asked: [{ text: "学新东西时你先做什么？", gist: "学新东西的第一步", repeats: 0, followUp: false }] } });
  };
  const { rpc, prompts } = fakeRuntime([turn(), "你备考先做往年题。学新东西时你先做什么？", "好。"], { script: marks });
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { extract: "off" });
  await run({ sessionId: "s", text: "先说经历" });
  await run({ sessionId: "s", text: "备考我先做往年题。" });
  expect(store.getOnboardingSession(workspaceId, "s")!.coverage).toMatchObject({ checklist: { "portrait:method": { status: "answered", round: 4 } } });
  const main = store.questionByKey(workspaceId, "iq:s:4:main-1")!;
  expect(main).toMatchObject({ status: "open", text: "学新东西时你先做什么？" });
  expect(interviewChecklistFor(store, workspaceId, [], { unfiledFiles: 0 }).find((item) => item.id === "portrait_grounded")!.parts!
    .find((part) => part.id === "portrait:method")!.done).toBe(true);
  await run({ sessionId: "s", text: "先看一遍入门视频。" });
  expect(store.questionByKey(workspaceId, "iq:s:4:main-1")).toMatchObject({ status: "answered", answer: "先看一遍入门视频。" });
  const third = dialogue(prompts).at(-1)!;
  expect(third.startsWith("〔账本快照 · 第 3 轮开始前")).toBe(true);
  expect(third).toContain(`- #${main.id} 已答｜学新东西的第一步｜原题：学新东西时你先做什么？ → 「先看一遍入门视频。」`);
  expect(third).toContain("- portrait:method｜做事方法｜answered ← reply-3「先做往年题」");
});

test("a free-text round that never marked its part keeps the part it started in, on its first answer (2026-11-27)", async () => {
  const reply = "那接下来谈精力：最近哪一件事最消耗你？";
  const { rpc, prompts } = fakeRuntime([turn(), reply]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { extract: "off" });
  await run({ sessionId: "s", text: "先说经历" });
  const before = (store.getOnboardingSession(workspaceId, "s")!.coverage as { stage?: string }).stage;
  // Unmarked, it is not sent back (the Skill asks for the mark); the round stays in the part it started in.
  expect(await run({ sessionId: "s", text: "工作给我的是自由。" })).toEqual({ state: "asked", sessionId: "s" });
  expect(prompts()).toHaveLength(2);
  expect(store.listOnboardingMessages(workspaceId, "s").at(-1)!.content).toMatchObject({ reply, ...(before ? { stage: before } : {}) });

  // A round that marked its part goes through on its first answer, in the part it marked.
  const marks: AgentScript = async ({ ask }) => {
    await ask("item/tool/call", { callId: "m1", tool: "mark_round", arguments: { stage: "energy" } });
  };
  const marked = fakeRuntime([turn(), reply], { script: marks });
  const again = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => marked.rpc, { extract: "off" });
  await again({ sessionId: "t", text: "先说经历" });
  await again({ sessionId: "t", text: "健身回血。" });
  expect(marked.prompts()).toHaveLength(2);
  expect(store.listOnboardingMessages(workspaceId, "t").at(-1)!.content).toMatchObject({ reply, stage: "energy" });
});

test("the person's messages are at most a thousand a session, counted as a turn starts (2026-11-22)", async () => {
  const now = new Date().toISOString();
  store.saveOnboardingSession({ id: "s", ownerId: store.getWorkspaceOwnerId(workspaceId)!, workspaceId, state: "active", coverage: {}, createdAt: now, updatedAt: now });
  for (let index = 0; index < 1000; index += 1) {
    store.appendOnboardingMessage({ sessionId: "s", workspaceId, role: "user", content: { text: `第 ${index} 句` }, createdAt: now });
    store.appendOnboardingMessage({ sessionId: "s", workspaceId, role: "assistant", content: JSON.parse(turn()), createdAt: now });
  }
  const { rpc } = fakeRuntime([turn()]);
  expect(await createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { extract: "off" })({ sessionId: "s", text: "再一句" }))
    .toMatchObject({ state: "blocked", code: "INTERVIEW_ROUND_LIMIT" });
});

test("a message queued while a round runs becomes the next round, in the same request, and the queue is emptied (D17)", async () => {
  const { rpc, rawPrompts } = fakeRuntime([turn(), turn()]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { extract: "off" });
  enqueueInterview(store, workspaceId, "s", "还有一件：周三下午有课。");
  expect(readQueued(store, workspaceId, "s")).toHaveLength(1);
  expect(await run({ sessionId: "s", text: "先说经历" })).toEqual({ state: "asked", sessionId: "s" });
  const said = store.listOnboardingMessages(workspaceId, "s").filter((message) => message.role === "user").map((message) => (message.content as { text: string }).text);
  expect(said).toEqual(["先说经历", "还有一件：周三下午有课。"]);
  expect(dialogue(rawPrompts)).toHaveLength(2);
  expect(store.getSetting(workspaceId, interviewQueueKey("s"))).toBeUndefined();
});

test("「插入本轮」 steers the running turn with its id and saves the words; with no round running it is queued (D17)", async () => {
  expect(await steerInterview(store, workspaceId, "s", "没在跑")).toMatchObject({ state: "queued", queued: 1 });
  store.deleteSetting(workspaceId, interviewQueueKey("s"));
  let steered: unknown;
  const insert: AgentScript = async ({ turnId }) => { if (turnId === "turn-1") steered = await steerInterview(store, workspaceId, "s", "补一句：周末也有课。"); };
  const { rpc, steers } = fakeRuntime([turn()], { script: insert });
  await createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { extract: "off" })({ sessionId: "s", text: "先说经历" });
  expect(steered).toEqual({ state: "steered", sessionId: "s" });
  expect(steers()).toEqual([expect.objectContaining({ expectedTurnId: "turn-1", input: [expect.objectContaining({ text: "补一句：周末也有课。" })] })]);
  expect(store.listOnboardingMessages(workspaceId, "s").map((message) => message.content)).toContainEqual({ text: "补一句：周末也有课。", steered: true });
  expect(readQueued(store, workspaceId, "s")).toEqual([]);
});

test("a thread the runtime unloaded is resumed from its rollout with the one-line message, not rebuilt from the ledger (2026-11-22)", async () => {
  const now = new Date().toISOString();
  store.saveOnboardingSession({ id: "s", ownerId: store.getWorkspaceOwnerId(workspaceId)!, workspaceId, state: "active", coverage: { cardTools: "tools" }, codexThreadId: "idle-thread", createdAt: now, updatedAt: now });
  store.appendOnboardingMessage({ sessionId: "s", workspaceId, role: "user", content: { text: "先说经历" }, createdAt: now });
  store.appendOnboardingMessage({ sessionId: "s", workspaceId, role: "assistant", content: JSON.parse(turn()), createdAt: now });
  const { rpc, rawPrompts, resumes, threadStarts } = fakeRuntime([turn()], { coldThreads: ["idle-thread"] });
  expect((await createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { extract: "off" })({ sessionId: "s", text: "周末在家" })).state).toBe("asked");
  expect(resumes()).toContain("idle-thread");
  expect(threadStarts()).toEqual([]);
  expect(dialogue(rawPrompts).at(-1)).toContain("周末在家\n\n〔reply-3｜");
  expect(dialogue(rawPrompts).at(-1)).not.toContain("history");
});

test("a new thread starts with its part's checklist; later ones the dialogue reads with read_interview_state when it moves (2026-11-22)", async () => {
  let guide = "";
  const read: AgentScript = async ({ ask, turnId }) => {
    if (turnId !== "turn-2") return;
    const answer = await ask("item/tool/call", { callId: "g", tool: "read_interview_state", arguments: { part: "compass" } });
    guide = String((answer.contentItems as Array<{ text: string }>)[0]!.text);
  };
  const { rpc, rawPrompts } = fakeRuntime([turn({ stage: "narrative" }), turn({ stage: "compass" })], { script: read });
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { extract: "off" });
  await run({ sessionId: "s", text: "最投入的是和同学一起赶比赛的时候。" });
  await run({ sessionId: "s", text: "周末一般在家。" });
  expect(dialogue(rawPrompts)[0]).toContain(stageGuide("narrative")!.split("\n")[0]!);
  expect(dialogue(rawPrompts)[1]).not.toContain("stageGuide");
  expect(guide).toBe(stageGuide("compass"));
});

test("the Skill's core keeps at most fifteen rules, and every stage has a checklist of at most ten (2026-11-15)", async () => {
  const { readFileSync } = await import("node:fs");
  const core = readFileSync(new URL("../../../skills/marketplace/plugins/crossline/skills/crossline-onboarding/SKILL.md", import.meta.url), "utf8");
  const rules = (text: string) => text.match(/^\d+\. \*\*/gmu)?.length ?? 0;
  expect(rules(core.split("## 核心规则")[1]!.split("\n## ")[0]!)).toBeLessThanOrEqual(15);
  for (const stage of ONBOARDING_STAGES) {
    const guide = stageGuide(stage);
    expect(guide, stage).toContain(`本阶段：${stage}`);
    expect(rules(guide!), stage).toBeGreaterThan(0);
    expect(rules(guide!), stage).toBeLessThanOrEqual(10);
  }
  expect(stageGuide("../SKILL")).toBeUndefined();
});

test("as the person reads a round: the safety reply ends at its help lines; the rest of the reply and the questions are the model's own", async () => {
  const help = "全国心理援助热线 12356；身处危险时打 120 或 110，或去最近的医院急诊。";
  const card = { text: "你最投入的两次都是有人一起、每天有反馈的事，一个人做的研究推得最慢。", falsifier: "如果独自时也常投入",
    refs: [{ replyId: "reply-1", quote: "和同学一起赶比赛" }, { replyId: "reply-7", quote: "一个人做研究" }] };
  const { rpc } = fakeRuntime([turn({ stage: "narrative", questions: [{ id: "q1", text: "讲一件到目前为止最有成就感的事？", kind: "free", allowOther: true, identityId: "", projectId: "", options: [] }] }),
    turn({ stage: "narrative", reply: `谢谢你愿意说出来。${help}回到前面：你敬佩的人和那段时间正好相对。` }), turn({ stage: "energy" }),
    turn({ stage: "energy", reply: "记下了。你最投入的两次都是有人一起、每天有反馈的事，一个人的研究推得最慢。周末先排整块时间。", insight: card,
      questions: [{ id: "q1", text: "近一年最骄傲的一件事是什么？", kind: "free", allowOther: true, identityId: "", projectId: "", options: [] }] })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { extract: "off" });
  const last = async (text: string) => {
    await run({ sessionId: "s", text });
    return store.listOnboardingMessages(workspaceId, "s").at(-1)!.content as { reply: string; insight?: { text: string }; questions: Array<{ text: string }> };
  };
  await last("我最有成就感的是和同学一起赶比赛的时候。");
  expect((await last("有过一段情绪很低的时候，现在没有了。")).reply).toBe(`谢谢你愿意说出来。${help}`);
  await last("现在没有了，继续吧。");
  const round = await last("一个人做研究时最慢。");
  expect(round.insight?.text).toBe(card.text);
  // Not cut or prefixed by the app any more (2026-11-14 audit): saying the card twice or asking for the best story again is the Skill's
  // to avoid, measured in the replay evaluation.
  expect(round.reply).toBe("记下了。你最投入的两次都是有人一起、每天有反馈的事，一个人的研究推得最慢。周末先排整块时间。");
  expect(round.questions[0]!.text).toBe("近一年最骄傲的一件事是什么？");
});

// 2026-11-25 (「访谈账本驱动」): the days the person gave are in the snapshot and the Skill says a reply writes no other; a reply that does is
// recorded (IR-006), not sent back. What keeps a made-up day off the ledger and the calendar is the write step (IR-005): the extraction
// cites only the person's words or a file.
test("a reply that sets a date nobody gave is not sent back; the snapshot lists the days the person did give", async () => {
  // A day ten days ahead: a fixed 11 月 17 日 stopped being invented on that day (it was today, 2026-11-17).
  const ahead = new Date(Date.now() + 10 * 86_400_000);
  const reply = `试做定在 ${ahead.getMonth() + 1} 月 ${ahead.getDate()} 日：约两位从业者聊一次。`;
  const { rpc, prompts } = fakeRuntime([turn({ reply }), turn({ reply: "好。" })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\repo", () => rpc, { extract: "off" });
  await run({ sessionId: "s", text: "【未来两周先做哪一件？】选择：约两位从业者聊一次" });
  expect(dialogue(prompts)).toHaveLength(1);
  expect((store.listOnboardingMessages(workspaceId, "s").at(-1)!.content as { reply: string }).reply).toBe(reply);
  await run({ sessionId: "s", text: "12 月 5 日要交初稿。" });
  expect(dialogue(prompts).at(-1)).toContain("- reply-3：12 月 5 日");
});

// 2026-11-25: whether a question was asked and answered is in the snapshot (the ledger), so 「还没答」 and the cards' notation are the
// model's to avoid (the Skill); not sent back.
test("a reply copying a card's notation, or saying a question still waits, is not sent back (2026-11-23, W-314, W-315)", async () => {
  const { rpc, prompts } = fakeRuntime([turn({ reply: "清洗先定一条规则。[【问卷清洗】已点选]" }), turn({ reply: "上面那问还没答：接下来三四年你在做什么？" })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\repo", () => rpc, { extract: "off" });
  await run({ sessionId: "s", text: "卡在清洗缺失值。" });
  await run({ sessionId: "s", text: "先这样。" });
  expect(dialogue(prompts)).toHaveLength(2);
  expect((store.listOnboardingMessages(workspaceId, "s").at(-1)!.content as { reply: string }).reply).toBe("上面那问还没答：接下来三四年你在做什么？");
});

test("a line with fewer than three goal candidates is told it has not enough, and the round does not ask for a goal yet", async () => {
  store.setSetting(workspaceId, "lines.profiles", JSON.stringify({ media: { description: "小红书科普", attributes: [{ text: "有趣", kind: "ability", sourceRef: "reply-0" }] } }));
  const { rpc, prompts } = fakeRuntime([turn()]);
  await createOnboardingSessionRunner(store, workspaceId, "C:\repo", () => rpc, { extract: "off" })({ sessionId: "s", text: "开始吧" });
  expect(dialogue(prompts)[0]).toMatch(/：长期目标的候选词还不够（1 个）/);
  const asked = (store.listOnboardingMessages(workspaceId, "s").at(-1)!.content as { questions: Array<{ id: string }> }).questions;
  expect(asked.some((question) => question.id.startsWith("gap-goal-"))).toBe(false);
});

test("a reply that uses a finished research thread's figures stands: the conclusion is the person's to hear (2026-11-22, IR-143 retired)", async () => {
  store.setSetting(workspaceId, "onboarding.research:s", JSON.stringify([{ id: "r1", question: "寒假实习何时截止？", why: "", dimension: "D0", status: "done",
    conclusion: "事务所寒假实习网申多在 7 月底到 10 月，安永 10 月 16 日截止；银行分行多在 12 月底到 1 月初截止。", messages: [] }]));
  const reply = "查到了：事务所网申在 7 月到 10 月，安永 10 月 16 日已截止；银行分行 12 月底截止。";
  const { rpc, prompts } = fakeRuntime([turn({ reply })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { extract: "off" });
  await run({ sessionId: "s", text: "想找寒假实习。" });
  expect(dialogue(prompts)).toHaveLength(1);
  expect((store.listOnboardingMessages(workspaceId, "s").at(-1)!.content as { reply: string }).reply).toBe(reply);
});

test("the dialogue is told which lines still have no goal candidates, so it asks what the person wants to become only there", async () => {
  store.setSetting(workspaceId, "lines.profiles", JSON.stringify({ media: { description: "小红书科普",
    attributes: [{ text: "有趣", kind: "ability", sourceRef: "reply-0" }, { text: "值得信赖", kind: "state", sourceRef: "reply-0" }, { text: "高产", kind: "state", sourceRef: "reply-0" }] } }));
  const { rpc, prompts } = fakeRuntime([turn()]);
  await createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { extract: "off" })({ sessionId: "s", text: "开始吧" });
  const first = dialogue(prompts)[0]!;
  expect(first).toContain("goalPicker");
  expect(first).toMatch(/：已给出 3 个长期目标的候选词/);
  expect(first).toMatch(/：还没有长期目标的候选词/);
});

test("a line's goal is chosen inside the conversation: its candidates go out as the app's question once the dialogue names it, and the taps adopt the goal", async () => {
  store.setSetting(workspaceId, "lines.v1", JSON.stringify([{ id: "media", label: "创作者", color: "media", goal: "", createdAt: "2026-10-30T00:00:00.000Z" }]));
  store.setSetting(workspaceId, "lines.profiles", JSON.stringify({ media: { description: "小红书科普",
    attributes: [{ text: "有趣", kind: "ability", sourceRef: "reply-0" }, { text: "值得信赖", kind: "state", sourceRef: "reply-0" }, { text: "高产", kind: "state", sourceRef: "reply-0" }] } }));
  const round = turn({ stage: "lines", questions: [{ id: "q1", text: "每周大概花几小时做内容？", kind: "single", allowOther: true, identityId: "media",
    projectId: "", options: [{ id: "a", label: "5 小时以内", detail: "" }, { id: "b", label: "5 小时以上", detail: "" }] }], openItems: ["gap-goal-media"] });
  const { rpc } = fakeRuntime([round, round]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { extract: "off" });
  await run({ sessionId: "s", text: "开始吧" });
  const asked = (store.listOnboardingMessages(workspaceId, "s").at(-1)!.content as { questions: Array<{ id: string; text: string; options: Array<{ label: string }> }> })
    .questions.find((question) => question.id === "gap-goal-media");
  expect(asked?.options.map((option) => option.label)).toEqual(["有趣", "值得信赖", "高产"]);
  await run({ sessionId: "s", text: `【${asked!.text}】选择：有趣；值得信赖` });
  const lines = JSON.parse(store.getSetting(workspaceId, "lines.v1")!) as Array<{ id: string; goalParts?: string[] }>;
  expect(lines.find((line) => line.id === "media")?.goalParts).toEqual(["有趣", "值得信赖"]);
  expect(store.listEvents(workspaceId, { type: "line.changed", change: "updated" }).at(-1)?.payload).toMatchObject({ via: "interview" });
});

test("the portrait framework has one copy: no Skill keeps its own table or points at another Skill's", async () => {
  const { readFileSync } = await import("node:fs");
  const skill = (name: string) => readFileSync(new URL(`../../../skills/marketplace/plugins/crossline/skills/${name.split(":")[0]}/SKILL.md`, import.meta.url), "utf8");
  for (const name of ["crossline-onboarding", "crossline-onboarding-extract", "crossline-research:onboarding", "crossline-portrait:report"]) {
    expect(skill(name)).not.toContain("| D0 背景与约束 |");
    expect(skill(name)).not.toMatch(/见访谈 Skill[^。]*画像框架/u);
  }
  expect(PROFILE_FRAMEWORK).toContain("| D9 维持循环 |");
});

test("the runners carry only the scenario: the Skill holds the rules, and the language comes from the shared style", () => {
  for (const text of [INSTRUCTIONS, EXTRACT_INSTRUCTIONS]) {
    expect(text.length).toBeLessThan(900);
    expect(text).not.toMatch(/in Chinese/i);
  }
});

test("a question still failing its check after the repairs is left out, named to the model next round, and recorded for debugging", async () => {
  const kept = turn({ questions: [
    { id: "q-room", text: "组会在哪个房间？", kind: "free", allowOther: true, identityId: "research", projectId: "", options: [] },
    { id: "q1", text: "项目 A 的图表清单在哪？", kind: "single", allowOther: true, identityId: "research", projectId: "",
      options: [{ id: "a", label: "师兄给的文档", detail: "" }, { id: "b", label: "师兄给的文档。", detail: "" }] }] });
  // The first answer and both repairs keep the repeated option.
  const { rpc, prompts } = fakeRuntime([kept, kept, kept, turn()]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
  await run({ sessionId: "s1", text: "西湖那篇 10/31 前要投出，数据下周到。" });
  const [edited] = store.listEvents(workspaceId, { type: "onboarding.changed", change: "round_edited" });
  expect(edited?.payload).toMatchObject({ removed: [{ why: expect.stringContaining("「师兄给的文档。」重复") }] });
  // The room question is the model's to judge (the screen that took it out is gone): it reached the person.
  expect((store.listOnboardingMessages(workspaceId, "s1").at(-1)!.content as { questions: Array<{ id: string }> }).questions.map((question) => question.id)).toEqual(["q-room"]);
  await run({ sessionId: "s1", text: "图表清单在师兄给的文档里" });
  const second = dialogue(prompts).at(-1)!;
  expect(second).toContain("lastRound");
  expect(second).toContain("项目 A 的图表清单在哪");
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
  store.appendEvent({ ownerId: "user-1", workspaceId, idempotencyKey: "u1", type: "onboarding.changed", entityId: "s1",
    payload: { dropped: [{ title: "周四组会", code: "DATE_TIME_INVALID" }, { title: "午饭", code: "OFF_HOURS" }], change: "dates_unrecorded" } });
  await run({ sessionId: "s1", text: "好的" });
  const second = dialogue(prompts)[1]!;
  expect(second).toContain("notRecorded");
  expect(second).toContain("周四组会 — its time is incomplete");
  expect(second).not.toContain("午饭 —");
});

test("every weekly arrangement reaches the dialogue each round as its own weekday and time, not as a count (W-183)", async () => {
  const meeting = (id: string, weekday: number, startTime: string, endTime: string) =>
    ({ id, title: "ECE 548", project: "", kind: "class", weekdays: [weekday], startTime, endTime, from: "2026-09-01", to: "2099-12-31", sourceRef: "reply-1" });
  store.appendEvent({ ownerId: "o", workspaceId, idempotencyKey: "dates:extracted:b1", type: "dates.extracted", entityId: "b1",
    payload: { dates: [], recurring: [meeting("w-1", 4, "09:00", "11:30"), meeting("w-2", 2, "14:00", "16:30")] } });
  const { rpc, prompts } = fakeRuntime([turn(), turn()]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { extract: "off" });
  await run({ sessionId: "s", text: "周二 14:00–16:30 和周四 09:00–11:30 上课。" });
  await run({ sessionId: "s", text: "继续" });
  for (const prompt of dialogue(prompts)) {
    expect(prompt).toContain("fixedSchedule");
    expect(prompt).toContain("周二 14:00–16:30 ECE 548");
    expect(prompt).toContain("周四 09:00–11:30 ECE 548");
  }
});

test("the scale holds no start item (D10, 2026-11-22): a v2 interview with no answers is not held for cards", async () => {
  const { interviewChecklistFor } = await import("@crossline/db");
  const at = "2026-11-03T00:00:00.000Z";
  store.saveOnboardingSession({ id: "s", ownerId: "o", workspaceId, state: "active", coverage: { flow: "v2" }, createdAt: at, updatedAt: at });
  expect(interviewChecklistFor(store, workspaceId, [], { unfiledFiles: 0 }).some((item) => item.id === "profile_cards")).toBe(false);
});


// P2b-3b (docs/onboarding-agent-session.md D1): on a route that calls functions the dialogue hands its questions in through the card
// tools; each is checked as it comes, and a failing one is answered as a tool error in the same turn, before the round is written.
test("the card tools: a question handed in is checked on the spot, a failing one comes back as the tool's answer, and the kept ones make the round", async () => {
  const answers: Array<Record<string, unknown>> = [];
  const bad = { id: "q-when", text: "哪段时间最空？", kind: "single", allowOther: true, identityId: "research", projectId: "",
    options: [{ id: "a", label: "周末", detail: "" }, { id: "a", label: "晚上", detail: "" }] };
  const good = { ...bad, options: [{ id: "a", label: "周末", detail: "" }, { id: "b", label: "晚上", detail: "" }] };
  const dialogueThreads = () => runtime.threadStarts().flatMap((params, index) =>
    (params.dynamicTools as Array<{ name: string }> | undefined)?.some((tool) => tool.name === "ask_question") ? [`thread-${index + 1}`] : []);
  const runtime = runtimeWithRoutes([turn({ questions: [] }), turn({ questions: [] })], [ONBOARDING_SKILL, ONBOARDING_EXTRACT_SKILL], {
    routes: [{ match: EXTRACT, answers: [turn()] }],
    script: async ({ threadId, ask }) => {
      if (!dialogueThreads().includes(threadId)) return;
      for (const question of [bad, good]) answers.push(await ask("item/tool/call", { callId: `c${answers.length}`, tool: "ask_question", arguments: question }));
    } });
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\repo", () => runtime.rpc);
  await run({ sessionId: "s1", text: "西湖那篇 10/31 前要投出，数据下周到。" });
  // The tools are declared at the thread's start, and the session remembers it, so the follow-up turns answer them too.
  expect(dialogueThreads()).toHaveLength(1);
  expect(store.getOnboardingSession(workspaceId, "s1")!.coverage).toMatchObject({ cardTools: "tools" });
  const text = (answer: Record<string, unknown>) => ((answer.contentItems as Array<{ text: string }>)[0]!.text);
  expect(answers[0]).toMatchObject({ success: false });
  expect(text(answers[0]!)).toContain("选项 id 有重复");
  expect(answers[1]).toMatchObject({ success: true });
  expect(text(answers[1]!)).toContain("收下");
  // The final answer's `questions` was []: the round is what the tool kept.
  const round = store.listOnboardingMessages(workspaceId, "s1").at(-1)!.content as { questions: Array<{ id: string }> };
  expect(round.questions.map((question) => question.id)).toEqual(["q-when"]);
  // The next turn: the same question again is checked against the ledger, which now holds it unanswered — asked once, so it goes out.
  await run({ sessionId: "s1", text: "周末吧" });
  expect(answers[3]).toMatchObject({ success: true });
});

// C7 (docs/onboarding-agent-session.md): a rebuilt thread was sent every file, those past the reading budget with empty text, and all of
// them were marked shown, so the model never read the last ones.
test("a rebuilt thread is sent the files within the reading budget; the rest are not marked shown", async () => {
  const { rpc } = fakeRuntime([turn()], { lostThreads: ["gone-thread"] });
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\repo", () => rpc);
  const now = "2026-10-02T00:00:00.000Z";
  const ownerId = store.getWorkspaceOwnerId(workspaceId)!;
  store.saveOnboardingSession({ id: "s1", ownerId, workspaceId, state: "active", coverage: {}, codexThreadId: "gone-thread", createdAt: now, updatedAt: now });
  for (let index = 1; index <= 6; index += 1) store.saveSourceDocument({ id: `doc-${index}`, ownerId, workspaceId, kind: "text", fileName: `File ${index}.txt`,
    mediaType: "text/plain", sha256: String(index), uri: `file:///${index}`, extractedText: "字".repeat(40_000), extractionStatus: "done", createdAt: now });
  store.appendOnboardingMessage({ sessionId: "s1", workspaceId, role: "user", content: { text: "文件都传了" }, createdAt: now });
  store.appendOnboardingMessage({ sessionId: "s1", workspaceId, role: "assistant", content: JSON.parse(turn()), createdAt: now });
  await run({ sessionId: "s1", text: "看看文件" });
  const announced = (store.getOnboardingSession(workspaceId, "s1")!.coverage as { announcedSources?: string[] }).announcedSources ?? [];
  expect(announced.length).toBeGreaterThan(0);
  expect(announced.length).toBeLessThan(6);
});
