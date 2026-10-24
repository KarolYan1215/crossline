import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore, addWorkflowFeedback, consentToGrownSkill, readGrownSkills, readGrownVersions, revertGrownSkill } from "@crossline/db";
import { LINE_SETTING } from "@crossline/identity-packs";
import { grownSkillFilesKey } from "@crossline/core";
import type { AgentOutcome, AgentTaskInput } from "./agent-task";
import { claimOrganising, collectionDone, configureFavouritesCollector, startWorkflowRun } from "./workflow-smith";
import { collectFolder, readCollectLedger, writeCollectLedger } from "./favourites-reader";
import { carryTopicFiles, installFavouritesTopicsWorkflow } from "./favourites-topics";
import { improvementDue, installRevision, workflowImprovePass } from "./workflow-improver";
import { scriptedRuntime } from "./testing/fake-runtime";

const REVIEWER = "crossline:crossline-validation-reviewer";
let store: CrosslineStore;
let ws: string;
let root: string;
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  ws = store.createPrincipalWithWorkspace("user-1", "个人 workspace").workspace.id;
  root = mkdtempSync(path.join(tmpdir(), "crossline-improve-"));
  store.setSetting(ws, LINE_SETTING, JSON.stringify([{ id: "media", label: "创作者", color: "media", goal: "", goals: [], createdAt: "" }]));
  store.setSetting(ws, "schedule.preferences", JSON.stringify({ timeZone: "UTC" }));
});
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

const said = () => store.listRecentNudges(ws, "2000-01-01T00:00:00Z").map((message) => (message.payload.card as { clarify: { question: string } }).clarify.question);
const done = (taskId: string, directory: string) => ({ state: "done", taskId, directory, summary: {}, artifacts: [], audit: {}, inputsModified: [], checksPassed: true, reviewRequired: false }) as unknown as AgentOutcome;
const reviewer = () => scriptedRuntime([REVIEWER], () => JSON.stringify({ verdict: "usable", reasons: ["只整理本机笔记"] }));
const favouritesFlow = () => { const record = installFavouritesTopicsWorkflow(store, ws, "media", new Date("2026-10-22T11:00:00Z")); consentToGrownSkill(store, ws, record.id); return readGrownSkills(store, ws)[0]!; };
const filesOf = (id: string) => (JSON.parse(store.getSetting(ws, grownSkillFilesKey(id)) ?? "{}") as { files: Array<{ path: string; text: string }> }).files;

test("a topic run writes only the topics it touched; the rest come over from the last result", () => {
  const last = path.join(root, "last"), now = path.join(root, "now");
  mkdirSync(last); mkdirSync(path.join(now, "out"), { recursive: true });
  for (const name of ["话题-咖啡.md", "话题-开头.md", "话题总览.md", "notes.txt"]) writeFileSync(path.join(last, name), `旧 ${name}`);
  writeFileSync(path.join(now, "out", "话题-咖啡.md"), "新 咖啡");
  expect(carryTopicFiles(last, now).sort()).toEqual(["话题-开头.md", "话题总览.md"]);
  expect(readFileSync(path.join(now, "out", "话题-咖啡.md"), "utf8")).toBe("新 咖啡");
  expect(readFileSync(path.join(now, "out", "话题-开头.md"), "utf8")).toBe("旧 话题-开头.md");
  expect(existsSync(path.join(now, "out", "notes.txt"))).toBe(false);
  expect(carryTopicFiles(undefined, now)).toEqual([]);
});

test("notes an organising run already has are not handed to a second one until it ends", () => {
  const first = claimOrganising(ws, "flow-x", ["a", "b"]);
  expect(first.ids).toEqual(["a", "b"]);
  expect(claimOrganising(ws, "flow-x", ["a", "b", "c"]).ids).toEqual(["c"]);
  first.release();
  expect(claimOrganising(ws, "flow-x", ["a", "b"]).ids).toEqual(["a", "b"]);
});

test("another favourites workflow works from the topic workflow's notes and never reads the site again", async () => {
  const topics = favouritesFlow();
  const folder = collectFolder(root, topics.id);
  mkdirSync(path.join(folder, "notes"), { recursive: true });
  writeCollectLedger(store, ws, topics.id, { read: { n1: { at: "2026-10-23T00:00:00Z", state: "read" } }, unorganised: [], listed: { n1: { title: "旧", xsecToken: "t", type: "normal" } } });
  const weekly = { ...topics, id: "flow-weekly-xhs", name: "weekly-xhs", manifest: { ...topics.manifest, name: "weekly-xhs", summary: "每周五整理小红书收藏夹" } };
  store.setSetting(ws, "skills.grown", JSON.stringify([...readGrownSkills(store, ws), weekly]));
  // What it had listed under its own ledger is merged into the reader's, so nothing is listed or read twice.
  writeCollectLedger(store, ws, weekly.id, { read: {}, unorganised: [], listed: { n2: { title: "新", xsecToken: "t2", type: "normal" } } });
  let opened = 0;
  configureFavouritesCollector({ outputRoot: root, open: async () => { opened += 1; throw new Error("no browser"); }, media: () => ({}), sleep: async () => {} });
  try {
    const runs: Array<AgentTaskInput & { taskId: string }> = [];
    const result = startWorkflowRun(store, ws, readGrownSkills(store, ws).find((item) => item.id === weekly.id)!, (input) => { runs.push(input); return { state: "started", taskId: input.taskId }; }, path.join(root, "p"));
    await collectionDone(ws, weekly.id);
    expect(result.state).toBe("started");
    expect(opened).toBe(0);
    expect(runs[0]!.inputs).toContain(folder);
    expect(runs[0]!.what).toContain("不访问小红书");
    expect(Object.keys(readCollectLedger(store, ws, topics.id).listed ?? {}).sort()).toEqual(["n1", "n2"]);
    expect(readCollectLedger(store, ws, weekly.id).listed).toBeUndefined();
  } finally { configureFavouritesCollector(undefined); }
});

test("what the person says about a workflow makes Crossline revise it, checked like a new one; the revision can be taken back", async () => {
  const record = favouritesFlow();
  expect(improvementDue(store, ws, record)).toBeUndefined();
  expect(addWorkflowFeedback(store, ws, record.id, "话题文件太长，每篇只留三行要点", new Date(Date.now() + 1_000))).toBe(true);
  const runs: Array<AgentTaskInput & { taskId: string }> = [];
  let after: ((outcome: AgentOutcome | { state: "failed"; message: string }) => void) | undefined;
  const started = workflowImprovePass(store, ws, (input, then) => { runs.push(input); after = then; return { state: "started", taskId: input.taskId }; },
    { client: () => reviewer().rpc, cwd: ".", workRoot: path.join(root, "work"), spend: () => true, now: new Date(Date.now() + 2_000) });
  expect(started).toBe(record.id);
  expect(runs[0]!.what).toContain("每篇只留三行要点");
  // The files in force are its read-only input.
  expect(readFileSync(path.join(runs[0]!.inputs![0]!, "skill", "SKILL.md"), "utf8")).toContain("小红书收藏按话题整理");
  // Installed by Crossline itself, it has no workflow.json among its files: the manifest goes in as one.
  expect(JSON.parse(readFileSync(path.join(runs[0]!.inputs![0]!, "skill", "workflow.json"), "utf8"))).toMatchObject({ name: "xiaohongshu-favourites-topics" });
  // One revision at a time: the next pass starts nothing while it runs.
  expect(workflowImprovePass(store, ws, () => ({ state: "started", taskId: "x" }), { client: () => undefined, cwd: ".", workRoot: path.join(root, "work"), spend: () => true })).toBeUndefined();
  const dir = path.join(root, "revised");
  mkdirSync(path.join(dir, "skill"), { recursive: true });
  writeFileSync(path.join(dir, "skill", "SKILL.md"), "---\nname: xiaohongshu-favourites-topics\ndescription: 按话题整理收藏\n---\n# 整理\n每篇三行要点。\n");
  writeFileSync(path.join(dir, "skill", "workflow.json"), JSON.stringify(record.manifest));
  writeFileSync(path.join(dir, "skill", "CHANGES.md"), "逐篇摘记从五行改为三行要点\n");
  const result = await installRevision(store, ws, record, done(runs[0]!.taskId, dir), { client: reviewer().rpc, cwd: "." });
  expect(result).toEqual({ state: "revised", version: 2 });
  after?.(done(runs[0]!.taskId, dir));
  const revised = readGrownSkills(store, ws)[0]!;
  expect(revised).toMatchObject({ version: 2, status: "active" });
  expect(filesOf(record.id).find((file) => file.path === "SKILL.md")!.text).toContain("每篇三行要点");
  expect(filesOf(record.id).some((file) => file.path === "CHANGES.md")).toBe(false);
  expect(said().at(-1)).toContain("第 2 版");
  // Answered: no revision is due until something new comes.
  expect(improvementDue(store, ws, revised)).toBeUndefined();
  expect(revertGrownSkill(store, ws, record.id)).toBe(1);
  expect(readGrownSkills(store, ws)[0]).toMatchObject({ version: 1 });
  expect(filesOf(record.id).find((file) => file.path === "SKILL.md")!.text).toContain("小红书收藏按话题整理");
  expect(readGrownVersions(store, ws, record.id)).toEqual([]);
});

test("a revision that reads a new site waits for the person's consent again; one that needs no change says why", async () => {
  const record = favouritesFlow();
  const dir = path.join(root, "wider");
  mkdirSync(path.join(dir, "skill"), { recursive: true });
  writeFileSync(path.join(dir, "skill", "SKILL.md"), "---\nname: xiaohongshu-favourites-topics\ndescription: 按话题整理收藏\n---\n# 整理\n");
  writeFileSync(path.join(dir, "skill", "workflow.json"), JSON.stringify({ ...record.manifest,
    access: [...record.manifest.access, { service: "抖音", site: "https://www.douyin.com", login: true, how: "读收藏" }] }));
  expect(await installRevision(store, ws, record, done("improve-a", dir), { client: reviewer().rpc, cwd: "." })).toMatchObject({ state: "revised" });
  expect(readGrownSkills(store, ws)[0]).toMatchObject({ status: "needs_consent" });
  const none = path.join(root, "none");
  mkdirSync(none);
  writeFileSync(path.join(none, "NO_CHANGE.md"), "这是 Crossline 读取程序的问题，工作流本身不用改。");
  expect(await installRevision(store, ws, readGrownSkills(store, ws)[0]!, done("improve-b", none), { client: reviewer().rpc, cwd: "." })).toMatchObject({ state: "unchanged" });
  expect(said().at(-1)).toContain("这次没有改它");
});

test("two workflows that do the same job are merged, judged by what they do and not their names, and the merge can be undone", async () => {
  const { unmergeGrownSkill } = await import("@crossline/db");
  const { workflowMergePass, WORKFLOW_MERGE_REQUESTED } = await import("./workflow-merge");
  const topics = favouritesFlow();
  // A weekly favourites workflow with other words and a schedule, and a course workflow with nothing in common.
  const weekly = { ...topics, id: "flow-weekly-xhs", name: "weekly-xhs", pinned: false, createdAt: "2026-10-01T00:00:00Z",
    manifest: { ...topics.manifest, name: "weekly-xhs", summary: "每周五 09:00 只读整理收藏，追踪重点作者并给出内容候选", trigger: "schedule" as const,
      schedule: { type: "weekly" as const, days: ["FR" as const], time: "09:00" } } };
  const course = { ...topics, id: "flow-course", name: "course", access: [], manifest: { ...topics.manifest, name: "course", summary: "按请求整理课程讲义目录", access: [], risks: [],
    steps: [{ title: "建立讲义台账", by: "assistant" as const, external: false }], outputs: ["目录.md"] }, description: "课程材料" };
  store.setSetting(ws, "skills.grown", JSON.stringify([...readGrownSkills(store, ws), weekly, course]));
  writeCollectLedger(store, ws, weekly.id, { read: {}, unorganised: [], listed: { w1: { title: "旧", xsecToken: "t", type: "normal" } } });
  store.setSetting(ws, grownSkillFilesKey(weekly.id), JSON.stringify({ files: [{ path: "SKILL.md", text: "# 每周追踪重点作者" }] }));
  const asked: string[] = [];
  const { rpc } = scriptedRuntime([REVIEWER], (prompt) => { asked.push(prompt); return JSON.stringify({ pairs: [{ id: "p1", same: true, why: "都读小红书收藏并整理，内容候选可并进话题整理" }] }); });
  store.setSetting(ws, WORKFLOW_MERGE_REQUESTED, "x");
  const merged = await workflowMergePass(store, ws, rpc, ".", "2026-10-24");
  // Only the pair sharing the logged-in site was asked about; the course workflow was never paired.
  expect(asked.join("\n")).not.toContain("按请求整理课程讲义目录");
  // The topic workflow reads the favourites, so it is the one kept.
  expect(merged).toEqual([{ keep: topics.id, absorbed: weekly.id }]);
  const after = readGrownSkills(store, ws);
  expect(after.find((item) => item.id === weekly.id)).toMatchObject({ status: "off", mergedInto: { id: topics.id, status: "active" } });
  expect(Object.keys(readCollectLedger(store, ws, topics.id).listed ?? {})).toContain("w1");
  expect(said().at(-1)).toContain("已合并");
  // The kept one's next revision is told to take over the absorbed one's ways, with its files beside.
  const runs: Array<AgentTaskInput & { taskId: string }> = [];
  workflowImprovePass(store, ws, (input) => { runs.push(input); return { state: "started", taskId: input.taskId }; },
    { client: () => undefined, cwd: ".", workRoot: path.join(root, "work"), spend: () => true });
  expect(runs[0]!.what).toContain("合并工作流「每周五 09:00");
  expect(readFileSync(path.join(runs[0]!.inputs![0]!, "absorbed", weekly.id, "SKILL.md"), "utf8")).toContain("每周追踪重点作者");
  // Asked once per version: the next daily pass asks nothing.
  asked.length = 0;
  await workflowMergePass(store, ws, rpc, ".", "2026-10-25");
  expect(asked).toEqual([]);
  expect(unmergeGrownSkill(store, ws, weekly.id)).toBe(true);
  expect(readGrownSkills(store, ws).find((item) => item.id === weekly.id)).toMatchObject({ status: "active" });
  expect(readGrownSkills(store, ws).find((item) => item.id === weekly.id)!.mergedInto).toBeUndefined();
});
