import { expect, test } from "vitest";
import { validateOnboardingProposal, type OnboardingContext } from "./onboarding-schema";

const context: OnboardingContext = {
  version: "crossline.onboarding.v1",
  answers: [{ id: "answer-0", question: "你目前最想推进的一件事是什么？", answer: "把实验结果写成论文初稿" }],
  identities: [{ id: "research", label: "科研" }],
  existingMilestones: []
};

const output = (overrides: Partial<{
  milestoneProposals: Array<{ identityId: string; projectId: string; title: string;
    successCriteria: Array<{ id: string; statement: string; required: boolean; evidenceOf: string; measure: unknown }>;
    rationale: string; confidence: string; sourceRefs: string[] }>;
  blockers: Array<{ code: string; message: string }>;
}> = {}) => ({
  milestoneProposals: [{
    identityId: "research", projectId: "research-default", title: "论文初稿完成并可供导师评审",
    successCriteria: [{ id: "c1", statement: "初稿存在且导师已过目", required: true, evidenceOf: "outcome",
      measure: { kind: "artifact", mustExist: "draft.pdf" } }],
    rationale: "用户明确表示这是当前最想推进的事", confidence: "high", sourceRefs: ["answer-0"]
  }],
  blockers: [],
  ...overrides
});

test("a well-formed onboarding proposal passes through", () => {
  const result = validateOnboardingProposal(output(), context);
  expect(result.milestoneProposals).toHaveLength(1);
});

test("citing an identity the user does not have is refused", () => {
  expect(() => validateOnboardingProposal(output({
    milestoneProposals: [{ ...output().milestoneProposals[0]!, identityId: "startup" }]
  }), context)).toThrow("ONBOARDING_IDENTITY_UNKNOWN");
});

test("citing an answer id never supplied is refused", () => {
  expect(() => validateOnboardingProposal(output({
    milestoneProposals: [{ ...output().milestoneProposals[0]!, sourceRefs: ["answer-999"] }]
  }), context)).toThrow("ONBOARDING_UNKNOWN_SOURCE_REF");
});

test("a reported blocker surfaces its message", () => {
  expect(() => validateOnboardingProposal(output({ blockers: [{ code: "ONBOARDING_NO_INPUT", message: "没有可用的访谈回答" }] }), context))
    .toThrow("ONBOARDING_BLOCKED");
});
