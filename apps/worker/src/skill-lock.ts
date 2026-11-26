import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  SKILL_LOCK_FILE, lockState, publicSkillFilesKey, publicSkillName, readSkillLock,
  type PublicSkillRecord, type SkillInjectionCheck, type SkillLock, type SkillLockEntry, type SkillLockFile, type SkillScan
} from "@crossline/core";
import { readPublicSkills, type CrosslineStore } from "@crossline/db";
import { runtimesDir } from "./owner";

/**
 * The skill supply chain on disk (docs/plans/harness-1125.md 「Skill 供应链」): the library the runtime installs from, the quarantine a
 * fetched skill is written to and read back from before any check, and the lock that says which files were checked by what.
 */
export function skillLibraryDir(workspaceId: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(path.dirname(runtimesDir(env)), "skill-library", workspaceId);
}
/** Beside the library, never inside it: nothing in quarantine is ever part of a plugin the runtime copies. */
export const quarantineDirFor = (libraryDir: string) => path.join(path.dirname(path.dirname(libraryDir)), "skill-quarantine", path.basename(libraryDir));
/** The folders only the worker writes (denied to the owner's shell under MXC, `protectSkillFolders`). */
export const skillStoreFolders = (env: NodeJS.ProcessEnv = process.env) => {
  const root = path.dirname(runtimesDir(env));
  return [path.join(root, "skill-library"), path.join(root, "skill-quarantine")];
};

export const sha256Text = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
export const fileHashes = (files: Array<{ path: string; text: string }>): SkillLockFile[] => files.map((file) => ({ path: file.path, sha256: sha256Text(file.text) }));

export function readLock(dir: string): SkillLock {
  try { return readSkillLock(readFileSync(path.join(dir, SKILL_LOCK_FILE), "utf8")); } catch { return readSkillLock(undefined); }
}
/** Read, change, and write back only when something changed (through a temporary file, so a crash never leaves half a lock). */
export function updateLock(dir: string, change: (lock: SkillLock) => void): SkillLock {
  const lock = readLock(dir);
  const before = JSON.stringify(lock);
  change(lock);
  if (JSON.stringify(lock) === before) return lock;
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, SKILL_LOCK_FILE);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(lock, null, 2), "utf8");
  renameSync(temporary, target);
  return lock;
}

/** Every file of a public skill as the ledger holds it, scripts included (`installedPublicFiles` leaves out scripts not allowed to run). */
export function storedPublicFiles(store: CrosslineStore, workspaceId: string, id: string): Array<{ path: string; text: string }> {
  try { return (JSON.parse(store.getSetting(workspaceId, publicSkillFilesKey(id)) ?? "{}") as { files?: Array<{ path: string; text: string }> }).files ?? []; }
  catch { return []; }
}

/** The public skills a run may be given: each with a lock entry that is intact for exactly the files the ledger holds. */
export function verifiedPublicIds(store: CrosslineStore, workspaceId: string, dir: string): Set<string> {
  const lock = readLock(dir);
  return new Set(readPublicSkills(store, workspaceId)
    .filter((record) => lockState(lock.skills[publicSkillName(record.id)], fileHashes(storedPublicFiles(store, workspaceId, record.id))) === "ok")
    .map((record) => record.id));
}

export function publicLockEntry(record: Pick<PublicSkillRecord, "id" | "source" | "commit">, files: SkillLockFile[], scan: SkillScan,
  injection: SkillInjectionCheck | undefined, scanner: string, at: string): SkillLockEntry {
  return { name: publicSkillName(record.id), trust: "public", source: record.source, commit: record.commit, files, scanner,
    findings: scan.findings, ...(injection ? { injection } : {}), at, status: "ok" };
}

// ── Quarantine ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export type Quarantined = { dir: string; files: Array<{ path: string; text: string; sha256: string; bytes: number }> };

/**
 * A fetched skill written to its own folder in quarantine and read back from disk: every check after this reads exactly the bytes that
 * were written, and a file whose bytes come back different (or whose path would leave the folder) refuses the skill. Released after the
 * decision, whatever it was.
 */
export function quarantine(root: string, label: string, files: Array<{ path: string; text: string; sha256?: string }>): Quarantined | { problem: string } {
  const dir = path.join(root, `${label.replace(/[^a-z0-9-]+/gi, "-").slice(0, 60)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    mkdirSync(dir, { recursive: true });
    for (const file of files) {
      const target = path.resolve(dir, file.path);
      if (!target.startsWith(`${path.resolve(dir)}${path.sep}`) || file.path.split(/[\\/]/).includes("..")) {
        releaseQuarantine(dir);
        return { problem: `unsafe path: ${file.path.slice(0, 80)}` };
      }
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, file.text, "utf8");
    }
    const back = files.map((file) => {
      const text = readFileSync(path.resolve(dir, file.path), "utf8");
      return { path: file.path, text, sha256: sha256Text(text), bytes: Buffer.byteLength(text, "utf8") };
    });
    const changed = back.find((file, index) => file.sha256 !== (files[index]!.sha256 ?? sha256Text(files[index]!.text)));
    if (changed) { releaseQuarantine(dir); return { problem: `changed on disk: ${changed.path}` }; }
    return { dir, files: back };
  } catch (error) {
    releaseQuarantine(dir);
    return { problem: error instanceof Error ? error.message.slice(0, 120) : "quarantine failed" };
  }
}
export function releaseQuarantine(dir: string | undefined): void {
  if (dir) rmSync(dir, { recursive: true, force: true });
}
/** What a crashed check left behind: folders older than a day. */
export function pruneQuarantine(root: string, now = Date.now()): void {
  try {
    for (const entry of readdirSync(root)) {
      const full = path.join(root, entry);
      if (now - statSync(full).mtimeMs > 86_400_000) rmSync(full, { recursive: true, force: true });
    }
  } catch { /* no quarantine yet */ }
}
