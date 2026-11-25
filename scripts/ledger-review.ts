/**
 * The monthly deletion review (docs/plans/harness-1125.md §4): which ledger event types and settings keys are written but never read,
 * and, given a ledger, which event types nothing wrote lately. It only lists candidates; a person deletes them after a look.
 *
 *   pnpm review:ledger                     # code only
 *   pnpm review:ledger -- --db <copy.db>   # plus write counts from a ledger (opened read-only; use a backup copy, not the live file)
 *
 * Heuristics, stated so the list is read with them in mind: an event type is a dotted lower-case literal after `type:`; it is a write
 * when `appendEvent(` or `idempotencyKey` sits shortly before it, a read anywhere else the literal (or a dotted prefix of it, for
 * `startsWith`) appears. A settings key is a `*_SETTING = "…"` constant or a literal given to `setSetting`; it is read when a line that
 * names it is not its definition and not a `setSetting` call. Tests do not count as readers.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

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

export type Review = { writeOnlyEvents: string[]; writeOnlySettings: string[]; eventTypes: number; settingKeys: number };

/** The pure part: given the source texts, which event types and settings keys have no reader. */
export function reviewSources(sources: string[]): Review {
  const writes = new Set<string>();
  const literalCount = new Map<string, number>();
  const writeCount = new Map<string, number>();
  const TYPE = /type:\s*["'`]([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)["'`]/g;
  for (const text of sources) {
    for (const match of text.matchAll(TYPE)) {
      const before = text.slice(Math.max(0, match.index! - 300), match.index);
      if (/appendEvent\(|idempotencyKey/.test(before)) {
        writes.add(match[1]!);
        writeCount.set(match[1]!, (writeCount.get(match[1]!) ?? 0) + 1);
      }
    }
  }
  const all = sources.join("\n");
  for (const type of writes) literalCount.set(type, all.split(`"${type}"`).length - 1 + all.split(`'${type}'`).length - 1 + all.split(`\`${type}\``).length - 1);
  const prefixRead = (type: string) => {
    const parts = type.split(".");
    for (let i = parts.length - 1; i >= 1; i -= 1) {
      const prefix = `${parts.slice(0, i).join(".")}.`;
      if (all.includes(`"${prefix}"`) || all.includes(`'${prefix}'`)) return true;
    }
    return false;
  };
  const writeOnlyEvents = [...writes].filter((type) => (literalCount.get(type) ?? 0) <= (writeCount.get(type) ?? 0) && !prefixRead(type)).sort();

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
  return { writeOnlyEvents, writeOnlySettings, eventTypes: writes.size, settingKeys: keys.size };
}

async function main() {
  const sources = SOURCES.flatMap((dir) => files(path.join(ROOT, dir))).map((file) => readFileSync(file, "utf8"));
  const review = reviewSources(sources);
  const out: string[] = [`# 删除评审 ${new Date().toISOString().slice(0, 10)}`, "",
    `代码写入的事件类型 ${review.eventTypes} 种；设置键 ${review.settingKeys} 个。`, "",
    `## 只写不读的事件类型（${review.writeOnlyEvents.length}）`, ...review.writeOnlyEvents.map((type) => `- \`${type}\``), "",
    `## 只写不读的设置键（${review.writeOnlySettings.length}）`, ...review.writeOnlySettings.map((key) => `- \`${key}\``)];
  const dbIndex = process.argv.indexOf("--db");
  if (dbIndex > 0 && process.argv[dbIndex + 1]) {
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(process.argv[dbIndex + 1]!, { readonly: true, fileMustExist: true });
    const since = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    const rows = db.prepare("SELECT type, SUM(created_at >= ?) AS d30, SUM(created_at >= ?) AS d90, COUNT(*) AS total FROM events GROUP BY type ORDER BY total DESC")
      .all(since(30), since(90)) as Array<{ type: string; d30: number; d90: number; total: number }>;
    db.close();
    const quiet = rows.filter((row) => row.d90 === 0);
    out.push("", `## 账本：90 天没写过的事件类型（${quiet.length} / ${rows.length}）`, ...quiet.map((row) => `- \`${row.type}\`（共 ${row.total}）`),
      "", "## 账本：近 30 天写得最多的十种", ...rows.slice(0, 10).map((row) => `- \`${row.type}\` ${row.d30}`));
  }
  console.log(out.join("\n"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) void main();
