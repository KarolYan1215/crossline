import { afterEach, beforeEach, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { AUTOMATIONS_SETTING, GROWN_LIBRARY_SETTING, grownSkillFilesKey, grownVersionsKey, readAutomations, type Automation, type GrownSkillRecord, type WorkflowManifest } from "@crossline/core";
import { CrosslineStore } from "./index";
import { restoreAutomationVersion } from "./automations";
import { readGrownSkills, readGrownVersions, restoreGrownVersion, reviseGrownSkill } from "./skills";

let store: CrosslineStore;
let ws: string;
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  ws = store.createPrincipalWithWorkspace("user-1", "个人 workspace").workspace.id;
});
afterEach(() => store.close());

const automation = (id: string, extra: Partial<Automation> = {}): Automation => ({ id, name: "整理邮件", summary: "每天整理课程邮件", lineId: "research", status: "active",
  trigger: { type: "schedule", schedule: { type: "daily", time: "08:00" } }, action: { kind: "run", instructions: "读新邮件，整理成清单写进 list.md", category: "read_research_organize", outputs: ["list.md"] },
  steps: [{ title: "整理", by: "assistant" }], origin: { kind: "asked", text: "每天整理邮件", requestId: "areq-1" }, createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z", runs: 0, ...extra });
const manifest = (summary: string): WorkflowManifest => ({ name: "notes", summary, lines: ["media"], category: "read_research_organize", trigger: "on_request", schedule: null,
  action: "run", reminder: "", steps: [{ title: "整理", by: "assistant", external: false }], inputs: [], outputs: [], access: [], risks: [] });
const grown = (status: GrownSkillRecord["status"] = "active"): GrownSkillRecord => ({ id: "flow-notes", kind: "grown", name: "notes", description: "", lines: ["media"],
  category: "read_research_organize", manifest: manifest("v1"), origin: { kind: "asked", text: "", requestId: "r" }, taskId: "", files: [],
  scan: { risk: "low", injection: false, findings: [] }, review: { verdict: "usable", reasons: [], final: "usable" }, status, pinned: false,
  createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", lastUsedAt: "2026-11-01T00:00:00Z" });

test("migration 27 moves the workflow settings into their tables whole, and the old keys still read the same", () => {
  const path = `crossline-test-${randomUUID()}.db`;
  try {
    const first = new CrosslineStore(path);
    const workspace = first.createPrincipalWithWorkspace("user-1", "w").workspace.id;
    first.close();
    // The ledger as it was before migration 27: the workflows in settings rows.
    const legacy = new Database(path);
    const put = legacy.prepare("INSERT OR REPLACE INTO settings (workspace_id, key, value, updated_at) VALUES (?, ?, ?, '2026-11-01T00:00:00Z')");
    const automations = [automation("auto-a"), automation("auto-b", { name: "看网页", status: "off" })];
    put.run(workspace, AUTOMATIONS_SETTING, JSON.stringify(automations));
    put.run(workspace, GROWN_LIBRARY_SETTING, JSON.stringify([grown()]));
    put.run(workspace, grownSkillFilesKey("flow-notes"), JSON.stringify({ files: [{ path: "SKILL.md", text: "# v2" }] }));
    put.run(workspace, grownVersionsKey("flow-notes"), JSON.stringify([{ version: 1, at: "2026-11-01T00:00:00Z", replacedBecause: "改了", manifest: manifest("v1"), files: [] }]));
    put.run(workspace, "skills.grown.mergeRequested", "2026-11-02");
    put.run(workspace, "automations.runs", "[]");
    legacy.exec("DELETE FROM workflows; DELETE FROM workflow_files; DELETE FROM workflow_versions;");
    legacy.pragma("user_version = 23");
    legacy.close();

    const reopened = new CrosslineStore(path);
    try {
      expect(readAutomations(reopened.getSetting(workspace, AUTOMATIONS_SETTING))).toEqual(automations);
      expect(readGrownSkills(reopened, workspace)).toEqual([grown()]);
      expect(JSON.parse(reopened.getSetting(workspace, grownSkillFilesKey("flow-notes"))!)).toEqual({ files: [{ path: "SKILL.md", text: "# v2" }] });
      expect(readGrownVersions(reopened, workspace, "flow-notes")).toHaveLength(1);
      // Each automation starts with its definition as version 1; the keys the tables do not hold stay settings.
      expect(reopened.listWorkflowVersions(workspace, "automation", "auto-a")).toMatchObject([{ version: 1, source: "import" }]);
      expect(reopened.getSetting(workspace, "skills.grown.mergeRequested")).toBe("2026-11-02");
      expect(reopened.getSetting(workspace, "automations.runs")).toBe("[]");
      const raw = reopened.exportSnapshot(workspace).tables;
      expect((raw.settings ?? []).map((row) => row.key)).not.toContain(AUTOMATIONS_SETTING);
      expect(raw.workflows).toHaveLength(3);
    } finally { reopened.close(); }
  } finally {
    for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}.v23.bak`]) if (existsSync(file)) rmSync(file);
  }
});

test("a backup taken before the tables existed restores into them", () => {
  const snapshot = store.exportSnapshot(ws);
  const tables = { ...snapshot.tables, settings: [{ workspace_id: "w-new", key: AUTOMATIONS_SETTING, value: JSON.stringify([automation("auto-a")]), updated_at: "2026-11-01T00:00:00Z" }] };
  const target = new CrosslineStore(":memory:");
  try {
    target.importSnapshot({ ...snapshot, workspaceId: "w-new", tables: { settings: tables.settings } });
    expect(readAutomations(target.getSetting("w-new", AUTOMATIONS_SETTING)).map((item) => item.id)).toEqual(["auto-a"]);
  } finally { target.close(); }
});

test("a change to what an automation does is a new version; its runs, its pause and an unchanged write are not", () => {
  const write = (list: Automation[]) => store.setSetting(ws, AUTOMATIONS_SETTING, JSON.stringify(list));
  write([automation("auto-a")]);
  write([automation("auto-a", { runs: 3, lastFiredAt: "2026-11-02T00:00:00Z", status: "off" })]);
  expect(store.listWorkflowVersions(ws, "automation", "auto-a")).toHaveLength(1);
  write([automation("auto-a", { trigger: { type: "interval", hours: 6 } })]);
  expect(store.listWorkflowVersions(ws, "automation", "auto-a").map((item) => [item.version, item.source])).toEqual([[1, "created"], [2, "change"]]);
  expect(store.annotateWorkflowVersion(ws, "automation", "auto-a", { source: "thread", note: "改成每 6 小时", turnId: "turn-1" })).toBe(2);
  expect(store.listWorkflowVersions(ws, "automation", "auto-a")[1]).toMatchObject({ source: "thread", note: "改成每 6 小时", turnId: "turn-1" });
  // Removed from the list: its row and versions go with it.
  write([]);
  expect(store.getSetting(ws, AUTOMATIONS_SETTING)).toBeUndefined();
  expect(store.listWorkflowVersions(ws, "automation", "auto-a")).toEqual([]);
});

test("rolling an automation back to any version makes a new version and keeps its runs", () => {
  const write = (list: Automation[]) => store.setSetting(ws, AUTOMATIONS_SETTING, JSON.stringify(list));
  write([automation("auto-a")]);
  write([automation("auto-a", { trigger: { type: "interval", hours: 6 } })]);
  write([automation("auto-a", { trigger: { type: "interval", hours: 12 }, name: "整理邮件 2", runs: 4 })]);
  expect(restoreAutomationVersion(store, ws, "auto-a", 1, new Date("2026-11-05T00:00:00Z"))).toBe(4);
  const now = readAutomations(store.getSetting(ws, AUTOMATIONS_SETTING))[0]!;
  expect(now).toMatchObject({ name: "整理邮件", trigger: { type: "schedule" }, runs: 4 });
  expect(store.listWorkflowVersions(ws, "automation", "auto-a").at(-1)).toMatchObject({ version: 4, source: "rollback" });
  // The version in force, or one that does not exist, is not a rollback.
  expect(restoreAutomationVersion(store, ws, "auto-a", 4)).toBeUndefined();
  expect(restoreAutomationVersion(store, ws, "auto-a", 9)).toBeUndefined();
});

test("rolling a grown workflow back to any version keeps the one in force and goes through the consent check", () => {
  store.setSetting(ws, GROWN_LIBRARY_SETTING, JSON.stringify([grown()]));
  store.setSetting(ws, grownSkillFilesKey("flow-notes"), JSON.stringify({ files: [{ path: "SKILL.md", text: "v1" }] }));
  const revise = (summary: string, at: string, extra: Partial<WorkflowManifest> = {}) => reviseGrownSkill(store, ws, "flow-notes", { manifest: { ...manifest(summary), ...extra },
    files: [{ path: "SKILL.md", text: summary }], scan: { risk: "low", injection: false, findings: [] }, review: { verdict: "usable", reasons: [], final: "usable" },
    changes: summary, taskId: "t" }, new Date(at));
  revise("v2", "2026-11-02T00:00:00Z");
  revise("v3", "2026-11-03T00:00:00Z");
  expect(restoreGrownVersion(store, ws, "flow-notes", 1, new Date("2026-11-04T00:00:00Z"))).toEqual({ version: 4, needsConsent: false });
  const record = readGrownSkills(store, ws)[0]!;
  expect(record).toMatchObject({ version: 4, status: "active", manifest: { summary: "v1" } });
  expect(JSON.parse(store.getSetting(ws, grownSkillFilesKey("flow-notes"))!).files[0].text).toBe("v1");
  expect(readGrownVersions(store, ws, "flow-notes").map((item) => item.version)).toEqual([1, 2, 3]);
  // A version that read a site the person never agreed to waits for them again.
  revise("v5", "2026-11-05T00:00:00Z", { access: [{ service: "小红书", site: "https://www.xiaohongshu.com", login: true, how: "读收藏" }], risks: ["可能被限流"] });
  store.setSetting(ws, GROWN_LIBRARY_SETTING, JSON.stringify(readGrownSkills(store, ws).map((item) => ({ ...item, status: "active" }))));
  restoreGrownVersion(store, ws, "flow-notes", 1, new Date("2026-11-06T00:00:00Z"));
  expect(restoreGrownVersion(store, ws, "flow-notes", 5, new Date("2026-11-07T00:00:00Z"))).toMatchObject({ needsConsent: true });
  expect(readGrownSkills(store, ws)[0]!.status).toBe("needs_consent");
});

test("a workflow's conversation keeps its turns in order and rewrites a streaming one in place", () => {
  const at = "2026-11-10T00:00:00.000Z";
  store.saveWorkflowThread({ workspaceId: ws, id: "areq-1", workflowId: "", kind: "automation", codexThreadId: "", lineId: "research", title: "每天整理邮件", createdAt: at, updatedAt: at });
  store.saveWorkflowTurn({ workspaceId: ws, id: "t1", threadId: "areq-1", role: "person", text: "每天整理邮件", items: [], state: "done", createdAt: at });
  store.saveWorkflowTurn({ workspaceId: ws, id: "t2", threadId: "areq-1", role: "assistant", text: "正在", items: [], state: "running", createdAt: at });
  store.saveWorkflowTurn({ workspaceId: ws, id: "t2", threadId: "areq-1", role: "assistant", text: "已建好", items: [{ type: "version", version: 1, note: "" }], state: "done", createdAt: at });
  expect(store.listWorkflowTurns(ws, "areq-1").map((turn) => [turn.ord, turn.id, turn.text, turn.state])).toEqual([[1, "t1", "每天整理邮件", "done"], [2, "t2", "已建好", "done"]]);
  store.saveWorkflowThread({ ...store.getWorkflowThread(ws, "areq-1")!, workflowId: "auto-a" });
  expect(store.findWorkflowThread(ws, "auto-a")?.id).toBe("areq-1");
});
