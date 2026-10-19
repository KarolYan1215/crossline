import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { ONBOARDING_PROGRESS_SETTING, type OnboardingProgress } from "@crossline/core";
import { createOnboardingSessionRunner, ONBOARDING_SKILL, paceDeepRound } from "./onboarding-session";
import { fakeRuntime as sharedRuntime } from "./testing/fake-runtime";

const fakeRuntime = (answers: string[], options: { lostThreads?: string[] } = {}) => sharedRuntime(answers, ONBOARDING_SKILL, options);
let store: CrosslineStore;
let workspaceId: string;

beforeEach(() => {
  store = new CrosslineStore(":memory:");
  workspaceId = store.createPrincipalWithWorkspace("user-1", "个人 workspace").workspace.id;
});
afterEach(() => store.close());

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
  const sent = prompts().map((prompt) => prompt.includes("\"calendar\""));
  expect(sent).toEqual([true, false, true]);
  expect(prompts()[0]).toContain("ECE 548 Lecture");
});

test("the second turn continues the same thread and only carries what is new", async () => {
  const { rpc, prompts, turns } = fakeRuntime([firstAnswer, turn()]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
  await run({ sessionId: "s1", text: "西湖那篇 10/31 前要投出，数据下周到。" });
  await run({ sessionId: "s1", text: "图表清单在师兄给的文档里" });
  expect(turns()).toBe(2);
  expect(prompts()[1]).not.toContain("identities");
  expect(prompts()[1]).toContain("reply-3");
  expect(store.listOnboardingMessages(workspaceId, "s1").map((message) => message.seq)).toEqual([1, 2, 3, 4]);
});

test("an extracted file reaches the model once, as numbered sentences, and a fact citing two of them gets their words", async () => {
  store.saveSourceDocument({ id: "d1", ownerId: "o", workspaceId, kind: "docx", fileName: "Lecture Plan.docx",
    mediaType: "application/octet-stream", sha256: "x", uri: "file:///x", extractedText: "Week-8: 27th Oct.\nL15: Mid-term-1",
    extractionStatus: "done", createdAt: "2026-10-02T00:00:00.000Z" });
  const answer = turn({ questions: [], nextAction: "ready_for_milestones", slotUpdates: [{ identityId: "research", projectId: "", slot: "midterm", value: "10/27 期中 1", status: "confirmed",
    refs: [2, 3] }] });
  const { rpc, prompts } = fakeRuntime([answer, turn()]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
  await run({ sessionId: "s", text: "我上传了课程文件" });
  expect(prompts()[0]).toContain("Lecture Plan.docx");
  expect(prompts()[0]).toContain("[2] Week-8: 27th Oct.\\n[3] L15: Mid-term-1");
  expect(store.listProfileFacts(workspaceId).find((fact) => fact.slot === "midterm")).toMatchObject({ sourceRef: "src-1", status: "confirmed",
    sourceQuote: "Week-8: 27th Oct.\nL15: Mid-term-1", sourceSentences: [2, 3] });
  await run({ sessionId: "s", text: "继续" });
  // Already announced: not sent again.
  expect(prompts()[1]).not.toContain("Lecture Plan.docx");
});

test("a sentence number the model was not shown is refused and nothing from that turn is saved", async () => {
  const bad = turn({ slotUpdates: [{ identityId: "research", projectId: "", slot: "deadline", value: "10/15", status: "confirmed", refs: [99] }] });
  const { rpc } = fakeRuntime([bad]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
  const outcome = await run({ sessionId: "s", text: "10/31 前要投出" });
  expect(outcome).toMatchObject({ state: "blocked", code: "ONBOARDING_REF_UNKNOWN" });
  expect(store.listProfileFacts(workspaceId)).toEqual([]);
  // The person's message is kept, ready for a retry, and there is no assistant message.
  expect(store.listOnboardingMessages(workspaceId, "s").map((message) => message.role)).toEqual(["user"]);
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

test("a finished interview marks the session complete", async () => {
  const { rpc } = fakeRuntime([turn({ questions: [], nextAction: "ready_for_milestones" })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { checklist: false });
  expect(await run({ sessionId: "s", text: "都说完了" })).toEqual({ state: "ready", sessionId: "s" });
  expect(store.getOnboardingSession(workspaceId, "s")?.state).toBe("complete");
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
  expect(saved?.codexThreadId).toBe("thread-1");
  // The new thread's first prompt carries the earlier lines, with the user's own reply id so it can be cited.
  const prompt = prompts()[0] ?? "";
  expect(prompt).toContain("history");
  expect(prompt).toContain("西湖那篇 10/31 前要投出");
  expect(prompt).toContain("reply-1");
  expect(store.listOnboardingMessages(workspaceId, "s1").map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
});

const withDates = (fileDates: object) => turn({ fileDates, questions: [], nextAction: "ready_for_milestones" });
const dateItem = (over: object = {}) => ({ id: "d1", date: "2026-10-27", startMinute: null, endMinute: null, kind: "exam", title: "ECE 548 期中 1", project: "",
  refs: [2, 3], confidence: "high", note: "", ...over });

test("dates the model read out of a file become one verified batch, and what cannot be verified is dropped and counted", async () => {
  store.saveSourceDocument({ id: "doc-1", ownerId: "o", workspaceId, kind: "docx", fileName: "Lecture Plan.docx", mediaType: "x", sha256: "1", uri: "file:///1",
    extractedText: "Week-8: 27th Oct.\nL15: Mid-term-1\nExam: 17th December Wednesday", extractionStatus: "done", createdAt: "2026-10-02T00:00:00.000Z" });
  const { rpc } = fakeRuntime([withDates({
    // [2] says 27 October: a date of 3 November citing it is dropped.
    dates: [dateItem(), dateItem({ id: "d2", title: "编造的考试", date: "2026-11-03", refs: [2] })],
    recurring: [], questions: ["这些材料是哪门课的？"]
  })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { checklist: false });
  expect((await run({ sessionId: "s1", text: "我添加了文件" })).state).toBe("ready");
  const [batch] = store.listEvents(workspaceId, { type: "dates.extracted" });
  const payload = batch!.payload as { documentIds: string[]; dates: Array<{ id: string }>; questions: string[]; dropped: Array<{ id: string }> };
  expect(payload.documentIds).toEqual(["doc-1"]);
  expect(payload.dates.map((item) => item.id)).toEqual(["d1"]);
  expect(payload.dropped.map((item) => item.id)).toEqual(["d2"]);
  expect(payload.questions).toEqual(["这些材料是哪门课的？"]);
});

test("a turn with no dates writes no batch, and a newer batch retires one nobody answered", async () => {
  store.saveSourceDocument({ id: "doc-1", ownerId: "o", workspaceId, kind: "docx", fileName: "Lecture Plan.docx", mediaType: "x", sha256: "1", uri: "file:///1",
    extractedText: "Week-8: 27th Oct.\nL15: Mid-term-1", extractionStatus: "done", createdAt: "2026-10-02T00:00:00.000Z" });
  const empty = { dates: [], recurring: [], questions: [] };
  const { rpc } = fakeRuntime([withDates(empty), withDates({ ...empty, dates: [dateItem()] }), withDates({ ...empty, dates: [dateItem({ id: "d9" })] })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { checklist: false });
  await run({ sessionId: "s1", text: "一" });
  expect(store.listEvents(workspaceId, { type: "dates.extracted" })).toHaveLength(0);
  await run({ sessionId: "s1", text: "二" });
  await run({ sessionId: "s1", text: "三" });
  expect(store.listEvents(workspaceId, { type: "dates.extracted" })).toHaveLength(2);
  const retired = store.listEvents(workspaceId, { type: "dates.decided" });
  expect(retired).toHaveLength(1);
  expect(retired[0]!.payload).toMatchObject({ superseded: true });
  // A later turn adds to the batch nobody answered; it does not throw the earlier dates away.
  const latest = store.listEvents(workspaceId, { type: "dates.extracted" }).at(-1)!.payload as { dates: Array<{ id: string }> };
  expect(latest.dates.map((item) => item.id).sort()).toEqual(["d1", "d9"]);
});

test("a re-read of the files replaces the unanswered batch; meals outside the stated hours never become a batch", async () => {
  store.saveSourceDocument({ id: "doc-1", ownerId: "o", workspaceId, kind: "docx", fileName: "Lecture Plan.docx", mediaType: "x", sha256: "1", uri: "file:///1",
    extractedText: "Week-8: 27th Oct.\nL15: Mid-term-1", extractionStatus: "done", createdAt: "2026-10-02T00:00:00.000Z" });
  const empty = { dates: [], recurring: [], questions: [] };
  const meal = { id: "lunch", title: "午饭", project: "个人安排", weekdays: [0, 1, 2, 3, 4, 5, 6], startMinute: 720, endMinute: 840, from: "2026-10-12",
    to: "2026-12-31", exceptions: [], location: "", refs: [4], confidence: "medium" };
  const hours = { windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMinute: 540, endMinute: 720, energy: "high" }, { days: [0, 1, 2, 3, 4, 5, 6], startMinute: 840, endMinute: 1080, energy: "medium" }], why: "本人所述" };
  const { rpc } = fakeRuntime([withDates({ ...empty, dates: [dateItem()] }),
    turn({ fileDates: { ...empty, recurring: [meal] }, availability: hours, questions: [], nextAction: "ready_for_milestones" }),
    withDates({ ...empty, dates: [dateItem({ id: "d9" })] })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { checklist: false });
  await run({ sessionId: "s1", text: "我添加了文件" });
  // The meals are what the hours already leave out: no batch, and the course's date still waits for an answer.
  await run({ sessionId: "s1", text: "上午 9–12 点效率最高，12–14 点午饭" });
  expect(store.listEvents(workspaceId, { type: "dates.extracted" })).toHaveLength(1);
  expect(store.getSetting(workspaceId, "schedule.availability.proposed")).toContain("09:00");
  await run({ sessionId: "s1", text: "请重新读一遍日期", reread: true });
  const latest = store.listEvents(workspaceId, { type: "dates.extracted" }).at(-1)!.payload as { dates: Array<{ id: string }> };
  expect(latest.dates.map((item) => item.id)).toEqual(["d9"]);
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
  expect(await run({ sessionId: "s", text: "ECE 555 评分：作业 20%、小测 30%、项目 25%、期末 25%，我想拿高分，期末 2026-12-15" })).toEqual({ state: "ready", sessionId: "s" });
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

test("declining the line is recorded by the app itself, and the interview can then finish", async () => {
  const { rpc } = fakeRuntime([guessOnly, turn({ questions: [], nextAction: "ready_for_milestones" })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { checklist: false });
  await run({ sessionId: "s", text: "随便聊聊" });
  const question = (store.listOnboardingMessages(workspaceId, "s").at(-1)!.content as { questions: Array<{ id: string; text: string }> }).questions.find((item) => item.id === "gap-line-startup")!;
  expect(await run({ sessionId: "s", text: `【${question.text}】选择：目前没有在做的事` })).toEqual({ state: "ready", sessionId: "s" });
  expect(store.listProfileFacts(workspaceId).find((fact) => fact.slot === "skipped")).toMatchObject({ identityId: "startup", status: "confirmed", sourceRef: "reply-3" });
});

test("with the completion list on, a 「ready」 before the portrait is written and grounded goes back to asking", async () => {
  const { rpc } = fakeRuntime([turn({ questions: [], nextAction: "ready_for_milestones" })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
  expect(await run({ sessionId: "s", text: "都说完了" })).toEqual({ state: "asked", sessionId: "s" });
  expect(store.getOnboardingSession(workspaceId, "s")?.state).toBe("active");
  const last = store.listOnboardingMessages(workspaceId, "s").at(-1)!.content as { reply: string; questions: unknown[] };
  expect(last.reply).toContain("完成访谈前还缺：画像各部分已写出");
  expect(last.questions.length).toBeGreaterThan(0);
});

const attributes = ["神经形态计算", "器件物理", "能独立立项", "能写基金申请", "持续产出", "被同行认可"]
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

test("先读材料：首轮把已读出的文件全部带上，清单标出可开始项，阶段从 orientation 开始", async () => {
  for (const [id, fileName, text] of [["d1", "Resume.md", "博士二年级，研究忆阻器"], ["d2", "ECE555 Syllabus.md", "Final Exam: Dec 15"]] as const)
    store.saveSourceDocument({ id, ownerId: "o", workspaceId, kind: "text", fileName, mediaType: "text/markdown", sha256: id, uri: `file:///${id}`,
      extractedText: text, extractionStatus: "done", createdAt: "2026-10-02T00:00:00.000Z" });
  const { rpc, prompts } = fakeRuntime([turn()]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
  await run({ sessionId: "s", text: "材料已添加，请先从材料里读出能读的，再问还缺的。" });
  const prompt = prompts()[0]!;
  const context = JSON.parse(prompt.slice(prompt.indexOf("{"), prompt.lastIndexOf("}") + 1)) as {
    sources: unknown[]; checklist: Array<{ start?: boolean }>; stage: string };
  expect(context.sources).toHaveLength(2);
  expect(context.checklist.some((item) => item.start === true)).toBe(true);
  expect(context.stage).toBe("orientation");
});

test("a deep-stage round keeps independent questions together, at most four, and a fact stage keeps its batch", () => {
  const two = JSON.parse(turn({ stage: "compass", questions: [
    { id: "q1", text: "工作对你意味着什么？", kind: "free", allowOther: true, identityId: "person", projectId: "", options: [] },
    { id: "q2", text: "人生的意义？", kind: "free", allowOther: true, identityId: "person", projectId: "", options: [] }] }));
  expect(paceDeepRound(two, false)).toMatchObject({ deep: true, output: { questions: [{ id: "q1" }, { id: "q2" }] } });
  const six = { ...two, questions: Array.from({ length: 6 }, (_, index) => ({ ...two.questions[0], id: `q${index + 1}` })) };
  expect(paceDeepRound(six, false).output.questions.map((question: { id: string }) => question.id)).toEqual(["q1", "q2", "q3", "q4"]);
  // A line's own interview is all details; a fact stage keeps every question.
  expect(paceDeepRound(two, true).output.questions).toHaveLength(2);
  expect(paceDeepRound({ ...two, stage: "lines" }, false)).toMatchObject({ deep: false });
  expect(paceDeepRound({ ...two, stage: "lines" }, false).output.questions).toHaveLength(2);
});

test("the tone the person chose goes with the first turn and every later one", async () => {
  // An account that chose the retired 「直接犀利」 is spoken to as 冷静客观.
  store.setSetting(workspaceId, "onboarding.tone", "direct");
  const { rpc, prompts } = fakeRuntime([firstAnswer, turn()]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
  await run({ sessionId: "s1", text: "开始" });
  store.setSetting(workspaceId, "onboarding.tone", "warm");
  await run({ sessionId: "s1", text: "继续" });
  expect(prompts()[0]).toContain('"tone":"neutral"');
  expect(prompts().slice(1).some((prompt) => prompt.includes('"tone":"warm"'))).toBe(true);
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
  const rewritten = { ...written, portrait: "一位在毕业前同时押注研究与产品的工程师，靠打球和讨论充电，最怕的是五件事都停在七成。",
    coreConflict: "想把两条未来都留着，代价落在睡眠和周日下午上。", problem: "缺的不是时间，而是一条让某件事这周先慢下来的规则。" };
  const { rpc } = fakeRuntime([turn({ profile: rewritten,
    questions: [{ id: "q", text: "这周最想先收口哪件事？", kind: "free", options: [], allowOther: true, identityId: "", projectId: "" }] })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
  expect(await run({ sessionId: "s", text: "【「当前画像」写的是否符合本人？】选择：符合" })).toEqual({ state: "asked", sessionId: "s" });
  const { PROFILE_CONFIRMED, portraitStillConfirmed } = await import("@crossline/core");
  const confirmed = JSON.parse(store.getSetting(workspaceId, PROFILE_CONFIRMED) ?? "{}") as { fingerprint?: string };
  expect(JSON.parse(store.getSetting(workspaceId, "profile.model")!)).toMatchObject({ portrait: rewritten.portrait });
  expect(portraitStillConfirmed(confirmed.fingerprint, rewritten)).toBe(true);
});
