import { expect, test } from "vitest";
import * as core from "./index";

const analysisContext = {
  version: "crossline.analysis.v1", capture: { title: "Compare notes and decide", context: "Use only supplied notes" },
  approvedMilestones: [{ id: "m", projectId: "p", identityId: "research", title: "Compare notes", version: 1 }],
  availableInputs: [], identityPacks: [{ id: "research", version: 1, summary: "Keep research judgment with the human" }],
  policy: { tools: [], externalSideEffects: false, humanApprovalRequired: true }
};
const validProposal = {
  identityId: "research", projectId: "p", milestoneId: "m", intent: "Compare notes and decide",
  automationParts: [{ id: "a", intent: "Organize supplied notes", reversibility: "local", quote: "Compare notes", rationale: "Prepare a comparison for review" }],
  humanCore: [{ id: "h", intent: "Decide", energy: "medium", interruptible: true, quote: "decide", rationale: "Judgment remains human" }],
  materialContract: [{ required: true, kind: "record", description: "A comparison draft", why: "The split needs the two papers side by side" }],
  evidenceContract: [{ kind: "record", description: "Human decision and rationale", why: "Only the person can own the call", required: true }],
  estimate: { p25Minutes: 12, p50Minutes: 20, p85Minutes: 38, source: "llm_prior", observationCount: 0, confidence: "low" },
  riskTier: "routine", blockers: []
};

test("accepts a strict proposal tied to supplied fragments and an approved milestone", () => {
  expect(core.validateAnalysisProposal(validProposal, analysisContext)).toEqual(validProposal);
  for (const invalid of [
    { ...validProposal, surprise: true }, { ...validProposal, milestoneId: "invented" },
    { ...validProposal, estimate: { ...validProposal.estimate, p25Minutes: 100 } },
    { ...validProposal, automationParts: [{ ...validProposal.automationParts[0], quote: "invented fragment" }] },
    { ...validProposal, automationParts: [{ ...validProposal.automationParts[0], reversibility: "external" }] }
  ]) expect(() => core.validateAnalysisProposal(invalid, analysisContext)).toThrow();
});

test("rejects fabricated splits whose quote is too short or quotes app-generated text", () => {
  const fabricate = (quote: string) => ({ ...validProposal, humanCore: [{ ...validProposal.humanCore[0], intent: "Send an outreach email", quote }] });
  // Against a 24-character title the bar is four characters, so these fragments prove nothing.
  for (const quote of ["e", ";", "de"]) expect(() => core.validateAnalysisProposal(fabricate(quote), analysisContext)).toThrow("ANALYSIS_EVIDENCE_INVALID");
  // The identity-pack summary is text this app composed, so quoting it is not user evidence.
  expect(() => core.validateAnalysisProposal(fabricate("research judgment"), analysisContext)).toThrow("ANALYSIS_EVIDENCE_INVALID");
});

test("rejects an estimate claiming a source, confidence or precision it cannot have", () => {
  const withEstimate = (estimate: Record<string, unknown>) => ({ ...validProposal, estimate: { ...validProposal.estimate, ...estimate } });
  for (const estimate of [{ confidence: "high" }, { source: "personal_history" }, { observationCount: 3 }]) {
    expect(() => core.validateAnalysisProposal(withEstimate(estimate), analysisContext)).toThrow();
  }
  expect(() => core.validateAnalysisProposal(withEstimate({ p25Minutes: 0.0001 }), analysisContext)).toThrow("ANALYSIS_ESTIMATE_INVALID");
});

test("a short capture can still evidence a split with its whole text", () => {
  const short = { ...analysisContext, capture: { title: "写周报", context: "" } };
  const quoting = (quote: string) => ({ ...validProposal, intent: "写周报",
    automationParts: [], humanCore: [{ ...validProposal.humanCore[0], quote }] });
  // A fixed four-character floor would leave a three-character capture permanently unanalysable.
  expect(core.validateAnalysisProposal(quoting("写周报"), short)).toMatchObject({ intent: "写周报" });
  expect(() => core.validateAnalysisProposal(quoting("写周"), short)).toThrow("ANALYSIS_EVIDENCE_INVALID");
});

test("milestone titles are app-authored constants, not usable as captured evidence", () => {
  // ensureSeeded() is the only saveMilestone caller, so these titles are hardcoded source strings.
  const seeded = { ...analysisContext,
    approvedMilestones: [{ ...analysisContext.approvedMilestones[0]!, title: "完成一版可复现的实验结论" }] };
  const quotingMilestone = { ...validProposal, automationParts: [],
    humanCore: [{ ...validProposal.humanCore[0], intent: "Buy NVDA", quote: "完成一版" }] };
  expect(() => core.validateAnalysisProposal(quotingMilestone, seeded)).toThrow("ANALYSIS_EVIDENCE_INVALID");
});

test("context may offer several identities, but every milestone needs a backing pack", () => {
  const multi = { ...analysisContext,
    approvedMilestones: [...analysisContext.approvedMilestones, { id: "m2", projectId: "p2", identityId: "startup", title: "Validate a paying problem", version: 1 }],
    identityPacks: [...analysisContext.identityPacks, { id: "startup", version: 1, summary: "Startup pack" }] };
  expect(core.validateAnalysisContext(multi).identityPacks).toHaveLength(2);
  // Choosing between identities is the Skill's job; offering a milestone with no pack is an app bug.
  expect(() => core.validateAnalysisContext({ ...multi, identityPacks: analysisContext.identityPacks })).toThrow("ANALYSIS_CONTEXT_INVALID");
});

test("a Skill's own reason for stopping survives as actionable text, not just a code", () => {
  // Observed on a real run: the Skill refused because the capture pointed at OneNote, which it was
  // never given. The code alone told the person nothing they could act on.
  const blocked = { ...validProposal, blockers: [
    { code: "REQUIRED_INPUT_UNAVAILABLE", message: "捕获引用了 OneNote，但它不在可用输入里。" },
    { code: "SCOPE_UNCLEAR", message: "摘要的目标读者未指明。" }
  ] };
  try {
    core.validateAnalysisProposal(blocked, analysisContext);
    throw new Error("expected the proposal to be refused");
  } catch (error) {
    expect((error as Error).message).toBe("ANALYSIS_POLICY_BLOCKED");
    expect((error as Error & { detail?: string }).detail)
      .toBe("捕获引用了 OneNote，但它不在可用输入里。；摘要的目标读者未指明。");
  }
});

test("a contract description carrying JSON punctuation is not a requirement the person can read", () => {
  // From a real run: the model lost the JSON, recovered inside a string, and left `'}],` plus its own
  // scratch reasoning in a description short enough to pass the length bound.
  const leaked = {
    ...validProposal,
    evidenceContract: [{ kind: "record", description: "组会清单。'}], Wait final invalid.", why: "组会要用", required: true }]
  };
  expect(() => core.validateAnalysisProposal(leaked, analysisContext)).toThrow("ANALYSIS_CONTRACT_NOT_PROSE");
  // The person has to be told which line was rejected; a bare code is the same dead end as「运行未完成」.
  try { core.validateAnalysisProposal(leaked, analysisContext); } catch (error) {
    expect((error as Error & { detail?: string }).detail).toContain("组会清单");
  }
});

test("a contract description that runs to the length limit is truncated text, not a requirement", () => {
  // Three real runs padded this field with restated policy until it hit whatever cap was in place and
  // arrived cut off mid-sentence. A checklist line never lands exactly on the limit.
  const padded = {
    ...validProposal,
    evidenceContract: [{ kind: "record", description: "清".repeat(120), why: "组会要用", required: true }]
  };
  expect(() => core.validateAnalysisProposal(padded, analysisContext)).toThrow("ANALYSIS_CONTRACT_TRUNCATED");
});

test("trailing filler is trimmed off a contract line rather than stored or rejected", () => {
  // A real run returned a complete `why` sentence followed by forty repetitions of one combining mark,
  // filling the field to its cap. The sentence in front of it is fine; only the padding is not.
  const padded = {
    ...validProposal,
    materialContract: [{ required: true, kind: "record", description: "三次反馈摘录", why: "整理清单要用到原始反馈。" + "ͅ".repeat(40) }]
  };
  const accepted = core.validateAnalysisProposal(padded, analysisContext);
  expect(accepted.materialContract[0]?.why).toBe("整理清单要用到原始反馈。");
  // A short run of repeats is ordinary text and must survive untouched.
  const ellipsis = {
    ...validProposal,
    materialContract: [{ required: true, kind: "record", description: "三次反馈摘录", why: "先给我原文……" }]
  };
  expect(core.validateAnalysisProposal(ellipsis, analysisContext).materialContract[0]?.why).toBe("先给我原文……");
});

test("a reason may quote the person, so quotation marks in `why` are not leakage", () => {
  // This check once covered `why` as well and refused a correct proposal whose reason quoted the
  // feedback being organised. A reason is a sentence; sentences have quotation marks in them.
  const quoting = {
    ...validProposal,
    materialContract: [{ required: true, kind: "record", description: "三次反馈摘录", why: "第一次说\"假设写得像结论\"，需要原文才能对齐。" }]
  };
  expect(() => core.validateAnalysisProposal(quoting, analysisContext)).not.toThrow();
});

test("a reason that loops on its own tail keeps the sentence and drops the echoes", () => {
  // Verbatim from a real run: the model looped on fragments of the sentence it had just written.
  const looping = {
    ...validProposal,
    materialContract: [{ required: true, kind: "record", description: "三次反馈摘录",
      why: "这是本次清单的主要输入，已由用户提供。工作应围绕这些摘录推进，不因缺少原文而停止。续推进，不因缺少原文而停止。里原文而停止。" }]
  };
  const accepted = core.validateAnalysisProposal(looping, analysisContext);
  expect(accepted.materialContract[0]?.why)
    .toBe("这是本次清单的主要输入，已由用户提供。工作应围绕这些摘录推进，不因缺少原文而停止。");
  // Two different sentences that merely share words are both kept.
  const distinct = {
    ...validProposal,
    materialContract: [{ required: true, kind: "record", description: "三次反馈摘录",
      why: "需要原文对齐。原文在学校系统里，现在拿不到。" }]
  };
  expect(core.validateAnalysisProposal(distinct, analysisContext).materialContract[0]?.why)
    .toBe("需要原文对齐。原文在学校系统里，现在拿不到。");
});
