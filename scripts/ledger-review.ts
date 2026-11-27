/**
 * The monthly deletion review (docs/plans/harness-1125.md §4): which ledger event kinds and settings keys are written but never read,
 * and, given a ledger, which kinds nothing wrote lately. It only lists candidates; a person deletes them after a look.
 *
 *   pnpm review:ledger                     # code only
 *   pnpm review:ledger -- --db <copy.db>   # plus write counts from a ledger (opened read-only; use a backup copy, not the live file)
 *
 * The kinds come from the typed registry (`packages/core/src/event-types.ts`, 2026-11-27): a standalone type, a `.changed` family's
 * `change`, a `job.ran` job. `person.decided` is audit by the owner's rule and only counted. Heuristics, stated so the list is read with
 * them in mind: a kind's literal (`"found"`) is looked for in the files that name its family; an occurrence is a write when
 * `appendEvent(`, `idempotencyKey` or `payload:` is nearer before it than `listEvents(`, `latestEventAt(`, `EventFilter` or a
 * `change ===`, a read otherwise. A common word (`done`, `created`) used for something else in the same file makes a kind look read: the
 * list misses candidates rather than naming false ones. A settings key is a `*_SETTING = "…"` constant or a literal given to
 * `setSetting`; it is read when a line that names it is not its definition and not a `setSetting` call. Tests do not count as readers.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { EVENT_CHANGES, EVENT_TYPES, JOB_STATES, PERSON_SUBJECTS, STANDALONE_EVENT_TYPES } from "../packages/core/src/event-types";

const ROOT = path.resolve(import.meta.dirname, "..");
const SOURCES = ["apps", "packages"];
const SKIP = /node_modules|[\\/]\.next|[\\/]dist[\\/]|[\\/]vendor[\\/]|\.test\.tsx?$|[\\/]testing[\\/]/;

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (SKIP.test(full)) continue;
    if (statSync(full).isDirectory()) files(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

export type Review = {
  writeOnlyEvents: string[]; unwrittenEvents: string[]; writeOnlySettings: string[];
  eventTypes: number; eventKinds: number; auditSubjects: number; settingKeys: number;
};

/** Every kind the registry names, as `[family, literal, "family:literal"]`; a standalone type is its own literal and kind. */
const KINDS: Array<[string, string, string]> = [
  ...STANDALONE_EVENT_TYPES.map((type): [string, string, string] => [type, type, type]),
  ...Object.entries(EVENT_CHANGES).flatMap(([type, changes]) => changes.map((change): [string, string, string] => [type, change, `${type}:${change}`])),
  ...Object.keys(JOB_STATES).map((job): [string, string, string] => ["job.ran", job, `job.ran:${job}`])];

/** Files that list every kind by design (the registry, the migration's mapping): neither writers nor readers. */
const REGISTRY = /event-types\.ts$|event-condense\.ts$/;
const CALL = /\b(appendEvent|listEvents|latestEventAt)\(/g;

/** Where the call whose `(` is at `open` closes, or `limit` if it runs past it. */
function closeOf(text: string, open: number, limit: number): number {
  let depth = 0;
  for (let i = open; i < limit; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")" && --depth === 0) return i;
  }
  return limit;
}

/** The ledger call an occurrence sits inside, if any: the nearest one opened within 2000 characters and not yet closed. */
function enclosingCall(text: string, at: number): string | undefined {
  const from = Math.max(0, at - 2000);
  for (const match of [...text.slice(from, at).matchAll(CALL)].reverse()) {
    if (closeOf(text, from + match.index! + match[0].length - 1, at) === at) return match[1];
  }
  return undefined;
}

/** Families some reader lists whole: a `listEvents`/`latestEventAt` call naming the family with no `change`, `job` or `subject`. */
function wholesale(sources: string[]): Set<string> {
  const out = new Set<string>();
  for (const text of sources) {
    for (const match of text.matchAll(CALL)) {
      if (match[1] === "appendEvent") continue;
      const open = match.index! + match[0].length - 1;
      const call = text.slice(open, closeOf(text, open, Math.min(text.length, open + 600)));
      if (/\b(change|job|subject)\s*:/.test(call)) continue;
      for (const type of call.matchAll(/"([a-z_]+\.[a-z_.]+)"/g)) out.add(type[1]!);
    }
  }
  return out;
}

/**
 * Whether an occurrence reads: inside a `listEvents`/`latestEventAt` call, compared (`===`, `!==`, `case`), in a list checked with
 * `.includes(`, in a list declared as filters (`EventFilter`, `Record<EventType`) or turned into SQL (`json_extract`) further down.
 * Everything else — inside `appendEvent`, a helper's argument, a lookup table — counts as a write.
 */
function reads(text: string, at: number): boolean {
  const call = enclosingCall(text, at);
  if (call) return call !== "appendEvent";
  if (/(===|!==|case)\s*$/.test(text.slice(Math.max(0, at - 12), at))) return true;
  const after = text.slice(at, at + 3000);
  return /^[^\]\n]*\]\.includes\(/.test(after) || /EventFilter|Record<EventType/.test(text.slice(Math.max(0, at - 600), at))
    || (/json_extract/.test(after) && !/appendEvent\(/.test(after));
}

/** A literal's occurrences, leaving out a constant's definition (`const GIT_COMMIT_SEEN_EVENT = "git.commit_seen"`). */
function occurrences(text: string, literal: string): number[] {
  const out: number[] = [];
  for (const quoted of [`"${literal}"`, `'${literal}'`, `\`${literal}\``]) {
    for (let at = text.indexOf(quoted); at >= 0; at = text.indexOf(quoted, at + 1)) {
      if (!/const\s+[A-Z][A-Z0-9_]*\s*=\s*$/.test(text.slice(Math.max(0, at - 80), at))) out.push(at);
    }
  }
  return out;
}

/** The pure part: given the source texts (and their paths, to leave the registry out), which event kinds and settings keys have no reader. */
export function reviewSources(sources: string[], paths: string[] = []): Review {
  const code = sources.filter((_, index) => !REGISTRY.test(paths[index] ?? ""));
  const all = code.join("\n");
  // A type kept in a constant is looked for under the constant's name too.
  const aliases = new Map<string, string[]>();
  for (const match of all.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*=\s*"([a-z_]+\.[a-z_.]+)"/g)) aliases.set(match[2]!, [...(aliases.get(match[2]!) ?? []), match[1]!]);
  const whole = wholesale(code);
  const writeOnlyEvents: string[] = [], unwrittenEvents: string[] = [];
  for (const [family, literal, kind] of KINDS) {
    let writes = 0, readCount = whole.has(family) && family !== literal ? 1 : 0;
    const names = aliases.get(family) ?? [];
    for (const text of code) {
      if (family !== literal && !text.includes(`"${family}"`) && !names.some((name) => text.includes(name))) continue;
      const found = [...occurrences(text, literal),
        ...(family === literal ? names.flatMap((name) => [...text.matchAll(new RegExp(`\\b${name}\\b(?!\\s*=)`, "g"))].map((match) => match.index!)) : [])];
      for (const at of found) {
        if (reads(text, at)) readCount += 1;
        else writes += 1;
      }
    }
    if (!writes) unwrittenEvents.push(kind);
    else if (!readCount) writeOnlyEvents.push(kind);
  }

  const keys = new Map<string, string | undefined>();
  for (const match of all.matchAll(/(?:export\s+)?const\s+([A-Z][A-Z0-9_]*_SETTING)\s*=\s*["'`]([^"'`]+)["'`]/g)) keys.set(match[2]!, match[1]);
  for (const match of all.matchAll(/setSetting\([^,]+,\s*["'`]([a-z][\w.:-]*)["'`]/g)) if (!keys.has(match[1]!)) keys.set(match[1]!, undefined);
  const lines = all.split("\n");
  const writeOnlySettings = [...keys].filter(([key, constant]) => !lines.some((line) => {
    const names = (constant && new RegExp(`\\b${constant}\\b`).test(line)) || line.includes(`"${key}"`) || line.includes(`'${key}'`);
    if (!names) return false;
    const definition = constant ? new RegExp(`const\\s+${constant}\\s*=`).test(line) : false;
    return !definition && !/setSetting\(/.test(line);
  })).map(([key]) => key).sort();
  return { writeOnlyEvents: writeOnlyEvents.sort(), unwrittenEvents: unwrittenEvents.sort(), writeOnlySettings,
    eventTypes: EVENT_TYPES.length, eventKinds: KINDS.length, auditSubjects: PERSON_SUBJECTS.length, settingKeys: keys.size };
}

async function main() {
  const paths = SOURCES.flatMap((dir) => files(path.join(ROOT, dir)));
  const review = reviewSources(paths.map((file) => readFileSync(file, "utf8")), paths);
  const out: string[] = [`# 删除评审 ${new Date().toISOString().slice(0, 10)}`, "",
    `事件类型 ${review.eventTypes} 种，细分 ${review.eventKinds} 项（独立类型、\`.changed\` 的 change、\`job.ran\` 的 job）；`
      + `\`person.decided\` 留作审计，${review.auditSubjects} 个 subject。设置键 ${review.settingKeys} 个。`, "",
    `## 只写不读的事件（${review.writeOnlyEvents.length}）`, ...review.writeOnlyEvents.map((kind) => `- \`${kind}\``), "",
    `## 登记了但代码不写的事件（${review.unwrittenEvents.length}）`, ...review.unwrittenEvents.map((kind) => `- \`${kind}\``), "",
    `## 只写不读的设置键（${review.writeOnlySettings.length}）`, ...review.writeOnlySettings.map((key) => `- \`${key}\``)];
  const dbIndex = process.argv.indexOf("--db");
  if (dbIndex > 0 && process.argv[dbIndex + 1]) {
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(process.argv[dbIndex + 1]!, { readonly: true, fileMustExist: true });
    const since = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    const rows = db.prepare(`SELECT type || COALESCE(':' || CASE type WHEN 'job.ran' THEN json_extract(payload_json, '$.job')
        WHEN 'person.decided' THEN json_extract(payload_json, '$.subject') ELSE json_extract(payload_json, '$.change') END, '') AS kind,
        SUM(created_at >= ?) AS d30, SUM(created_at >= ?) AS d90, COUNT(*) AS total FROM events GROUP BY kind ORDER BY total DESC`)
      .all(since(30), since(90)) as Array<{ kind: string; d30: number; d90: number; total: number }>;
    db.close();
    const known = new Set([...KINDS.map(([, , kind]) => kind), ...PERSON_SUBJECTS.map((subject) => `person.decided:${subject}`)]);
    const unknown = rows.filter((row) => !known.has(row.kind));
    const quiet = rows.filter((row) => row.d90 === 0);
    out.push("", `## 账本：登记表里没有的（${unknown.length}）`, ...unknown.map((row) => `- \`${row.kind}\`（共 ${row.total}）`),
      "", `## 账本：90 天没写过的（${quiet.length} / ${rows.length}）`, ...quiet.map((row) => `- \`${row.kind}\`（共 ${row.total}）`),
      "", "## 账本：近 30 天写得最多的十种", ...rows.slice(0, 10).map((row) => `- \`${row.kind}\` ${row.d30}`));
  }
  console.log(out.join("\n"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) void main();
