import { afterEach, beforeEach, expect, test } from "vitest";
import { pushPolicyOf, readPersonQuestion } from "@crossline/core";
import { CrosslineStore, PERSON_QUESTION_EVENT, personQuestionKey, personQuestions, settlePersonQuestion } from "@crossline/db";
import { createAskTool, withAskTool, type AskToolContext } from "./ask-tool";

let store: CrosslineStore;
let ws: string;
const NOW = new Date("2026-11-25T18:00:00Z");
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  ws = store.createPrincipalWithWorkspace("user-1", "个人").workspace.id;
});
afterEach(() => store.close());

const context = (over: Partial<AskToolContext> = {}): AskToolContext => ({ store, workspaceId: ws, skill: "crossline:crossline-step-planner",
  ref: { kind: "task", id: "task-1" }, identityId: "research", projectId: "ece555", dueBy: "", title: "完成 ECE 555 作业 4", now: () => NOW, ...over });
const ask = (question: string, over: Record<string, unknown> = {}) => ({ question, why: "决定要不要排复习步骤", knownBy: "person", answerType: "text",
  assumption: "按照常规复习", blocking: false, ...over });
const call = async (tool: ReturnType<typeof createAskTool>, args: unknown) => JSON.parse(await tool.call("ask_person", args)) as Record<string, string>;
const said = () => store.listConversationMessages(ws, store.conversationFor(ws, "2026-11-25").id)
  .filter((message) => message.role === "nudge" && (message.payload as { nudge?: { kind?: string } }).nudge?.kind === "person_question");

test("a question the ledger already holds an answer to is answered from it, and the person is not asked", async () => {
  const number = store.recordQuestion(ws, { kind: "ask", key: "ask:stepq:x", text: "期末考试允许带一页公式纸吗？", status: "open", at: NOW.toISOString() });
  store.answerQuestion(ws, number, { text: "允许，一页双面", at: NOW.toISOString() });
  const tool = createAskTool(context());
  const answer = await call(tool, ask("期末考试允许带一页公式纸吗"));
  expect(answer).toMatchObject({ status: "answered", answer: "允许，一页双面" });
  expect(store.listEvents(ws, { type: PERSON_QUESTION_EVENT })).toHaveLength(0);
  expect(tool.outcomes()).toEqual([{ status: "answered", question: "期末考试允许带一页公式纸吗" }]);
});

test("at most two new questions a run; the third is refused and the run is told to go on with its assumption", async () => {
  const tool = createAskTool(context());
  expect((await call(tool, ask("你每周能给这门课几个小时？"))).status).toBe("asked");
  expect((await call(tool, ask("你打算用 Python 还是 MATLAB 完成项目？"))).status).toBe("asked");
  expect(() => tool.call("ask_person", ask("期中之后还准备换组吗？"))).toThrow(/已向本人提了 2 个问题/);
  expect(personQuestions(store, ws)).toHaveLength(2);
});

test("the same question again joins the open one: one card, and another run's blocking answer reruns it too", async () => {
  const first = createAskTool(context());
  const asked = await call(first, ask("你打算用 Python 还是 MATLAB 完成项目？"));
  // Asked again in the same run: not a second card, and not counted.
  expect((await call(first, ask("你打算用 Python 还是 MATLAB 完成项目"))).status).toBe("already_asked");
  const other = createAskTool(context({ ref: { kind: "milestone", id: "m-1" } }));
  expect((await call(other, ask("打算用 Python 还是 MATLAB 完成项目？", { blocking: true }))).status).toBe("already_asked");
  const rows = personQuestions(store, ws);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.askers.map((asker) => [asker.ref.kind, asker.blocking])).toEqual([["task", false], ["milestone", true]]);
  // Answered: written as the person's own confirmed fact, on the question ledger, and only the blocking waiter is rerun.
  const settled = settlePersonQuestion(store, ws, asked.id!, "Python", "answered", NOW.toISOString());
  expect(settled).toEqual({ ok: true, rerun: [{ kind: "milestone", id: "m-1" }] });
  const fact = store.listProfileFacts(ws).find((item) => item.sourceRef === personQuestionKey(asked.id!))!;
  expect(fact).toMatchObject({ status: "confirmed", projectId: "ece555", sourceQuote: "Python" });
  expect(fact.value).toContain("Python");
  expect(store.questionByKey(ws, personQuestionKey(asked.id!))).toMatchObject({ status: "answered", answer: "Python" });
  // And the next run reads the answer instead of asking.
  expect(await call(createAskTool(context()), ask("你打算用 Python 还是 MATLAB 完成项目？"))).toMatchObject({ status: "answered", answer: "Python" });
});

test("keeping the assumption settles the question without rerunning anything", async () => {
  const asked = await call(createAskTool(context()), ask("你每周能给这门课几个小时？", { blocking: true }));
  expect(settlePersonQuestion(store, ws, asked.id!, "按照常规复习", "assumed", NOW.toISOString())).toEqual({ ok: true, rerun: [] });
  expect(store.questionByKey(ws, personQuestionKey(asked.id!))?.status).toBe("assumed");
});

test("a run that read untrusted content may not pass a link to the person, and its question is marked", async () => {
  const tool = createAskTool(context({ untrusted: () => true }));
  expect(() => tool.call("ask_person", ask("要不要在 https://example.com/form 报名？"))).toThrow(/不能带链接/);
  expect(() => tool.call("ask_person", ask("要报名 luma.com 上那个活动吗？"))).toThrow(/不能带链接/);
  await call(tool, ask("这周六下午有空参加线下活动吗？"));
  expect(personQuestions(store, ws)[0]!.origin).toBe("untrusted");
  // A run that read only the person's own material may.
  expect(readPersonQuestion(ask("看 https://example.com 这份大纲对吗？"), { untrusted: false }).ok).toBe(true);
});

test("only the person's own knowledge, with an assumption, is accepted", () => {
  expect(readPersonQuestion(ask("助教要求的格式是什么？", { knownBy: "teaching_assistant" }))).toMatchObject({ ok: false });
  expect(readPersonQuestion(ask("你偏好哪种？", { assumption: "" }))).toMatchObject({ ok: false });
  expect(readPersonQuestion(ask("你偏好哪种？", { answerType: "choice", options: ["A"] }))).toMatchObject({ ok: false });
});

test("pushed only when blocking and what it bears on is due within 48 hours", async () => {
  await call(createAskTool(context({ dueBy: "2026-11-26" })), ask("你每周能给这门课几个小时？"));
  expect(said()).toHaveLength(0);
  await call(createAskTool(context({ dueBy: "2026-12-20" })), ask("你打算用 Python 还是 MATLAB 完成项目？", { blocking: true }));
  expect(said()).toHaveLength(0);
  await call(createAskTool(context({ dueBy: "2026-11-26" })), ask("期中之后还准备换组吗？", { blocking: true }));
  expect(said()).toHaveLength(1);
  expect(pushPolicyOf("person_question")).toBe("interrupt");
});

test("withAskTool adds ask_person beside a run's own tools without replacing them", async () => {
  const own = { specs: [{ name: "read_chunk", description: "", inputSchema: {} }], call: () => "chunk" };
  const tools = withAskTool(own, context());
  expect(tools.specs.map((spec) => spec.name)).toEqual(["read_chunk", "ask_person"]);
  expect(await tools.call("read_chunk", {})).toBe("chunk");
  expect(JSON.parse(await tools.call("ask_person", ask("你每周能给这门课几个小时？"))).status).toBe("asked");
});
