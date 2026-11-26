import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { setRuleSink } from "@crossline/core";

/**
 * Where `ruleFired` (packages/core/src/rule-spec.ts) writes: one JSON line per firing in `<data dir>/telemetry/rule-fired.jsonl`, the
 * same pattern as `owner-disputes.jsonl`. Telemetry, never the ledger (CLAUDE.md 「Telemetry is not the ledger」): its readers are
 * `scripts/ablate.ts` and whoever decides to retire a rule. The worker and the web server each install it at start.
 */
export const RULE_FIRED_FILE = "rule-fired.jsonl";

export function installRuleTelemetry(dataDir: string | undefined): void {
  if (!dataDir) { setRuleSink(undefined); return; }
  const dir = path.join(dataDir, "telemetry");
  const file = path.join(dir, RULE_FIRED_FILE);
  setRuleSink((line) => {
    mkdirSync(dir, { recursive: true });
    appendFileSync(file, `${JSON.stringify(line)}\n`, "utf8");
  });
}
