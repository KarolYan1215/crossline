import { expect, test } from "vitest";
import { criteriaCoverOutcome, validateMilestoneProposal, type MilestoneProposalContext, type SuccessCriterion } from "./index";

const context: MilestoneProposalContext = {
  version: "crossline.milestone-proposal.v1",
  identities: [{ id: "research", label: "科研", summary: "" }, { id: "media", label: "自媒体", summary: "" }],
  existingMilestones: [{ id: "m1", identityId: "research", title: "稳定推进当前实验与论文", status: "approved" }],
  recentWork: [],
  templates: [{ id: "research-literature-review-done", identityId: "research", kind: "deliverable", titleHint: "文献综述完成" }],
  request: ""
};

const criterion = (over: Partial<SuccessCriterion> = {}): SuccessCriterion => ({
  id: "c1", statement: "有人主动回信约了后续", required: true, evidenceOf: "outcome",
  measure: { kind: "count", unit: "replies", atLeast: 1 }, ...over
});
const proposal = (over: Record<string, unknown> = {}) => ({
  milestones: [{ identityId: "research", projectId: "p", title: "新的里程碑",
    successCriteria: [criterion()], rationale: "因为…", templateId: null }],
  assumptions: [], blockers: [], ...over
});

test("a well-formed proposal passes through", () => {
  expect(validateMilestoneProposal(proposal(), context).milestones).toHaveLength(1);
});

test("a milestone on an identity the user does not have is refused", () => {
  const alien = proposal({ milestones: [{ identityId: "woodwork", projectId: "p", title: "x",
    successCriteria: [criterion()], rationale: "r" }] });
  expect(() => validateMilestoneProposal(alien, context)).toThrow("PROPOSAL_IDENTITY_UNKNOWN");
});

test("re-proposing something that already exists is refused rather than duplicated", () => {
  const duplicate = proposal({ milestones: [{ identityId: "research", projectId: "p",
    title: "稳定推进当前实验与论文", successCriteria: [criterion()], rationale: "r" }] });
  expect(() => validateMilestoneProposal(duplicate, context)).toThrow("PROPOSAL_DUPLICATE_TITLE");
});

test("the criterion rules apply to proposals, surfaced as a proposal problem not a later write failure", () => {
  const vague = proposal({ milestones: [{ identityId: "media", projectId: "p", title: "含糊",
    successCriteria: [criterion({ measure: { kind: "judgement", rubric: "做得好", failsWhen: "" } })], rationale: "r", templateId: null }] });
  expect(() => validateMilestoneProposal(vague, context)).toThrow("CRITERION_NOT_FALSIFIABLE");
});

test("a templateId naming a template that was never offered is refused as fabrication", () => {
  const fabricated = proposal({ milestones: [{ identityId: "research", projectId: "p", title: "新的里程碑",
    successCriteria: [criterion()], rationale: "r", templateId: "not-a-real-template" }] });
  expect(() => validateMilestoneProposal(fabricated, context)).toThrow("PROPOSAL_TEMPLATE_UNKNOWN");
});

test("a templateId naming a template that was actually offered passes through", () => {
  const templated = proposal({ milestones: [{ identityId: "research", projectId: "p", title: "新的里程碑",
    successCriteria: [criterion()], rationale: "r", templateId: "research-literature-review-done" }] });
  expect(validateMilestoneProposal(templated, context).milestones[0]?.templateId).toBe("research-literature-review-done");
});

test("a Skill that stopped keeps its reason", () => {
  const blocked = proposal({ milestones: [], blockers: [{ code: "TOO_VAGUE", message: "没有说明想推进什么。" }] });
  try {
    validateMilestoneProposal(blocked, context);
    throw new Error("expected refusal");
  } catch (error) {
    expect((error as Error).message).toBe("PROPOSAL_BLOCKED");
    expect((error as Error & { detail?: string }).detail).toBe("没有说明想推进什么。");
  }
});

test("criteriaCoverOutcome is the warning that catches a milestone documents alone could pass", () => {
  expect(criteriaCoverOutcome([criterion()])).toBe(true);
  expect(criteriaCoverOutcome([criterion({ evidenceOf: "output" })])).toBe(false);
  // Criteria written before the field existed are unlabelled, which is not the same as "an output".
  expect(criteriaCoverOutcome([{ id: "old", statement: "x", required: true, measure: { kind: "artifact", mustExist: "y" } }])).toBe(false);
});
