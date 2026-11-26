import type { ScanFinding, SkillInjectionCheck } from "./public-skills";

/**
 * The skill lock (`lock.json` beside the skill library, the owner's decision of 2026-11-25, docs/plans/harness-1125.md 「Skill 供应链」):
 * one entry per skill a run can be given — where it came from, at which commit, every file's sha256, which scanner version read it and
 * what it found, when, and how far it is trusted. A public skill is offered to a run only while its entry is intact: present, not
 * disabled, read by the current scanner, and naming exactly the files the ledger holds. Written by the worker only; the assistant's shell
 * and file tools are refused the folder (`isSkillStorePath`).
 */
export const SKILL_LOCK_FILE = "lock.json";
/**
 * The version of everything that judges a skill's text: `scanSkillFiles`' rules and the injection check's section of the reviewer Skill.
 * Raise it whenever either changes: every installed public skill is then read again before a run may use it.
 */
export const SKILL_SCANNER_VERSION = "2026-11-25.1";

/** `builtin`: the repository's own `crossline` plugin; `mine`: the person's line skills; `grown`: workflows Crossline wrote; `public`: strangers'. */
export type SkillTrust = "builtin" | "mine" | "grown" | "public";
export type SkillLockFile = { path: string; sha256: string };
export type SkillLockEntry = {
  name: string;
  trust: SkillTrust;
  source?: { url: string; repo: string; path: string };
  commit?: string;
  files: SkillLockFile[];
  /** The scanner version the findings are from; `unknown` for a record installed before the lock existed. */
  scanner: string;
  findings: ScanFinding[];
  injection?: SkillInjectionCheck;
  at: string;
  /** `disabled`: a rescan or a hash check found a problem; the skill is not offered until a later version passes. */
  status: "ok" | "disabled";
  reason?: string;
};
export type SkillLock = {
  version: 1;
  /** The day of the last daily rescan and the scanner version it ran with: a new version makes it due at once. */
  rescannedOn?: string;
  scanner?: string;
  skills: Record<string, SkillLockEntry>;
};

export function readSkillLock(raw: string | undefined): SkillLock {
  try {
    const parsed = JSON.parse(raw ?? "") as SkillLock;
    if (parsed && parsed.version === 1 && parsed.skills && typeof parsed.skills === "object") return parsed;
  } catch { /* none, or unreadable: an empty lock, so nothing public is offered until it is rebuilt */ }
  return { version: 1, skills: {} };
}

/** The same paths with the same hashes, in any order. */
export function sameFiles(a: SkillLockFile[], b: SkillLockFile[]): boolean {
  if (a.length !== b.length) return false;
  const left = new Map(a.map((file) => [file.path, file.sha256]));
  return left.size === b.length && b.every((file) => left.get(file.path) === file.sha256);
}

/** Why a locked skill may not be offered, or `ok`. */
export function lockState(entry: SkillLockEntry | undefined, files: SkillLockFile[]): "ok" | "missing" | "disabled" | "stale_scanner" | "hash_mismatch" {
  if (!entry) return "missing";
  if (entry.status !== "ok") return "disabled";
  if (entry.scanner !== SKILL_SCANNER_VERSION) return "stale_scanner";
  return sameFiles(entry.files, files) ? "ok" : "hash_mismatch";
}
