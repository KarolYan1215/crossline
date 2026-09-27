import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";

/**
 * Reads the user's own day-to-day Codex CLI session history — a completely different directory from the
 * worker's own isolated Codex sandbox (`packages/codex/src/index.ts`'s `codexProcessEnvironment()`,
 * `<LOCALAPPDATA>/Crossline/codex-home` on Windows, kept deliberately separate and never reading the
 * Desktop app's private auth state either). This module only ever reads; nothing here writes to or
 * touches that personal `CODEX_HOME` in any way.
 *
 * File format confirmed against this repo's own vendored Codex CLI source
 * (`vendor/codex/codex-rs/thread-store/src/local/*.rs`, `vendor/codex/codex-rs/history/src/rollout_payload.rs`):
 * `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<timestamp>-<threadId>.jsonl`, one JSON object per line,
 * tagged by a `type` field (`session_meta`, `response_item`, `turn_context`, `event_msg`, …). This reader
 * never assumes more about that shape than the tag and a permissive text search — untested against a real
 * install (this build has no personal Codex history to read in its own sandbox), so it fails soft: a
 * session it cannot parse is skipped, never thrown over.
 */

export function defaultPersonalCodexHome(): string {
  return process.env.CROSSLINE_PERSONAL_CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
}

export type CodexHistorySessionSummary = {
  id: string;
  date: string;
  lineCount: number;
  approxChars: number;
  firstUserText: string;
};

// A session counts as substantial if either signal clears its floor: a short session with one genuinely
// long first message (someone pasting real context) is not trivial just because it has few lines, and a
// long session this reader failed to extract clean text from (an unrecognized shape) is not trivial just
// because `firstUserText` came back empty. Raw JSONL byte length is deliberately not the signal — its
// per-line JSON-wrapper overhead alone clears most thresholds regardless of actual content.
const TRIVIAL_MIN_TEXT_CHARS = 80;
const TRIVIAL_MIN_LINES = 6;
const MAX_TEXT_SEARCH_DEPTH = 6;

/** A permissive search for the first substantial string under a common text-bearing key, bounded in
 * depth/breadth so one odd file cannot make the scan pathologically slow. Not a real parse of the
 * `ResponseItem` union — that would mean pinning to the vendored Rust type in TypeScript, which this
 * reader avoids so a Codex CLI version bump does not silently break onboarding. */
function firstSubstantialText(value: unknown, depth = 0): string | undefined {
  if (depth > MAX_TEXT_SEARCH_DEPTH || value === null || value === undefined) return undefined;
  if (typeof value === "string") return value.trim().length >= 8 ? value.trim() : undefined;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) {
      const found = firstSubstantialText(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["text", "content", "message", "value"]) {
      if (key in record) {
        const found = firstSubstantialText(record[key], depth + 1);
        if (found) return found;
      }
    }
    for (const key of Object.keys(record).slice(0, 20)) {
      if (["text", "content", "message", "value"].includes(key)) continue;
      const found = firstSubstantialText(record[key], depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

async function summarizeRolloutFile(filePath: string, date: string): Promise<CodexHistorySessionSummary> {
  const id = path.basename(filePath, ".jsonl");
  let lineCount = 0;
  let approxChars = 0;
  let firstUserText = "";
  const rl = createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    lineCount += 1;
    approxChars += line.length;
    if (firstUserText) continue;
    try {
      const parsed = JSON.parse(line) as { type?: string; payload?: unknown };
      if (parsed.type === "response_item" || parsed.type === "event_msg") {
        const record = parsed.payload as { role?: string } | undefined;
        // A user turn only — an assistant's own reply is not the signal onboarding wants.
        if (!record || record.role === undefined || record.role === "user") {
          const found = firstSubstantialText(parsed.payload);
          if (found) firstUserText = found;
        }
      }
    } catch { /* a line this reader cannot parse just contributes to lineCount/approxChars and nothing else */ }
  }
  return { id, date, lineCount, approxChars, firstUserText };
}

/** Every `rollout-*.jsonl` file under `<home>/sessions`, walked by the `YYYY/MM/DD` layout the CLI itself
 * writes — never a recursive directory walk, so a symlink loop or an unrelated huge directory dropped in
 * by hand cannot turn this into an unbounded scan. */
async function listRolloutFiles(sessionsRoot: string): Promise<Array<{ filePath: string; date: string }>> {
  if (!existsSync(sessionsRoot)) return [];
  const files: Array<{ filePath: string; date: string }> = [];
  for (const year of safeReaddir(sessionsRoot)) {
    const yearDir = path.join(sessionsRoot, year);
    if (!/^\d{4}$/.test(year) || !statSync(yearDir).isDirectory()) continue;
    for (const month of safeReaddir(yearDir)) {
      const monthDir = path.join(yearDir, month);
      if (!/^\d{2}$/.test(month) || !statSync(monthDir).isDirectory()) continue;
      for (const day of safeReaddir(monthDir)) {
        const dayDir = path.join(monthDir, day);
        if (!/^\d{2}$/.test(day) || !statSync(dayDir).isDirectory()) continue;
        for (const entry of safeReaddir(dayDir)) {
          if (entry.startsWith("rollout-") && entry.endsWith(".jsonl")) {
            files.push({ filePath: path.join(dayDir, entry), date: `${year}-${month}-${day}` });
          }
        }
      }
    }
  }
  return files;
}

function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

export type CodexHistoryScanResult = {
  sessionCount: number;
  keptCount: number;
  sources: Array<{ label: string; excerpt: string }>;
};

/**
 * The whole pipeline behind one click: scan every session under `home`, drop trivial ones locally, and
 * turn what is left into short `{label, excerpt}` sources — never a full transcript, and everything stays
 * on this machine until the person's own onboarding conversation call sends the excerpts (not the raw
 * files) to the worker's Codex skill they already consented to using.
 */
export async function scanPersonalCodexHistory(home: string = defaultPersonalCodexHome(),
  options: { maxSources?: number } = {}): Promise<CodexHistoryScanResult> {
  const files = await listRolloutFiles(path.join(home, "sessions"));
  const summaries = await Promise.all(files.map((file) => summarizeRolloutFile(file.filePath, file.date)));
  const kept = summaries
    .filter((session) => session.firstUserText.length >= TRIVIAL_MIN_TEXT_CHARS || session.lineCount >= TRIVIAL_MIN_LINES)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, options.maxSources ?? 60);
  return {
    sessionCount: summaries.length,
    keptCount: kept.length,
    sources: kept.map((session) => ({
      label: `${session.date} · ${session.firstUserText.slice(0, 40) || session.id}`,
      excerpt: session.firstUserText.slice(0, 500)
    }))
  };
}
