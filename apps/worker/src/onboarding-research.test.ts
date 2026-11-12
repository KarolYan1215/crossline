import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import type { ResearchThread } from "@crossline/core";
import { createResearchRunner, newResearchQuestions, profileBrief, readResearch, RESEARCH_OPEN_MAX, RESEARCH_RUNS_PER_STEP, RESEARCH_SKILL, researchForDialogue } from "./onboarding-research";
import { fakeRuntime } from "./testing/fake-runtime";

let store: CrosslineStore;
let workspaceId: string;
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  workspaceId = store.createPrincipalWithWorkspace("user-1", "个人 workspace").workspace.id;
});
afterEach(() => store.close());

const turn = (over: object = {}) => JSON.stringify({ message: "查了 10 份咨询分析师实习 JD。", ask: "", conclusion: "", sources: [], ...over });
const source = { title: "某咨询公司 2026 暑期实习", url: "https://example.com/jd/1" };
const asked = { question: "管理咨询实习 JD 最常要求什么？", why: "职业候选：咨询", dimension: "D0" as const };
const thread = (over: Partial<ResearchThread>): ResearchThread => ({ id: "r1", question: "q", why: "", dimension: "D2", status: "running", messages: [],
  createdAt: "2026-11-12T00:00:00.000Z", updatedAt: "2026-11-12T00:00:00.000Z", ...over });
const threadsNow = () => readResearch(store, workspaceId, "s");

test("a new question opens a thread only when its words are new and fewer than the open maximum run", () => {
  const open = Array.from({ length: RESEARCH_OPEN_MAX - 1 }, (_, index) => thread({ id: `r${index}`, question: `问题 ${index}` }));
  const fresh = newResearchQuestions(open, [{ ...asked, question: "问题 0？" }, asked, { ...asked, question: "另一个问题" }]);
  expect(fresh.map((item) => item.question)).toEqual([asked.question]);
});

test("a thread that asks waits for the person; their answer goes to that thread alone and a sourced conclusion closes it", async () => {
  const { rpc, prompts } = fakeRuntime([turn({ ask: "你说的咨询是战略咨询还是 IT 咨询？" }),
    turn({ message: "按战略咨询收窄。", conclusion: "Excel/PPT 9/10，案例面试 8/10。", sources: [source] })], RESEARCH_SKILL);
  const runner = createResearchRunner(store, workspaceId, "C:\\repo", () => rpc);
  expect(runner.start("s", [asked])).toHaveLength(1);
  await vi.waitFor(() => expect(threadsNow()[0]?.status).toBe("asking"));
  expect(threadsNow()[0]?.ask).toBe("你说的咨询是战略咨询还是 IT 咨询？");
  expect(runner.answer("s", threadsNow()[0]!.id, "战略咨询")).toEqual({ ok: true });
  await vi.waitFor(() => expect(threadsNow()[0]?.status).toBe("done"));
  const done = threadsNow()[0]!;
  expect(done.conclusion).toBe("Excel/PPT 9/10，案例面试 8/10。");
  expect(done.sources).toEqual([source]);
  expect(done.messages.map((message) => message.role)).toEqual(["agent", "person", "agent"]);
  // Every run sees the whole thread: the second was shown the person's answer.
  expect(prompts().at(-1)).toContain("战略咨询");
  expect(researchForDialogue(threadsNow())).toEqual([{ id: done.id, question: asked.question, status: "done", conclusion: done.conclusion }]);
});

test("a thread with neither a conclusion nor a question runs again, and after its runs closes with what it found", async () => {
  const { rpc } = fakeRuntime(Array.from({ length: RESEARCH_RUNS_PER_STEP }, () => turn({ message: "公开 JD 太少，查不到比例。" })), RESEARCH_SKILL);
  createResearchRunner(store, workspaceId, "C:\\repo", () => rpc).start("s", [asked]);
  await vi.waitFor(() => expect(threadsNow()[0]?.status).toBe("done"));
  expect(threadsNow()[0]!.messages).toHaveLength(RESEARCH_RUNS_PER_STEP);
  expect(researchForDialogue(threadsNow())[0]).toMatchObject({ status: "done", found: "公开 JD 太少，查不到比例。" });
  expect(researchForDialogue(threadsNow())[0]).not.toHaveProperty("conclusion");
});

test("the portrait brief puts the question's dimension first and names the career options", () => {
  const brief = profileBrief({
    dimensions: [{ id: "D2", summary: "成就动机强", evidenced: true }],
    hypotheses: [{ id: "h1", dimension: "D4", statement: "看重自由", basis: [], falsifier: "x", alternative: "", status: "open" },
      { id: "h2", dimension: "D2", statement: "被人等着才开工", basis: [], falsifier: "y", alternative: "", status: "supported" }],
    careers: [{ role: "管理咨询分析师", why: "", hypothesisIds: [], requirements: [], sources: [], trial: { weeks: 2, task: "做一个案例", supportsIf: "", refutesIf: "" }, lineId: "" }]
  } as never, "D2");
  expect(brief[0]).toContain("成就动机强");
  expect(brief.findIndex((line) => line.includes("h2"))).toBeLessThan(brief.findIndex((line) => line.includes("h1")));
  expect(brief.at(-1)).toBe("职业候选：管理咨询分析师");
});
