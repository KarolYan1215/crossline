import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore, addAiTool, removeAiTool, requestWorkflow, saveMineVersion, writeGrownSkills, writePublicSkills } from "@crossline/db";
import { currentMineVersion, mineSkillSettingKey, readMineSkill, type PublicSkillRecord } from "@crossline/core";
vi.mock("server-only", () => ({}));
import { changeGrownSkill, deletePublicSkill, editMineSkill, loadSkillLibrary, restoreMineSkill } from "./skill-library";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });
const ws = TEST_CTX.workspaceId;

function setup() {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  saveMineVersion(store, ws, "media", { at: "2026-10-14T06:00:00Z", by: "compiler", markdown: "---\nname: media\ndescription: \"x\"\n---\n1. 先抛冲突\n",
    rules: [{ kind: "play", text: "先抛冲突", sources: ["m1"], quote: "制造冲突", url: "", sourceLabels: ["验收备注"] }] });
  return store;
}

test("the person's edit is a new version in force at once, made loadable; an earlier version comes back as a new one; nothing is deleted", () => {
  const store = setup();
  expect(editMineSkill(TEST_CTX, "media", "1. 先抛冲突\n2. 标题不超过 15 个字")).toEqual({ ok: true, version: 2 });
  const edited = currentMineVersion(readMineSkill(store.getSetting(ws, mineSkillSettingKey("media"))))!;
  expect(edited).toMatchObject({ version: 2, by: "person" });
  expect(edited.markdown).toMatch(/^---\nname: media\ndescription: "本人在「创作者」主线上的打法、偏好与红线。[^"]*"\n---\n\n1\. 先抛冲突\n2\. 标题不超过 15 个字$/);
  expect(restoreMineSkill(TEST_CTX, "media", 1)).toEqual({ ok: true, version: 3 });
  expect(restoreMineSkill(TEST_CTX, "media", 3)).toEqual({ ok: false, code: "VERSION_IN_FORCE" });
  expect(editMineSkill(TEST_CTX, "nope", "x")).toEqual({ ok: false, code: "LINE_NOT_FOUND" });
  expect(editMineSkill(TEST_CTX, "media", "  ")).toEqual({ ok: false, code: "SKILL_EMPTY" });
  // The page's empty template (headings and 「1. 」) is not a skill.
  expect(editMineSkill(TEST_CTX, "media", "# 创作者：本人的做法\n\n## 打法\n\n1. \n\n## 偏好\n\n1. \n")).toEqual({ ok: false, code: "SKILL_EMPTY" });
  const view = loadSkillLibrary(TEST_CTX).mine.find((line) => line.lineId === "media")!;
  expect(view.current).toMatchObject({ version: 3, by: "person", restoredFrom: 1, rules: [expect.objectContaining({ text: "先抛冲突" })] });
  expect(view.versions.map((version) => version.version)).toEqual([3, 2, 1]);
  expect(store.listEvents(ws, { type: "skill.mine.rewritten" })).toHaveLength(3);
});

test("a public skill is shown with its source, licence, scan and review, and the person can remove it", () => {
  const store = setup();
  const record = { id: "pub-x", kind: "public", name: "x", description: "d", lines: ["media"], category: "writing",
    source: { repo: "https://github.com/a/b", path: "skills/x", url: "https://github.com/a/b/tree/c/skills/x" }, commit: "c".repeat(40), license: "MIT",
    files: [{ path: "SKILL.md", sha256: "d".repeat(64), bytes: 10 }], scan: { risk: "high", injection: false, findings: [{ file: "scripts/a.sh", line: 1, rule: "net", excerpt: "curl" }] },
    review: { verdict: "usable", reasons: ["可用"], final: "text_only" }, installedAt: "2026-10-10T00:00:00Z", updatedAt: "2026-10-10T00:00:00Z",
    lastUsedAt: "2026-10-12T00:00:00Z", why: "w" } as PublicSkillRecord;
  writePublicSkills(store, ws, [record]);
  expect(loadSkillLibrary(TEST_CTX).publics[0]).toMatchObject({ id: "pub-x", category: "写作", license: "MIT", risk: "high", verdict: "text_only", files: 1,
    findings: [{ file: "scripts/a.sh", line: 1, rule: "net" }] });
  expect(deletePublicSkill(TEST_CTX, "pub-x")).toEqual({ ok: true });
  expect(deletePublicSkill(TEST_CTX, "pub-x")).toEqual({ ok: false, code: "SKILL_NOT_FOUND" });
  expect(loadSkillLibrary(TEST_CTX)).toMatchObject({ publics: [], removed: [{ name: "x", reason: "本人删除", by: "person" }] });
});

test("a grown workflow shows when it runs, which steps are the person's and what the checks found; the person turns it off, keeps it or removes it", () => {
  const store = setup();
  const manifest = { name: "weekly-vlog-cut", summary: "每周剪一条 vlog", lines: ["media"], category: "media_edit" as const, trigger: "schedule" as const,
    schedule: { type: "weekly" as const, days: ["FR" as const], time: "18:00" }, action: "run" as const, reminder: "",
    steps: [{ title: "粗剪", by: "assistant" as const, external: false }, { title: "发布", by: "person" as const, external: true }], inputs: [], outputs: [], access: [], risks: [] };
  writeGrownSkills(store, ws, [{ id: "flow-weekly-vlog-cut", kind: "grown", name: "weekly-vlog-cut", description: "d", lines: ["media"], category: "media_edit", manifest,
    origin: { kind: "asked", text: "以后每周五把素材剪成 vlog", requestId: "r" }, taskId: "t", files: [], scan: { risk: "low", injection: false, findings: [] },
    review: { verdict: "usable", reasons: ["可用"], final: "usable" }, status: "active", pinned: false, createdAt: "2026-10-12T00:00:00Z", updatedAt: "", lastUsedAt: "2026-10-12T00:00:00Z" }]);
  requestWorkflow(store, ws, "每天九点提醒喝水", "media", TEST_CTX.principalId);
  expect(loadSkillLibrary(TEST_CTX)).toMatchObject({ growing: 1, grown: [{ id: "flow-weekly-vlog-cut", schedule: "每周五 18:00", category: "剪辑音视频和图片（不发布）",
    origin: "本人要求：「以后每周五把素材剪成 vlog」", steps: [{ title: "粗剪", person: false }, { title: "发布", person: true }] }] });
  expect(changeGrownSkill(TEST_CTX, "flow-weekly-vlog-cut", { status: "off" })).toEqual({ ok: true });
  expect(changeGrownSkill(TEST_CTX, "flow-weekly-vlog-cut", { pinned: true })).toEqual({ ok: true });
  expect(loadSkillLibrary(TEST_CTX).grown[0]).toMatchObject({ status: "off", pinned: true });
  expect(changeGrownSkill(TEST_CTX, "flow-weekly-vlog-cut", "remove")).toEqual({ ok: true });
  expect(changeGrownSkill(TEST_CTX, "flow-weekly-vlog-cut", "remove")).toEqual({ ok: false, code: "SKILL_NOT_FOUND" });
});

test("the AI tools plans assume are listed: the assistant's own always, the person's named ones removable", () => {
  const store = setup();
  expect(loadSkillLibrary(TEST_CTX).aiTools.map((tool) => [tool.name, tool.source])).toEqual([["Crossline 助手", "built_in"], ["联网调研（Codex）", "built_in"]]);
  const tool = addAiTool(store, ws, { name: "剪映", kind: "media", goodFor: "自动字幕、粗剪" })!;
  expect(loadSkillLibrary(TEST_CTX).aiTools.at(-1)).toMatchObject({ name: "剪映", kind: "media", source: "person" });
  expect(removeAiTool(store, ws, tool.id)).toBe(true);
  expect(removeAiTool(store, ws, "crossline-assistant")).toBe(false);
});
