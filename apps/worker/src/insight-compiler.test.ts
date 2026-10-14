import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { LINE_SETTING } from "@crossline/identity-packs";
import { currentMineVersion, mineSkillSettingKey, readMineSkill, type MilestoneGateResult } from "@crossline/core";
import { createInsightCompiler, INSIGHT_COMPILER, linesAwaitingMineSkill, mineMaterials, saveMineVersion } from "./insight-compiler";
import { AGENT_SKILL, approveCategory, createAgentRunner } from "./agent-task";
import { createMilestoneGate, MILESTONE_GATE_SKILL } from "./milestone-gate-runner";
import { libraryMarketplacePath } from "./skill-library";
import { fakeRuntime } from "./testing/fake-runtime";

// The real account's note on the assistant's first Xiaohongshu outline (agent-97846949-1, 2026-10-14) — the first real rule.
const NOTE = "本人选主线 A（科研是缩小不确定性的循环）。不同意按科研报告的边界来做：自媒体的核心是制造冲突和贩卖焦虑，再通过卖 solution 变现，而不是做得像科研报告一样。";
const estimate = { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const };

let store: CrosslineStore;
let ws: string;
let dir: string;
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  ws = store.createPrincipalWithWorkspace("user-1", "个人 workspace").workspace.id;
  dir = mkdtempSync(path.join(tmpdir(), "crossline-library-"));
  store.setSetting(ws, LINE_SETTING, JSON.stringify([
    { id: "research", label: "研究者", color: "research", goal: "", goals: [], createdAt: "" },
    { id: "media", label: "创作者", color: "media", goal: "", goals: ["成为有影响力的科普创作者"], createdAt: "" }]));
  store.saveWorkOrder({ id: "wo-note", ownerId: "o", workspaceId: ws, identityId: "media", projectId: "p", milestoneId: "", intent: "小红书首篇笔记提纲",
    state: "accepted", riskTier: "routine", estimate, payload: {} });
  const owner = store.getWorkspaceOwnerId(ws)!;
  store.appendEvent({ ownerId: owner, workspaceId: ws, idempotencyKey: "req", type: "agent.task.requested", entityId: "agent-97846949-1",
    payload: { taskId: "agent-97846949-1", title: "为小红书首篇「科研如何实际发生」笔记形成提纲", category: "read_research_organize", workOrderId: "wo-note" } });
  store.appendEvent({ ownerId: owner, workspaceId: ws, idempotencyKey: "rev", type: "agent.task.reviewed", entityId: "agent-97846949-1",
    payload: { taskId: "agent-97846949-1", decision: "accepted", note: NOTE, category: "read_research_organize" } });
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const play = { kind: "play", text: "笔记先制造冲突、点出焦虑，再给出可购买的 solution；不写成科研报告体", sources: ["m1"],
  quote: "自媒体的核心是制造冲突和贩卖焦虑，再通过卖 solution 变现", url: "" };
const compiled = JSON.stringify({ summary: "以冲突和焦虑开场，以 solution 收尾。", rules: [play], blockers: [] });

test("the review note on the line's work is the material, and only lines with something to say are waiting", () => {
  const materials = mineMaterials(store, ws, "media");
  expect(materials).toEqual([expect.objectContaining({ id: "m1", kind: "review", text: NOTE, label: expect.stringContaining("本人采纳助手结果") })]);
  expect(mineMaterials(store, ws, "research")).toEqual([]);
  expect(linesAwaitingMineSkill(store, ws)).toEqual(["media"]);
});

test("the compiled skill is a new version with its sources, an event, and nothing waits until the person says something new", async () => {
  const runtime = fakeRuntime([compiled], INSIGHT_COMPILER);
  const outcome = await createInsightCompiler(store, ws, "C:\\repo", () => runtime.rpc)();
  expect(outcome).toEqual({ lineId: "media", version: 1, rules: 1, dropped: [] });
  const version = currentMineVersion(readMineSkill(store.getSetting(ws, mineSkillSettingKey("media"))))!;
  expect(version).toMatchObject({ version: 1, by: "compiler" });
  expect(version.markdown).toContain("1. 笔记先制造冲突");
  expect(version.markdown).toContain("「自媒体的核心是制造冲突和贩卖焦虑，再通过卖 solution 变现」");
  expect(store.listEvents(ws, { type: "skill.mine.rewritten" }).map((event) => event.payload)).toEqual([expect.objectContaining({ lineId: "media", version: 1, by: "compiler", rules: 1 })]);
  expect(linesAwaitingMineSkill(store, ws)).toEqual([]);

  // A hand edit stays in force; only a new decision by the person brings a rewrite, and every older version is still there.
  saveMineVersion(store, ws, "media", { at: new Date(Date.now() + 1000).toISOString(), by: "person", markdown: `${version.markdown}\n补充：标题要短。` });
  expect(linesAwaitingMineSkill(store, ws)).toEqual([]);
  store.addPreference({ workspaceId: ws, source: "correction", scope: "media", weight: 1, refId: "x", text: "标题不超过 15 个字", createdAt: new Date(Date.now() + 2000).toISOString() });
  expect(linesAwaitingMineSkill(store, ws)).toEqual(["media"]);
  expect(mineMaterials(store, ws, "media").map((material) => material.kind)).toEqual(["review", "preference", "edit"]);
  expect(readMineSkill(store.getSetting(ws, mineSkillSettingKey("media")))!.versions.map((item) => item.by)).toEqual(["compiler", "person"]);
});

test("a rule that cannot cite the person's words is sent back, and after the repairs only the sourced ones are kept", async () => {
  const invented = { ...play, text: "多用学术引用", quote: "要像论文一样严谨" };
  const runtime = fakeRuntime([JSON.stringify({ summary: "", rules: [play, invented], blockers: [] })], INSIGHT_COMPILER);
  const outcome = await createInsightCompiler(store, ws, "C:\\repo", () => runtime.rpc)();
  expect(runtime.prompts()[1]).toContain("找不到逐字原文");
  expect(outcome).toMatchObject({ version: 1, rules: 1 });
});

test("the assistant runs with the line's own skill on beside its own, and switches it back off", async () => {
  saveMineVersion(store, ws, "media", { at: "2026-10-14T06:00:00Z", by: "person", markdown: "---\nname: media\ndescription: \"x\"\n---\n# 创作者\n1. 先抛冲突\n" });
  approveCategory(store, ws, "read_research_organize");
  const outputRoot = mkdtempSync(path.join(tmpdir(), "crossline-agent-"));
  const summary = JSON.stringify({ summary: "按本人打法写好了第二篇笔记。", artifacts: [{ path: "note.md", purpose: "笔记" }],
    verification: [{ check: "按主线 skill 自查", result: "pass", evidence: "开头有冲突" }], needsHuman: [], notDone: [], assumptions: [] });
  const runtime = fakeRuntime([summary], AGENT_SKILL, { library: ["crossline-mine:media"],
    script: async () => { writeFileSync(path.join(outputRoot, "t-mine", "note.md"), "笔记"); } });
  try {
    const run = createAgentRunner(store, ws, "C:\\repo", () => runtime.rpc, { outputRoot, libraryDir: dir, homeDir: outputRoot });
    const outcome = await run({ taskId: "t-mine", title: "第二篇笔记", what: "写第二篇小红书笔记", category: "read_research_organize", humanPart: "确认选题", workOrderId: "wo-note" });
    expect(outcome).toMatchObject({ state: "done" });
    expect(runtime.prompts()[0]!.split("\n")[0]).toBe("$crossline:crossline-agent $crossline-mine:media");
    const calls = runtime.configCalls();
    expect(calls[0]).toMatchObject({ method: "plugin/install", params: { pluginName: "crossline-mine", marketplacePath: libraryMarketplacePath(dir) } });
    expect(calls.filter((call) => call.method === "skills/config/write").map((call) => call.params.enabled)).toEqual([true, false]);
    expect(readFileSync(path.join(dir, "plugins", "crossline-mine", "skills", "media", "SKILL.md"), "utf8")).toContain("1. 先抛冲突");
    expect(store.listEvents(ws, { type: "agent.task.completed" }).at(-1)!.payload).toMatchObject({ skills: ["crossline-mine:media"] });
  } finally { rmSync(outputRoot, { recursive: true, force: true }); }
});

test("the gate is given the line's skill, and a delivery that covers its contract but not the person's play is held as partial", async () => {
  saveMineVersion(store, ws, "media", { at: "2026-10-14T06:00:00Z", by: "person", markdown: "# 创作者\n1. 笔记先制造冲突、点出焦虑，再给出可购买的 solution\n" });
  store.saveMilestone({ id: "m", ownerId: "o", workspaceId: ws, identityId: "media", projectId: "p", title: "首篇笔记", version: 1, status: "approved", successCriteria: [] });
  store.saveWorkOrder({ id: "w1", ownerId: "o", workspaceId: ws, identityId: "media", projectId: "p", milestoneId: "m", intent: "首篇笔记提纲", state: "ready_for_human",
    riskTier: "milestone", estimate, payload: { evidenceContract: [{ kind: "record", description: "提纲", why: "交付物", required: true }] } });
  store.transitionWorkOrder(ws, "w1", { type: "human.started" }, "start:w1");
  store.transitionWorkOrder(ws, "w1", { type: "human.completed" }, "done:w1", { evidence: [{ kind: "record", uri: "local://r", description: "提纲：科研如何实际发生（报告体）" }] });
  const answer: MilestoneGateResult = { verdict: "partial", criteriaVerdict: [],
    contractCoverage: [{ requirement: "提纲", satisfiedBy: "e1", reasoning: "有提纲", quote: "提纲：科研如何实际发生" }],
    unplannedGains: [], improvements: [], incomplete: [], flywheelAssessment: [], gaps: [], proposedNextMilestones: [], blockers: [],
    fit: { fits: false, violated: ["笔记先制造冲突、点出焦虑，再给出可购买的 solution"], why: "按科研报告写成" } };
  const runtime = fakeRuntime([JSON.stringify(answer)], MILESTONE_GATE_SKILL);
  expect(await createMilestoneGate(store, ws, "C:\\repo", () => runtime.rpc)("w1")).toMatchObject({ state: "held", verdict: "partial" });
  expect(JSON.parse(runtime.prompts()[0]!.split("\n\n").slice(1).join("\n\n")).mineSkill).toEqual({ lineId: "media", text: expect.stringContaining("先制造冲突") });
  const order = store.listWorkOrders(ws).find((item) => item.id === "w1")!;
  expect(order.state).toBe("blocked");
  expect((order.payload as { gateReview: MilestoneGateResult }).gateReview.fit?.violated).toEqual(answer.fit!.violated);
  // The gate's 「部分」 becomes material for the next rewrite.
  expect(mineMaterials(store, ws, "media").some((material) => material.kind === "gate" && material.text.includes("按科研报告写成"))).toBe(true);
});
