import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CrosslineStore } from "@crossline/db";
import { createAssistantTurn, ASSISTANT_SKILL } from "./assistant-runner";
import { fakeRuntime as sharedRuntime } from "./testing/fake-runtime";

const fakeRuntime = (answers: string[]) => sharedRuntime(answers, ASSISTANT_SKILL);

const WORKSPACE = "personal-crossline";
let store: CrosslineStore;
let projectRoot: string;

beforeEach(() => {
  store = new CrosslineStore(":memory:");
  projectRoot = mkdtempSync(path.join(tmpdir(), "crossline-assistant-"));
});
afterEach(() => {
  store.close();
  rmSync(projectRoot, { recursive: true, force: true });
});

const plainReply = { reply: "你好，有什么可以帮你？", quickReplies: [], materialDraft: null, blockers: [] };

test("a first turn opens a real Codex thread and records it against the given threadId", async () => {
  const { rpc } = fakeRuntime([JSON.stringify(plainReply)]);
  const turn = createAssistantTurn(store, WORKSPACE, projectRoot, () => rpc);
  const outcome = await turn("t1", "你好", [], [], null);

  expect(outcome).toMatchObject({ state: "replied", reply: "你好，有什么可以帮你？" });
  const thread = store.getAssistantThread(WORKSPACE, "t1");
  expect(thread?.codexThreadId).toBeTruthy();
});

test("a follow-up turn on the same threadId continues the same Codex thread rather than opening a new one", async () => {
  const { rpc, turns } = fakeRuntime([JSON.stringify(plainReply), JSON.stringify({ ...plainReply, reply: "继续回答" })]);
  const turn = createAssistantTurn(store, WORKSPACE, projectRoot, () => rpc);
  await turn("t1", "第一条消息", [], [], null);
  const outcome = await turn("t1", "第二条消息", [{ from: "user", text: "第一条消息" }, { from: "assistant", text: "你好，有什么可以帮你？" }], [], null);

  expect(outcome).toMatchObject({ state: "replied", reply: "继续回答" });
  expect(turns()).toBe(2);
});

test("a materialDraft is saved to disk and reported back, when the turn is scoped to a work order", async () => {
  store.saveMilestone({ id: "m", ownerId: "local-owner", workspaceId: WORKSPACE, identityId: "research",
    projectId: "p", title: "里程碑", version: 1, status: "approved" });
  store.saveWorkOrder({
    id: "w1", ownerId: "local-owner", workspaceId: WORKSPACE, identityId: "research",
    projectId: "p", milestoneId: "m", intent: "写个脚本", state: "active", riskTier: "routine",
    estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior", observationCount: 0, confidence: "low" },
    payload: {}
  });
  const withDraft = { reply: "写好了，已存成脚本。", quickReplies: [],
    materialDraft: { relativePath: "word-count.py", content: "print('hi')", mediaType: "text/plain", sourceRefs: [] },
    blockers: [] };
  const { rpc } = fakeRuntime([JSON.stringify(withDraft)]);
  const turn = createAssistantTurn(store, WORKSPACE, projectRoot, () => rpc);
  const outcome = await turn("t1", "帮我写个统计单词的脚本", [], [], "w1");

  expect(outcome).toMatchObject({ state: "replied" });
  expect((outcome as { savedMaterial?: { fileName: string } }).savedMaterial?.fileName).toBe("word-count.py");
  const written = path.join(projectRoot, ".crossline-materials", "w1", "word-count.py");
  expect(readFileSync(written, "utf8")).toBe("print('hi')");
  expect(store.listMaterials(WORKSPACE, "w1")).toHaveLength(1);
  // Unlike material prep, a chat-saved snippet must not move the work order's own state.
  expect(store.listWorkOrders(WORKSPACE)[0]?.state).toBe("active");
});

test("a materialDraft offered with no work order in scope is not saved — only the reply comes back", async () => {
  const withDraft = { reply: "这是一个例子，我没法保存它。", quickReplies: [],
    materialDraft: { relativePath: "x.py", content: "print(1)", mediaType: "text/plain", sourceRefs: [] },
    blockers: [] };
  const { rpc } = fakeRuntime([JSON.stringify(withDraft)]);
  const turn = createAssistantTurn(store, WORKSPACE, projectRoot, () => rpc);
  // The schema itself refuses this case (`ASSISTANT_MATERIAL_REQUIRES_WORK_ORDER`), so the whole turn
  // is blocked rather than silently dropping the draft — the Skill's contract is what enforces this.
  const outcome = await turn("t1", "帮我写个例子", [], [], null);
  expect(outcome).toMatchObject({ state: "blocked" });
});

test("an empty message is refused before any Codex call runs", async () => {
  const { rpc, turns } = fakeRuntime([JSON.stringify(plainReply)]);
  const turn = createAssistantTurn(store, WORKSPACE, projectRoot, () => rpc);
  const outcome = await turn("t1", "   ", [], [], null);
  expect(outcome).toMatchObject({ state: "blocked", code: "ASSISTANT_MESSAGE_REQUIRED" });
  expect(turns()).toBe(0);
});

// The person chose 「只读快照 + 提议卡」: a template the assistant drafts is a card they confirm, never a row it writes.
test("a templateProposal comes back as a card to confirm, and nothing is saved by the assistant", async () => {
  const withTemplate = { reply: "这是一个模板草稿，确认后添加。", quickReplies: [], materialDraft: null,
    templateProposal: { identityId: "research", kind: "deliverable", titleHint: "新模板",
      successCriteriaDefaults: [{ id: "c1", statement: "产出物存在", required: true, evidenceOf: "output",
        measure: { kind: "artifact", mustExist: "x" } }] },
    proposals: [], blockers: [] };
  const { rpc } = fakeRuntime([JSON.stringify(withTemplate)]);
  const turn = createAssistantTurn(store, WORKSPACE, projectRoot, () => rpc);
  const outcome = await turn("t1", "帮我加一个新的里程碑模板", [], [], null);

  expect(outcome).toMatchObject({ state: "replied", templateProposal: { titleHint: "新模板" } });
  expect(store.listMilestoneTemplates(WORKSPACE, "research")).toHaveLength(0);
});

// Asked 「我这周最该做什么？」 the widget used to answer generically: it was never told anything about the person.
test("every turn — first and follow-up — carries the person's snapshot, and capture cards come back", async () => {
  const withCard = { ...plainReply, reply: "先做 10/12 到期的参数映射。", proposals: [{ kind: "capture", title: "10/8 拿到数据后跑仿真", context: "" }] };
  const { rpc, prompts } = fakeRuntime([JSON.stringify(withCard), JSON.stringify({ ...plainReply, proposals: [] })]);
  const turn = createAssistantTurn(store, WORKSPACE, projectRoot, () => rpc);
  const first = await turn("t1", "我这周最该做什么？", [], [], null, undefined, "已批准：实测 MoS₂ 参数已可直接驱动 NeuroSim · 最晚 2026-10-12");
  expect(first).toMatchObject({ state: "replied", proposals: [{ kind: "capture", title: "10/8 拿到数据后跑仿真" }] });
  await turn("t1", "那周末呢？", [{ from: "user", text: "我这周最该做什么？" }], [], null, undefined, "已批准：西湖合作论文已在截止日前投出 · 最晚 2026-10-31");
  const sent = prompts().join(" ");
  expect(sent).toContain("最晚 2026-10-12");
  expect(sent).toContain("最晚 2026-10-31");
});

test("a templateProposal naming an identity the workspace does not have is blocked, not silently dropped", async () => {
  const withTemplate = { reply: "x", quickReplies: [], materialDraft: null,
    templateProposal: { identityId: "woodwork", kind: "deliverable", titleHint: "新模板",
      successCriteriaDefaults: [{ id: "c1", statement: "x", required: true, evidenceOf: "output",
        measure: { kind: "artifact", mustExist: "x" } }] },
    blockers: [] };
  const { rpc } = fakeRuntime([JSON.stringify(withTemplate)]);
  const turn = createAssistantTurn(store, WORKSPACE, projectRoot, () => rpc);
  const outcome = await turn("t1", "帮我加一个模板", [], [], null);
  expect(outcome).toMatchObject({ state: "blocked" });
  expect(store.listMilestoneTemplates(WORKSPACE)).toEqual([]);
});

test("no Codex client available is a typed blocker, not a throw", async () => {
  const turn = createAssistantTurn(store, WORKSPACE, projectRoot, () => undefined);
  const outcome = await turn("t1", "你好", [], [], null);
  expect(outcome).toMatchObject({ state: "blocked", code: "CODEX_SUPERVISOR_UNAVAILABLE" });
});

// The runtime forgets threads when it restarts. A stored thread id then answers 「thread not found」; the
// widget used to stay broken on it. Now the conversation is reopened from its history.
test("a lost thread is reopened from the conversation history instead of failing the turn", async () => {
  const lost: string[] = [];
  const runtime = sharedRuntime([JSON.stringify(plainReply), JSON.stringify({ ...plainReply, reply: "重新接上了" })], ASSISTANT_SKILL, { lostThreads: lost });
  const turn = createAssistantTurn(store, WORKSPACE, projectRoot, () => runtime.rpc);
  await turn("t1", "第一条", [], [], null);
  const first = store.getAssistantThread(WORKSPACE, "t1")!.codexThreadId!;
  lost.push(first);
  const outcome = await turn("t1", "第二条", [{ from: "user", text: "第一条" }], [], null, undefined, "快照");
  expect(outcome).toMatchObject({ state: "replied", reply: "重新接上了" });
  expect(store.getAssistantThread(WORKSPACE, "t1")?.codexThreadId).not.toBe(first);
});
