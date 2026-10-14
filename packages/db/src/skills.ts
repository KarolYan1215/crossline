import {
  GROWN_LIBRARY_SETTING, SKILL_LIBRARY_SETTING, categoryFromWording, grownSkillFilesKey, grownSkillId, isScriptFile, mineSkillSettingKey, publicSkillFilesKey,
  readGrownLibrary, readMineSkill, readSkillLibrary,
  type GrownSkillRecord, type PublicSkillRecord, type StoredMineSkill, type Weekday, type WorkflowSchedule
} from "@crossline/core";
import { randomUUID } from "node:crypto";
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

export const readGrownSkills = (store: CrosslineStore, workspaceId: string) => readGrownLibrary(store.getSetting(workspaceId, GROWN_LIBRARY_SETTING));
export const writeGrownSkills = (store: CrosslineStore, workspaceId: string, records: GrownSkillRecord[]) =>
  store.setSetting(workspaceId, GROWN_LIBRARY_SETTING, JSON.stringify(records));

/** A grown workflow's files: all of them, or — when the scan or the review allowed it only as text — all but its scripts. */
export function installedGrownFiles(store: CrosslineStore, workspaceId: string, record: GrownSkillRecord): Array<{ path: string; text: string }> {
  let stored: { files?: Array<{ path: string; text: string }> } | undefined;
  try { stored = JSON.parse(store.getSetting(workspaceId, grownSkillFilesKey(record.id)) ?? "{}") as typeof stored; } catch { stored = undefined; }
  return (stored?.files ?? []).filter((file) => record.review.final === "usable" || !isScriptFile(file.path));
}

/** The person turns a grown workflow off or on, or keeps it (`pinned`: never removed for being idle). */
export function updateGrownSkill(store: CrosslineStore, workspaceId: string, id: string, patch: { status?: "active" | "off"; pinned?: boolean },
  now = new Date()): boolean {
  const records = readGrownSkills(store, workspaceId);
  const record = records.find((item) => item.id === id);
  if (!record) return false;
  writeGrownSkills(store, workspaceId, records.map((item) => item.id === id ? { ...item, ...patch, updatedAt: now.toISOString() } : item));
  store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `skill.grown.updated:${id}:${now.toISOString()}`, type: "skill.grown.updated",
    entityId: id, payload: { id, ...patch } });
  return true;
}

/** Removes a grown workflow and its files (`skill.grown.removed` keeps why and by whom). */
export function removeGrownSkill(store: CrosslineStore, workspaceId: string, id: string, reason: string, by: "system" | "person", now = new Date()): boolean {
  const records = readGrownSkills(store, workspaceId);
  const record = records.find((item) => item.id === id);
  if (!record) return false;
  writeGrownSkills(store, workspaceId, records.filter((item) => item.id !== id));
  store.deleteSetting(workspaceId, grownSkillFilesKey(id));
  store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `skill.grown.removed:${id}:${now.toISOString()}`, type: "skill.grown.removed",
    entityId: id, payload: { id, name: record.name, reason, by } });
  return true;
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

const DAY_OF_INDEX: Weekday[] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/**
 * A reminder the person set in words (「每周五下午六点提醒我发小红书」): a remind-only workflow written at once, with no assistant run and
 * nothing to install — there is no method to write down, only a time and the words to say. `weekdays` are 0 (Sunday) to 6; none is every day.
 */
export function createReminderWorkflow(store: CrosslineStore, workspaceId: string,
  input: { text: string; reminder: string; time: string; weekdays: number[]; lineId: string }, now = new Date()): GrownSkillRecord {
  const days = [...new Set(input.weekdays.filter((day) => day >= 0 && day <= 6))].sort().map((day) => DAY_OF_INDEX[day]!);
  const schedule: WorkflowSchedule = !days.length || days.length === 7 ? { type: "daily", time: input.time }
    : days.length === 5 && !days.includes("SA") && !days.includes("SU") ? { type: "weekdays", time: input.time } : { type: "weekly", days, time: input.time };
  const records = readGrownSkills(store, workspaceId);
  const id = grownSkillId(`reminder-${input.time.replace(":", "")}`, records.map((record) => record.id));
  const at = now.toISOString();
  const record: GrownSkillRecord = { id, kind: "grown", name: id.replace(/^flow-/, ""), description: input.reminder, lines: input.lineId ? [input.lineId] : [],
    category: "files_calendar_prep",
    manifest: { name: id.replace(/^flow-/, ""), summary: input.reminder, lines: input.lineId ? [input.lineId] : [], category: "files_calendar_prep", trigger: "schedule",
      schedule, action: "remind", reminder: input.reminder, steps: [{ title: input.reminder, by: "person", external: false }], inputs: [], outputs: [] },
    origin: { kind: "asked", text: input.text, requestId: `reminder-${id}` }, taskId: "", files: [],
    scan: { risk: "low", injection: false, findings: [] }, review: { verdict: "usable", reasons: ["本人在输入框里设的提醒，没有脚本"], final: "usable" },
    status: "active", pinned: true, createdAt: at, updatedAt: at, lastUsedAt: at };
  writeGrownSkills(store, workspaceId, [...records, record]);
  store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `skill.grown.created:${id}`, type: "skill.grown.created", entityId: id,
    payload: { id, name: record.name, trigger: "schedule", schedule, action: "remind", origin: "asked" } });
  return record;
}

/** The person asked, in words, for a workflow (「以后每周五把素材剪成一条 vlog」): recorded for the worker's next growing pass. Returns its id. */
export function requestWorkflow(store: CrosslineStore, workspaceId: string, text: string, lineId: string, ownerId: string): string {
  const id = `wfreq-${randomUUID().slice(0, 8)}`;
  const category = categoryFromWording(text);
  store.appendEvent({ ownerId, workspaceId, idempotencyKey: `workflow.requested:${id}`, type: "workflow.requested", entityId: id,
    payload: { text: text.slice(0, 1000), lineId, ...(category ? { category } : {}) } });
  return id;
}
