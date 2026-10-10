import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { createOnboardingSessionRunner, ONBOARDING_SKILL } from "./onboarding-session";
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
    sourceRef: "reply-1", sourceQuote: "10/31 前要投出" }],
  flywheelCandidates: [{ fromIdentityId: "research", toIdentityId: "media", kind: "informs", explanation: "研究过程是自媒体的选题来源",
    evidenceRefs: ["inference"], status: "inferred" }],
  coverage: [{ identityId: "research", filled: ["deadline"], missing: ["stage"] }]
});

test("a first turn opens a thread, saves the reply, and writes the projects and facts it learned", async () => {
  const { rpc } = fakeRuntime([firstAnswer]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
  const outcome = await run({ sessionId: "s1", text: "西湖那篇 10/31 前要投出，数据下周到。" });
  expect(outcome).toEqual({ state: "asked", sessionId: "s1" });

  expect(store.listProjects(workspaceId).map((project) => project.name)).toEqual(["西湖合作：MoS2 忆阻器片上训练"]);
  const facts = store.listProfileFacts(workspaceId);
  expect(facts.find((fact) => fact.slot === "deadline")).toMatchObject({ value: "10/31 前投出", status: "confirmed", sourceRef: "reply-1" });
  // A connection between lines is only ever a guess at this point.
  expect(facts.find((fact) => fact.slot === "flywheel_media_informs")).toMatchObject({ status: "inferred" });

  const messages = store.listOnboardingMessages(workspaceId, "s1");
  expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  expect(store.getOnboardingSession(workspaceId, "s1")).toMatchObject({ codexThreadId: expect.any(String), state: "active" });
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

test("an extracted file reaches the model once, as a citable source, and its text can be quoted", async () => {
  store.saveSourceDocument({ id: "d1", ownerId: "o", workspaceId, kind: "docx", fileName: "Lecture Plan.docx",
    mediaType: "application/octet-stream", sha256: "x", uri: "file:///x", extractedText: "Week-8: 27th Oct.\nL15: Mid-term-1",
    extractionStatus: "done", createdAt: "2026-10-02T00:00:00.000Z" });
  const answer = turn({ questions: [], nextAction: "ready_for_milestones", slotUpdates: [{ identityId: "research", projectId: "", slot: "midterm", value: "10/27 期中 1", status: "confirmed",
    sourceRef: "src-1", sourceQuote: "27th Oct. L15: Mid-term-1" }] });
  const { rpc, prompts } = fakeRuntime([answer, turn()]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
  await run({ sessionId: "s", text: "我上传了课程文件" });
  expect(prompts()[0]).toContain("Lecture Plan.docx");
  expect(store.listProfileFacts(workspaceId).find((fact) => fact.slot === "midterm")).toMatchObject({ sourceRef: "src-1", status: "confirmed" });
  await run({ sessionId: "s", text: "继续" });
  // Already announced: not sent again.
  expect(prompts()[1]).not.toContain("Lecture Plan.docx");
});

test("a fabricated quote is refused and nothing from that turn is saved", async () => {
  const bad = turn({ slotUpdates: [{ identityId: "research", projectId: "", slot: "deadline", value: "10/15", status: "confirmed",
    sourceRef: "reply-1", sourceQuote: "10/15 前投出" }] });
  const { rpc } = fakeRuntime([bad]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
  const outcome = await run({ sessionId: "s", text: "10/31 前要投出" });
  expect(outcome).toMatchObject({ state: "blocked", code: "ONBOARDING_QUOTE_NOT_VERBATIM" });
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
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\repo", () => rpc, { checklist: false });
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
const dateItem = (over: object = {}) => ({ id: "d1", date: "2026-10-27", startTime: "", endTime: "", kind: "exam", title: "ECE 548 期中 1", project: "", sourceRef: "src-1",
  quote: "Week-8: 27th Oct. L15: Mid-term-1", confidence: "high", note: "", ...over });

test("dates the model read out of a file become one verified batch, and what cannot be verified is dropped and counted", async () => {
  store.saveSourceDocument({ id: "doc-1", ownerId: "o", workspaceId, kind: "docx", fileName: "Lecture Plan.docx", mediaType: "x", sha256: "1", uri: "file:///1",
    extractedText: "Week-8: 27th Oct.\nL15: Mid-term-1\nExam: 17th December Wednesday", extractionStatus: "done", createdAt: "2026-10-02T00:00:00.000Z" });
  const { rpc } = fakeRuntime([withDates({
    dates: [dateItem(), dateItem({ id: "d2", title: "编造的考试", date: "2026-11-03", quote: "27th Oct. L15" })],
    recurring: [], questions: ["这些材料是哪门课的？"]
  })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\repo", () => rpc, { checklist: false });
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
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\repo", () => rpc, { checklist: false });
  await run({ sessionId: "s1", text: "一" });
  expect(store.listEvents(workspaceId, { type: "dates.extracted" })).toHaveLength(0);
  await run({ sessionId: "s1", text: "二" });
  await run({ sessionId: "s1", text: "三" });
  expect(store.listEvents(workspaceId, { type: "dates.extracted" })).toHaveLength(2);
  const retired = store.listEvents(workspaceId, { type: "dates.decided" });
  expect(retired).toHaveLength(1);
  expect(retired[0]!.payload).toMatchObject({ superseded: true });
});

const course = turn({
  projectsDetected: [{ id: "ece555", identityId: "research", name: "ECE 555", summary: "课程" }],
  slotUpdates: [
    { identityId: "research", projectId: "ece555", slot: "grading", value: "作业 20%、小测 30%、项目 25%、期末 25%", status: "confirmed", sourceRef: "reply-1", sourceQuote: "作业 20%、小测 30%、项目 25%、期末 25%" },
    { identityId: "research", projectId: "ece555", slot: "goal", value: "拿高分", status: "confirmed", sourceRef: "reply-1", sourceQuote: "拿高分" }
  ],
  questions: [], nextAction: "ready_for_milestones"
});

test("a course's target grade is not asked: the architect proposes one later, so a finished interview stays finished", async () => {
  const { rpc } = fakeRuntime([course]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\repo", () => rpc, { checklist: false });
  expect(await run({ sessionId: "s", text: "ECE 555 评分：作业 20%、小测 30%、项目 25%、期末 25%，我想拿高分" })).toEqual({ state: "ready", sessionId: "s" });
  expect(store.listProfileFacts(workspaceId).some((fact) => fact.slot === "target_grade")).toBe(false);
});

const guessOnly = turn({
  slotUpdates: [{ identityId: "startup", projectId: "", slot: "what", value: "可能在做某个产品", status: "inferred", sourceRef: "inference", sourceQuote: "" }],
  questions: [], nextAction: "ready_for_milestones"
});

test("the model saying it is done does not make it so: a line resting only on its own guesses turns it back into a question", async () => {
  const { rpc } = fakeRuntime([guessOnly]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\repo", () => rpc, { checklist: false });
  expect(await run({ sessionId: "s", text: "随便聊聊" })).toEqual({ state: "asked", sessionId: "s" });
  const asked = store.listOnboardingMessages(workspaceId, "s").at(-1)!.content as { questions: Array<{ id: string }>; nextAction: string };
  expect(asked.nextAction).toBe("ask");
  expect(asked.questions.map((question) => question.id)).toContain("gap-line-startup");
});

test("declining the line is recorded by the app itself, and the interview can then finish", async () => {
  const { rpc } = fakeRuntime([guessOnly, turn({ questions: [], nextAction: "ready_for_milestones" })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\repo", () => rpc, { checklist: false });
  await run({ sessionId: "s", text: "随便聊聊" });
  const question = (store.listOnboardingMessages(workspaceId, "s").at(-1)!.content as { questions: Array<{ id: string; text: string }> }).questions.find((item) => item.id === "gap-line-startup")!;
  expect(await run({ sessionId: "s", text: `【${question.text}】选择：目前没有在做的事` })).toEqual({ state: "ready", sessionId: "s" });
  expect(store.listProfileFacts(workspaceId).find((fact) => fact.slot === "skipped")).toMatchObject({ identityId: "startup", status: "confirmed", sourceRef: "reply-3" });
});

test("with the completion list on, a 「ready」 before the portrait is written and grounded goes back to asking", async () => {
  const { rpc } = fakeRuntime([turn({ questions: [], nextAction: "ready_for_milestones" })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\repo", () => rpc);
  expect(await run({ sessionId: "s", text: "都说完了" })).toEqual({ state: "asked", sessionId: "s" });
  expect(store.getOnboardingSession(workspaceId, "s")?.state).toBe("active");
  const last = store.listOnboardingMessages(workspaceId, "s").at(-1)!.content as { reply: string; questions: unknown[] };
  expect(last.reply).toContain("完成访谈前还缺：画像各部分已写出");
  expect(last.questions.length).toBeGreaterThan(0);
});

const attributes = ["神经形态计算", "器件物理", "能独立立项", "能写基金申请", "持续产出", "被同行认可"]
  .map((text, index) => ({ text, kind: index < 2 ? "domain" : index < 4 ? "ability" : "state", sourceRef: "reply-1" }));

test("a line card's turn is that line's own interview: attributes refresh by line, and a goal change waits for the person", async () => {
  store.setSetting(workspaceId, "lines.profiles", JSON.stringify({ research: { description: "旧描述",
    attributes: [{ text: "类脑芯片方向能带队", kind: "domain", sourceRef: "goal" }, { text: "旧候选", kind: "domain", sourceRef: "reply-0" }] },
    media: { description: "自媒体描述", goalCandidates: ["成为有影响力的科普创作者"] } }));
  const answer = turn({ questions: [], nextAction: "ready_for_milestones",
    lineProfiles: [{ lineId: "research", description: "以器件物理为底的神经形态计算研究", attributeCandidates: attributes }],
    goalEdits: [{ lineId: "research", parts: [{ text: "器件物理", kind: "domain" }, { text: "能独立立项", kind: "ability" }], sourceRef: "reply-1" }] });
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
  store.setSetting(workspaceId, "lines.profiles", JSON.stringify({ research: { description: "旧描述", attributes } }));
  const { rpc } = fakeRuntime([turn({ questions: [], nextAction: "ready_for_milestones", lineProfiles: [{ lineId: "research", description: "新描述", attributeCandidates: [] }] })]);
  await createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc)({ sessionId: "line-research", text: "补充一点" });
  const profiles = JSON.parse(store.getSetting(workspaceId, "lines.profiles")!) as Record<string, { description: string; attributes: unknown[] }>;
  expect(profiles.research).toMatchObject({ description: "新描述", attributes });
});
