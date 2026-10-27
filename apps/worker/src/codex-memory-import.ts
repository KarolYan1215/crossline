import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { addLesson, type CrosslineStore } from "@crossline/db";

/**
 * The one-time move of Codex's own memories into the ledger (docs/token-economy.md §2, the owner's decision of 2026-10-21). Structured
 * Skills ran with Codex's memories on: every thread was summarised by a model six hours after it went idle, several accounts' summaries
 * landed in the machine owner's one memory file, and none was ever read back (a structured Skill has no shell and cites nothing). Memories
 * are now off; what they held that is worth keeping — 「Failures and how to do differently」 and 「Preference signals」 — becomes each
 * account's lessons (`run_lessons`, source `codex-memory`), placed by `model_usage.thread_id` (a thread no account ran is skipped, never
 * given to another), and the files are moved aside into the data folder's backups for the person, not deleted.
 */
export const CODEX_MEMORY_IMPORT_MARKER = "repair.codex-memory-import.v1";
export const CODEX_MEMORY_SOURCE = "codex-memory";

export type RawMemory = { threadId: string; keywords: string; failures: string[]; preferences: string[] };

/** Bullets that describe Crossline's own wire contract (a validator, the JSON, a repair turn), not the person or the work. */
const CONTRACT_NOISE = /JSON|schema|接收层|rejection|validator|repair|字段|结构化|Skill|SKILL_|outputSchema|developer instruction/i;

/** `raw_memories.md` cut at `## Thread \`<id>\``: each thread's keywords and the bullets of its two sections that carry over. */
export function parseRawMemories(text: string): RawMemory[] {
  const out: RawMemory[] = [];
  const parts = text.split(/^## Thread `([^`]+)`\s*$/m);
  for (let index = 1; index < parts.length; index += 2) {
    const threadId = parts[index]!.trim();
    const body = parts[index + 1] ?? "";
    const keywords = (/^\s*keywords:\s*(.+)$/m.exec(body)?.[1] ?? "").trim();
    const failures: string[] = [];
    const preferences: string[] = [];
    let section: "failures" | "preferences" | "" = "";
    for (const line of body.split(/\r?\n/)) {
      if (/^\s*Failures and how to do differently:\s*$/i.test(line)) { section = "failures"; continue; }
      if (/^\s*Preference signals:\s*$/i.test(line)) { section = "preferences"; continue; }
      if (/^\s*(#{2,}\s|[A-Z][A-Za-z ]+:\s*$|task(_group|_outcome)?:|description:)/.test(line)) { section = ""; continue; }
      const bullet = /^\s*-\s+(.+)$/.exec(line)?.[1]?.trim();
      if (!bullet || !section) continue;
      (section === "failures" ? failures : preferences).push(bullet);
    }
    out.push({ threadId, keywords, failures, preferences });
  }
  return out;
}

/** A bullet as a lesson: noise about the wire contract dropped, at most 300 characters. */
function lessonText(bullet: string): string | undefined {
  const text = bullet.replace(/`/g, "").replace(/\s+/g, " ").trim();
  if (text.length < 6 || CONTRACT_NOISE.test(text)) return undefined;
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

/** Moves a file or folder; across devices or while another process holds it, copies it and removes what it can. Returns what stayed behind. */
function moveAside(from: string, to: string): string[] {
  try { renameSync(from, to); return []; } catch { /* another device, or held open: copy instead */ }
  cpSync(from, to, { recursive: true });
  try { rmSync(from, { recursive: true, force: true }); return []; } catch { return [from]; }
}

export type CodexMemoryImport = { homes: number; threads: number; placed: number; skipped: number; lessons: Record<string, number>; backup: string; left: string[] };

/**
 * Runs once (the marker, on every workspace): reads `memories/raw_memories.md` of each Codex home given (the machine owner's, and any
 * guest's), writes the lessons, then moves `memories/` and `memories_1.sqlite` (with its -wal/-shm) to `<dataDir>/backups/codex-memories-<day>/`.
 * Returns undefined when it already ran.
 */
export function importCodexMemories(store: CrosslineStore, options: { homes: Array<{ label: string; dir: string }>; dataDir: string; now?: Date }): CodexMemoryImport | undefined {
  const workspaces = store.listWorkspaces();
  if (workspaces.some((workspace) => store.getSetting(workspace.id, CODEX_MEMORY_IMPORT_MARKER))) return undefined;
  const now = options.now ?? new Date();
  const backup = path.join(options.dataDir, "backups", `codex-memories-${now.toISOString().slice(0, 10)}`);
  const result: CodexMemoryImport = { homes: 0, threads: 0, placed: 0, skipped: 0, lessons: {}, backup, left: [] };
  const existing = new Map<string, ReturnType<CrosslineStore["listLessons"]>>();
  for (const home of options.homes) {
    const folder = path.join(home.dir, "memories");
    const database = path.join(home.dir, "memories_1.sqlite");
    if (!existsSync(folder) && !existsSync(database)) continue;
    result.homes += 1;
    let memories: RawMemory[] = [];
    try { memories = parseRawMemories(readFileSync(path.join(folder, "raw_memories.md"), "utf8")); } catch { /* no raw file: only the move */ }
    const owners = store.threadWorkspaces(memories.map((memory) => memory.threadId));
    result.threads += memories.length;
    for (const memory of memories) {
      const workspaceId = owners.get(memory.threadId);
      if (!workspaceId) { result.skipped += 1; continue; }
      result.placed += 1;
      const known = existing.get(workspaceId) ?? store.listLessons(workspaceId, { includeInvalidated: true });
      existing.set(workspaceId, known);
      const items = [...memory.failures.map((text) => ({ kind: "failure" as const, text })), ...memory.preferences.map((text) => ({ kind: "preference" as const, text }))];
      items.forEach((item, index) => {
        const text = lessonText(item.text);
        if (!text) return;
        if (addLesson(store, { workspaceId, lineId: null, archetypeId: null, kind: item.kind, text, source: CODEX_MEMORY_SOURCE,
          sourceRef: `${memory.threadId}:${item.kind}:${index}`, keywords: memory.keywords.slice(0, 300), createdAt: now.toISOString() }, known))
          result.lessons[workspaceId] = (result.lessons[workspaceId] ?? 0) + 1;
      });
    }
    const target = path.join(backup, home.label);
    mkdirSync(target, { recursive: true });
    if (existsSync(folder)) result.left.push(...moveAside(folder, path.join(target, "memories")));
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(`${database}${suffix}`)) result.left.push(...moveAside(`${database}${suffix}`, path.join(target, `memories_1.sqlite${suffix}`)));
  }
  for (const workspace of workspaces) {
    const count = result.lessons[workspace.id] ?? 0;
    if (count) store.appendEvent({ ownerId: store.getWorkspaceOwnerId(workspace.id) ?? "", workspaceId: workspace.id, idempotencyKey: `${CODEX_MEMORY_IMPORT_MARKER}:${workspace.id}`,
      type: "lessons.imported_from_codex_memory", entityId: workspace.id, payload: { lessons: count, at: now.toISOString() } });
    store.setSetting(workspace.id, CODEX_MEMORY_IMPORT_MARKER, now.toISOString());
  }
  return result;
}

/** The guest Codex homes beside the owner's (`<runtimes>/<workspace>/codex-home`), for the import. */
export function guestCodexHomes(runtimesDir: string): Array<{ label: string; dir: string }> {
  try {
    return readdirSync(runtimesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
      .map((entry) => ({ label: `guest-${entry.name}`, dir: path.join(runtimesDir, entry.name, "codex-home") }))
      .filter((home) => existsSync(home.dir));
  } catch { return []; }
}
