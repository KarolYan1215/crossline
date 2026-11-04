import { afterEach, beforeEach, expect, test } from "vitest";
import { GROWN_LIBRARY_SETTING, grownSkillFilesKey, type GrownSkillRecord, type WorkflowManifest } from "@crossline/core";
import { CrosslineStore } from "./index";
import { consentToGrownSkill, readGrownSkills, readGrownVersions, revertGrownSkill, reviseGrownSkill } from "./skills";

let store: CrosslineStore;
let ws: string;
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  ws = store.createPrincipalWithWorkspace("user-1", "个人 workspace").workspace.id;
});
afterEach(() => store.close());

const manifest = (extra: Partial<WorkflowManifest> = {}): WorkflowManifest => ({ name: "notes", summary: "整理笔记", lines: ["media"], category: "read_research_organize",
  trigger: "on_request", schedule: null, action: "run", reminder: "", steps: [{ title: "整理", by: "assistant", external: false }], inputs: [], outputs: [],
  access: [], risks: [], ...extra });
const install = (status: GrownSkillRecord["status"], m = manifest()) => {
  const record: GrownSkillRecord = { id: "flow-notes", kind: "grown", name: "notes", description: "", lines: ["media"], category: "read_research_organize", manifest: m,
    origin: { kind: "asked", text: "", requestId: "r" }, taskId: "", files: [], scan: { risk: "low", injection: false, findings: [] },
    review: { verdict: "usable", reasons: [], final: "usable" }, status, pinned: false, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", lastUsedAt: "2026-11-01T00:00:00Z" };
  store.setSetting(ws, GROWN_LIBRARY_SETTING, JSON.stringify([record]));
  store.setSetting(ws, grownSkillFilesKey(record.id), JSON.stringify({ files: [] }));
};
const revise = (m: WorkflowManifest, at: string) => reviseGrownSkill(store, ws, "flow-notes",
  { manifest: m, files: [{ path: "SKILL.md", text: at }], scan: { risk: "low", injection: false, findings: [] }, review: { verdict: "usable", reasons: [], final: "usable" }, changes: "改", taskId: "t" },
  new Date(at));
const current = () => readGrownSkills(store, ws)[0]!;

test("a revision adding a risk or a step leaving the machine to a workflow that reads nothing waits for consent", () => {
  install("active");
  expect(revise(manifest({ risks: ["可能被平台限流"] }), "2026-11-02T00:00:00Z")).toMatchObject({ needsConsent: true });
  expect(current().status).toBe("needs_consent");
  install("active");
  expect(revise(manifest({ steps: [{ title: "发出邮件", by: "person", external: true }] }), "2026-11-02T00:00:00Z")).toMatchObject({ needsConsent: true });
  install("active");
  expect(revise(manifest({ steps: [{ title: "整理成表", by: "assistant", external: false }] }), "2026-11-02T00:00:00Z")).toMatchObject({ needsConsent: false });
  expect(current().status).toBe("active");
});

test("reverting a revision that reached further switches the workflow back on; one never agreed to stays waiting", () => {
  install("active");
  revise(manifest({ risks: ["可能被平台限流"] }), "2026-11-02T00:00:00Z");
  expect(revertGrownSkill(store, ws, "flow-notes", new Date("2026-11-03T00:00:00Z"))).toBe(1);
  expect(current().status).toBe("active");
  // Accepted at a wider scope, then a narrower revision reverted to it: still within what was agreed.
  install("needs_consent", manifest({ access: [{ service: "小红书", site: "https://www.xiaohongshu.com", login: true, how: "读收藏" }] }));
  expect(consentToGrownSkill(store, ws, "flow-notes", new Date("2026-11-02T00:00:00Z"))).toBe(true);
  revise(manifest({ access: [{ service: "抖音", site: "https://www.douyin.com", login: true, how: "读收藏" }] }), "2026-11-03T00:00:00Z");
  expect(current().status).toBe("needs_consent");
  revertGrownSkill(store, ws, "flow-notes", new Date("2026-11-04T00:00:00Z"));
  expect(current().status).toBe("active");
});

test("version numbers only go up: a revision after a revert takes a new number", () => {
  install("active");
  expect(revise(manifest({ summary: "二" }), "2026-11-02T00:00:00Z")?.version).toBe(2);
  revertGrownSkill(store, ws, "flow-notes", new Date("2026-11-03T00:00:00Z"));
  expect(current().version).toBe(1);
  expect(revise(manifest({ summary: "三" }), "2026-11-04T00:00:00Z")?.version).toBe(3);
  expect(readGrownVersions(store, ws, "flow-notes").map((version) => version.version)).toEqual([1]);
});
