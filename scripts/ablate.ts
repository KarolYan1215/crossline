/**
 * Whether a registered rule earns its place (docs/plans/harness-1125.md §10): replays its samples (fixtures, and the person's corrections
 * from `golden-from-corrections.ts`) once with the rule's verdict used (`enforce`) and once only recorded (`record`), and prints how many
 * answers it changes and which mode agrees with the person. With `--telemetry`, also how often it fired in real use.
 *
 *   pnpm exec tsx scripts/ablate.ts --rule <id> [--golden <dir>] [--telemetry <rule-fired.jsonl>] [--json]
 *   pnpm exec tsx scripts/ablate.ts --list
 *
 * Deterministic: no model is called (the samples hold what the model said). `money` and `invariant` rules are refused.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isRuleId, RULE_IDS, RULE_SPEC } from "../packages/core/src/index";
import { ABLATIONS, ablate, firingsOf, type GoldenCase } from "./eval-lib";

const args = process.argv.slice(2);
const flag = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const repoRoot = path.resolve(import.meta.dirname, "..");

if (args.includes("--list")) {
  console.log("| rule | kind | mode | ablation |\n|---|---|---|---|");
  for (const id of RULE_IDS) console.log(`| ${id} | ${RULE_SPEC[id].kind} | ${RULE_SPEC[id].mode} | ${ABLATIONS[id] ? "yes" : "—"} |`);
  process.exit(0);
}

const rule = flag("--rule");
if (!rule || !isRuleId(rule)) throw new Error(`usage: ablate.ts --rule <id> (one of: ${RULE_IDS.join(", ")})`);

const fixturesDir = path.join(repoRoot, "apps", "worker", "src", "testing", "fixtures");
const fixtures: Record<string, unknown> = {};
for (const name of readdirSync(fixturesDir).filter((item) => item.endsWith(".json"))) fixtures[name.replace(/\.json$/, "")] = JSON.parse(readFileSync(path.join(fixturesDir, name), "utf8"));
const goldenDir = path.resolve(flag("--golden") ?? path.join(repoRoot, "apps", "worker", "src", "testing", "golden"));
const golden: GoldenCase[] = existsSync(goldenDir) ? readdirSync(goldenDir).filter((item) => item.endsWith(".json"))
  .flatMap((name) => (JSON.parse(readFileSync(path.join(goldenDir, name), "utf8")) as { cases?: GoldenCase[] }).cases ?? []) : [];

const report = ablate(rule, { golden, fixtures });
const telemetry = flag("--telemetry");
const fired = telemetry && existsSync(telemetry) ? firingsOf(readFileSync(telemetry, "utf8").split(/\r?\n/), rule) : undefined;

if (args.includes("--json")) {
  console.log(JSON.stringify({ report, fired }, null, 2));
} else if ("refused" in report) {
  console.log(`${rule}: not ablated — ${report.refused}`);
  if (fired) console.log(`fired ${fired.total} times (${fired.applied} applied) since ${fired.since ?? "—"}: ${JSON.stringify(fired.byVerdict)}`);
} else {
  const pct = (count: number, of: number) => of ? `${count}/${of} (${Math.round((count / of) * 100)}%)` : "—";
  console.log(`${rule} (${report.kind}, registered ${report.mode})\nsamples: ${report.source}\n`);
  console.log("| mode | answers changed by the rule | agrees with the label (person or fixture) |\n|---|---|---|");
  console.log(`| enforce | ${pct(report.changed, report.samples)} | ${pct(report.agreeEnforce, report.labelled)} |`);
  console.log(`| record | — | ${pct(report.agreeRecord, report.labelled)} |`);
  if (fired) console.log(`\nfired ${fired.total} times in use (${fired.applied} applied) since ${fired.since ?? "—"}: ${JSON.stringify(fired.byVerdict)}`);
  const changed = report.rows.filter((row) => row.changed);
  if (changed.length) console.log(`\nchanged:\n${changed.map((row) => `  ${row.id}: enforce ${row.enforce} / record ${row.record}${row.truth ? ` / person ${row.truth}` : ""}`).join("\n")}`);
  if (!report.samples) console.log("\nno samples: run golden-from-corrections.ts on a ledger copy first, or add a fixture.");
}
