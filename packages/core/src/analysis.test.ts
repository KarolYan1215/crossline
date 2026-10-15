import { expect, test } from "vitest";
import * as core from "./index";

const analysisContext = {
  version: "crossline.analysis.v1", capture: { title: "Compare notes and decide", context: "Use only supplied notes" },
  approvedMilestones: [{ id: "m", projectId: "p", identityId: "research", title: "Compare notes", version: 1, hasSuccessCriteria: true }],
  availableInputs: [], identityPacks: [{ id: "research", version: 1, summary: "Keep research judgment with the human" }],
  historicalStats: [], policy: { tools: [], externalSideEffects: false, humanApprovalRequired: true }
};
const validProposal = {
  identityId: "research", projectId: "p", milestoneId: "m", intent: "Compare notes and decide", family: "deep_work",
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

test("an empty milestoneId is accepted as \"not bound to any offered milestone\", not rejected as missing", () => {
  // GTD's "next action with no project" needs a legitimate way to say so; forcing a fit onto an
  // approved milestone every time was the actual constraint, not a schema requirement.
  const unbound = { ...validProposal, milestoneId: "" };
  expect(core.validateAnalysisProposal(unbound, analysisContext)).toMatchObject({ milestoneId: "" });
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
    approvedMilestones: [...analysisContext.approvedMilestones, { id: "m2", projectId: "p2", identityId: "startup", title: "Validate a paying problem", version: 1, hasSuccessCriteria: true }],
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
    evidenceContract: [{ kind: "record", description: "清".repeat(300), why: "组会要用", required: true }]
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

test("an evidence contract with nothing required is refused, so the core deliverable can always fail the gate", () => {
  const allOptional = { ...validProposal, evidenceContract: validProposal.evidenceContract.map((item) => ({ ...item, required: false })) };
  expect(() => core.validateAnalysisProposal(allOptional, analysisContext)).toThrow("ANALYSIS_EVIDENCE_REQUIRED_MISSING");
  // Optional supporting items beside a required deliverable are fine.
  const mixed = { ...validProposal, evidenceContract: [...validProposal.evidenceContract,
    { kind: "record", description: "Supporting log", why: "Makes the call easier to trust", required: false }] };
  expect(core.validateAnalysisProposal(mixed, analysisContext).evidenceContract).toHaveLength(2);
});

test("only required items are the bar for pass; a contract without the flag fails closed", () => {
  expect(core.requiredContractRequirements([
    { description: "核心交付物", required: true }, { description: "佐证", required: false },
    { description: "旧契约，没有 required 字段" }, { kind: "file" }
  ])).toEqual(["核心交付物", "旧契约，没有 required 字段", "file"]);
  expect(core.requiredContractRequirements(undefined)).toEqual([]);
  // The shape older analyses wrote: everything explicitly optional. That must not shrink the bar to nothing.
  expect(core.requiredContractRequirements([
    { description: "旧契约一", required: false }, { description: "旧契约二", required: false }
  ])).toEqual(["旧契约一", "旧契约二"]);
});

test("an estimate has to add up: the steps' minutes are the median, within a quarter, and a padded total is sent back with the sum", () => {
  const withSteps = (steps: Array<[string, number]>, p50 = 20) => ({ ...validProposal, estimate: { ...validProposal.estimate, p25Minutes: Math.round(p50 * 0.6), p50Minutes: p50, p85Minutes: Math.round(p50 * 1.9) },
    estimateBreakdown: steps.map(([step, minutes]) => ({ step, minutes })) });
  expect(core.validateAnalysisProposal(withSteps([["读两篇笔记", 8], ["比较并写结论", 12]]), analysisContext)).toMatchObject({ estimateBreakdown: [{ step: "读两篇笔记", minutes: 8 }, { step: "比较并写结论", minutes: 12 }] });
  // 360 against steps that sum to 120: padding.
  try { core.validateAnalysisProposal(withSteps([["读", 60], ["写", 60]], 360), analysisContext); throw new Error("accepted"); } catch (error) {
    expect((error as Error).message).toBe("ANALYSIS_ESTIMATE_BREAKDOWN_MISMATCH");
    expect((error as Error & { detail?: string }).detail).toContain("120");
    expect((error as Error & { detail?: string }).detail).toContain("360");
  }
});

test("a context carries the person's measured rhythm, and one written before it existed reads as nothing measured", () => {
  const measured = { ...analysisContext, rhythm: { focusRunMinutes: 52, productiveMinutesPerDay: 310, planActualRatio: 0.7, observedDays: 12, completed: 6 } };
  expect(core.validateAnalysisContext(measured).rhythm).toEqual(measured.rhythm);
  expect(core.validateAnalysisContext(analysisContext).rhythm).toEqual({ focusRunMinutes: 0, productiveMinutesPerDay: 0, planActualRatio: 0, observedDays: 0, completed: 0 });
});

test("the margin is stated in p85: no room above the typical value is refused, and so is a margin that is a guess", () => {
  const withP85 = (p85Minutes: number) => ({ ...validProposal, estimate: { ...validProposal.estimate, p25Minutes: 12, p50Minutes: 20, p85Minutes },
    estimateBreakdown: [{ step: "读", minutes: 8 }, { step: "写", minutes: 12 }] });
  expect(core.validateAnalysisProposal(withP85(26), analysisContext)).toBeTruthy();
  for (const p85 of [20, 23, 91]) {
    try { core.validateAnalysisProposal(withP85(p85), analysisContext); throw new Error("accepted"); } catch (error) {
      expect((error as Error).message).toBe("ANALYSIS_ESTIMATE_MARGIN_INVALID");
      expect((error as Error & { detail?: string }).detail).toContain("至少 24");
    }
  }
});

// v2: dates and waiting are read from the capture itself; a byproduct serves another line.
const v2Context = {
  version: "crossline.analysis.v2", today: "2026-10-06",
  capture: { title: "10月8号左右师兄会给我西湖MoS2的真实测量数据，拿到后跑仿真并画图，10月21号前把图表交给师兄", context: "" },
  approvedMilestones: [
    { id: "m", projectId: "p", identityId: "research", title: "图表获师兄接收", version: 1, hasSuccessCriteria: true, deadline: "2026-10-21" },
    { id: "media-m", projectId: "x", identityId: "media", title: "首轮内容获真实反馈", version: 1, hasSuccessCriteria: true, deadline: "2026-10-19" }],
  availableInputs: [], identityPacks: [{ id: "research", version: 1, summary: "r" }, { id: "media", version: 1, summary: "m" }],
  referenceClass: [], relations: [], policy: { tools: [], externalSideEffects: false, humanApprovalRequired: true }
};
const v2Proposal = {
  ...validProposal, milestoneId: "m", intent: "处理实测数据并交付图表",
  automationParts: [], humanCore: [{ id: "h", intent: "判断数据质量", energy: "high", interruptible: false, quote: "拿到后跑仿真并画图", rationale: "研究判断" }],
  estimateBreakdown: [{ step: "仿真", minutes: 20 }],
  dates: [{ kind: "release", date: "2026-10-08", quote: "10月8号左右", approximate: true },
    { kind: "due", date: "2026-10-21", quote: "10月21号前把图表交给师兄", approximate: false },
    { kind: "due", date: "2026-10-25", quote: "10月21号前把图表交给师兄", approximate: false }],
  waitingOn: { who: "师兄", what: "西湖MoS2的真实测量数据", expectedDate: "2026-10-08", quote: "10月8号左右师兄会给我" },
  byproducts: [{ lineId: "media", milestoneId: "media-m", artifact: "一篇“科研如何发生”的研究日记笔记",
    captureSteps: [{ step: "仿真时记下每次调参的想法", minutes: 10 }], landing: { minutes: 40, description: "把笔记改成一条小红书草稿" }, why: "自媒体主线需要真实科研素材" }]
};

test("v2: verifiable dates and the waiting-for are kept; a date the quote does not name is dropped", () => {
  const result = core.validateAnalysisProposal(v2Proposal, v2Context);
  expect(result.dates.map((item) => item.date)).toEqual(["2026-10-08", "2026-10-21"]);
  expect(result.waitingOn).toMatchObject({ who: "师兄", expectedDate: "2026-10-08" });
  const unverifiable = core.validateAnalysisProposal({ ...v2Proposal, waitingOn: { ...v2Proposal.waitingOn, expectedDate: "2026-10-09" } }, v2Context);
  expect(unverifiable.waitingOn.who).toBe("");
});

test("v2: a byproduct must serve another existing line, once, with a concrete artifact", () => {
  expect(core.validateAnalysisProposal(v2Proposal, v2Context).byproducts).toHaveLength(1);
  const bad = (byproduct: Record<string, unknown>) => ({ ...v2Proposal, byproducts: [{ ...v2Proposal.byproducts[0], ...byproduct }] });
  expect(() => core.validateAnalysisProposal(bad({ lineId: "research" }), v2Context)).toThrow("ANALYSIS_BYPRODUCT_INVALID");
  expect(() => core.validateAnalysisProposal(bad({ lineId: "woodwork" }), v2Context)).toThrow("ANALYSIS_BYPRODUCT_INVALID");
  expect(() => core.validateAnalysisProposal(bad({ artifact: "保持创作状态" }), v2Context)).toThrow("ANALYSIS_BYPRODUCT_INVALID");
  expect(() => core.validateAnalysisProposal(bad({ milestoneId: "m" }), v2Context)).toThrow("ANALYSIS_BYPRODUCT_INVALID");
  expect(() => core.validateAnalysisProposal({ ...v2Proposal, byproducts: [v2Proposal.byproducts[0], v2Proposal.byproducts[0]] }, v2Context))
    .toThrow("ANALYSIS_BYPRODUCT_INVALID");
});

test("v2 context no longer carries correction factors to the model", () => {
  expect(() => core.validateAnalysisContext({ ...v2Context, rhythm: { focusRunMinutes: 0, productiveMinutesPerDay: 0, planActualRatio: 1.4, observedDays: 0, completed: 3 } }))
    .toThrow("ANALYSIS_CONTEXT_INVALID");
  expect(core.validateAnalysisContext(v2Context).version).toBe("crossline.analysis.v2");
});

test("asking someone for a fact: the system may draft the email but never send it (info-request.ts)", () => {
  const ask = { ...analysisContext, capture: { title: "问助教 ECE 548 期中考查范围", context: "" } };
  const proposal = (part: string) => ({ ...validProposal, title: "询问 ECE 548 期中考查范围", intent: "向助教确认 ECE 548 期中考查范围", family: "preparation",
    estimate: { p25Minutes: 5, p50Minutes: 10, p85Minutes: 15, source: "llm_prior", observationCount: 0, confidence: "low" }, estimateBreakdown: [{ step: "检查并发送", minutes: 10 }],
    automationParts: [{ ...validProposal.automationParts[0], intent: part, quote: "问助教 ECE 548 期中考查范围" }],
    humanCore: [{ ...validProposal.humanCore[0], intent: "检查草稿并发送", quote: "问助教 ECE 548 期中考查范围" }] });
  expect(() => core.validateAnalysisProposal(proposal("起草给助教的邮件草稿"), ask)).not.toThrow();
  expect(() => core.validateAnalysisProposal(proposal("发送邮件给助教"), ask)).toThrow("ANALYSIS_INFO_REQUEST_SENT_BY_SYSTEM");
});
