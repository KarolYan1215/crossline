import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

/**
 * The `rule-fired` telemetry (2026-11-25, docs/plans/harness-1125.md 「访谈账本驱动」): one JSON line each time a code check that no longer
 * sends anything back fired — the rule is the model's now (its prompt and the ledger snapshot), and the line is what a replay counts to see
 * whether moving it brought the fault back. Never in the ledger, never an event (CLAUDE.md 「Telemetry is not the ledger」): a file next to
 * the data (`<CROSSLINE_DATA_DIR>/telemetry/rule-fired.jsonl`), or a JSON line on stdout when no data dir is set.
 *
 * The consistency-eval branch is building the same record (`RULE_SPEC`, `ruleFired`); this is a local one with the same shape, to be joined
 * to it when the branches merge.
 */
export type RuleFired = {
  /** The interview rule's id (`INTERVIEW_RULES`, 「IR-006」). */
  rule: string;
  workspaceId: string;
  sessionId?: string;
  /** The reply the round answered (`reply-N`). */
  replyId?: string;
  /** What fired, in a few words; never the person's own words beyond a short span. */
  detail?: string;
};

export function ruleFired(fired: RuleFired, dataDir = process.env.CROSSLINE_DATA_DIR, now = new Date()): void {
  const line = JSON.stringify({ type: "rule.fired", at: now.toISOString(), ...fired, ...(fired.detail ? { detail: fired.detail.slice(0, 300) } : {}) });
  if (!dataDir) { console.info(line); return; }
  try {
    const dir = path.join(dataDir, "telemetry");
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, "rule-fired.jsonl"), `${line}\n`, "utf8");
  } catch { /* the log is for reading, never a reason to fail the round */ }
}
