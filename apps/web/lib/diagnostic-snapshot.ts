import "server-only";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { CrosslineStore } from "@crossline/db";

/**
 * 「上传诊断快照」 (docs/local-installer.md, 脱敏快照): the whole ledger's shape — every table, every row, states, times, durations
 * and counts — with every piece of free text replaced by `{len, h}`, where `h` is a keyed hash only this install can produce (a
 * plain SHA-256 of a short text like 「是」 is reversed by guessing). Ids become keyed hashes too, so rows still join. The person sees
 * exactly what would be sent, adds a note if they like, and only then is it uploaded.
 *
 * What is kept as it is is decided by column, not by guessing at values: numbers, booleans and nulls; times in time columns; short
 * code tokens in the few columns that hold codes. Everything else that is a string — titles, messages, payloads, JSON settings,
 * file names, URLs — is hashed whole.
 */
export type Redacted = { len: number; h: string };
type Cell = string | number | boolean | null | Redacted;

const TOKEN_COLUMNS = new Set(["state", "status", "type", "kind", "role", "tier", "stage", "verdict", "family", "risk_tier", "spend_mode", "effort",
  "model", "source", "executor", "mode", "key", "provider_id", "decision", "method", "outcome", "confidence", "energy", "priority", "urgency", "error_code"]);
const TOKEN = /^[a-z][a-z0-9_.:-]{0,60}$|^[A-Z][A-Z0-9_]{2,63}$/;
const TIME_COLUMN = /(^|_)(at|date|day|deadline|until|since|start|end|due|expires|starts|ends)$/;
const TIME = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const ID_COLUMN = /^id$|_id$|^idempotency_key$|^event_id$|^jti$/;

export function redactCell(column: string, value: unknown, salt: string): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const keyed = createHmac("sha256", salt).update(text).digest("hex").slice(0, 16);
  if (ID_COLUMN.test(column)) return keyed;
  if (TIME_COLUMN.test(column) && TIME.test(text)) return text;
  if (TOKEN_COLUMNS.has(column) && TOKEN.test(text)) return text;
  return { len: [...text].length, h: keyed };
}

export type DiagnosticSnapshot = {
  format: "crossline.diagnostic-snapshot.v1";
  createdAt: string;
  version: string;
  tables: Record<string, Array<Record<string, Cell>>>;
};

export function redactedSnapshot(store: Pick<CrosslineStore, "exportSnapshot">, workspaceId: string, salt: string,
  version = process.env.CROSSLINE_APP_VERSION ?? "0.0.0-dev", now = new Date()): DiagnosticSnapshot {
  const raw = (store.exportSnapshot(workspaceId) as { tables?: Record<string, Array<Record<string, unknown>>> }).tables ?? {};
  const tables = Object.fromEntries(Object.entries(raw).map(([name, rows]) => [name,
    rows.map((row) => Object.fromEntries(Object.entries(row).map(([column, value]) => [column, redactCell(column, value, salt)])))]));
  return { format: "crossline.diagnostic-snapshot.v1", createdAt: now.toISOString(), version, tables };
}

/** What the preview shows above the full JSON: rows per table and the size that would be sent. */
export function snapshotSummary(snapshot: DiagnosticSnapshot): { tables: Array<{ name: string; rows: number }>; bytes: number; gzipBytes: number } {
  const json = JSON.stringify(snapshot);
  return { tables: Object.entries(snapshot.tables).map(([name, rows]) => ({ name, rows: rows.length })).filter((table) => table.rows > 0),
    bytes: Buffer.byteLength(json), gzipBytes: gzipSync(json).length };
}

/**
 * Previews are kept in memory, keyed by a random id, for half an hour: what is uploaded is the very object the person looked at,
 * not a fresh export that may have changed since.
 */
const previews = new Map<string, { workspaceId: string; snapshot: DiagnosticSnapshot; at: number }>();
const PREVIEW_TTL_MS = 30 * 60_000;
export function rememberPreview(workspaceId: string, snapshot: DiagnosticSnapshot): string {
  for (const [id, preview] of previews) if (Date.now() - preview.at > PREVIEW_TTL_MS) previews.delete(id);
  const id = randomUUID();
  previews.set(id, { workspaceId, snapshot, at: Date.now() });
  return id;
}
export function takePreview(workspaceId: string, id: string): DiagnosticSnapshot | undefined {
  const preview = previews.get(id);
  if (!preview || preview.workspaceId !== workspaceId || Date.now() - preview.at > PREVIEW_TTL_MS) return undefined;
  previews.delete(id);
  return preview.snapshot;
}

export const SNAPSHOT_MAX_GZIP_BYTES = 1_900_000;
export const FEEDBACK_MAX_CHARS = 4000;

/**
 * Uploads a previewed snapshot and the person's note to the owner's collector. The note is the one piece of free text that leaves
 * the machine, typed for that purpose and shown before sending.
 */
export async function uploadSnapshot(snapshot: DiagnosticSnapshot, feedback: string, account: string | undefined,
  env: Record<string, string | undefined> = process.env, fetcher: typeof fetch = fetch): Promise<{ ok: true; id: string } | { ok: false; code: string }> {
  const url = env.CROSSLINE_TELEMETRY_URL, install = env.CROSSLINE_INSTALL_ID;
  if (!url || !install) return { ok: false, code: "COLLECTOR_NOT_CONFIGURED" };
  const body = gzipSync(JSON.stringify({ install, version: snapshot.version, createdAt: snapshot.createdAt,
    ...(account ? { account: createHash("sha256").update(account.trim().toLowerCase()).digest("hex") } : {}),
    feedback: feedback.slice(0, FEEDBACK_MAX_CHARS), snapshot }));
  if (body.length > SNAPSHOT_MAX_GZIP_BYTES) return { ok: false, code: "SNAPSHOT_TOO_LARGE" };
  const response = await fetcher(new URL("/v1/snapshots", url), { method: "POST",
    headers: { "content-type": "application/octet-stream", "x-crossline-encoding": "gzip", "x-crossline-install": install },
    body, signal: AbortSignal.timeout(60_000) }).catch(() => undefined);
  if (!response?.ok) return { ok: false, code: response ? `HTTP_${response.status}` : "NETWORK" };
  const answer = await response.json().catch(() => ({})) as { id?: unknown };
  return { ok: true, id: typeof answer.id === "string" ? answer.id : "" };
}
