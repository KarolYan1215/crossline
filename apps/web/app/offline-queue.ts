"use client";
import Dexie, { type Table } from "dexie";
import { classifyReplay, type DeadLetter } from "@crossline/core";

export type OfflineCommandType =
  | "task.capture" | "work_order.start" | "work_order.pause" | "work_order.resume" | "work_order.complete";

export type OfflineCommand = {
  ownerId: string;
  workspaceId: string;
  clientCommandId: string;
  clientSequence: number;
  type: OfflineCommandType;
  payload: Record<string, unknown>;
  createdAt: string;
};

const WORKSPACE_KEY = "crossline.offline.workspaceId";
const DEVICE_KEY = "crossline.offline.deviceId";

/**
 * Both live in `localStorage`, not Dexie: the device id has to survive an `indexedDB.deleteDatabase`
 * (clearing the queue must not also make the browser look like a new device), and the workspace id has
 * to be readable with no network and no server-rendered props at all — the `/offline` fallback page is
 * served from the service worker's precache, not freshly rendered, so it cannot receive one as a prop.
 */
export function currentWorkspaceId(): string | null {
  try { return localStorage.getItem(WORKSPACE_KEY); } catch { return null; }
}

export function rememberWorkspace(workspaceId: string): void {
  try { localStorage.setItem(WORKSPACE_KEY, workspaceId); } catch { /* private browsing or similar */ }
}

export function deviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_KEY);
    if (existing) return existing;
    const generated = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, generated);
    return generated;
  } catch { return crypto.randomUUID(); }
}

type ReplayRecord = { clientCommandId: string; command: OfflineCommand; status: number; reason: string; failedAt: string };
type StoredCommand = OfflineCommand & { encrypted: boolean };
type MetaRow = { key: string; value: unknown };

/**
 * `crossline-offline-${workspaceId}`, not a fixed name: switching accounts must not read the previous
 * account's queued captures and in-flight work-order actions as if they belonged to the new one, and a
 * fixed database name was exactly that hazard.
 */
class OfflineDatabase extends Dexie {
  pending!: Table<StoredCommand, string>;
  dead!: Table<ReplayRecord, string>;
  conflicts!: Table<ReplayRecord, string>;
  meta!: Table<MetaRow, string>;

  constructor(workspaceId: string) {
    super(`crossline-offline-${workspaceId}`);
    this.version(1).stores({
      pending: "clientCommandId, clientSequence",
      dead: "clientCommandId",
      conflicts: "clientCommandId",
      meta: "key"
    });
  }
}

/**
 * A non-extractable AES-GCM key, generated once per workspace database and stored directly as a
 * `CryptoKey` object — IndexedDB structured-clones `CryptoKey` natively, so this never touches raw key
 * bytes. This is the one piece the plan itself flagged as the most engineering-uncertain part of the
 * whole stage: if a target browser cannot round-trip a persisted non-extractable `CryptoKey` (getting it
 * back `null`/throwing on decrypt after a reload), every write here falls back to storing the payload in
 * the clear rather than silently losing captures — `encrypted: false` on the record says which happened.
 * Proven to round-trip in this repo's actual e2e browser (Chromium) by `offline-queue.test.ts`.
 */
async function getOrCreateKey(db: OfflineDatabase): Promise<CryptoKey | undefined> {
  try {
    const row = await db.meta.get("cryptoKey");
    if (row?.value instanceof CryptoKey) return row.value;
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await db.meta.put({ key: "cryptoKey", value: key });
    return key;
  } catch { return undefined; }
}

async function encryptPayload(key: CryptoKey, payload: Record<string, unknown>): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const buffer = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  return { ciphertext: btoa(String.fromCharCode(...new Uint8Array(buffer))), iv: btoa(String.fromCharCode(...iv)) };
}

async function decryptPayload(key: CryptoKey, ciphertext: string, iv: string): Promise<Record<string, unknown>> {
  const cipherBytes = Uint8Array.from(atob(ciphertext), (char) => char.charCodeAt(0));
  const ivBytes = Uint8Array.from(atob(iv), (char) => char.charCodeAt(0));
  const buffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ivBytes }, key, cipherBytes);
  return JSON.parse(new TextDecoder().decode(buffer)) as Record<string, unknown>;
}

async function readPending(db: OfflineDatabase): Promise<OfflineCommand[]> {
  const rows = await db.pending.toArray();
  const key = rows.some((row) => row.encrypted) ? await getOrCreateKey(db) : undefined;
  return Promise.all(rows.map(async (row) => {
    if (!row.encrypted) return row;
    if (!key) throw new Error("OFFLINE_KEY_UNAVAILABLE");
    const { ciphertext, iv } = row.payload as unknown as { ciphertext: string; iv: string };
    return { ...row, payload: await decryptPayload(key, ciphertext, iv) };
  }));
}

export async function listPending(workspaceId: string): Promise<OfflineCommand[]> {
  return readPending(new OfflineDatabase(workspaceId));
}

export async function listDeadLetters(workspaceId: string): Promise<Array<DeadLetter<OfflineCommand>>> {
  return (await new OfflineDatabase(workspaceId).dead.toArray()).map((row) => ({
    command: row.command, status: row.status, reason: row.reason, failedAt: row.failedAt
  }));
}

export async function listConflicts(workspaceId: string): Promise<Array<DeadLetter<OfflineCommand>>> {
  return (await new OfflineDatabase(workspaceId).conflicts.toArray()).map((row) => ({
    command: row.command, status: row.status, reason: row.reason, failedAt: row.failedAt
  }));
}

export async function enqueue(workspaceId: string, command: OfflineCommand): Promise<void> {
  const db = new OfflineDatabase(workspaceId);
  const key = await getOrCreateKey(db);
  if (!key) { await db.pending.put({ ...command, encrypted: false }); return; }
  const { ciphertext, iv } = await encryptPayload(key, command.payload);
  await db.pending.put({ ...command, payload: { ciphertext, iv } as unknown as Record<string, unknown>, encrypted: true });
}

export async function discardDeadLetter(workspaceId: string, id: string): Promise<void> {
  await new OfflineDatabase(workspaceId).dead.delete(id);
}

export async function discardConflict(workspaceId: string, id: string): Promise<void> {
  await new OfflineDatabase(workspaceId).conflicts.delete(id);
}

export async function nextSequence(workspaceId: string): Promise<number> {
  const db = new OfflineDatabase(workspaceId);
  return db.transaction("rw", db.meta, async () => {
    const row = await db.meta.get("sequence");
    const next = (typeof row?.value === "number" ? row.value : 0) + 1;
    await db.meta.put({ key: "sequence", value: next });
    return next;
  });
}

export function createCommand(ownerId: string, workspaceId: string, sequence: number,
  type: OfflineCommandType, payload: Record<string, unknown>): OfflineCommand {
  return {
    ownerId,
    workspaceId,
    clientCommandId: crypto.randomUUID(),
    clientSequence: sequence,
    type,
    payload,
    createdAt: new Date().toISOString()
  };
}

/** Deletes the workspace's whole offline database and forgets the remembered workspace and device id —
 * called on sign-out so the next person to use this browser starts from nothing. */
export async function clearOfflineData(workspaceId: string): Promise<void> {
  await Dexie.delete(`crossline-offline-${workspaceId}`);
  try { localStorage.removeItem(WORKSPACE_KEY); localStorage.removeItem(DEVICE_KEY); } catch { /* ignore */ }
}

export type ReplaySummary = { sent: number; retrying: number; deadLettered: number; conflicted: number };

/**
 * The storage the replay loop touches. Injecting it keeps the loop testable without pulling Dexie or an
 * IndexedDB shim into a pure unit test of the retry/dead-letter/conflict classification itself.
 */
export type ReplayStore = {
  listPending: () => Promise<OfflineCommand[]>;
  removePending: (id: string) => Promise<unknown>;
  putDead: (entry: DeadLetter<OfflineCommand>) => Promise<unknown>;
  putConflict: (entry: DeadLetter<OfflineCommand>) => Promise<unknown>;
};

function dexieStore(workspaceId: string): ReplayStore {
  const db = new OfflineDatabase(workspaceId);
  return {
    listPending: () => readPending(db),
    removePending: (id) => db.pending.delete(id),
    putDead: (entry) => db.dead.put({ clientCommandId: entry.command.clientCommandId, command: entry.command,
      status: entry.status, reason: entry.reason, failedAt: entry.failedAt }),
    putConflict: (entry) => db.conflicts.put({ clientCommandId: entry.command.clientCommandId, command: entry.command,
      status: entry.status, reason: entry.reason, failedAt: entry.failedAt })
  };
}

/**
 * Replays the queue once. A command the server permanently rejected is moved to the dead-letter store
 * instead of being pushed back — otherwise it is retried on every reconnect forever, invisibly, and it
 * blocks nothing but wastes every future replay. A command the server refused because the work order it
 * names moved on (409 — see `classifyReplay`) goes to the conflicts store instead: it was not wrong when
 * it was written, so silently discarding it would lose a real decision the person made offline.
 */
export async function replayQueue(
  workspaceId: string,
  send: (command: OfflineCommand) => Promise<{ status: number } | undefined> = defaultSend,
  store?: ReplayStore
): Promise<ReplaySummary> {
  const active = store ?? dexieStore(workspaceId);
  const pending = (await active.listPending()).sort((a, b) => a.clientSequence - b.clientSequence);
  const summary: ReplaySummary = { sent: 0, retrying: 0, deadLettered: 0, conflicted: 0 };
  for (const command of pending) {
    let status: number | undefined;
    let reason = "";
    try {
      const response = await send(command);
      status = response?.status;
    } catch (error) {
      reason = error instanceof Error ? error.message.slice(0, 120) : "network error";
    }
    const outcome = classifyReplay(status);
    if (outcome === "done") { await active.removePending(command.clientCommandId); summary.sent += 1; }
    else if (outcome === "dead_letter") {
      await active.putDead({ command, status: status ?? 0, reason: reason || `服务器拒绝（HTTP ${status}）`, failedAt: new Date().toISOString() });
      await active.removePending(command.clientCommandId);
      summary.deadLettered += 1;
    } else if (outcome === "conflict") {
      await active.putConflict({ command, status: status ?? 409, reason: reason || "该作业已被其他设备或网页改变状态", failedAt: new Date().toISOString() });
      await active.removePending(command.clientCommandId);
      summary.conflicted += 1;
    } else summary.retrying += 1;
  }
  return summary;
}

async function defaultSend(command: OfflineCommand): Promise<{ status: number }> {
  const response = await fetch("/api/commands", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command)
  });
  return { status: response.status };
}
