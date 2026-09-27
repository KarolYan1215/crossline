import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { createOnboardingProposer, createOnboardingConversation, ONBOARDING_SKILL } from "./onboarding-runner";
import { fakeRuntime as sharedRuntime } from "./testing/fake-runtime";

const fakeRuntime = (answers: string[]) => sharedRuntime(answers, ONBOARDING_SKILL);
const WORKSPACE = "workspace-a";
let store: CrosslineStore;

beforeEach(() => { store = new CrosslineStore(":memory:"); });
afterEach(() => store.close());

const proposal = JSON.stringify({
  reply: "已经记下了，接下来聊聊创业这条线？",
  focusIdentityId: "startup",
  allIdentitiesCovered: false,
  milestoneProposals: [{
    identityId: "research", projectId: "research-default", title: "论文初稿完成并可供导师评审",
    successCriteria: [{ id: "c1", statement: "初稿存在且导师已过目", required: true, evidenceOf: "outcome",
      measure: { kind: "artifact", mustExist: "draft.pdf" } }],
    rationale: "用户明确表示这是当前最想推进的事", confidence: "high", sourceRefs: ["answer-0"]
  }],
  relationProposals: [],
  blockers: []
});

test("interview answers become a draft milestone through the same propose-then-approve path", async () => {
  const { rpc } = fakeRuntime([proposal]);
  const propose = createOnboardingProposer(store, WORKSPACE, "C:\\repo", () => rpc);
  const outcome = await propose([{ question: "你目前最想推进的一件事是什么？", answer: "把实验结果写成论文初稿" }]);
  expect(outcome).toMatchObject({ state: "proposed" });
  const saved = store.listMilestones(WORKSPACE);
  expect(saved).toHaveLength(1);
  expect(saved[0]?.status).toBe("draft");
});

test("empty answers are a blocker before any Skill call happens", async () => {
  const propose = createOnboardingProposer(store, WORKSPACE, "C:\\repo", () => fakeRuntime(["{}"]).rpc);
  const outcome = await propose([{ question: "问题", answer: "" }]);
  expect(outcome).toMatchObject({ state: "blocked", code: "ONBOARDING_NO_INPUT" });
});

test("a pure question turn (no milestones yet) is a normal 'asking' turn, not an error", async () => {
  const questionOnly = JSON.stringify({
    reply: "这条线你具体想做什么方向？", focusIdentityId: "research", allIdentitiesCovered: false,
    milestoneProposals: [], relationProposals: [], blockers: []
  });
  const { rpc } = fakeRuntime([questionOnly]);
  const propose = createOnboardingProposer(store, WORKSPACE, "C:\\repo", () => rpc);
  const outcome = await propose([{ question: "你目前最想推进的一件事是什么？", answer: "还没想好" }]);
  expect(outcome).toMatchObject({ state: "asking", reply: "这条线你具体想做什么方向？", focusIdentityId: "research" });
  expect(store.listMilestones(WORKSPACE)).toHaveLength(0);
});

test("local Codex CLI history excerpts ground a proposal the same way an answer does", async () => {
  const grounded = JSON.stringify({
    reply: "看起来这条线是真实在推进的，记下了。", focusIdentityId: "startup", allIdentitiesCovered: false,
    milestoneProposals: [{
      identityId: "startup", projectId: "startup-default", title: "验证首个付费客户的真实痛点",
      successCriteria: [{ id: "c1", statement: "至少一位客户确认愿意付费", required: true, evidenceOf: "outcome",
        measure: { kind: "artifact", mustExist: "customer-confirmation.md" } }],
      rationale: "历史记录里反复讨论了同一个客户痛点", confidence: "medium", sourceRefs: ["source-0"]
    }],
    relationProposals: [], blockers: []
  });
  const { rpc } = fakeRuntime([grounded]);
  const propose = createOnboardingProposer(store, WORKSPACE, "C:\\repo", () => rpc);
  const outcome = await propose([], [{ label: "2026-01-10 · 讨论客户痛点", excerpt: "反复聊到同一个客户的付费意愿" }]);
  expect(outcome).toMatchObject({ state: "proposed" });
  expect(store.listMilestones(WORKSPACE)).toHaveLength(1);
});

test("the thread from the first call carries into a real conversational follow-up, and a relation lands as a candidate", async () => {
  const first = JSON.stringify({
    reply: "创业这条线呢？", focusIdentityId: "startup", allIdentitiesCovered: false,
    milestoneProposals: [{
      identityId: "research", projectId: "research-default", title: "论文初稿完成并可供导师评审",
      successCriteria: [{ id: "c1", statement: "初稿存在且导师已过目", required: true, evidenceOf: "outcome",
        measure: { kind: "artifact", mustExist: "draft.pdf" } }],
      rationale: "用户明确表示这是当前最想推进的事", confidence: "high", sourceRefs: ["answer-0"]
    }],
    relationProposals: [], blockers: []
  });
  const second = JSON.stringify({
    reply: "两条线之间有联系，记下了一条关系。", focusIdentityId: null, allIdentitiesCovered: true,
    milestoneProposals: [{
      identityId: "startup", projectId: "startup-default", title: "验证首个付费客户的真实痛点",
      successCriteria: [{ id: "c1", statement: "至少一位客户确认愿意付费", required: true, evidenceOf: "outcome",
        measure: { kind: "artifact", mustExist: "customer-confirmation.md" } }],
      rationale: "用户说这条线也很重要", confidence: "high", sourceRefs: []
    }],
    relationProposals: [{
      fromTitle: "论文初稿完成并可供导师评审", toTitle: "验证首个付费客户的真实痛点", kind: "informs",
      explanation: "论文里的分析方法可以用来验证客户数据", refutedWhen: "如果客户验证完全不需要分析方法", sourceRefs: []
    }],
    blockers: []
  });
  const { rpc } = fakeRuntime([first, second]);
  const propose = createOnboardingProposer(store, WORKSPACE, "C:\\repo", () => rpc);
  const outcome1 = await propose([{ question: "你目前最想推进的一件事是什么？", answer: "把实验结果写成论文初稿" }]);
  expect(outcome1.state).toBe("proposed");
  const threadId = outcome1.state !== "blocked" ? outcome1.threadId : undefined;
  expect(threadId).toBeTruthy();

  const conversation = createOnboardingConversation(store, WORKSPACE, "C:\\repo", () => rpc);
  const outcome2 = await conversation(threadId!, "创业这条线也很重要", "startup");
  expect(outcome2).toMatchObject({ state: "proposed", allIdentitiesCovered: true });
  expect(store.listMilestones(WORKSPACE)).toHaveLength(2);
  expect(store.listMilestoneRelations(WORKSPACE)).toHaveLength(1);
  expect(store.listMilestoneRelations(WORKSPACE)[0]?.status).toBe("candidate");
});
