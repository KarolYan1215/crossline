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

test("no Codex client available is a typed blocker, not a throw", async () => {
  const turn = createAssistantTurn(store, WORKSPACE, projectRoot, () => undefined);
  const outcome = await turn("t1", "你好", [], [], null);
  expect(outcome).toMatchObject({ state: "blocked", code: "CODEX_SUPERVISOR_UNAVAILABLE" });
});
