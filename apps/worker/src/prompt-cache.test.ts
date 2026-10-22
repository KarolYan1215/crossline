import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { MAIL_ACCOUNTS_SETTING, type CostSignal } from "@crossline/core";
import { LINE_SETTING } from "@crossline/identity-packs";
import { runCodexAnalysis, type CodexRpcBoundary, type JsonLineRpcClient } from "@crossline/codex";
import { createStepPlanner } from "./step-planner";
import { createGoalBackplanner } from "./goal-backplanner";
import { MANUAL_DESIGNER_SKILL, MATERIAL_RESEARCHER_SKILL, MATERIAL_WRITER_SKILL, createManualbookBuilder } from "./manualbook";
import { createOnboardingSessionRunner, ONBOARDING_SKILL } from "./onboarding-session";
import { ONBOARDING_EXTRACT_SKILL } from "./onboarding-extract";
import { MAIL_TRIAGE_SKILL, triageMail } from "./mailbox";
import { createInsightCompiler, INSIGHT_COMPILER } from "./insight-compiler";
import { createMilestoneRiskReviewer, MILESTONE_RISK_REVIEWER } from "./milestone-risk-review";
import { fakeRuntime, scriptedRuntime } from "./testing/fake-runtime";

/**
 * The prompt cache (docs/token-economy.md §2.5): the provider matches a request from its first token. For each Skill reordered on
 * 2026-10-21, two runs on different objects of one workspace are captured as the runtime receives them (the thread's developer
 * instructions and the first turn's text parts), and must agree byte for byte on the developer instructions and on the input's stable
 * keys, which come first; what differs comes after. `PROMPT_CACHE_REPORT=1` prints how much of each request the two share.
 */
type Captured = { skill: string; developer: string; parts: string[] };

/** Wraps a runtime client to record each thread's developer instructions and its first turn's text parts. */
function capturing(rpc: JsonLineRpcClient): { client: CodexRpcBoundary; runs: Captured[] } {
  const developer = new Map<string, string>();
  const seen = new Set<string>();
  const runs: Captured[] = [];
  const client: CodexRpcBoundary = {
    request: async (method: string, params?: unknown) => {
      const record = (params ?? {}) as Record<string, unknown>;
      if (method === "turn/start" && !seen.has(String(record.threadId))) {
        seen.add(String(record.threadId));
        const parts = (record.input as Array<{ type: string; text?: string }>).filter((item) => item.type === "text").map((item) => item.text ?? "");
        runs.push({ skill: /^\$(\S+)/.exec(parts[0] ?? "")?.[1] ?? "", developer: developer.get(String(record.threadId)) ?? "", parts });
      }
      const result = await rpc.request(method, params);
      if (method === "thread/start") developer.set(String(((result as { thread?: { id?: string } }).thread ?? {}).id), String(record.developerInstructions ?? ""));
      return result;
    },
    onNotification: (handler) => rpc.onNotification(handler),
    onServerRequest: (handler) => rpc.onServerRequest(handler)
  } as CodexRpcBoundary;
  return { client, runs };
}

const request = (run: Captured) => `${run.developer}\u0000${run.parts.join("\u0000")}`;
const commonPrefix = (a: string, b: string) => { let at = 0; while (at < a.length && at < b.length && a[at] === b[at]) at += 1; return at; };
/** The input object as sent, after the Skill's name. */
const sentInput = (run: Captured) => JSON.parse(run.parts[0]!.slice(run.parts[0]!.indexOf("\n\n") + 2)) as Record<string, unknown>;

const report: string[] = [];
afterAll(() => { if (process.env.PROMPT_CACHE_REPORT) console.info(`skill\tshared chars\tshare of the request\n${report.join("\n")}`); });
/**
 * Two runs of one Skill: the developer instructions are the same, the input starts with `stable` (those present, in that order) and
 * every other key follows; the first `same` of them (all by default) read the same in both. A stable key past `same` is the run's own
 * object put before the rest because the runs after it share it (the backplanner's second mode and rolling rounds on one milestone).
 */
function expectShared(skill: string, runs: Captured[], stable: string[], same = stable.length) {
  const [a, b] = runs.filter((run) => run.skill === skill);
  expect(a && b, `two runs of ${skill}`).toBeTruthy();
  expect(b!.developer).toBe(a!.developer);
  const segment = (run: Captured) => {
    const input = sentInput(run);
    const keys = Object.keys(input);
    const first = stable.filter((key) => key in input);
    expect(keys.slice(0, first.length)).toEqual(first);
    // The stable keys' serialization is the start of the input's own.
    const head = (list: string[]) => JSON.stringify(Object.fromEntries(list.map((key) => [key, input[key]]))).slice(0, -1);
    expect(run.parts[0]!.startsWith(`$${skill}\n\n${head(first)}`)).toBe(true);
    return head(stable.slice(0, same).filter((key) => key in input));
  };
  expect(segment(b!)).toBe(segment(a!));
  const shared = commonPrefix(request(a!), request(b!));
  report.push(`${skill}\t${shared}\t${Math.round(200 * shared / (request(a!).length + request(b!).length))}%`);
}

let store: CrosslineStore;
let ws: string;
const estimate = { p25Minutes: 60, p50Minutes: 120, p85Minutes: 240, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const };
const NOW = new Date("2026-10-15T15:00:00Z");
const fact = (identityId: string, projectId: string, slot: string, value: string) => store.upsertProfileFact({ workspaceId: ws, identityId, projectId, slot, value,
  status: "confirmed", sourceRef: "reply-1", sourceQuote: value, updatedAt: "2026-10-01T00:00:00.000Z" });

beforeEach(() => {
  store = new CrosslineStore(":memory:");
  ws = store.createPrincipalWithWorkspace("user-1", "个人 workspace").workspace.id;
  store.setSetting(ws, LINE_SETTING, JSON.stringify([
    { id: "research", label: "研究者", color: "research", goal: "", goals: ["成为能独立设计芯片的研究者"], createdAt: "" },
    { id: "media", label: "创作者", color: "media", goal: "", goals: ["成为有影响力的科普创作者"], createdAt: "" }]));
  store.saveProject({ id: "ece555", ownerId: "user-1", workspaceId: ws, identityId: "research", name: "ECE 555", status: "active", summary: "数字集成电路课程",
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" });
  fact("person", "", "background", "电子工程硕士一年级，熟悉 Verilog，不熟悉 Cadence");
  fact("person", "", "work_style", "上午精力最好，晚上只做轻的事");
  fact("research", "", "description", "芯片设计方向的课程与研究");
  fact("research", "ece555", "grading", "作业 30%，期中 30%，期末项目 40%");
  fact("research", "ece555", "target_grade", "A");
  for (const id of ["m1", "m2"]) store.saveMilestone({ id, ownerId: "user-1", workspaceId: ws, identityId: "research", projectId: "ece555",
    title: id === "m1" ? "ECE 555 期中拿到 85 分以上" : "ECE 555 期末项目提交", status: "approved", version: 1,
    successCriteria: [{ id: "c1", statement: "成绩单显示分数", required: true, evidenceOf: "output", measure: { kind: "artifact", mustExist: "成绩" } }] });
  for (const [id, intent] of [["wo1", "完成 ECE 555 作业 2：静态时序分析"], ["wo2", "复习 ECE 555 第 5–7 讲准备期中"]] as const)
    store.saveWorkOrder({ id, ownerId: "user-1", workspaceId: ws, identityId: "research", projectId: "ece555", milestoneId: "m1", intent,
      state: "preparing", riskTier: "milestone", estimate, payload: { family: "deep_work",
        materialContract: [{ id: `${id}-c`, description: "课程讲义", required: true }], evidenceContract: [{ kind: "record", description: "提交的作业", required: true }] } });
});
const onExit: Array<() => void> = [];
afterEach(() => { store.close(); for (const done of onExit.splice(0)) done(); });

test("the step planner: one workspace's archetypes, tools and person first; each task after; its feedback after the input", async () => {
  const { client, runs } = capturing(fakeRuntime(["{}"], "crossline:crossline-step-planner").rpc);
  const plan = createStepPlanner(store, ws, "C:\\repo", () => client);
  await plan("wo1");
  await plan("wo2", "把复习拆成每讲一步");
  expectShared("crossline:crossline-step-planner", runs, ["version", "archetypes", "aiTools", "person", "personalPreferences", "lessons", "projectDates", "milestone"]);
  // What only the second run was told is after its input, not in the instructions both share.
  expect(runs[1]!.parts.at(-1)).toMatch(/^Instructions for this run only.*\n Apply the feedback|^Instructions for this run only[^\n]*\nApply the feedback/s);
  expect(runs[1]!.developer).not.toContain("Apply the feedback");
});

test("the backplanner: the person and the project's work first; the milestone, its mode and the date after", async () => {
  const { client, runs } = capturing(fakeRuntime([JSON.stringify({ steps: [], dateCandidates: [], blockers: [] })], "crossline:crossline-goal-backplanner").rpc);
  const backplan = createGoalBackplanner(store, ws, "C:\\repo", () => client);
  await backplan("m1");
  await backplan("m2");
  expectShared("crossline:crossline-goal-backplanner", runs, ["version", "personProfile", "existingTasks", "recentlyDone", "facts", "materials", "milestone", "artifacts"], 6);
  expect(runs[0]!.developer).not.toContain("First mode");
  expect(runs[0]!.parts.at(-1)).toContain("First mode");
});

test("the tutorial's designer, researcher and writer: the person's and the line's first, the step and the date after", async () => {
  const healthy: CostSignal = { available: true, limitReached: false, short: { usedPercent: 10, windowDurationMins: 300, resetsAt: null }, long: { usedPercent: 10, windowDurationMins: 10080, resetsAt: null } };
  const design = (order: string, intent: string) => ({ overview: "先读讲义，再做。", edges: [{ from: "a", to: "b" }], assumptions: [], blockers: [], nodes: [
    { id: "a", title: `读讲义：${intent}`, kind: "read", goal: "读懂", steps: ["读第 5 讲"], acceptance: "能复述", serves: [`${order}-c`], needsResearch: true, researchQuestions: ["讲义", "教材"] },
    { id: "b", title: `动手：${intent}`, kind: "do", goal: "做完", steps: ["做题"], acceptance: "有答案", serves: [`${order}-evidence-0`], needsResearch: true, researchQuestions: ["示例", "方法"] }] });
  const respond = (prompt: string) => prompt.includes("crossline.manualbook.design.v1")
    ? JSON.stringify(prompt.includes("作业 2") ? design("wo1", "作业 2") : design("wo2", "期中"))
    : prompt.includes("crossline.manualbook.search.v1") ? JSON.stringify({ sources: [], gaps: ["没有找到"], blockers: [] })
    : JSON.stringify({ analysis: "按讲义做。", tutorial: "第一步……", citations: [], blockers: [] });
  const { client, runs } = capturing(scriptedRuntime([MANUAL_DESIGNER_SKILL, MATERIAL_RESEARCHER_SKILL, MATERIAL_WRITER_SKILL], respond).rpc);
  const dir = mkdtempSync(path.join(tmpdir(), "crossline-cache-"));
  onExit.push(() => rmSync(dir, { recursive: true, force: true }));
  const build = createManualbookBuilder(store, ws, dir, "C:\\repo", () => client, { readCost: async () => healthy, webBlocker: () => undefined, now: () => NOW,
    safeGet: { fetchImpl: (async () => { throw new Error("offline"); }) as typeof fetch, isPublicHost: async () => true } });
  await build("wo1").catch(() => undefined);
  await build("wo2").catch(() => undefined);
  expectShared(MANUAL_DESIGNER_SKILL, runs, ["version", "setting", "profile", "constraints", "person", "localFiles"]);
  expectShared(MATERIAL_RESEARCHER_SKILL, runs, ["version", "setting", "constraints", "localFiles", "task"]);
  // The task and its files are shared by every step of one tutorial (a fresh thread after a lost one), not by another task's.
  expectShared(MATERIAL_WRITER_SKILL, runs, ["version", "profile", "person", "aiTools", "task", "inputs", "sources"], 4);
});

test("the interview's extraction: the lines, projects and portrait first; the replies after", async () => {
  const round = JSON.stringify({ reply: "收到。", questions: [], coverage: [], nextAction: "ask", stage: "orientation" });
  const empty = JSON.stringify({ slotUpdates: [], projectsDetected: [], flywheelCandidates: [], lineProfiles: [], goalEdits: [],
    fileDates: { dates: [], recurring: [], questions: [], undated: [] }, availability: { windows: [], why: "" }, profile: null });
  const { client, runs } = capturing(fakeRuntime([round], [ONBOARDING_SKILL, ONBOARDING_EXTRACT_SKILL],
    { routes: [{ match: "crossline.onboarding.extract.v1", answers: [empty] }] }).rpc);
  const run = createOnboardingSessionRunner(store, ws, "C:\\repo", () => client, { extract: "await" });
  await run({ sessionId: "s", text: "我在读电子工程硕士，这学期修 ECE 555。" });
  await run({ sessionId: "s", text: "每周大概能投入 40 小时，周日休息。" });
  expectShared(ONBOARDING_EXTRACT_SKILL, runs, ["version", "timeZone", "lines", "domainGuides", "lineProfiles", "projects", "focusLine", "profile", "facts"]);
});

test("the capture analysis: the lines, the person, the milestones and the open tasks first; the capture after", async () => {
  const { client, runs } = capturing(fakeRuntime(["{}"], "crossline:crossline-automation-stripper").rpc);
  const context = (title: string) => ({ version: "crossline.analysis.v2", today: "2026-10-15", capture: { title, context: "" },
    approvedMilestones: [{ id: "m1", projectId: "ece555", identityId: "research", title: "ECE 555 期中拿到 85 分以上", version: 1, hasSuccessCriteria: true, deadline: "2026-11-01" }],
    availableInputs: [], identityPacks: [{ id: "research", version: 1, summary: "研究者" }, { id: "media", version: 1, summary: "创作者" }],
    personProfile: ["上午精力最好", "电子工程硕士一年级"], personalPreferences: ["作业先做最难的一题"], referenceClass: [], relations: [],
    existingTasks: [{ id: "wo1", title: "作业 2", intent: "完成 ECE 555 作业 2", lineId: "research", projectId: "ece555", dueDate: "2026-10-20", state: "approved" }],
    policy: { tools: [] as never[], externalSideEffects: false, humanApprovalRequired: true } });
  for (const title of ["周五前交 ECE 555 作业 3", "录一期讲静态时序的短视频"])
    await runCodexAnalysis(client, context(title), { skillName: "crossline:crossline-automation-stripper", cwd: "C:\\repo", onAudit: () => {} });
  expectShared("crossline:crossline-automation-stripper", runs, ["version", "policy", "identityPacks", "personProfile", "personalPreferences",
    "historicalStats", "rhythm", "approvedMilestones", "relations", "existingTasks"]);
});

test("mail sorting: the lines, open tasks and waits first; the mail after", async () => {
  store.setSetting(ws, MAIL_ACCOUNTS_SETTING, JSON.stringify([{ id: "a1", address: "me@qq.com", label: "QQ", host: "imap.qq.com", port: 993, triage: true, addedAt: "2026-10-01T00:00:00Z" }]));
  const { client, runs } = capturing(fakeRuntime([JSON.stringify({ items: [] })], MAIL_TRIAGE_SKILL).rpc);
  const mail = (uid: number, subject: string) => ({ accountId: "a1", uid, from: "Prof Lin", fromAddress: "lin@uni.edu", to: "me@qq.com", subject, date: "2026-10-15", snippet: subject });
  const deps = { store, secrets: { read: async () => undefined, write: async () => {}, remove: () => {} }, now: () => NOW, client, cwd: "C:\\repo" };
  await triageMail(deps, ws, [mail(1, "HW3 released")]);
  await triageMail(deps, ws, [mail(2, "Office hours moved")]);
  expectShared(MAIL_TRIAGE_SKILL, runs, ["lines", "openTasks", "waiting"]);
});

test("the line's own skill: the line and its material first; the date and, without the web, the note after", async () => {
  const owner = store.getWorkspaceOwnerId(ws)!;
  const review = (id: string, note: string) => {
    store.appendEvent({ ownerId: owner, workspaceId: ws, idempotencyKey: `req-${id}`, type: "agent.task.requested", entityId: id,
      payload: { taskId: id, title: "小红书笔记提纲", category: "read_research_organize", workOrderId: "wo1" } });
    store.appendEvent({ ownerId: owner, workspaceId: ws, idempotencyKey: `rev-${id}`, type: "agent.task.reviewed", entityId: id,
      payload: { taskId: id, decision: "accepted", note, category: "read_research_organize" } });
  };
  review("t1", "研究的笔记要先给结论，再给推导。");
  const { client, runs } = capturing(fakeRuntime(["{}"], INSIGHT_COMPILER).rpc);
  const compile = createInsightCompiler(store, ws, "C:\\repo", () => client, { now: () => NOW });
  await compile("research");
  await compile("research");
  expectShared(INSIGHT_COMPILER, runs, ["version", "line", "materials", "previousRules"]);
});

test("the milestone risk reviewer: the week's hours and the competing milestones first; the ones under review after", async () => {
  const anchor = (milestoneId: string, deadline: string) => store.saveMilestoneAnchor({ workspaceId: ws, milestoneId, stage: 1, deadline, baseline: "", target: "",
    stakeholders: [], sourceFactIds: [], dependsOn: [], updatedAt: NOW.toISOString() });
  anchor("m1", "2026-11-01");
  anchor("m2", "2026-12-10");
  const { client, runs } = capturing(fakeRuntime([JSON.stringify({ milestones: [{ milestoneId: "m1", risks: [] }, { milestoneId: "m2", risks: [] }] })], MILESTONE_RISK_REVIEWER).rpc);
  const reviewer = createMilestoneRiskReviewer(store, ws, "C:\\repo", () => client);
  await reviewer(NOW);
  store.saveMilestone({ id: "m3", ownerId: "user-1", workspaceId: ws, identityId: "research", projectId: "ece555", title: "ECE 555 作业全部按时提交", status: "draft", version: 1,
    successCriteria: [{ id: "c1", statement: "提交记录", required: true, evidenceOf: "output", measure: { kind: "artifact", mustExist: "记录" } }] });
  anchor("m3", "2026-12-01");
  await reviewer(NOW);
  // The competing milestones leave out those under review, so they differ when the milestones reviewed do.
  expectShared(MILESTONE_RISK_REVIEWER, runs, ["version", "weeklyHours", "others"], 2);
});
