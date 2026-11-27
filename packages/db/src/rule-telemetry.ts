import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { setRuleSink } from "@crossline/core";

/**
 * Where `ruleFired` (packages/core/src/rule-spec.ts) writes: one JSON line per firing in `<data dir>/telemetry/rule-fired.jsonl`, the
 * same pattern as `owner-disputes.jsonl`. Telemetry, never the ledger (CLAUDE.md 「Telemetry is not the ledger」): its readers are
 * `scripts/ablate.ts` and whoever decides to retire a rule. The worker and the web server each install it at start.
 */
export const RULE_FIRED_FILE = "rule-fired.jsonl";

let tickDir: string | undefined;

export function installRuleTelemetry(dataDir: string | undefined): void {
  tickDir = dataDir ? path.join(dataDir, "telemetry") : undefined;
  if (!dataDir) { setRuleSink(undefined); return; }
  const dir = path.join(dataDir, "telemetry");
  const file = path.join(dir, RULE_FIRED_FILE);
  setRuleSink((line) => {
    mkdirSync(dir, { recursive: true });
    appendFileSync(file, `${JSON.stringify(line)}\n`, "utf8");
  });
}

/**
 * Progress ticks that left the ledger on 2026-11-27 (docs/plans/condense-1127.md §C): a gate's model call attempts (read back for the
 * daily spending bound) and a manual's build progress (read back by the page while it builds). One JSON line each in
 * `<data dir>/telemetry/<kind>.jsonl`, installed with the rule telemetry; nothing is written or read before that.
 */
export type TickKind = "gate-attempts" | "manualbook-progress";
export type Tick = { at: string; workspaceId: string; entityId: string; payload: Record<string, unknown> };

export function appendTick(kind: TickKind, tick: Omit<Tick, "at">, now = new Date()): void {
  if (!tickDir) return;
  mkdirSync(tickDir, { recursive: true });
  appendFileSync(path.join(tickDir, `${kind}.jsonl`), `${JSON.stringify({ at: now.toISOString(), ...tick })}\n`, "utf8");
}

/** The ticks of one workspace since `sinceIso`, oldest first. ponytail: reads the whole file; rotate or index it if it ever grows past a few MB. */
export function readTicks(kind: TickKind, workspaceId: string, sinceIso = ""): Tick[] {
  if (!tickDir) return [];
  const file = path.join(tickDir, `${kind}.jsonl`);
  if (!existsSync(file)) return [];
  const out: Tick[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const tick = JSON.parse(line) as Tick;
      if (tick.workspaceId === workspaceId && tick.at >= sinceIso) out.push(tick);
    } catch { /* a torn last line from a crash: skip it */ }
  }
  return out;
}
