import {
  SKILL_LIBRARY_SETTING, isScriptFile, mineSkillSettingKey, publicSkillFilesKey, readMineSkill, readSkillLibrary,
  type PublicSkillRecord, type StoredMineSkill
} from "@crossline/core";
import type { CrosslineStore } from "./index";

/**
 * The skill library's ledger side (docs/skills-library.md), shared by the worker that writes it and the settings page where the person
 * edits, restores and removes: the person's line skills as versions in `skills.mine.<line>`, the public ones in `skills.library`.
 */
const ownerOf = (store: CrosslineStore, workspaceId: string) => store.getWorkspaceOwnerId(workspaceId) ?? "system";

/** Appends a version of a line's own skill and makes it current; the old ones stay, and the system never removes one. Returns its number. */
export function saveMineVersion(store: CrosslineStore, workspaceId: string, lineId: string,
  version: Omit<StoredMineSkill["versions"][number], "version">): number {
  const stored = readMineSkill(store.getSetting(workspaceId, mineSkillSettingKey(lineId))) ?? { lineId, current: 0, versions: [] };
  const number = Math.max(0, ...stored.versions.map((item) => item.version)) + 1;
  const next: StoredMineSkill = { lineId, current: number, versions: [...stored.versions, { ...version, version: number }] };
  store.setSetting(workspaceId, mineSkillSettingKey(lineId), JSON.stringify(next));
  store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `skill.mine:${lineId}:v${number}`, type: "skill.mine.rewritten", entityId: lineId,
    payload: { lineId, version: number, by: version.by, rules: version.rules?.length ?? 0, ...(version.fingerprint ? { fingerprint: version.fingerprint } : {}),
      ...(version.restoredFrom ? { restoredFrom: version.restoredFrom } : {}) } });
  return number;
}

export const readPublicSkills = (store: CrosslineStore, workspaceId: string) => readSkillLibrary(store.getSetting(workspaceId, SKILL_LIBRARY_SETTING));
export const writePublicSkills = (store: CrosslineStore, workspaceId: string, records: PublicSkillRecord[]) =>
  store.setSetting(workspaceId, SKILL_LIBRARY_SETTING, JSON.stringify(records));

/** The files installed for a public skill: everything fetched, or — for one allowed only as text — everything but its scripts. */
export function installedPublicFiles(store: CrosslineStore, workspaceId: string, record: PublicSkillRecord): Array<{ path: string; text: string }> {
  let stored: { files?: Array<{ path: string; text: string }> } | undefined;
  try { stored = JSON.parse(store.getSetting(workspaceId, publicSkillFilesKey(record.id)) ?? "{}") as typeof stored; } catch { stored = undefined; }
  return (stored?.files ?? []).filter((file) => record.review.final === "usable" || !isScriptFile(file.path));
}

/** Removes a public skill and its files (the record of why stays in `skill.public.removed`). The person's line skills are never removed. */
export function removePublicSkill(store: CrosslineStore, workspaceId: string, id: string, reason: string, by: "system" | "person", now = new Date()): boolean {
  const records = readPublicSkills(store, workspaceId);
  const record = records.find((item) => item.id === id);
  if (!record) return false;
  writePublicSkills(store, workspaceId, records.filter((item) => item.id !== id));
  store.deleteSetting(workspaceId, publicSkillFilesKey(id));
  store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `skill.public.removed:${id}:${now.toISOString()}`, type: "skill.public.removed",
    entityId: id, payload: { id, name: record.name, repo: record.source.repo, path: record.source.path, commit: record.commit, reason, by } });
  return true;
}
