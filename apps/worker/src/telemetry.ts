import { createHash, createHmac } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { APP_PAGES, sanitizeTelemetryBatch, TELEMETRY_ENABLED_SETTING, telemetryFromLedgerEvent, type TelemetryBatch } from "@crossline/core";
import type { CrosslineStore } from "@crossline/db";

/**
 * Sends an installed copy's usage metadata to the owner's collector every fifteen minutes (docs/local-installer.md, 回传). Only on
 * an installed copy (the launcher sets the install id, salt, version and collector URL), only while the person has not turned it
 * off in Settings, and only what `sanitizeTelemetryBatch` lets through — the last call before the request, on the whole batch.
 * Cursors move only after the collector accepted a batch, so nothing is lost to a network failure and nothing is sent twice.
 */
export { TELEMETRY_ENABLED_SETTING };
export const TELEMETRY_CURSOR_SETTING = "telemetry.cursor";

type Cursor = { eventRow: number; usageId: number; roundAt: string };
export type TelemetryDeps = {
  store: CrosslineStore;
  workspaceId: string | undefined;
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  /** The machine Codex's ChatGPT email, hashed before it is used; undefined when it cannot be read. */
  accountEmail?: () => Promise<string | undefined>;
  fetch?: typeof fetch;
  now?: () => Date;
};

export type TelemetryOutcome = { sent: number } | { skipped: "NOT_INSTALLED" | "TURNED_OFF" | "NO_WORKSPACE" | "NOTHING_NEW" } | { failed: string };

export function telemetryEnabled(store: Pick<CrosslineStore, "getSetting">, workspaceId: string): boolean {
  return store.getSetting(workspaceId, TELEMETRY_ENABLED_SETTING) !== "0";
}

function readCursor(store: CrosslineStore, workspaceId: string): Cursor {
  try {
    const saved = JSON.parse(store.getSetting(workspaceId, TELEMETRY_CURSOR_SETTING) ?? "{}") as Partial<Cursor>;
    return { eventRow: Number(saved.eventRow) || 0, usageId: Number(saved.usageId) || 0, roundAt: typeof saved.roundAt === "string" ? saved.roundAt : "" };
  } catch { return { eventRow: 0, usageId: 0, roundAt: "" }; }
}

/** Page views wait in `data/telemetry/pages.jsonl`; a send takes the file whole (renamed first, so the web keeps appending to a new one). */
function takePages(dataDir: string): { file: string; lines: unknown[] } {
  const outbox = path.join(dataDir, "telemetry", "pages.jsonl");
  const sending = `${outbox}.sending`;
  if (!existsSync(sending) && existsSync(outbox)) renameSync(outbox, sending);
  if (!existsSync(sending)) return { file: sending, lines: [] };
  const lines = readFileSync(sending, "utf8").split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line) as unknown]; } catch { return []; } });
  return { file: sending, lines };
}

const COUNTED: Record<string, "captures" | "tasks" | "milestones" | "timers" | "confirmations"> = {
  "capture.created": "captures", "analysis.proposed": "tasks", "milestone.proposed": "milestones", "human.started": "timers",
  "plan.approved": "confirmations", "ask.answered": "confirmations", "evidence.accepted": "confirmations"
};

export async function telemetryPass(deps: TelemetryDeps): Promise<TelemetryOutcome> {
  const env = deps.env ?? process.env;
  const url = env.CROSSLINE_TELEMETRY_URL, install = env.CROSSLINE_INSTALL_ID, salt = env.CROSSLINE_TELEMETRY_SALT, version = env.CROSSLINE_APP_VERSION;
  if (!url || !install || !salt || !version) return { skipped: "NOT_INSTALLED" };
  const pagesTaken = takePages(deps.dataDir);
  if (!deps.workspaceId) return { skipped: "NO_WORKSPACE" };
  if (!telemetryEnabled(deps.store, deps.workspaceId)) {
    // What happened while sending was off is never sent: the cursors follow the ledger, so turning it back on starts from then.
    rmSync(pagesTaken.file, { force: true });
    let cursor = readCursor(deps.store, deps.workspaceId), moved = false;
    for (;;) {
      const read = deps.store.telemetrySince(deps.workspaceId, cursor);
      if (!read.events.length && !read.usage.length && !read.rounds.length) break;
      cursor = { eventRow: read.events.at(-1)?.row ?? cursor.eventRow, usageId: read.usage.at(-1)?.id ?? cursor.usageId,
        roundAt: read.rounds.at(-1)?.createdAt ?? cursor.roundAt };
      moved = true;
    }
    if (moved) deps.store.setSetting(deps.workspaceId, TELEMETRY_CURSOR_SETTING, JSON.stringify(cursor));
    return { skipped: "TURNED_OFF" };
  }
  const now = (deps.now ?? (() => new Date()))();
  const cursor = readCursor(deps.store, deps.workspaceId);
  const read = deps.store.telemetrySince(deps.workspaceId, cursor);
  const entity = (id: string) => createHmac("sha256", salt).update(id).digest("hex").slice(0, 16);

  const events: unknown[] = [];
  if (!cursor.eventRow && !cursor.usageId && !cursor.roundAt) events.push({ type: "install.started", at: now.toISOString(), version });
  for (const event of read.events) { const mapped = telemetryFromLedgerEvent(event, { entity, version }); if (mapped) events.push(mapped); }
  for (const run of read.usage) events.push({ type: "skill.run", at: run.at, version, skill: run.skill.replace(/^crossline:/, ""), ok: run.ok, ms: run.ms, repairs: run.repairs,
    ...(run.code ? { code: run.code } : {}), tokens: { input: run.input, cached: run.cached, output: run.output } });
  for (const round of read.rounds) events.push({ type: "onboarding.round", at: round.createdAt, version, counts: { rounds: round.seq }, ...(round.stage ? { stage: round.stage } : {}) });
  for (const view of pagesTaken.lines) {
    const page = view as { page?: unknown; at?: unknown };
    // A view whose page is not one of the app's route templates is not a view of anything this reports.
    if (typeof page.page === "string" && (APP_PAGES as readonly string[]).includes(page.page)) events.push({ type: "page.viewed", at: page.at, version, page: page.page });
  }
  const today = now.toISOString().slice(0, 10);
  const counts: Record<string, number> = {};
  for (const event of read.events) if (event.createdAt.startsWith(today) && COUNTED[event.type]) counts[COUNTED[event.type]!] = (counts[COUNTED[event.type]!] ?? 0) + 1;
  if (Object.keys(counts).length) events.push({ type: "counts.today", at: now.toISOString(), version, counts });
  if (!events.length) return { skipped: "NOTHING_NEW" };

  const email = await deps.accountEmail?.().catch(() => undefined);
  const batch: TelemetryBatch | undefined = sanitizeTelemetryBatch({ install, version, sentAt: now.toISOString(), events,
    ...(email ? { account: createHash("sha256").update(email.trim().toLowerCase()).digest("hex") } : {}) }, new Set<string>(APP_PAGES));
  if (!batch) return { failed: "BATCH_INVALID" };
  const response = await (deps.fetch ?? fetch)(new URL("/v1/events", url), { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(batch), signal: AbortSignal.timeout(20_000) }).catch(() => undefined);
  if (!response?.ok) return { failed: response ? `HTTP_${response.status}` : "NETWORK" };
  deps.store.setSetting(deps.workspaceId, TELEMETRY_CURSOR_SETTING, JSON.stringify({
    eventRow: read.events.at(-1)?.row ?? cursor.eventRow, usageId: read.usage.at(-1)?.id ?? cursor.usageId,
    roundAt: read.rounds.at(-1)?.createdAt ?? cursor.roundAt }));
  rmSync(pagesTaken.file, { force: true });
  return { sent: batch.events.length };
}
