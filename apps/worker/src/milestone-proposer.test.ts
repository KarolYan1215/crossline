import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { createMilestoneConversation, createMilestoneProposer, MILESTONE_ARCHITECT_SKILL } from "./milestone-proposer";
import { fakeRuntime as sharedRuntime } from "./testing/fake-runtime";

const fakeRuntime = (answers: string[]) => sharedRuntime(answers, MILESTONE_ARCHITECT_SKILL);
const WORKSPACE = "workspace-a";
let store: CrosslineStore;

beforeEach(() => { store = new CrosslineStore(":memory:"); });
afterEach(() => store.close());

const proposal = (title: string) => JSON.stringify({
  milestones: [{ identityId: "research", projectId: "p", title,
    successCriteria: [{ id: "c", statement: "写完初稿", required: true, measure: { kind: "artifact", mustExist: "draft.md" } }],
    rationale: "推进论文进度" }],
  assumptions: [], blockers: []
});

test("a proposal is saved as a draft milestone, never approved", async () => {
  const { rpc } = fakeRuntime([proposal("完成实验第一阶段")]);
  const propose = createMilestoneProposer(store, WORKSPACE, "C:\\repo", () => rpc);
  const outcome = await propose("推进科研");
  expect(outcome).toMatchObject({ state: "proposed" });
  const saved = store.listMilestones(WORKSPACE);
  expect(saved).toHaveLength(1);
  expect(saved[0]?.status).toBe("draft");
});

test("the thread from the first call carries into a real conversational follow-up", async () => {
  const { rpc } = fakeRuntime([proposal("完成实验第一阶段"), proposal("完成实验第二阶段")]);
  const propose = createMilestoneProposer(store, WORKSPACE, "C:\\repo", () => rpc);
  const first = await propose("推进科研");
  expect(first.state).toBe("proposed");
  const threadId = first.state === "proposed" ? first.threadId : undefined;
  expect(threadId).toBeTruthy();

  // The reply reuses the same live thread rather than starting a fresh one — proven by the fake's own
  // turn counter: a second `thread/start` would show up as a distinct thread id in the fake's bookkeeping,
  // which `continueSkillTurn` never calls at all.
  const conversation = createMilestoneConversation(store, WORKSPACE, "C:\\repo", () => rpc);
  const second = await conversation(threadId!, "再提一个阶段二的里程碑");
  expect(second).toMatchObject({ state: "proposed" });
  expect(store.listMilestones(WORKSPACE)).toHaveLength(2);
});

test("a follow-up cannot duplicate the title the first turn already proposed", async () => {
  const { rpc } = fakeRuntime([proposal("完成实验第一阶段"), proposal("完成实验第一阶段")]);
  const propose = createMilestoneProposer(store, WORKSPACE, "C:\\repo", () => rpc);
  const first = await propose("推进科研");
  const threadId = first.state === "proposed" ? first.threadId : undefined;
  const conversation = createMilestoneConversation(store, WORKSPACE, "C:\\repo", () => rpc);
  const second = await conversation(threadId!, "再说一遍");
  expect(second).toMatchObject({ state: "blocked", code: "PROPOSAL_DUPLICATE_TITLE" });
});
