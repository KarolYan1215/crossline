import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { AGENT_HISTORY_CONSENT, AGENT_HISTORY_SUMMARY, spansOf, summarizeAgentHistory, type ActivitySpan } from "@crossline/core";
import type { CrosslineStore } from "@crossline/db";

/**
 * Reads the person's Codex and Claude Code session logs on this machine for **when** and **where** only (see `packages/core/src/agent-history.ts`).
 * Each log line is matched for its `"timestamp"` and `"cwd"` fields by pattern; nothing else in it is parsed or kept. Files are cached by
 * size and modification time, so a pass re-reads only the logs that grew — about 2 GB on first read, a few files afterwards.
 */
const ROOTS = (): Array<{ tool: ActivitySpan["tool"]; dir: string }> => [
  { tool: "codex", dir: process.env.CROSSLINE_CODEX_SESSIONS ?? join(homedir(), ".codex", "sessions") },
  { tool: "claude", dir: process.env.CROSSLINE_CLAUDE_PROJECTS ?? join(homedir(), ".claude", "projects") }
];
const KEEP_DAYS = 90;
const TIMESTAMP = /"timestamp":"(\d{4}-\d{2}-\d{2}T[^"]+)"/;
const CWD = /"cwd":"((?:[^"\\]|\\.)+)"/;

type Cached = { size: number; mtimeMs: number; spans: ActivitySpan[] };

function* logFiles(dir: string, since: number): Generator<string> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* logFiles(path, since);
    else if (entry.name.endsWith(".jsonl") && statSync(path).mtimeMs >= since) yield path;
  }
}

/** A folder's last segment: the one name kept (`C:\…\Multi-ID` → 「Multi-ID」). */
const folderOf = (cwd: string) => basename(cwd.replace(/\\\\/g, "\\").replace(/[\\/]+$/, "").replace(/\\/g, "/")) || "";

async function readSpans(path: string, tool: ActivitySpan["tool"]): Promise<ActivitySpan[]> {
  const times = new Map<string, number[]>();
  let folder = "";
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    // Only the head of a line is looked at: the fields sit near its start, and a long message body is never scanned.
    const head = line.slice(0, 4000);
    const cwd = CWD.exec(head)?.[1];
    if (cwd) folder = folderOf(cwd);
    const stamp = TIMESTAMP.exec(head)?.[1];
    if (!stamp || !folder) continue;
    const at = Date.parse(stamp);
    if (!Number.isFinite(at)) continue;
    times.set(folder, [...(times.get(folder) ?? []), at]);
  }
  return [...times].flatMap(([name, stamps]) => spansOf(stamps, tool, name));
}

/**
 * One pass for every workspace that said yes (`history.agentLogs` = "on"): refresh the cache, then write each one's summary in its own
 * time zone. Workspaces that did not are never read for.
 */
export async function agentHistoryPass(store: CrosslineStore, workspaceIds: string[], dataDir: string, timeZoneOf: (workspaceId: string) => string, now = new Date()): Promise<number> {
  const consenting = workspaceIds.filter((id) => store.getSetting(id, AGENT_HISTORY_CONSENT) === "on");
  if (!consenting.length) return 0;
  const cachePath = join(dataDir, "agent-history-cache.json");
  let cache: Record<string, Cached> = {};
  try { cache = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, Cached>; } catch { /* first pass */ }
  const since = now.getTime() - KEEP_DAYS * 86_400_000;
  const next: Record<string, Cached> = {};
  for (const { tool, dir } of ROOTS()) {
    for (const path of logFiles(dir, since)) {
      const stat = statSync(path);
      const hit = cache[path];
      next[path] = hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs ? hit
        : { size: stat.size, mtimeMs: stat.mtimeMs, spans: await readSpans(path, tool).catch(() => []) };
    }
  }
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(next));
  const spans = Object.values(next).flatMap((entry) => entry.spans);
  for (const workspaceId of consenting) {
    store.setSetting(workspaceId, AGENT_HISTORY_SUMMARY, JSON.stringify(summarizeAgentHistory(spans, now, timeZoneOf(workspaceId))));
  }
  return spans.length;
}
