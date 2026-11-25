import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { readExternal } from "@crossline/core";

/**
 * The `owner-disputes` telemetry (docs/plans/harness-1125.md §1): one JSON line each time a work-writing Skill marked an item not
 * external (`external: false`) while the one word list (`external-action.ts`) reads it as external. The model's answer stood; the line is
 * kept so a real case can become a replay fixture (`testing/fixtures/`). Never in the ledger, never an event: a file next to the data
 * (`<CROSSLINE_DATA_DIR>/telemetry/owner-disputes.jsonl`), or a JSON line on stdout when no data dir is set.
 */
export type OwnerDispute = { workspaceId: string; skill: string; itemId: string; title: string; intent?: string };

export function recordOwnerDispute(dispute: OwnerDispute, dataDir = process.env.CROSSLINE_DATA_DIR, now = new Date()): void {
  const line = JSON.stringify({ type: "owner.disputed", at: now.toISOString(), ...dispute, title: dispute.title.slice(0, 200),
    ...(dispute.intent ? { intent: dispute.intent.slice(0, 400) } : {}) });
  if (!dataDir) { console.info(line); return; }
  try {
    const dir = path.join(dataDir, "telemetry");
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, "owner-disputes.jsonl"), `${line}\n`, "utf8");
  } catch { /* the log is for reading, never a reason to fail the run */ }
}

/** Records every item the model marked not external while the words say external; returns how many were recorded. */
export function recordOwnerDisputes(workspaceId: string, skill: string,
  items: ReadonlyArray<{ id: string; title: string; intent?: string; external?: boolean }>, dataDir = process.env.CROSSLINE_DATA_DIR): number {
  let count = 0;
  for (const item of items) {
    if (!readExternal(item.external, item.title, item.intent).disputed) continue;
    recordOwnerDispute({ workspaceId, skill, itemId: item.id, title: item.title, ...(item.intent ? { intent: item.intent } : {}) }, dataDir);
    count += 1;
  }
  return count;
}
