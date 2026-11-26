/**
 * The person's corrections as evaluation cases (docs/plans/harness-1125.md §10): every undo, gate override, changed estimate or due day,
 * declined proposal, renamed task and chosen completion mode in a ledger, with what the system said and what the person made of it.
 *
 *   pnpm exec tsx scripts/golden-from-corrections.ts <copy.db> [--workspace <id>] [--out <dir>]
 *
 * `<copy.db>` is a copy: a ledger rebuilt from a backup (`scripts/restore-crossline-backup.ps1`, `pnpm restore`) or copied aside. A file
 * in a folder named `data`, or the installed app's ledger, is refused: the live ledger is never opened here.
 *
 * Writes one file per kind (`undo.json`, `gate.json`, `duration.json`, `date.json`, `reject.json`, `rename.json`, `completion.json`) to
 * `--out`, default `apps/worker/src/testing/golden/`. Those files hold the person's own words and are gitignored; only `example-*.json`
 * (made up) and the README are committed. `scripts/ablate.ts` reads them.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CrosslineStore } from "../packages/db/src/index";
import { extractGolden, type GoldenCase, type LedgerOrder } from "./eval-lib";

const args = process.argv.slice(2);
const flag = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const repoRoot = path.resolve(import.meta.dirname, "..");
const file = args.find((item, index) => !item.startsWith("--") && !args[index - 1]?.startsWith("--"));
if (!file) throw new Error("usage: golden-from-corrections.ts <copy.db> [--workspace <id>] [--out <dir>]");

const resolved = path.resolve(file);
const installed = process.env.LOCALAPPDATA ? path.resolve(process.env.LOCALAPPDATA, "Crossline", "data") : undefined;
if (path.basename(path.dirname(resolved)).toLowerCase() === "data" || (installed && resolved.toLowerCase().startsWith(installed.toLowerCase())))
  throw new Error("REFUSED_LIVE_LEDGER: pass a copy (a restored backup), not a file in data/");

const store = new CrosslineStore(resolved);
try {
  const workspaceId = flag("--workspace") ?? [...store.listWorkspaces()].sort((a, b) => store.listEvents(b.id).length - store.listEvents(a.id).length)[0]?.id;
  if (!workspaceId) throw new Error("NO_WORKSPACE in this ledger");
  const orders = new Map<string, LedgerOrder>(store.listWorkOrders(workspaceId).map((order) => [order.id, { id: order.id, intent: order.intent, payload: order.payload }]));
  const cases = extractGolden(store.listEvents(workspaceId), orders);
  const out = path.resolve(flag("--out") ?? path.join(repoRoot, "apps", "worker", "src", "testing", "golden"));
  mkdirSync(out, { recursive: true });
  const byKind = new Map<string, GoldenCase[]>();
  for (const item of cases) byKind.set(item.kind, [...(byKind.get(item.kind) ?? []), item]);
  for (const [kind, list] of byKind) writeFileSync(path.join(out, `${kind}.json`), `${JSON.stringify({ workspaceId, extractedAt: new Date().toISOString(), cases: list }, null, 1)}\n`, "utf8");
  console.log(`golden: ${cases.length} cases from workspace ${workspaceId} → ${out}`);
  for (const [kind, list] of [...byKind].sort()) console.log(`  ${kind}: ${list.length}${kind === "undo" ? ` (${list.filter((item) => item.bySystem).length} by the system)` : ""}`);
} finally {
  store.close();
}
