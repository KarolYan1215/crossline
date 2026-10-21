import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { GrownSkillView, PublicSkillView, SkillLibraryView } from "../../lib/skill-library";
import { matchesSkill, recentSkills, SkillLibraryModule } from "./skill-library";

const scripts = { scripts: 0, scriptsAllowable: false, findings: [] };
const publicSkill = (id: string, lastUsedAt: string, installedAt = "2026-10-01T00:00:00Z"): PublicSkillView => ({ id, name: `skill-${id}`, description: "整理笔记", lines: ["media"],
  commit: "abcdef1234", license: "MIT", installedAt, updatedAt: installedAt, lastUsedAt, why: "", category: "写作", repo: "https://github.com/example/skills",
  path: `skills/${id}`, url: "https://github.com/example/skills", files: 2, skipped: 0, risk: "low", injection: false, verdict: "usable", reasons: ["可用"], ...scripts });
const flow = (id: string, over: Partial<GrownSkillView> = {}): GrownSkillView => ({ id, summary: `每周剪辑 ${id}`, name: id, category: "剪辑", lines: ["media"], lineLabel: "自媒体",
  schedule: "每周五 18:00", action: "run", origin: "本人要求", steps: [{ title: "粗剪", person: false }, { title: "发布", person: true }], status: "active", pinned: false,
  verdict: "usable", access: [], risks: [], risk: "low", reasons: ["可用"], files: 1, createdAt: "2026-10-01T00:00:00Z", lastUsedAt: "2026-10-02T00:00:00Z", skillText: "",
  ...scripts, ...over });

test("最近用过 lists what runs used last, newest first; a public skill never called since install is not 'used'", () => {
  const recent = recentSkills([publicSkill("a", "2026-10-01T00:00:00Z"), publicSkill("b", "2026-10-18T00:00:00Z")],
    [flow("f", { lastRunAt: "2026-10-20T00:00:00Z" }), flow("g")], 3);
  expect(recent.map((item) => item.id)).toEqual(["f", "b", "g"]);
});

test("a search matches every word, anywhere in what a skill is remembered by", () => {
  expect(matchesSkill("剪辑 自媒体", "每周剪辑", "自媒体")).toBe(true);
  expect(matchesSkill("剪辑 研究", "每周剪辑", "自媒体")).toBe(false);
  expect(matchesSkill("  ", "anything")).toBe(true);
  expect(matchesSkill("NOTE", "note-tools")).toBe(true);
});

test("the library opens as a summary: counts per kind, what waits for the person, recent use and search, with the full lists folded away", () => {
  const library: SkillLibraryView = { mine: [{ lineId: "media", lineLabel: "自媒体", versions: [],
    current: { version: 2, by: "compiler", at: "2026-10-14T00:00:00Z", markdown: "# 自媒体", rules: [] } }],
    grown: [flow("f", { status: "needs_consent", summary: "整理小红书收藏" }), flow("g")],
    publics: [publicSkill("a", "2026-10-18T00:00:00Z")], aiTools: [], removed: [], growing: 1, shell: false };
  const html = renderToStaticMarkup(<SkillLibraryModule library={library} />);
  expect(html).toContain("Skill 库概览");
  for (const label of ["主线 skill", "工作流", "公开 skill", "AI 工具"]) expect(html).toContain(label);
  expect(html).toContain("已整理 1");
  expect(html).toContain("生成中 1");
  expect(html).toContain("待本人确认风险");
  expect(html).toContain("整理小红书收藏");
  expect(html).toContain("最近用过");
  expect(html).toContain("全部展开");
  // Folded: no list, no rule text, no install form until a kind is opened or something is searched.
  expect(html).not.toContain('aria-label="本人的主线 skill"');
  expect(html).not.toContain('aria-label="公开 skills"');
  expect(html).not.toContain("按链接添加");
});