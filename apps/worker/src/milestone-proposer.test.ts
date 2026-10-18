import { afterEach, beforeEach, expect, test } from "vitest";
import { approveArtifactRelationsFor, CrosslineStore } from "@crossline/db";
import { defaultMilestoneTemplates, MILESTONE_DRAFTING_SETTING, readMilestoneDrafting } from "@crossline/core";
import { ARTIFACT_PLANNER_SKILL, buildProposalContext, createMilestoneConversation, createMilestoneProposer, MILESTONE_ARCHITECT_SKILL } from "./milestone-proposer";
import { fakeRuntime as sharedRuntime, scriptedRuntime } from "./testing/fake-runtime";

const fakeRuntime = (answers: Array<string | ((prompts: string[]) => string)>, _skill?: string) => sharedRuntime(answers, MILESTONE_ARCHITECT_SKILL);
const WORKSPACE = "workspace-a";
let store: CrosslineStore;

beforeEach(() => { store = new CrosslineStore(":memory:"); });
afterEach(() => store.close());

const proposal = (title: string, templateId: string | null = null) => JSON.stringify({
  milestones: [{ identityId: "research", projectId: "p", title,
    successCriteria: [{ id: "c", statement: "写完初稿", required: true, measure: { kind: "artifact", mustExist: "draft.md" } }],
    rationale: "推进论文进度", templateId,
    evidenceQuestionBank: [{ id: "q1", prompt: "初稿是否存在？", kind: "checkbox", options: ["是", "否"], required: true }] }],
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

test("buildProposalContext offers whatever templates are seeded for this workspace", () => {
  store.seedMilestoneTemplates(WORKSPACE, defaultMilestoneTemplates());
  const context = buildProposalContext(store, WORKSPACE, "");
  expect(context.templates.length).toBeGreaterThan(0);
  expect(context.templates.some((template) => template.identityId === "research")).toBe(true);
});

test("a proposal built from a seeded template's own criteria is saved with high confidence", async () => {
  store.seedMilestoneTemplates(WORKSPACE, defaultMilestoneTemplates());
  const template = store.listMilestoneTemplates(WORKSPACE, "research")[0]!;
  const templated = JSON.stringify({
    milestones: [{ identityId: "research", projectId: "p", title: "套用模板的里程碑",
      successCriteria: template.successCriteriaDefaults, rationale: "r", templateId: template.id,
      evidenceQuestionBank: template.evidenceQuestionDefaults }],
    assumptions: [], blockers: []
  });
  const { rpc } = fakeRuntime([templated]);
  const propose = createMilestoneProposer(store, WORKSPACE, "C:\\repo", () => rpc);
  const outcome = await propose("推进科研");
  expect(outcome).toMatchObject({ state: "proposed" });
  const saved = store.listMilestones(WORKSPACE)[0];
  expect(saved).toMatchObject({ templateId: template.id, confidence: "high" });
});

test("a free-form proposal with no template is saved at low confidence, the same baseline as before templates existed", async () => {
  const { rpc } = fakeRuntime([proposal("完全自由生成的里程碑")]);
  const propose = createMilestoneProposer(store, WORKSPACE, "C:\\repo", () => rpc);
  await propose("推进科研");
  expect(store.listMilestones(WORKSPACE)[0]).toMatchObject({ confidence: "low" });
  expect(store.listMilestones(WORKSPACE)[0]?.templateId).toBeUndefined();
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

const NOW = () => new Date("2026-10-02T12:00:00.000Z");
const seedProfile = () => {
  for (const [slot, value] of [["deadline", "10/31 前投出"], ["goal", "NeuroSim 仿真结果投稿"]] as const) {
    store.upsertProfileFact({ workspaceId: WORKSPACE, identityId: "research", projectId: "westlake", slot, value, status: "confirmed",
      sourceRef: "reply-1", sourceQuote: value, updatedAt: "2026-10-02T00:00:00.000Z" });
  }
};
const step = (key: string, stage: number, title: string, deadline: string, dependsOn: string[]) => ({
  identityId: "research", projectId: "westlake", title,
  successCriteria: [{ id: "c", statement: "师兄确认图表可用", required: true, evidenceOf: "outcome", measure: { kind: "artifact", mustExist: "师兄的确认回复" } }],
  rationale: "按西湖截止日期倒推", templateId: null,
  evidenceQuestionBank: [{ id: "q1", prompt: "师兄是否确认？", kind: "checkbox", options: ["是", "否"], required: true }],
  plan: { key, stage, deadline, outcome: "拿到好成绩", derivation: "总评 A 要 90 分，其余部分预计 92，所以这一项至少 85，再留 3 分余量", baseline: "数据尚未到", target: "把图表交给师兄并得到确认", stakeholders: ["师兄"],
    sourceFactIds: ["research/westlake/deadline"], dependsOn }
});
const chain = (over: Partial<ReturnType<typeof step>>[] = []) => JSON.stringify({
  milestones: [
    { ...step("a", 1, "西湖图表交付师兄确认", "2026-10-15", []), ...over[0] },
    { ...step("b", 2, "西湖论文投出", "2026-10-31", ["a"]), ...over[1] },
    { ...step("c", 3, "拿到审稿反馈并规划修改", "2026-12-20", ["b"]), ...over[2] }
  ], assumptions: [], blockers: []
});

test("with a profile the answer must be a dated, sourced chain, and its anchors are kept with real ids", async () => {
  seedProfile();
  const { rpc } = fakeRuntime([chain()]);
  const propose = createMilestoneProposer(store, WORKSPACE, "C:\repo", () => rpc, NOW);
  expect(await propose("")).toMatchObject({ state: "proposed" });
  const anchors = store.listMilestoneAnchors(WORKSPACE);
  expect(anchors.map((anchor) => anchor.stage)).toEqual([1, 2, 3]);
  const ids = new Set(store.listMilestones(WORKSPACE).map((milestone) => milestone.id));
  // `dependsOn` was written in the answer's own keys and is stored as the ledger's ids.
  expect(anchors[1]?.dependsOn.every((id) => ids.has(id))).toBe(true);
  expect(anchors[1]?.dependsOn).toEqual([anchors[0]?.milestoneId]);
});

test("a chain that is not dated or is too short is sent back, and nothing is saved", async () => {
  seedProfile();
  const short = JSON.stringify({ milestones: [step("a", 1, "西湖图表交付师兄确认", "2026-10-15", [])], assumptions: [], blockers: [] });
  const { rpc } = fakeRuntime([short, short, short]);
  const propose = createMilestoneProposer(store, WORKSPACE, "C:\repo", () => rpc, NOW);
  expect(await propose("")).toMatchObject({ state: "blocked" });
  expect(store.listMilestones(WORKSPACE)).toHaveLength(0);
  expect(store.listMilestoneAnchors(WORKSPACE)).toHaveLength(0);
});

test("starter milestones and the relations between them are archived once there is a profile", async () => {
  seedProfile();
  store.saveMilestone({ id: "research-starter", ownerId: "o", workspaceId: WORKSPACE, identityId: "research", projectId: "research-default", title: "为「科研」确定第一个可验收的里程碑", version: 1, status: "approved" });
  store.saveMilestone({ id: "startup-starter", ownerId: "o", workspaceId: WORKSPACE, identityId: "startup", projectId: "startup-default", title: "为「创业」确定第一个可验收的里程碑", version: 1, status: "approved" });
  store.saveMilestoneRelation({ id: "r", ownerId: "o", workspaceId: WORKSPACE, fromMilestoneId: "research-starter", toMilestoneId: "startup-starter", kind: "informs", status: "approved" });
  const { rpc } = fakeRuntime([chain()]);
  await createMilestoneProposer(store, WORKSPACE, "C:\repo", () => rpc, NOW)("");
  const byId = new Map(store.listMilestones(WORKSPACE).map((milestone) => [milestone.id, milestone.status]));
  expect(byId.get("research-starter")).toBe("archived");
  expect(byId.get("startup-starter")).toBe("archived");
  // Archived relations drop out of the listing, so an empty one is the archived state.
  expect(store.listMilestoneRelations(WORKSPACE)).toEqual([]);
});

test("only accepted research reaches the architect, with the claims and pages behind it", () => {
  const ownerId = "o";
  store.saveDiligenceReport({ id: "r1", ownerId, workspaceId: WORKSPACE, scope: "startup", question: "q", status: "done", runAt: "2026-10-02T00:00:00.000Z",
    findings: [{ id: "f1", claim: "该孵化器接受在读学生，申请截止 2026-11-15。", sourceIds: ["s1"] }],
    sources: [{ id: "s1", title: "Student Accelerator", finalUrl: "https://example.edu/accelerator" }],
    proposals: [
      { id: "p1", title: "11/15 前提交学生孵化器申请", why: "符合身份", kind: "milestone", dueDate: "2026-11-15", findingIds: ["f1"], status: "accepted" },
      { id: "p2", title: "不想做的建议", why: "x", kind: "task", dueDate: "", findingIds: ["f1"], status: "rejected" },
      { id: "p3", title: "还没决定的建议", why: "x", kind: "task", dueDate: "", findingIds: ["f1"], status: "pending" }
    ] });
  const context = buildProposalContext(store, WORKSPACE, "");
  expect(context.diligence).toEqual([{ identityId: "startup", title: "11/15 前提交学生孵化器申请", why: "符合身份", kind: "milestone", dueDate: "2026-11-15",
    claims: ["该孵化器接受在读学生，申请截止 2026-11-15。"], sources: ["Student Accelerator https://example.edu/accelerator"] }]);
});

const seedStartup = () => {
  for (const [slot, value] of [["goal", "10 个试用者"], ["stage", "只有我自己在用"]] as const) {
    store.upsertProfileFact({ workspaceId: WORKSPACE, identityId: "startup", projectId: "", slot, value, status: "confirmed",
      sourceRef: "reply-1", sourceQuote: value, updatedAt: "2026-10-02T00:00:00.000Z" });
  }
};
const startupStep = (key: string, stage: number, title: string, deadline: string, dependsOn: string[]) => ({
  ...step(key, stage, title, deadline, dependsOn), identityId: "startup", projectId: "",
  plan: { ...step(key, stage, title, deadline, dependsOn).plan, sourceFactIds: ["startup/-/goal"] }
});
const startupChain = JSON.stringify({ milestones: [
  startupStep("s1", 1, "Crossline 自己用满两周并留下记录", "2026-10-20", []),
  startupStep("s2", 2, "Crossline 交到第一位外部试用者手里", "2026-11-10", ["s1"]),
  startupStep("s3", 3, "Crossline 获得十位外部试用者的反馈", "2026-11-30", ["s2"])
], assumptions: [], blockers: [] });

const artifactPlan = (over: object = {}) => JSON.stringify({
  artifacts: [{ id: "research-figs", line: "research", kind: "论文图表", title: "西湖论文图表", readyBy: "2026-10-15" }],
  needs: [{ line: "startup", input: "可信的演示材料", why: "试用者要看到真实效果" }],
  supplies: [{ from: "research-figs", toLine: "startup", use: "做 Crossline 演示材料的配图", transfer: { metric: "图表", expected: 3, unit: "张" }, lagDays: 3,
    counterfactual: "没有这些图要重做演示图，多花约 5 小时", hoursSaved: 5 }],
  assumptions: [], blockers: [], ...over
});
const withRefs = (raw: string, refs: Record<string, { outputs?: string[]; inputs?: string[]; derivation?: string }>) => {
  const answer = JSON.parse(raw) as { milestones: Array<{ plan: Record<string, unknown> }> };
  for (const milestone of answer.milestones) {
    const own = refs[String(milestone.plan.key)] ?? {};
    milestone.plan = { ...milestone.plan, outputs: own.outputs ?? [], inputs: own.inputs ?? [], ...(own.derivation ? { derivation: own.derivation } : {}) };
  }
  return JSON.stringify(answer);
};
const researchWithFigs = () => withRefs(chain(), { a: { outputs: ["research-figs"] } });
const startupUsing = (key: string) => withRefs(startupChain, { [key]: { inputs: ["research-figs"], derivation: "复用西湖论文图表 3 张（research-figs），演示材料从 6 小时减到 1 小时" } });
/** Answers by what the prompt asks: the artifact plan, or one line's milestones; a repair turn gets the same answer again. */
const flywheelRuntime = (answers: { plan: () => string; research: () => string; startup: () => string }) => {
  let last = "";
  return scriptedRuntime([MILESTONE_ARCHITECT_SKILL, ARTIFACT_PLANNER_SKILL], (prompt) => {
    last = prompt.includes("crossline.artifact-plan.v1") ? answers.plan()
      : prompt.includes('"requiredIdentities":["research"]') ? answers.research()
      : prompt.includes('"requiredIdentities":["startup"]') ? answers.startup() : last;
    return last;
  });
};

test("artifacts are planned first, each line is designed against them, and the relation is derived from the references", async () => {
  seedProfile(); seedStartup();
  const runtime = flywheelRuntime({ plan: () => artifactPlan(), research: researchWithFigs, startup: () => startupUsing("s2") });
  const outcome = await createMilestoneProposer(store, WORKSPACE, "C:\\repo", () => runtime.rpc, NOW)("");
  expect(outcome).toMatchObject({ state: "proposed" });
  const prompts = runtime.prompts();
  expect(prompts[0]).toContain('"planLines":["research","startup"]');
  // The startup run was about startup only, but it was told what research will hand it and which research draft produces it.
  const startupPrompt = prompts.find((prompt) => prompt.includes('"requiredIdentities":["startup"]'))!;
  expect(startupPrompt).not.toContain("research/westlake");
  expect(startupPrompt).toContain('"consume":[{"id":"research-figs"');
  expect(startupPrompt).toContain("西湖图表交付师兄确认");
  // No separate relations run any more.
  expect(prompts.some((prompt) => prompt.includes("milestone-relations"))).toBe(false);

  const drafts = new Map(store.listMilestones(WORKSPACE).map((milestone) => [milestone.title, milestone.id]));
  const relations = store.listMilestoneRelations(WORKSPACE);
  expect(relations).toEqual([expect.objectContaining({
    id: `artifact:research-figs:${drafts.get("西湖图表交付师兄确认")}->${drafts.get("Crossline 交到第一位外部试用者手里")}`,
    status: "candidate", kind: "reuses", artifactId: "research-figs", checkOn: "2026-11-10", counterfactual: "没有这些图要重做演示图，多花约 5 小时",
    transfer: { metric: "图表", expected: 3, unit: "张", hoursSaved: 5, lagDays: 3, measured: null } })]);
  expect(outcome.state === "proposed" && outcome.relations?.derived).toEqual([relations[0]!.id]);
  expect(store.listMilestoneAnchors(WORKSPACE).find((anchor) => anchor.milestoneId === drafts.get("西湖图表交付师兄确认"))?.outputs).toEqual(["research-figs"]);
});

test("a downstream milestone due before the artifact can arrive is sent back; after the repairs it is kept without the reference and no relation is drawn", async () => {
  seedProfile(); seedStartup();
  // s1 is due 10/20; the figures are due 10/15 with three days to adapt them: 10/18 is fine, so make the producer late instead.
  const lateResearch = () => withRefs(chain([{ plan: { ...step("a", 1, "西湖图表交付师兄确认", "2026-10-19", []).plan } }]), { a: { outputs: ["research-figs"] } });
  const runtime = flywheelRuntime({ plan: () => artifactPlan(), research: lateResearch, startup: () => startupUsing("s1") });
  const outcome = await createMilestoneProposer(store, WORKSPACE, "C:\\repo", () => runtime.rpc, NOW)("");
  expect(outcome).toMatchObject({ state: "proposed" });
  expect(runtime.prompts().some((prompt) => prompt.includes("MILESTONE_INPUT_TOO_EARLY"))).toBe(true);
  const s1 = store.listMilestones(WORKSPACE).find((milestone) => milestone.title === "Crossline 自己用满两周并留下记录")!;
  expect(store.listMilestoneAnchors(WORKSPACE).find((anchor) => anchor.milestoneId === s1.id)?.inputs).toEqual([]);
  expect(store.listMilestoneRelations(WORKSPACE)).toEqual([]);
});

test("redoing one line keeps the other lines' artifacts and re-derives the cross-line links instead of losing them", async () => {
  seedProfile(); seedStartup();
  let startup = () => startupUsing("s2");
  let plan = () => artifactPlan();
  const runtime = flywheelRuntime({ plan: () => plan(), research: researchWithFigs, startup: () => startup() });
  const propose = createMilestoneProposer(store, WORKSPACE, "C:\\repo", () => runtime.rpc, NOW);
  await propose("");
  const research = store.listMilestones(WORKSPACE).filter((milestone) => milestone.identityId === "research").map((milestone) => milestone.id).sort();
  const first = store.listMilestoneRelations(WORKSPACE)[0]!;

  startup = () => startupUsing("s3");
  // Startup's part is planned again: the pair into it is restated from research's kept artifact; research's own artifacts are not.
  plan = () => artifactPlan({ artifacts: [], needs: [] });
  const outcome = await propose("", undefined, ["startup"]);
  expect(outcome).toMatchObject({ state: "proposed" });
  const planPrompt = runtime.prompts().filter((prompt) => prompt.includes("crossline.artifact-plan.v1")).at(-1)!;
  expect(planPrompt).toContain('"planLines":["startup"]');
  expect(planPrompt).toContain('"kept":{"artifacts":[{"id":"research-figs"');
  // Research was not redone, and its artifact is still in the plan.
  expect(store.listMilestones(WORKSPACE).filter((milestone) => milestone.identityId === "research" && milestone.status === "draft").map((milestone) => milestone.id).sort()).toEqual(research);
  expect(JSON.parse(store.getSetting(WORKSPACE, "flywheel.artifacts")!).artifacts.map((artifact: { id: string }) => artifact.id)).toEqual(["research-figs"]);
  // The old link pointed at a superseded draft and is retired; the new one points at the new draft.
  const live = store.listMilestoneRelations(WORKSPACE);
  expect(live).toHaveLength(1);
  expect(live[0]!.id).not.toBe(first.id);
  const s3 = store.listMilestones(WORKSPACE).find((milestone) => milestone.status === "draft" && milestone.title === "Crossline 获得十位外部试用者的反馈")!;
  expect(live[0]).toMatchObject({ toMilestoneId: s3.id, fromMilestoneId: first.fromMilestoneId, status: "candidate", checkOn: "2026-11-30" });
});

test("a pair an approved downstream milestone rests on survives redoing the upstream line, and its new relation is approved with the new upstream", async () => {
  seedProfile(); seedStartup();
  let plan = () => artifactPlan();
  const runtime = flywheelRuntime({ plan: () => plan(), research: researchWithFigs, startup: () => startupUsing("s2") });
  const propose = createMilestoneProposer(store, WORKSPACE, "C:\\repo", () => runtime.rpc, NOW);
  await propose("");
  const s2 = store.listMilestones(WORKSPACE).find((milestone) => milestone.title === "Crossline 交到第一位外部试用者手里")!;
  store.saveMilestone({ ...s2, version: 2, status: "approved" });
  expect(approveArtifactRelationsFor(store, WORKSPACE, "o", s2.id)).toHaveLength(1);

  plan = () => artifactPlan({ artifacts: [], needs: [], supplies: [] });
  await propose("", undefined, ["research"]);
  const planPrompt = runtime.prompts().filter((prompt) => prompt.includes("crossline.artifact-plan.v1")).at(-1)!;
  expect(planPrompt).toContain('"planLines":["research"]');
  expect(planPrompt).toContain('"supplies":[{"from":"research-figs","toLine":"startup"');
  const newA = store.listMilestones(WORKSPACE).find((milestone) => milestone.status === "draft" && milestone.title === "西湖图表交付师兄确认")!;
  const relation = store.listMilestoneRelations(WORKSPACE).find((item) => item.fromMilestoneId === newA.id)!;
  expect(relation).toMatchObject({ toMilestoneId: s2.id, status: "candidate", artifactId: "research-figs" });
  store.saveMilestone({ ...newA, version: 2, status: "approved" });
  expect(approveArtifactRelationsFor(store, WORKSPACE, "o", newA.id)).toEqual([relation.id]);
});

test("one line that cannot be done does not take the others with it, and the person is told which and why", async () => {
  seedProfile(); seedStartup();
  const stuck = JSON.stringify({ milestones: [], assumptions: [], blockers: [{ code: "thin", message: "创业线没有任何截止日期可以倒推" }] });
  const runtime = fakeRuntime([chain(), stuck, stuck, stuck], "crossline:crossline-milestone-architect");
  const outcome = await createMilestoneProposer(store, WORKSPACE, "C:\repo", () => runtime.rpc, NOW)("");
  expect(outcome).toMatchObject({ state: "proposed", skipped: [{ identityId: "startup", code: "PROPOSAL_BLOCKED" }] });
  expect(outcome.state === "proposed" && outcome.assumptions.some((line) => line.includes("创业") && line.includes("没有任何截止日期"))).toBe(true);
  expect(store.listMilestones(WORKSPACE).filter((milestone) => milestone.status === "draft" && milestone.identityId === "research")).toHaveLength(3);
  expect(store.listMilestones(WORKSPACE).filter((milestone) => milestone.identityId === "startup")).toHaveLength(0);
  // The 主线 page reads the run line by line: research done, startup skipped with its reason, the run finished (W-26/W-27).
  const drafting = readMilestoneDrafting(store.getSetting(WORKSPACE, MILESTONE_DRAFTING_SETTING))!;
  expect(drafting).toMatchObject({ done: ["research"], skipped: [{ lineId: "startup" }] });
  expect(drafting.skipped[0]!.why).toContain("没有任何截止日期");
  expect(drafting.finishedAt).toBeTruthy();
});

test("a line whose run failed keeps the drafts the person already had", async () => {
  seedProfile(); seedStartup();
  store.saveMilestone({ id: "old-startup", ownerId: "o", workspaceId: WORKSPACE, identityId: "startup", projectId: "", title: "旧的创业草稿", version: 1, status: "draft" });
  store.saveMilestone({ id: "old-research", ownerId: "o", workspaceId: WORKSPACE, identityId: "research", projectId: "westlake", title: "旧的科研草稿", version: 1, status: "draft" });
  const stuck = JSON.stringify({ milestones: [], assumptions: [], blockers: [{ code: "thin", message: "太少" }] });
  const runtime = fakeRuntime([chain(), stuck], "crossline:crossline-milestone-architect");
  await createMilestoneProposer(store, WORKSPACE, "C:\repo", () => runtime.rpc, NOW)("");
  const status = (id: string) => store.listMilestones(WORKSPACE).find((milestone) => milestone.id === id)?.status;
  expect([status("old-research"), status("old-startup")]).toEqual(["archived", "draft"]);
});

test("asking again replaces the drafts nobody touched, keeps the ones the person edited, and never touches an approved one", async () => {
  seedProfile();
  const save = (id: string, version: number, status: "draft" | "approved") => store.saveMilestone({ id, ownerId: "o", workspaceId: WORKSPACE,
    identityId: "research", projectId: "westlake", title: `旧的 ${id}`, version, status });
  save("stale", 1, "draft"); save("edited", 2, "draft"); save("approved", 1, "approved");
  const { rpc } = fakeRuntime([chain()]);
  expect(await createMilestoneProposer(store, WORKSPACE, "C:\repo", () => rpc, NOW)("")).toMatchObject({ state: "proposed" });
  const status = (id: string) => store.listMilestones(WORKSPACE).find((milestone) => milestone.id === id)?.status;
  expect([status("stale"), status("edited"), status("approved")]).toEqual(["archived", "draft", "approved"]);
  expect(store.listMilestones(WORKSPACE).filter((milestone) => milestone.status === "draft").length).toBe(4);
});

test("a blocker next to real milestones is kept as an assumption instead of throwing the answer away; one with nothing in it still stops", async () => {
  seedProfile();
  const hedged = JSON.stringify({ ...JSON.parse(chain()), blockers: [{ code: "thin", message: "自媒体线缺少已确认的受众" }] });
  const { rpc } = fakeRuntime([hedged]);
  const outcome = await createMilestoneProposer(store, WORKSPACE, "C:\repo", () => rpc, NOW)("");
  expect(outcome).toMatchObject({ state: "proposed" });
  expect(outcome.state === "proposed" && outcome.assumptions).toContain("自媒体线缺少已确认的受众");
  expect(store.listMilestones(WORKSPACE).filter((milestone) => milestone.status === "draft")).toHaveLength(3);

  const empty = JSON.stringify({ milestones: [], assumptions: [], blockers: [{ code: "none", message: "什么都提不出来" }] });
  const { rpc: second } = fakeRuntime([empty]);
  expect(await createMilestoneProposer(store, WORKSPACE, "C:\repo", () => second, NOW)("")).toMatchObject({ state: "blocked", code: "PROPOSAL_BLOCKED" });
});

test("a line the profile only guesses about is not asked for a chain it could not honestly give, and the person is told why", async () => {
  seedProfile();
  for (const slot of ["goal", "stage"]) {
    store.upsertProfileFact({ workspaceId: WORKSPACE, identityId: "investment", projectId: "", slot, value: "大概想做研究备忘录", status: "inferred",
      sourceRef: "", sourceQuote: "", updatedAt: "2026-10-02T00:00:00.000Z" });
  }
  const context = buildProposalContext(store, WORKSPACE, "", { requireChains: true, now: NOW });
  expect(context.profile?.requiredIdentities).toEqual(["research"]);

  const runtime = fakeRuntime([chain()]);
  const outcome = await createMilestoneProposer(store, WORKSPACE, "C:\repo", () => runtime.rpc, NOW)("");
  expect(outcome.state === "proposed" && outcome.assumptions.some((line) => line.includes("投资") && line.includes("确认"))).toBe(true);
});

test("the dates the person's files gave reach the architect, tied to the project they belong to even when the model wrote its name", () => {
  seedProfile();
  store.saveProject({ id: "ece555", workspaceId: WORKSPACE, ownerId: "o", identityId: "research", name: "ECE 555", status: "active", summary: "", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" });
  store.appendEvent({ ownerId: "o", workspaceId: WORKSPACE, idempotencyKey: "dates:extracted:b1", type: "dates.extracted", entityId: "b1",
    payload: { dates: [
      { project: "ECE 555", kind: "quiz", date: "2026-10-09", title: "Quiz 2" },
      { project: "ece555", kind: "exam", date: "2026-12-07", title: "期末" },
      { project: "", kind: "other", date: "2026-10-10", title: "no project" }
    ] } });
  const context = buildProposalContext(store, WORKSPACE, "", { requireChains: true, now: NOW });
  expect(context.profile?.dates).toEqual([
    { project: "ece555", kind: "quiz", date: "2026-10-09", title: "Quiz 2" },
    { project: "ece555", kind: "exam", date: "2026-12-07", title: "期末" }
  ]);
});

const courseLine = (extra: object = {}) => {
  seedProfile();
  store.saveProject({ id: "ece555", workspaceId: WORKSPACE, ownerId: "o", identityId: "research", name: "ECE 555", status: "active", summary: "", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" });
  for (const [slot, value] of [["grading", "作业 20%、小测 30%、项目 25%、期末 25%"], ["goal", "修完 ECE 555"]] as const) {
    store.upsertProfileFact({ workspaceId: WORKSPACE, identityId: "research", projectId: "ece555", slot, value, status: "confirmed",
      sourceRef: "reply-1", sourceQuote: value, updatedAt: "2026-10-02T00:00:00.000Z" });
  }
  store.appendEvent({ ownerId: "o", workspaceId: WORKSPACE, idempotencyKey: "dates:extracted:c1", type: "dates.extracted", entityId: "c1",
    payload: { dates: [{ project: "ece555", kind: "quiz", date: "2026-10-26", title: "Quiz 3" }, { project: "ece555", kind: "homework_due", date: "2026-11-20", title: "HW4" },
      { project: "ece555", kind: "exam", date: "2026-12-07", title: "期末" }] } });
  const part = (key: string, stage: number, title: string, deadline: string, dependsOn: string[]) => ({
    identityId: "research", projectId: "ece555", title,
    successCriteria: [{ id: "c", statement: "平均分达标", required: true, evidenceOf: "outcome", measure: { kind: "threshold", unit: "分", comparator: "gte", value: 88, bareLine: 85 } }],
    rationale: "占比倒推", templateId: null,
    evidenceQuestionBank: [{ id: "q1", prompt: "成绩是否已公布？", kind: "checkbox", options: ["是", "否"], required: true }],
    plan: { key, stage, deadline, outcome: "ECE 555 总评 A−", derivation: "总评 90，其余预计 92，至少 85（bareLine），留 3 分余量设 88", baseline: "尚未开始",
      target: "平均分不低于 88 分", stakeholders: [], sourceFactIds: ["research/ece555/grading", "research/ece555/target_grade"], dependsOn }
  });
  return JSON.stringify({
    milestones: [part("q", 1, "ECE 555 小测平均分不低于 88", "2026-10-26", []), part("h", 2, "ECE 555 作业平均分不低于 88", "2026-11-20", ["q"]),
      part("f", 3, "ECE 555 期末考试不低于 88 分", "2026-12-07", ["h"])],
    targetProposals: [{ projectId: "ece555", value: "总评 A−（≥ 90）", why: "他读博方向相关，这门课稳妥即可，时间要留给论文" }],
    assumptions: [], blockers: [], ...extra
  });
};

test("a course with no target gets one proposed from the person's goals, kept as an unconfirmed fact with its reason", async () => {
  const { rpc } = fakeRuntime([courseLine()]);
  const propose = createMilestoneProposer(store, WORKSPACE, "C:\repo", () => rpc, NOW);
  const outcome = await propose("");
  expect(outcome).toMatchObject({ state: "proposed" });
  expect(store.listProfileFacts(WORKSPACE, { projectId: "ece555" }).find((fact) => fact.slot === "target_grade"))
    .toMatchObject({ status: "inferred", value: expect.stringContaining("总评 A−（≥ 90）（暂定：") });
  expect(outcome.state === "proposed" && outcome.assumptions.join("")).toContain("修改并重算");
});

test("a target the person already set is never replaced by a new proposal", async () => {
  store.upsertProfileFact({ workspaceId: WORKSPACE, identityId: "research", projectId: "ece555", slot: "target_grade", value: "只要通过（≥ 70）", status: "confirmed",
    sourceRef: "manual", sourceQuote: "只要通过（≥ 70）", updatedAt: "2026-10-02T00:00:00.000Z" });
  const { rpc } = fakeRuntime([courseLine()]);
  const propose = createMilestoneProposer(store, WORKSPACE, "C:\repo", () => rpc, NOW);
  await propose("");
  expect(store.listProfileFacts(WORKSPACE, { projectId: "ece555" }).find((fact) => fact.slot === "target_grade")).toMatchObject({ status: "confirmed", value: "只要通过（≥ 70）" });
});

test("changing one course's target redoes only its line", async () => {
  const answer = courseLine();
  const { rpc, turns } = fakeRuntime([answer]);
  const propose = createMilestoneProposer(store, WORKSPACE, "C:\repo", () => rpc, NOW);
  expect(await propose("", undefined, ["startup"])).toMatchObject({ state: "blocked", code: "NO_MATCHING_LINE" });
  expect(turns()).toBe(0);
  expect(await propose("", undefined, ["research"])).toMatchObject({ state: "proposed" });
  expect(turns()).toBe(1);
});

test("a milestone that was archived is not offered to the architect as something that already exists", () => {
  seedProfile();
  const base = { ownerId: "o", workspaceId: WORKSPACE, identityId: "research", projectId: "westlake", version: 1 };
  store.saveMilestone({ ...base, id: "kept", title: "西湖论文投出", status: "approved" });
  store.saveMilestone({ ...base, id: "retired", title: "西湖论文完成投稿", status: "archived" });
  const titles = buildProposalContext(store, WORKSPACE, "", { requireChains: true, replaceUntouchedDrafts: true, now: NOW }).existingMilestones.map((milestone) => milestone.title);
  expect(titles).toEqual(["西湖论文投出"]);
});
