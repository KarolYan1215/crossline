import { expect, test } from "vitest";
import { validateOnboardingProposal, type OnboardingContext } from "./onboarding-schema";

const context: OnboardingContext = {
  version: "crossline.onboarding.v1",
  answers: [{ id: "answer-0", question: "你目前最想推进的一件事是什么？", answer: "把实验结果写成论文初稿" }],
  sources: [{ id: "source-0", label: "2026-01-15 · 讨论论文结构", excerpt: "想把三个实验的结果整理成一篇论文" }],
  identities: [{ id: "research", label: "科研" }],
  existingMilestones: [{ id: "existing-1", identityId: "research", title: "已批准的旧里程碑", status: "approved" }],
  focusIdentityId: "research"
};

const output = (overrides: Partial<{
  reply: string; focusIdentityId: string | null; allIdentitiesCovered: boolean;
  milestoneProposals: Array<{ identityId: string; projectId: string; title: string;
    successCriteria: Array<{ id: string; statement: string; required: boolean; evidenceOf: string; measure: unknown }>;
    rationale: string; confidence: string; sourceRefs: string[] }>;
  relationProposals: Array<{ fromTitle: string; toTitle: string; kind: string; explanation: string; refutedWhen: string; sourceRefs: string[] }>;
  blockers: Array<{ code: string; message: string }>;
}> = {}) => ({
  reply: "论文初稿的截止日期大概是什么时候？",
  focusIdentityId: "research",
  allIdentitiesCovered: false,
  milestoneProposals: [{
    identityId: "research", projectId: "research-default", title: "论文初稿完成并可供导师评审",
    successCriteria: [{ id: "c1", statement: "初稿存在且导师已过目", required: true, evidenceOf: "outcome",
      measure: { kind: "artifact", mustExist: "draft.pdf" } }],
    rationale: "用户明确表示这是当前最想推进的事", confidence: "high", sourceRefs: ["answer-0"]
  }],
  relationProposals: [],
  blockers: [],
  ...overrides
});

test("a well-formed onboarding proposal passes through", () => {
  const result = validateOnboardingProposal(output(), context);
  expect(result.milestoneProposals).toHaveLength(1);
  expect(result.reply).toBe("论文初稿的截止日期大概是什么时候？");
});

test("a pure question turn (no proposals yet) is a normal, valid turn", () => {
  const result = validateOnboardingProposal(output({ milestoneProposals: [] }), context);
  expect(result.milestoneProposals).toHaveLength(0);
  expect(result.reply.length).toBeGreaterThan(0);
});

test("citing an identity the user does not have is refused", () => {
  expect(() => validateOnboardingProposal(output({
    milestoneProposals: [{ ...output().milestoneProposals[0]!, identityId: "startup" }]
  }), context)).toThrow("ONBOARDING_IDENTITY_UNKNOWN");
});

test("an unknown focusIdentityId is refused the same way", () => {
  expect(() => validateOnboardingProposal(output({ focusIdentityId: "startup" }), context)).toThrow("ONBOARDING_IDENTITY_UNKNOWN");
});

test("citing an answer id never supplied is refused", () => {
  expect(() => validateOnboardingProposal(output({
    milestoneProposals: [{ ...output().milestoneProposals[0]!, sourceRefs: ["answer-999"] }]
  }), context)).toThrow("ONBOARDING_UNKNOWN_SOURCE_REF");
});

test("a follow-up turn may cite the opening turn's answer ids, but not made-up ones", () => {
  const proposal = (sourceRefs: string[]) => output({ milestoneProposals: [{ ...output().milestoneProposals[0]!, sourceRefs }] });
  const empty = { ...context, answers: [], sources: [] };
  expect(() => validateOnboardingProposal(proposal(["answer-0", "source-1"]), empty)).toThrow("ONBOARDING_UNKNOWN_SOURCE_REF");
  expect(validateOnboardingProposal(proposal(["answer-0", "source-1"]), empty, { inheritedSourceRefs: true }).milestoneProposals).toHaveLength(1);
  expect(() => validateOnboardingProposal(proposal(["made-up"]), empty, { inheritedSourceRefs: true })).toThrow("ONBOARDING_UNKNOWN_SOURCE_REF");
});

test("a reported blocker surfaces its message", () => {
  expect(() => validateOnboardingProposal(output({ blockers: [{ code: "ONBOARDING_NO_INPUT", message: "没有可用的访谈回答" }] }), context))
    .toThrow("ONBOARDING_BLOCKED");
});

test("a relation between an existing milestone and a same-turn proposal resolves by title", () => {
  const result = validateOnboardingProposal(output({
    relationProposals: [{
      fromTitle: "论文初稿完成并可供导师评审", toTitle: "已批准的旧里程碑", kind: "informs",
      explanation: "论文初稿会用到旧里程碑积累的数据", refutedWhen: "如果论文改用了全新的数据集", sourceRefs: ["source-0"]
    }]
  }), context);
  expect(result.relationProposals).toHaveLength(1);
});

test("a relation naming a title nobody proposed or already has is refused", () => {
  expect(() => validateOnboardingProposal(output({
    relationProposals: [{
      fromTitle: "论文初稿完成并可供导师评审", toTitle: "凭空编造的里程碑", kind: "informs",
      explanation: "x", refutedWhen: "y", sourceRefs: []
    }]
  }), context)).toThrow("ONBOARDING_RELATION_MILESTONE_UNKNOWN");
});

test("a relation pointing a milestone at itself is refused", () => {
  expect(() => validateOnboardingProposal(output({
    relationProposals: [{
      fromTitle: "论文初稿完成并可供导师评审", toTitle: "论文初稿完成并可供导师评审", kind: "informs",
      explanation: "x", refutedWhen: "y", sourceRefs: []
    }]
  }), context)).toThrow("ONBOARDING_RELATION_SELF_LOOP");
});

test("a relation with no falsifier is refused, the same standard the nightly flywheel holds itself to", () => {
  expect(() => validateOnboardingProposal(output({
    relationProposals: [{
      fromTitle: "论文初稿完成并可供导师评审", toTitle: "已批准的旧里程碑", kind: "informs",
      explanation: "x", refutedWhen: "", sourceRefs: []
    }]
  }), context)).toThrow("ONBOARDING_RELATION_FALSIFIER_REQUIRED");
});

test("a relation citing a source excerpt id is grounded the same way an answer id is", () => {
  const result = validateOnboardingProposal(output({
    relationProposals: [{
      fromTitle: "论文初稿完成并可供导师评审", toTitle: "已批准的旧里程碑", kind: "reuses",
      explanation: "历史记录里提到过复用同一批数据", refutedWhen: "如果换了数据集", sourceRefs: ["source-0"]
    }]
  }), context);
  expect(result.relationProposals[0]!.sourceRefs).toEqual(["source-0"]);
});
