import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { createOnboardingProposer, ONBOARDING_SKILL } from "./onboarding-runner";
import { fakeRuntime as sharedRuntime } from "./testing/fake-runtime";

const fakeRuntime = (answers: string[]) => sharedRuntime(answers, ONBOARDING_SKILL);
const WORKSPACE = "workspace-a";
let store: CrosslineStore;

beforeEach(() => { store = new CrosslineStore(":memory:"); });
afterEach(() => store.close());

const proposal = JSON.stringify({
  milestoneProposals: [{
    identityId: "research", projectId: "research-default", title: "论文初稿完成并可供导师评审",
    successCriteria: [{ id: "c1", statement: "初稿存在且导师已过目", required: true, evidenceOf: "outcome",
      measure: { kind: "artifact", mustExist: "draft.pdf" } }],
    rationale: "用户明确表示这是当前最想推进的事", confidence: "high", sourceRefs: ["answer-0"]
  }],
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
