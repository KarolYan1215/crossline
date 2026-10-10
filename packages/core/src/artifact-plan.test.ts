import { describe, expect, test } from "vitest";
import {
  ARTIFACT_PLAN_SCHEMA, byproductArtifactId, capOutgoing, deriveArtifactRelations, keptArtifactPlan, lineArtifacts, mergeArtifactPlan, producedArtifacts,
  relationFulfilment, sanitizeArtifactReferences, timeOrderProblem, usedArtifacts, validateArtifactPlan, validateArtifactReferences,
  type ArtifactPlanContext, type ArtifactMilestone, type StoredArtifactPlan, type SupplyPair
} from "./artifact-plan";
import { structuredOutputProblems } from "./structured-output";
import { keepMilestoneProposal, validateMilestoneProposal, type MilestoneProposalContext } from "./milestone-gate-schema";

const context = (over: Partial<ArtifactPlanContext> = {}): ArtifactPlanContext => ({
  version: "crossline.artifact-plan.v1", today: "2026-10-10", planLines: ["research", "media"],
  lines: [{ id: "research", label: "科研", goal: "成为做器件仿真的研究者", facts: [] }, { id: "media", label: "自媒体", goal: "成为科普作者", facts: [] },
    { id: "startup", label: "创业", goal: "", facts: [] }],
  milestones: [], flywheelFacts: [], kept: { artifacts: [], supplies: [] }, lowFulfilment: [], ...over
});
const supply = (over: Partial<SupplyPair> = {}): SupplyPair => ({ from: "research-figs", toLine: "media", use: "做第 2 期科普视频的配图",
  transfer: { metric: "图表", expected: 3, unit: "张" }, lagDays: 3, counterfactual: "没有这些图要自己重画，多花约 6 小时", hoursSaved: 6, ...over });
const answer = (over: { supplies?: SupplyPair[]; artifacts?: unknown[] } = {}) => ({
  artifacts: over.artifacts ?? [
    { id: "research-figs", line: "research", kind: "论文图表", title: "MoS2 器件仿真图表", readyBy: "2026-10-25" },
    { id: "research-data", line: "research", kind: "数据集", title: "NeuroSim 仿真数据", readyBy: "2026-10-28" },
    { id: "media-notes", line: "media", kind: "读者反馈", title: "评论区问题汇总", readyBy: "2026-11-05" }],
  needs: [{ line: "media", input: "可解释的科研图", why: "科普需要真实数据" }],
  supplies: over.supplies ?? [supply()], assumptions: [], blockers: []
});
const codeOf = (run: () => unknown) => { try { run(); return "none"; } catch (error) { return (error as Error).message; } };

describe("the artifact plan contract", () => {
  test("its schema satisfies the strict structured-output rules", () => {
    expect(structuredOutputProblems(ARTIFACT_PLAN_SCHEMA)).toEqual([]);
  });

  test("a sound plan is kept as it is", () => {
    const checked = validateArtifactPlan(answer(), context());
    expect(checked.artifacts).toHaveLength(3);
    expect(checked.supplies).toEqual([supply()]);
    expect(checked.warnings).toEqual([]);
  });

  test("hard checks: a pair must name a real artifact, another line, and a numeric transfer with a unit", () => {
    expect(codeOf(() => validateArtifactPlan(answer({ supplies: [supply({ from: "nowhere" })] }), context()))).toBe("SUPPLY_ARTIFACT_UNKNOWN");
    expect(codeOf(() => validateArtifactPlan(answer({ supplies: [supply({ toLine: "research" })] }), context()))).toBe("SUPPLY_SAME_LINE");
    expect(codeOf(() => validateArtifactPlan(answer({ supplies: [supply({ transfer: { metric: "图表", expected: Number.NaN, unit: "张" } })] }), context())))
      .toBe("SUPPLY_TRANSFER_NOT_NUMERIC");
    expect(codeOf(() => validateArtifactPlan(answer({ supplies: [supply({ transfer: { metric: "图表", expected: 0, unit: "张" } })] }), context())))
      .toBe("SUPPLY_TRANSFER_NOT_NUMERIC");
    expect(codeOf(() => validateArtifactPlan(answer({ supplies: [supply({ transfer: { metric: "图表", expected: 3, unit: " " } })] }), context())))
      .toBe("SUPPLY_TRANSFER_UNIT_MISSING");
    expect(codeOf(() => validateArtifactPlan(answer({ supplies: [supply({ lagDays: 2.5 })] }), context()))).toBe("SUPPLY_LAG_INVALID");
  });

  test("a one-line run may not restate another line's artifacts or kept ids", () => {
    const only = context({ planLines: ["media"], kept: { artifacts: [{ id: "research-figs", line: "research", kind: "论文图表", title: "MoS2 器件仿真图表", readyBy: "2026-10-25" }], supplies: [] } });
    expect(codeOf(() => validateArtifactPlan(answer(), only))).toBe("ARTIFACT_LINE_NOT_PLANNED");
    const media = { artifacts: [{ id: "media-notes", line: "media", kind: "读者反馈", title: "评论区问题汇总", readyBy: "2026-11-05" }],
      supplies: [supply(), supply({ from: "media-notes", toLine: "research", use: "选下一个仿真问题的依据", hoursSaved: 2 })] };
    // A pair from a kept (other line's) artifact into the redone line is fine; so is one out of it.
    expect(validateArtifactPlan(answer(media), only).supplies).toHaveLength(2);
    const withKept = { ...only, kept: { ...only.kept, artifacts: [...only.kept.artifacts, { id: "media-old", line: "media", kind: "x", title: "已被采用的产物", readyBy: "2026-11-01" }] } };
    expect(codeOf(() => validateArtifactPlan(answer({ ...media, artifacts: [...media.artifacts, { id: "media-old", line: "media", kind: "x", title: "重复的产物", readyBy: "2026-11-01" }] }), withKept)))
      .toBe("ARTIFACT_ID_DUPLICATE");
  });

  test("at most two outgoing edges per line: the rest are dropped by hours saved, then by expected transfer", () => {
    const pairs = [supply({ toLine: "media", hoursSaved: 2 }), supply({ from: "research-data", toLine: "media", hoursSaved: 9 }),
      supply({ from: "research-data", toLine: "startup", hoursSaved: 2, transfer: { metric: "条", expected: 40, unit: "行" } })];
    const checked = validateArtifactPlan(answer({ supplies: pairs }), context({ planLines: ["research", "media", "startup"] }));
    expect(checked.supplies.map((pair) => `${pair.from}>${pair.toLine}`)).toEqual(["research-data>media", "research-data>startup"]);
    expect(checked.dropped.join("")).toContain("research-figs → media");
    // A kept pair holds its slot first.
    const lineOf = (id: string) => id.split("-")[0];
    const locked = [supply({ from: "research-old", hoursSaved: 0 })];
    expect(capOutgoing(pairs, lineOf, locked).kept).toHaveLength(1);
  });

  test("a vague counterfactual is a warning for the reviewer, not a refusal", () => {
    const checked = validateArtifactPlan(answer({ supplies: [supply({ counterfactual: "会更难做" })] }), context());
    expect(checked.supplies).toHaveLength(1);
    expect(checked.warnings[0]!.warnings.map((warning) => warning.code)).toEqual(["SUPPLY_COUNTERFACTUAL_VAGUE"]);
  });
});

describe("time order", () => {
  test("upstream is due by the downstream deadline less the lag", () => {
    expect(timeOrderProblem("2026-10-20", "2026-10-25", 5)).toBeNull();
    expect(timeOrderProblem("2026-10-21", "2026-10-25", 5)).toContain("最晚 2026-10-20");
    expect(timeOrderProblem(undefined, "2026-10-25", 5)).toBeNull();
  });
  test("a feedback edge (the two lines supply each other) needs a day of lag, so it lands on the next period", () => {
    expect(timeOrderProblem("2026-10-25", "2026-10-25", 0)).toBeNull();
    expect(timeOrderProblem("2026-10-25", "2026-10-25", 0, true)).toContain("下一期");
    expect(timeOrderProblem("2026-10-24", "2026-10-25", 0, true)).toBeNull();
  });
});

const plan: StoredArtifactPlan = { version: 1, updatedAt: "", needs: [],
  artifacts: [{ id: "research-figs", line: "research", kind: "论文图表", title: "MoS2 器件仿真图表", readyBy: "2026-10-25" },
    { id: "media-notes", line: "media", kind: "读者反馈", title: "评论区问题汇总", readyBy: "2026-11-05" }],
  supplies: [supply()] };
const milestone = (id: string, line: string, deadline: string, refs: { outputs?: string[]; inputs?: string[] } = {}, status = "draft"): ArtifactMilestone =>
  ({ id, line, title: `里程碑 ${id}`, status, deadline, outputs: refs.outputs ?? [], inputs: refs.inputs ?? [] });

describe("relations are derived from references", () => {
  test("producer output + consumer input in another line make one relation, checked on the downstream deadline", () => {
    const { relations } = deriveArtifactRelations([milestone("r1", "research", "2026-10-20", { outputs: ["research-figs"] }),
      milestone("m1", "media", "2026-11-01", { inputs: ["research-figs"] }), milestone("m0", "media", "2026-10-30")], plan, { labels: { research: "科研", media: "自媒体" } });
    expect(relations).toEqual([expect.objectContaining({ id: "artifact:research-figs:r1->m1", fromMilestoneId: "r1", toMilestoneId: "m1", kind: "reuses",
      artifactId: "research-figs", checkOn: "2026-11-01", counterfactual: supply().counterfactual,
      transfer: { metric: "图表", expected: 3, unit: "张", hoursSaved: 6, lagDays: 3, measured: null } })]);
    expect(relations[0]!.explanation).toContain("科研的「MoS2 器件仿真图表」");
  });

  test("no reference, no relation; a producer too late is refused rather than drawn", () => {
    expect(deriveArtifactRelations([milestone("r1", "research", "2026-10-20", { outputs: ["research-figs"] }), milestone("m1", "media", "2026-11-01")], plan).relations).toEqual([]);
    const late = deriveArtifactRelations([milestone("r1", "research", "2026-10-31", { outputs: ["research-figs"] }),
      milestone("m1", "media", "2026-11-01", { inputs: ["research-figs"] })], plan);
    expect(late.relations).toEqual([]);
    expect(late.refused).toEqual([expect.objectContaining({ code: "RELATION_TIME_ORDER", toMilestoneId: "m1" })]);
  });

  test("of several producers, the latest one still in time is the source", () => {
    const { relations } = deriveArtifactRelations([milestone("r1", "research", "2026-10-15", { outputs: ["research-figs"] }),
      milestone("r2", "research", "2026-10-27", { outputs: ["research-figs"] }), milestone("r3", "research", "2026-10-31", { outputs: ["research-figs"] }),
      milestone("m1", "media", "2026-11-01", { inputs: ["research-figs"] })], plan);
    expect(relations.map((relation) => relation.fromMilestoneId)).toEqual(["r2"]);
  });

  test("two lines that supply each other make a feedback loop, each leg landing on a later milestone", () => {
    const loop: StoredArtifactPlan = { ...plan, supplies: [supply({ lagDays: 0 }), supply({ from: "media-notes", toLine: "research", use: "读者问题决定下一组仿真", hoursSaved: 1, lagDays: 0 })] };
    const { relations } = deriveArtifactRelations([milestone("r1", "research", "2026-10-20", { outputs: ["research-figs"] }),
      milestone("m1", "media", "2026-10-20", { inputs: ["research-figs"], outputs: ["media-notes"] }), milestone("m2", "media", "2026-10-25", { inputs: ["research-figs"] }),
      milestone("r2", "research", "2026-10-20", { inputs: ["media-notes"] }), milestone("r3", "research", "2026-11-10", { inputs: ["media-notes"] })], loop);
    // Same-day ends cannot feed each other: r1 → m1 (same day) and m1 → r2 (same day) are not drawn; the next period is.
    expect(relations.map((relation) => `${relation.fromMilestoneId}->${relation.toMilestoneId}:${relation.kind}`).sort())
      .toEqual(["m1->r3:recurring_feedback", "r1->m2:recurring_feedback"]);
  });

  test("a line keeps at most two outgoing relations, approved ones first", () => {
    const wide: StoredArtifactPlan = { ...plan, artifacts: [...plan.artifacts, { id: "research-data", line: "research", kind: "数据集", title: "数据", readyBy: "2026-10-25" }],
      supplies: [supply({ hoursSaved: 1 }), supply({ from: "research-data", hoursSaved: 8 })] };
    const milestones = [milestone("r1", "research", "2026-10-20", { outputs: ["research-figs", "research-data"] }),
      milestone("m1", "media", "2026-11-01", { inputs: ["research-figs", "research-data"] }), milestone("m2", "media", "2026-11-02", { inputs: ["research-figs"] })];
    const free = deriveArtifactRelations(milestones, wide);
    expect(free.relations.map((relation) => relation.id)).toEqual(["artifact:research-data:r1->m1", "artifact:research-figs:r1->m1"]);
    expect(free.refused.map((item) => item.code)).toEqual(["RELATION_OUTGOING_CAP"]);
    const locked = deriveArtifactRelations(milestones, wide, { locked: new Set(["artifact:research-figs:r1->m2"]) });
    expect(locked.relations.map((relation) => relation.id)).toContain("artifact:research-figs:r1->m2");
    expect(locked.relations).toHaveLength(2);
  });
});

describe("one line's milestones against the plan", () => {
  const forMedia = (milestones: ArtifactMilestone[]) => lineArtifacts(plan, "media", milestones, { research: "科研" });
  const proposed = (deadline: string, inputs: string[], derivation = "复用 MoS2 器件仿真图表 3 张，省下 6 小时，配图部分只需 1 小时") =>
    ({ identityId: "media", title: "第 2 期科普视频发布", plan: { key: "m", deadline, derivation, outputs: [], inputs } });

  test("an input must be known, used in the derivation, and deliverable in time", () => {
    const artifacts = forMedia([milestone("r1", "research", "2026-10-20", { outputs: ["research-figs"] })]);
    expect(codeOf(() => validateArtifactReferences([proposed("2026-11-01", ["research-figs"])], artifacts))).toBe("none");
    expect(codeOf(() => validateArtifactReferences([proposed("2026-11-01", ["research-other"])], artifacts))).toBe("MILESTONE_INPUT_UNKNOWN");
    expect(codeOf(() => validateArtifactReferences([proposed("2026-11-01", ["research-figs"], "按 3 次发布倒推，每次 2 小时")], artifacts))).toBe("MILESTONE_INPUT_NOT_DERIVED");
    expect(codeOf(() => validateArtifactReferences([proposed("2026-10-21", ["research-figs"])], artifacts))).toBe("MILESTONE_INPUT_TOO_EARLY");
    // With no producer yet, the plan's readyBy is the promise checked against.
    expect(codeOf(() => validateArtifactReferences([proposed("2026-10-26", ["research-figs"])], forMedia([])))).toBe("MILESTONE_INPUT_TOO_EARLY");
  });

  test("an output must reach the milestones already waiting for it, and every promised artifact must be produced", () => {
    const artifacts = lineArtifacts(plan, "research", [milestone("m1", "media", "2026-11-01", { inputs: ["research-figs"] })]);
    const research = (deadline: string, outputs: string[]) => ({ identityId: "research", title: "图表交付师兄确认", plan: { key: "r", deadline, derivation: "", outputs, inputs: [] } });
    expect(codeOf(() => validateArtifactReferences([research("2026-10-20", ["research-figs"])], artifacts))).toBe("none");
    expect(codeOf(() => validateArtifactReferences([research("2026-10-31", ["research-figs"])], artifacts))).toBe("MILESTONE_OUTPUT_TOO_LATE");
    expect(codeOf(() => validateArtifactReferences([research("2026-10-20", [])], artifacts))).toBe("MILESTONE_ARTIFACT_UNPRODUCED");
    expect(codeOf(() => validateArtifactReferences([research("2026-10-20", ["research-unknown"])], artifacts))).toBe("MILESTONE_OUTPUT_UNKNOWN");
  });

  test("what cannot pass is stripped from a kept answer, so only valid relations can be derived from it", () => {
    const artifacts = forMedia([milestone("r1", "research", "2026-10-20", { outputs: ["research-figs"] })]);
    const [late] = sanitizeArtifactReferences([proposed("2026-10-21", ["research-figs", "research-other"])], artifacts);
    expect(late!.plan.inputs).toEqual([]);
    const [fine] = sanitizeArtifactReferences([proposed("2026-11-01", ["research-figs"])], artifacts);
    expect(fine!.plan.inputs).toEqual(["research-figs"]);
  });

  test("the architect's answer is refused on a time-order problem and, after the repairs, kept without the reference", () => {
    const facts = [{ id: "media/-/goal", identityId: "media", projectId: "", slot: "goal", value: "做科普", status: "confirmed" as const }];
    const ctx: MilestoneProposalContext = { version: "crossline.milestone-proposal.v1", identities: [{ id: "media", label: "自媒体", summary: "" }],
      existingMilestones: [], recentWork: [], templates: [], request: "", artifacts: forMedia([milestone("r1", "research", "2026-10-20", { outputs: ["research-figs"] })]),
      profile: { today: "2026-10-10", requiredIdentities: ["media"], projects: [], facts } };
    const item = (key: string, stage: number, deadline: string, dependsOn: string[], inputs: string[] = []) => ({ identityId: "media", projectId: "", title: `科普视频第 ${stage} 期发布`,
      successCriteria: [{ id: "c", statement: "播放量达到 1000", required: true, evidenceOf: "outcome", measure: { kind: "count", unit: "次", atLeast: 1000 } }],
      rationale: "按发布节奏倒推", templateId: null, evidenceQuestionBank: [{ id: "q", prompt: "是否发布？", kind: "checkbox", options: ["是", "否"], required: true }],
      plan: { key, stage, deadline, outcome: "建立科普读者群", derivation: "复用 MoS2 器件仿真图表 3 张，每期省 2 小时", baseline: "尚未开始", target: "视频发布并收到反馈",
        stakeholders: [], sourceFactIds: ["media/-/goal"], dependsOn, outputs: [], inputs } });
    const raw = { milestones: [item("a", 1, "2026-10-21", [], ["research-figs"]), item("b", 2, "2026-11-10", ["a"]), item("c", 3, "2026-12-01", ["b"])], assumptions: [], blockers: [] };
    expect(codeOf(() => validateMilestoneProposal(raw, ctx))).toBe("MILESTONE_INPUT_TOO_EARLY");
    const kept = keepMilestoneProposal(raw, ctx, "MILESTONE_INPUT_TOO_EARLY");
    expect(kept?.milestones[0]!.plan!.inputs).toEqual([]);
  });
});

describe("redoing one line", () => {
  test("keeps the other lines' part and every pair an approved milestone rests on", () => {
    const stored: StoredArtifactPlan = { version: 1, updatedAt: "t", needs: [{ line: "media", input: "x", why: "y" }, { line: "research", input: "a", why: "b" }],
      artifacts: [...plan.artifacts, { id: "research-old", line: "research", kind: "代码", title: "旧脚本", readyBy: "2026-10-30" },
        { id: "research-used", line: "research", kind: "数据集", title: "已被采用的数据", readyBy: "2026-10-30" }],
      supplies: [supply(), supply({ from: "research-old", toLine: "startup" }), supply({ from: "research-used", toLine: "media" }),
        supply({ from: "media-notes", toLine: "research", use: "读者问题", hoursSaved: 1 })] };
    const milestones = [milestone("m9", "media", "2026-11-20", { inputs: ["research-used"] }, "approved")];
    const kept = keptArtifactPlan(stored, milestones, ["research"]);
    expect(kept.artifacts.map((artifact) => artifact.id).sort()).toEqual(["media-notes", "research-used"]);
    expect(kept.supplies.map((pair) => `${pair.from}>${pair.toLine}`)).toEqual(["research-used>media"]);
    expect(kept.needs).toEqual([{ line: "media", input: "x", why: "y" }]);
    const merged = mergeArtifactPlan(kept, { artifacts: [plan.artifacts[0]!], needs: [], supplies: [supply()] }, "t2");
    expect(merged.artifacts).toHaveLength(3);
    expect(merged.updatedAt).toBe("t2");
  });
});

describe("fulfilment and task-level artifacts", () => {
  test("跨线关系兑现率 counts a partial delivery as half and flags kinds delivered under half the time", () => {
    const result = relationFulfilment([{ outcome: "fulfilled", kind: "论文图表" }, { outcome: "partial", kind: "论文图表" },
      { outcome: "none", kind: "访谈记录" }, { outcome: "none", kind: "访谈记录" }]);
    expect(result.rate).toBe(0.38);
    expect(result.low).toEqual([{ kind: "访谈记录", checked: 2, rate: 0 }]);
    expect(relationFulfilment([]).rate).toBeNull();
  });

  test("a task produces its own artifact and one per byproduct; a landing task uses its main task's", () => {
    expect(producedArtifacts({ id: "wo", payload: { produces: "research-figs", byproducts: [{ lineId: "media" }] } }))
      .toEqual(["research-figs", byproductArtifactId("wo", "media")]);
    expect(usedArtifacts({ payload: { uses: ["research-figs", 3] } })).toEqual(["research-figs"]);
  });
});
