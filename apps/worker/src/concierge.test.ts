import { expect, test } from "vitest";
import type { ConciergePack } from "@crossline/core";
import { CrosslineStore } from "@crossline/db";
import { CONCIERGE_SKILL, createConcierge } from "./concierge";
import { fakeRuntime } from "./testing/fake-runtime";

const pack = (over: Partial<ConciergePack> = {}): ConciergePack => ({
  now: "2026-10-09T20:00:00Z", today: "2026-10-09", timeZone: "America/Chicago", page: { kind: "today", entityId: "", title: "" },
  lines: [{ id: "research", label: "研究者", goals: [], hard: true, description: "" }],
  tasks: [{ id: "wo-hw2", title: "完成 ECE 555 作业 2", line: "research", project: "ECE 555", state: "approved", dueDate: "2026-10-12", notBefore: "",
    usualMinutes: 120, nextBlock: "", steps: [{ id: "v1s1", title: "拆解题目", status: "planned", minutes: 20, executor: "human" }] }],
  proposals: [], milestones: [], asks: [], plan: [], capacity: [], ops: [{ id: "op-1", label: "不等了：测量数据", at: "2026-10-09T19:59:00Z" }],
  agentResults: [], materials: [], projects: [], facts: [], preferences: [], energy: null, forecast: [], ...over
});
const answer = (actions: unknown[], reply = "") => JSON.stringify({ reply, confidence: "high", actions, clarify: { question: "", options: [] } });
const due = { action: "task.op", summary: "作业 2 截止改为 10/16", args: { workOrderId: "wo-hw2", type: "due", date: "2026-10-16", minutes: 0, stepId: "", text: "", who: "", energy: "" } };

const setup = () => {
  const store = new CrosslineStore(":memory:");
  const conversation = store.conversationFor("w", "2026-10-09");
  return { store, conversation };
};

test("the model looks a task up through a tool and proposes the change by the id it found; the tools are declared at thread start", async () => {
  const { store, conversation } = setup();
  const lookups: string[] = [];
  const fake = fakeRuntime([answer([due])], CONCIERGE_SKILL, { script: async ({ ask }) => {
    const result = await ask("item/tool/call", { callId: "c1", tool: "find_tasks", arguments: { query: "作业 2" } });
    lookups.push(String(((result.contentItems as Array<{ text: string }>)[0])?.text));
  } });
  const turn = createConcierge(store, "w", "C:\repo", () => fake.rpc);
  const outcome = await turn({ conversationId: conversation.id, text: "作业2截止改到下周五", mentions: [], snapshot: "", pack: pack(), history: [] });
  expect(outcome).toMatchObject({ state: "replied", turn: { actions: [{ action: "task.op", args: { workOrderId: "wo-hw2" } }] } });
  expect(lookups[0]).toContain("wo-hw2");
  expect((fake.threadStarts()[0]!.dynamicTools as Array<{ name: string }>).map((tool) => tool.name)).toContain("read_material");
  expect(store.getConversation("w", conversation.id)?.codexThreadId).toBe("thread-1");
});

test("「撤销刚刚的不等了」 comes back as an undo of the recent operation, and an id the model made up is sent back for repair", async () => {
  const { store, conversation } = setup();
  const undo = (opId: string) => ({ action: "undo", summary: "撤销「不等了」", args: { opId } });
  const fake = fakeRuntime([answer([undo("op-made-up")]), answer([undo("op-1")])], CONCIERGE_SKILL);
  const outcome = await createConcierge(store, "w", "C:\repo", () => fake.rpc)({ conversationId: conversation.id, text: "撤销刚刚的不等了", mentions: [],
    snapshot: "", pack: pack(), history: [] });
  expect(outcome).toMatchObject({ state: "replied", turn: { actions: [{ action: "undo", args: { opId: "op-1" } }] } });
  expect(fake.prompts()[1]).toContain("op-made-up");
});

test("a follow-up continues the day's thread; a thread the runtime forgot is reopened with today's messages", async () => {
  const { store, conversation } = setup();
  store.setConversationThread("w", conversation.id, "thread-gone");
  const fake = fakeRuntime([answer([], "好的")], CONCIERGE_SKILL, { lostThreads: ["thread-gone"] });
  const outcome = await createConcierge(store, "w", "C:\repo", () => fake.rpc)({ conversationId: conversation.id, text: "这周还有多少时间？", mentions: [],
    snapshot: "", pack: pack(), history: [{ role: "person", text: "早上好" }] });
  expect(outcome).toMatchObject({ state: "replied", turn: { reply: "好的" } });
  expect(fake.prompts().at(-1)).toContain("早上好");
  expect(store.getConversation("w", conversation.id)?.codexThreadId).toBe("thread-1");
});

test("the Skill describes exactly the registry: every action it names exists, and every action is described (the router once named two the schema lacked)", async () => {
  const { readFileSync } = await import("node:fs");
  const { ACTION_IDS } = await import("@crossline/core");
  const skill = readFileSync(new URL("../../../skills/marketplace/plugins/crossline/skills/crossline-concierge/SKILL.md", import.meta.url), "utf8");
  const registry = skill.slice(skill.indexOf("## The registry"), skill.indexOf("## Language"));
  const described = [...registry.matchAll(/^- `([a-z_.]+)` —/gm)].map((match) => match[1]!);
  expect(described.sort()).toEqual([...ACTION_IDS].sort());
});

test("a second look runs on the same thread and the stronger model; a correction keeps every later turn on it", async () => {
  const { store, conversation } = setup();
  const fake = fakeRuntime([answer([due]), answer([], "复核后无改动")], CONCIERGE_SKILL);
  const run = createConcierge(store, "w", "C:\repo", () => fake.rpc);
  await run({ conversationId: conversation.id, text: "作业2截止改到下周五", mentions: [], snapshot: "", pack: pack(), history: [] });
  const reviewed = await run({ conversationId: conversation.id, text: "", mentions: [], snapshot: "", pack: pack(), history: [], review: true });
  expect(reviewed).toMatchObject({ state: "replied", turn: { reply: "复核后无改动" } });
  expect(fake.prompts()[1]).toContain("review");
  expect(fake.threadStarts()).toHaveLength(1);
  const fresh = setup();
  const none = await createConcierge(fresh.store, "w", "C:\repo", () => fake.rpc)({ conversationId: fresh.conversation.id, text: "", mentions: [], snapshot: "",
    pack: pack(), history: [], review: true });
  expect(none).toMatchObject({ state: "blocked", code: "CONCIERGE_REVIEW_NO_THREAD" });
});
