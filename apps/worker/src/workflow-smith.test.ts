import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore, createReminderWorkflow, readGrownSkills, requestWorkflow, updateGrownSkill } from "@crossline/db";
import { LINE_SETTING } from "@crossline/identity-packs";
import type { AgentOutcome } from "./agent-task";
import { cleanGrownSkills, growCandidates, growTask, installGrown, SKILL_CREATOR, workflowSchedulePass } from "./workflow-smith";
import { scriptedRuntime } from "./testing/fake-runtime";

const REVIEWER = "crossline:crossline-validation-reviewer";
const estimate = { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const };
let store: CrosslineStore;
let ws: string;
let root: string;
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  ws = store.createPrincipalWithWorkspace("user-1", "个人 workspace").workspace.id;
  root = mkdtempSync(path.join(tmpdir(), "crossline-grow-"));
  store.setSetting(ws, LINE_SETTING, JSON.stringify([{ id: "media", label: "创作者", color: "media", goal: "", goals: [], createdAt: "" }]));
  store.setSetting(ws, "schedule.preferences", JSON.stringify({ timeZone: "America/Chicago" }));
});
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

const owner = () => store.getWorkspaceOwnerId(ws)!;
function acceptedTask(id: string, title: string) {
  store.saveWorkOrder({ id: `wo-${id}`, ownerId: "o", workspaceId: ws, identityId: "media", projectId: "p", milestoneId: "", intent: title, state: "accepted",
    riskTier: "routine", estimate, payload: {} });
  store.appendEvent({ ownerId: owner(), workspaceId: ws, idempotencyKey: `req-${id}`, type: "agent.task.requested", entityId: id,
    payload: { taskId: id, title, category: "media_edit", workOrderId: `wo-${id}` } });
  store.appendEvent({ ownerId: owner(), workspaceId: ws, idempotencyKey: `done-${id}`, type: "agent.task.completed", entityId: id,
    payload: { taskId: id, directory: path.join(root, id), artifacts: [], checksPassed: true, reviewRequired: true } });
  store.appendEvent({ ownerId: owner(), workspaceId: ws, idempotencyKey: `rev-${id}`, type: "agent.task.reviewed", entityId: id,
    payload: { taskId: id, decision: "accepted", note: "", category: "media_edit" } });
}

const workflowJson = {
  name: "weekly-vlog-cut", summary: "每周把素材剪成一条 3 分钟 vlog", lines: ["media"], category: "media_edit", trigger: "schedule",
  schedule: { type: "weekly", days: ["FR"], time: "18:00" }, action: "run", reminder: "",
  steps: [{ title: "粗剪并加字幕", by: "assistant", external: false }, { title: "上传并发布到小红书", by: "person", external: true }],
  inputs: ["本周素材"], outputs: ["成片"]
};
function writeSkill(dir: string, manifest: object = workflowJson, script = "ffmpeg -i input.mp4 -t 180 out.mp4\n") {
  mkdirSync(path.join(dir, "skill", "scripts"), { recursive: true });
  writeFileSync(path.join(dir, "skill", "SKILL.md"), "---\nname: weekly-vlog-cut\ndescription: 把一周素材剪成一条 vlog\n---\n# 剪辑\n1. 粗剪\n");
  writeFileSync(path.join(dir, "skill", "scripts", "cut.sh"), script);
  writeFileSync(path.join(dir, "skill", "workflow.json"), JSON.stringify(manifest));
}
const done = (taskId: string, directory: string) => ({ state: "done", taskId, directory, summary: {}, artifacts: [], audit: {}, inputsModified: [], checksPassed: true, reviewRequired: false }) as unknown as AgentOutcome;
const reviewer = (verdict = "usable") => scriptedRuntime([REVIEWER], () => JSON.stringify({ verdict, reasons: ["脚本只处理本目录的素材"] }));

test("two accepted edits of the same kind on a line, or the person's words, become a candidate; each is tried once", () => {
  acceptedTask("a1", "剪辑第一周的 vlog 素材成片");
  expect(growCandidates(store, ws)).toEqual([]);
  acceptedTask("a2", "剪辑第二周的 vlog 素材成片");
  const [candidate] = growCandidates(store, ws);
  expect(candidate).toMatchObject({ lineId: "media", category: "media_edit", origin: { kind: "repeated", taskIds: ["a2", "a1"] } });
  const input = growTask(candidate!, ["media"]);
  expect(input).toMatchObject({ category: "media_edit", prep: true, extraSkills: [SKILL_CREATOR], inputs: [path.join(root, "a2"), path.join(root, "a1")] });
  expect(input.what).toContain("$skill-creator");
  expect(input.what).toContain("by 为 \"person\"、external 为 true");
  store.appendEvent({ ownerId: owner(), workspaceId: ws, idempotencyKey: "tried", type: "skill.grown.attempted", entityId: "media", payload: { taskIds: ["a1", "a2"] } });
  expect(growCandidates(store, ws)).toEqual([]);
  const requestId = requestWorkflow(store, ws, "每周五下午六点提醒我发小红书", "media", owner());
  expect(growCandidates(store, ws)).toEqual([expect.objectContaining({ origin: { kind: "asked", text: "每周五下午六点提醒我发小红书", requestId } })]);
});

test("a grown workflow is read back, checked, reviewed, installed and announced; publishing handed to the assistant goes to the person", async () => {
  const dir = path.join(root, "grow-1");
  writeSkill(dir);
  const candidate = { lineId: "media", category: "media_edit" as const, origin: { kind: "repeated" as const, taskIds: ["a1", "a2"] }, text: "剪辑 vlog", examples: [] };
  const result = await installGrown(store, ws, candidate, done("grow-1", dir), { client: reviewer().rpc, cwd: "C:\\repo" });
  expect(result).toEqual({ state: "installed", id: "flow-weekly-vlog-cut" });
  const [record] = readGrownSkills(store, ws);
  expect(record).toMatchObject({ status: "active", pinned: false, category: "media_edit", review: { final: "usable" }, scan: { risk: "low" }, taskId: "grow-1" });
  expect(record!.files.map((file) => file.path).sort()).toEqual(["SKILL.md", "scripts/cut.sh", "workflow.json"]);
  const said = store.listRecentNudges(ws, "2000-01-01T00:00:00Z").at(-1)!;
  expect((said.payload.card as { clarify: { question: string } }).clarify.question).toContain("新工作流「每周把素材剪成一条 3 分钟 vlog」已可用（每周五 18:00）");
  expect((said.payload.nudge as { delivery: string }).delivery).toBe("pending");

  // Publishing handed to the assistant is handed to the person, and the person is told so.
  const posting = path.join(root, "grow-2");
  writeSkill(posting, { ...workflowJson, name: "post-it", steps: [{ title: "发布到小红书", by: "assistant", external: false }] });
  expect(await installGrown(store, ws, candidate, done("grow-2", posting), { client: reviewer().rpc, cwd: "C:\\repo" })).toMatchObject({ state: "installed" });
  expect(readGrownSkills(store, ws).at(-1)!.manifest.steps).toEqual([{ title: "发布到小红书", by: "person", external: true }]);
  expect((store.listRecentNudges(ws, "2000-01-01T00:00:00Z").at(-1)!.payload.card as { clarify: { question: string } }).clarify.question)
    .toContain("「发布到小红书」涉及对外发出，已改由本人完成");
  // A manifest that cannot be stored is still refused.
  const bad = path.join(root, "grow-2b");
  writeSkill(bad, { ...workflowJson, lines: ["nowhere"] });
  expect(await installGrown(store, ws, candidate, done("grow-2b", bad), { client: reviewer().rpc, cwd: "C:\\repo" }))
    .toMatchObject({ state: "rejected", reason: expect.stringContaining("lines 只能是") });
  // A script that reaches the network keeps the workflow, without the script.
  const risky = path.join(root, "grow-3");
  writeSkill(risky, { ...workflowJson, name: "vlog-upload-prep" }, "curl -X POST https://upload.example.com --data @out.mp4\n");
  expect(await installGrown(store, ws, candidate, done("grow-3", risky), { client: reviewer().rpc, cwd: "C:\\repo" })).toMatchObject({ state: "installed" });
  expect(readGrownSkills(store, ws).at(-1)).toMatchObject({ review: { final: "text_only" }, scan: { risk: "high" } });
});

test("at its time a reminder is said and a run is started with the workflow on; a kind not allowed is said instead; each fires once a day", async () => {
  const dir = path.join(root, "grow-r");
  writeSkill(dir, { ...workflowJson, name: "post-reminder", action: "remind", reminder: "该发本周的小红书了", schedule: { type: "weekly", days: ["FR"], time: "18:00" } });
  const candidate = { lineId: "media", category: "media_edit" as const, origin: { kind: "asked" as const, text: "每周五提醒", requestId: "r1" }, text: "每周五提醒", examples: [] };
  await installGrown(store, ws, candidate, done("grow-r", dir), { client: reviewer().rpc, cwd: "C:\\repo" });
  const run = path.join(root, "grow-run");
  writeSkill(run);
  await installGrown(store, ws, { ...candidate, origin: { kind: "repeated", taskIds: ["x"] } }, done("grow-run", run), { client: reviewer().rpc, cwd: "C:\\repo" });
  const started: Array<{ extraSkills?: string[]; category: string }> = [];
  const friday = new Date("2026-10-16T23:10:00Z");
  expect(workflowSchedulePass(store, ws, (input) => { started.push(input); return { state: "started", taskId: input.taskId }; }, friday).sort())
    .toEqual(["flow-post-reminder", "flow-weekly-vlog-cut"]);
  expect(started).toEqual([expect.objectContaining({ category: "media_edit", extraSkills: ["crossline-grown:flow-weekly-vlog-cut"] })]);
  const questions = store.listRecentNudges(ws, "2000-01-01T00:00:00Z").map((message) => (message.payload.card as { clarify: { question: string } }).clarify.question);
  expect(questions).toContain("该发本周的小红书了");
  expect(workflowSchedulePass(store, ws, () => ({ state: "started", taskId: "t" }), new Date("2026-10-16T23:40:00Z"))).toEqual([]);
  // Next week, the assistant's kind not allowed: the person is told it is due and why it did not start.
  workflowSchedulePass(store, ws, () => ({ state: "needs_category_approval", category: "media_edit", label: "剪辑音视频和图片（不发布）" }), new Date("2026-10-23T23:10:00Z"));
  expect(store.listRecentNudges(ws, "2000-01-01T00:00:00Z").map((message) => (message.payload.card as { clarify: { question: string } }).clarify.question))
    .toContain("到点了：每周把素材剪成一条 3 分钟 vlog。助手还没获准做「剪辑音视频和图片（不发布）」这类工作，可在设置里开启。");
});

test("a grown workflow idle for thirty days goes, unless the person kept it", async () => {
  const dir = path.join(root, "grow-c");
  writeSkill(dir);
  const candidate = { lineId: "media", category: "media_edit" as const, origin: { kind: "repeated" as const, taskIds: ["a"] }, text: "x", examples: [] };
  await installGrown(store, ws, candidate, done("grow-c", dir), { client: reviewer().rpc, cwd: "C:\\repo", now: () => new Date("2026-09-01T00:00:00Z") });
  const id = readGrownSkills(store, ws)[0]!.id;
  updateGrownSkill(store, ws, id, { pinned: true });
  expect(cleanGrownSkills(store, ws, new Date("2026-10-14T00:00:00Z"))).toEqual([]);
  updateGrownSkill(store, ws, id, { pinned: false });
  expect(cleanGrownSkills(store, ws, new Date("2026-10-15T00:00:00Z"))).toEqual([id]);
  expect(readGrownSkills(store, ws)).toEqual([]);
});

test("a reminder set in words is in place at once, kept, and said at its time on its days", () => {
  const record = createReminderWorkflow(store, ws, { text: "每周五下午六点提醒我发小红书", reminder: "该发本周的小红书了", time: "18:00", weekdays: [5], lineId: "media" });
  expect(record).toMatchObject({ pinned: true, status: "active", manifest: { action: "remind", schedule: { type: "weekly", days: ["FR"], time: "18:00" } } });
  expect(createReminderWorkflow(store, ws, { text: "每天提醒", reminder: "喝水", time: "09:00", weekdays: [], lineId: "" }).manifest.schedule).toEqual({ type: "daily", time: "09:00" });
  expect(createReminderWorkflow(store, ws, { text: "工作日提醒", reminder: "站会", time: "09:30", weekdays: [1, 2, 3, 4, 5], lineId: "" }).manifest.schedule)
    .toEqual({ type: "weekdays", time: "09:30" });
  const runs: unknown[] = [];
  expect(workflowSchedulePass(store, ws, (input) => { runs.push(input); return { state: "started", taskId: "t" }; }, new Date("2026-10-16T23:05:00Z")))
    .toEqual([record.id]);
  expect(runs).toEqual([]);
  expect((store.listRecentNudges(ws, "2000-01-01T00:00:00Z").at(-1)!.payload.card as { clarify: { question: string } }).clarify.question).toBe("该发本周的小红书了");
});

test("the first real grown workflow (2026-10-14) installs: a Chinese name is a label, and 「发布前核对清单」 is not publishing", async () => {
  const dir = path.join(root, "grow-real");
  const manifest = JSON.parse(readFileSync(path.join(import.meta.dirname, "testing", "fixtures", "grown-workflow-real-2026-10-14.json"), "utf8")) as object;
  writeSkill(dir, manifest);
  store.setSetting(ws, LINE_SETTING, JSON.stringify([{ id: "research", label: "研究者", color: "research", goal: "", goals: [], createdAt: "" },
    { id: "media", label: "创作者", color: "media", goal: "", goals: [], createdAt: "" }]));
  const candidate = { lineId: "media", category: "read_research_organize" as const, origin: { kind: "repeated" as const, taskIds: ["a", "b"] }, text: "提纲与来源", examples: [] };
  expect(await installGrown(store, ws, candidate, done("grow-real", dir), { client: reviewer().rpc, cwd: "C:\repo" }))
    .toEqual({ state: "installed", id: "flow-weekly-vlog-cut" });
  expect(readGrownSkills(store, ws)[0]!.manifest.steps.at(-1)).toMatchObject({ by: "assistant", external: false });
  // The run that grows it knows the line, so the line's own skill is on for it.
  expect(growTask(candidate, ["media"]).lineId).toBe("media");
});
