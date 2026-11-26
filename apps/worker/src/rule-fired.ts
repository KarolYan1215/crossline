import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

/**
 * The `rule-fired` telemetry (docs/plans/harness-1125.md 「机会放宽」): one JSON line each time a deterministic check disagreed with a
 * model's judgement and the model's answer stood. The line is for a developer reading which rules still fire (and whether a case should
 * become a replay fixture); never in the ledger, never an event. A file next to the data (`<CROSSLINE_DATA_DIR>/telemetry/rule-fired.jsonl`),
 * or a JSON line on stdout when no data dir is set.
 *
 * Local stand-in for the shared `ruleFired` the consistency-eval session is building (`RULE_SPEC`); same shape — a rule id and its detail —
 * so the merge only swaps the import.
 */
export function ruleFired(rule: string, detail: Record<string, unknown>, dataDir = process.env.CROSSLINE_DATA_DIR, now = new Date()): void {
  const line = JSON.stringify({ type: "rule.fired", rule, at: now.toISOString(), ...detail });
  if (!dataDir) { console.info(line); return; }
  try {
    const dir = path.join(dataDir, "telemetry");
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, "rule-fired.jsonl"), `${line}\n`, "utf8");
  } catch { /* the log is for reading, never a reason to fail the run */ }
}
