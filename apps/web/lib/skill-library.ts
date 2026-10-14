import {
  PUBLIC_SKILL_CATEGORY_LABEL, currentMineVersion, ensureMineFrontmatter, mineSkillSettingKey, publicSkillFilesKey, readMineSkill,
  type AccessContext, type PublicSkillRecord, type StoredMineRule
} from "@crossline/core";
import { readPublicSkills, removePublicSkill, saveMineVersion } from "@crossline/db";
import { getStore } from "./crossline";
import { identityLines } from "./lines";

/**
 * The settings page's Skill 库 (docs/skills-library.md §5): each line's own skill — the version in force in full, where every rule came
 * from, every earlier version — and the public skills with where they came from, their licence, what the scan and the review found, and
 * when a run last used them.
 */
export type MineSkillView = {
  lineId: string; lineLabel: string;
  current?: { version: number; by: "compiler" | "person"; at: string; markdown: string; rules: StoredMineRule[]; restoredFrom?: number };
  /** Newest first, each in full, so 回到此版 shows what comes back. */
  versions: Array<{ version: number; by: "compiler" | "person"; at: string; markdown: string; rules: StoredMineRule[]; restoredFrom?: number }>;
};
export type PublicSkillView = Pick<PublicSkillRecord, "id" | "name" | "description" | "lines" | "commit" | "license" | "installedAt" | "updatedAt" | "lastUsedAt" | "why"> & {
  category: string; repo: string; path: string; url: string; files: number; skipped: number;
  risk: "low" | "high"; injection: boolean; findings: Array<{ file: string; line: number; rule: string }>;
  verdict: "usable" | "text_only" | "reject"; reasons: string[];
};
export type SkillLibraryView = { mine: MineSkillView[]; publics: PublicSkillView[]; removed: Array<{ name: string; reason: string; at: string; by: string }> };

export function loadSkillLibrary(ctx: AccessContext): SkillLibraryView {
  const store = getStore();
  const mine = identityLines(ctx).map((line): MineSkillView => {
    const stored = readMineSkill(store.getSetting(ctx.workspaceId, mineSkillSettingKey(line.id)));
    const current = currentMineVersion(stored);
    return { lineId: line.id, lineLabel: line.label,
      ...(current ? { current: { version: current.version, by: current.by, at: current.at, markdown: current.markdown, rules: current.rules ?? [],
        ...(current.restoredFrom ? { restoredFrom: current.restoredFrom } : {}) } } : {}),
      versions: (stored?.versions ?? []).map((version) => ({ version: version.version, by: version.by, at: version.at, markdown: version.markdown, rules: version.rules ?? [],
        ...(version.restoredFrom ? { restoredFrom: version.restoredFrom } : {}) })).reverse() };
  });
  const publics = readPublicSkills(store, ctx.workspaceId).map((record): PublicSkillView => {
    let skipped = 0;
    try { skipped = (JSON.parse(store.getSetting(ctx.workspaceId, publicSkillFilesKey(record.id)) ?? "{}") as { skipped?: unknown[] }).skipped?.length ?? 0; } catch { /* none recorded */ }
    return { id: record.id, name: record.name, description: record.description, lines: record.lines, commit: record.commit, license: record.license,
      installedAt: record.installedAt, updatedAt: record.updatedAt, lastUsedAt: record.lastUsedAt, why: record.why,
      category: PUBLIC_SKILL_CATEGORY_LABEL[record.category] ?? record.category, repo: record.source.repo, path: record.source.path, url: record.source.url,
      files: record.files.length, skipped, risk: record.scan.risk, injection: record.scan.injection,
      findings: record.scan.findings.slice(0, 8).map(({ file, line, rule }) => ({ file, line, rule })), verdict: record.review.final, reasons: record.review.reasons };
  });
  const removed = store.listEvents(ctx.workspaceId, { type: "skill.public.removed" }).slice(-5).reverse().map((event) => {
    const payload = event.payload as { name?: string; reason?: string; by?: string };
    return { name: String(payload.name ?? event.entityId), reason: String(payload.reason ?? ""), at: event.createdAt, by: String(payload.by ?? "system") };
  });
  return { mine, publics, removed };
}

const MAX_SKILL_CHARS = 20_000;

/** The person's own text as a new version, in force at once; the compiler rewrites it only after they decide something new. */
export function editMineSkill(ctx: AccessContext, lineId: string, markdown: string): { ok: true; version: number } | { ok: false; code: string } {
  const line = identityLines(ctx).find((item) => item.id === lineId);
  if (!line) return { ok: false, code: "LINE_NOT_FOUND" };
  const text = markdown.replace(/\r\n/g, "\n").trim();
  if (!text) return { ok: false, code: "SKILL_EMPTY" };
  if (text.length > MAX_SKILL_CHARS) return { ok: false, code: "SKILL_TOO_LONG" };
  const version = saveMineVersion(getStore(), ctx.workspaceId, lineId,
    { at: new Date().toISOString(), by: "person", markdown: ensureMineFrontmatter(text, { id: line.id, label: line.label }) });
  return { ok: true, version };
}

/** An earlier version brought back, as a new version of the person's (the history is never rewritten). */
export function restoreMineSkill(ctx: AccessContext, lineId: string, version: number): { ok: true; version: number } | { ok: false; code: string } {
  const store = getStore();
  const stored = readMineSkill(store.getSetting(ctx.workspaceId, mineSkillSettingKey(lineId)));
  const old = stored?.versions.find((item) => item.version === version);
  if (!old) return { ok: false, code: "VERSION_NOT_FOUND" };
  if (stored!.current === version) return { ok: false, code: "VERSION_IN_FORCE" };
  const number = saveMineVersion(store, ctx.workspaceId, lineId, { at: new Date().toISOString(), by: "person", markdown: old.markdown,
    ...(old.rules ? { rules: old.rules } : {}), restoredFrom: version });
  return { ok: true, version: number };
}

export function deletePublicSkill(ctx: AccessContext, id: string): { ok: boolean; code?: string } {
  return removePublicSkill(getStore(), ctx.workspaceId, id, "本人删除", "person") ? { ok: true } : { ok: false, code: "SKILL_NOT_FOUND" };
}
