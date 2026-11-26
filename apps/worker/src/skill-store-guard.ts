import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * The skill folders around an owner's shell run that has no sandbox (gap of 2026-11-25, docs/plans/harness-1125.md §18). Without MXC the
 * folders' deny is gone, and the text guard cannot see a path a command builds from variables (`$d="skill-"+"library"`), so what the run
 * did to them is checked after it ends instead: every file is held before the run (they are small text files), and anything the run added,
 * changed or removed there is put back. Content, not times: another run writing the same library again is no change.
 */
export type SkillStoreSnapshot = { files: Map<string, string>; held: Map<string, Buffer> };

/** Past this, files are only hashed, not held: a change is still found and reported, but not put back. */
const HOLD_BYTES = 64 * 1024 * 1024;

export function snapshotSkillStore(folders: readonly string[], holdBytes = HOLD_BYTES): SkillStoreSnapshot {
  const files = new Map<string, string>(), held = new Map<string, Buffer>();
  let bytes = 0;
  const walk = (entry: string) => {
    let stat;
    try { stat = lstatSync(entry); } catch { return; }
    if (stat.isSymbolicLink()) { let target = "?"; try { target = readlinkSync(entry); } catch { /* reported as a link */ } files.set(entry, `link:${target}`); return; }
    if (stat.isDirectory()) { for (const name of readdirSync(entry)) walk(path.join(entry, name)); return; }
    if (!stat.isFile()) return;
    let content: Buffer;
    try { content = readFileSync(entry); } catch { return; }
    files.set(entry, createHash("sha256").update(content).digest("hex"));
    bytes += content.length;
    if (bytes <= holdBytes) held.set(entry, content);
  };
  for (const folder of folders) walk(path.resolve(folder));
  return { files, held };
}

/**
 * What changed in the folders since `before`, put back where it can be: a new file or link removed, a changed or removed file written
 * again from what was held. Returns the paths that changed and whether all of them were put back.
 */
export function restoreSkillStore(before: SkillStoreSnapshot, folders: readonly string[]): { changed: string[]; restored: boolean } {
  const after = snapshotSkillStore(folders, 0);
  const changed = [...new Set([...before.files.keys(), ...after.files.keys()])].filter((file) => before.files.get(file) !== after.files.get(file)).sort();
  let restored = true;
  for (const file of changed) {
    try {
      if (!before.files.has(file)) { rmSync(file, { recursive: true, force: true }); continue; }
      const content = before.held.get(file);
      if (!content) { restored = false; continue; }
      if (after.files.get(file)?.startsWith("link:")) rmSync(file, { force: true });
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
    } catch { restored = false; }
  }
  return { changed, restored };
}
