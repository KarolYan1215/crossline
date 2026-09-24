"use client";
import { classifyReplay, type DeadLetter } from "@crossline/core";

export type OfflineCommand = {
  ownerId: string;
  workspaceId: string;
  clientCommandId: string;
  clientSequence: number;
  type: "task.capture";
  payload: Record<string, unknown>;
  createdAt: string;
};

/**
 * The offline queue lives in IndexedDB rather than localStorage: localStorage is synchronous, and a
 * service worker cannot read it at all, so a Background Sync replay could never reach the queue.
 * Nothing here is shared with another origin — this is the same browser profile's own store.
 */
const DB_NAME = "crossline-offline";
const DB_VERSION = 1;
const PENDING = "pending";
const DEAD = "dead";
const META = "meta";

const open = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(PENDING)) db.createObjectStore(PENDING, { keyPath: "clientCommandId" });
    if (!db.objectStoreNames.contains(DEAD)) db.createObjectStore(DEAD, { keyPath: "command.clientCommandId" });
    if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error("INDEXEDDB_UNAVAILABLE"));
});

const run = <T>(store: string, mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
  open().then((db) => new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const request = body(transaction.objectStore(store));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("INDEXEDDB_WRITE_FAILED"));
    transaction.oncomplete = () => db.close();
  }));

export const listPending = () => run<OfflineCommand[]>(PENDING, "readonly", (store) => store.getAll());
export const listDeadLetters = () => run<Array<DeadLetter<OfflineCommand>>>(DEAD, "readonly", (store) => store.getAll());
export const enqueue = (command: OfflineCommand) => run(PENDING, "readwrite", (store) => store.put(command));
const removePending = (id: string) => run(PENDING, "readwrite", (store) => store.delete(id));
const putDead = (entry: DeadLetter<OfflineCommand>) => run(DEAD, "readwrite", (store) => store.put(entry));
export const discardDeadLetter = (id: string) => run(DEAD, "readwrite", (store) => store.delete(id));

export async function nextSequence(): Promise<number> {
  const current = await run<number | undefined>(META, "readonly", (store) => store.get("sequence"));
  const next = (current ?? 0) + 1;
  await run(META, "readwrite", (store) => store.put(next, "sequence"));
  return next;
}

export function createCommand(ownerId: string, workspaceId: string, sequence: number,
  type: OfflineCommand["type"], payload: Record<string, unknown>): OfflineCommand {
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

export type ReplaySummary = { sent: number; retrying: number; deadLettered: number };

/**
 * The storage the replay loop touches. Injecting it keeps the loop testable without pulling in an
 * IndexedDB shim just to prove that a rejected command stops being retried.
 */
export type ReplayStore = {
  listPending: () => Promise<OfflineCommand[]>;
  removePending: (id: string) => Promise<unknown>;
  putDead: (entry: DeadLetter<OfflineCommand>) => Promise<unknown>;
};

const indexedDbStore: ReplayStore = { listPending, removePending, putDead };

/**
 * Replays the queue once. A command the server permanently rejected is moved to the dead-letter store
 * instead of being pushed back — otherwise it is retried on every reconnect forever, invisibly, and it
 * blocks nothing but wastes every future replay.
 */
export async function replayQueue(
  send: (command: OfflineCommand) => Promise<{ status: number } | undefined> = defaultSend,
  store: ReplayStore = indexedDbStore
): Promise<ReplaySummary> {
  const pending = (await store.listPending()).sort((a, b) => a.clientSequence - b.clientSequence);
  const summary: ReplaySummary = { sent: 0, retrying: 0, deadLettered: 0 };
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
    if (outcome === "done") { await store.removePending(command.clientCommandId); summary.sent += 1; }
    else if (outcome === "dead_letter") {
      await store.putDead({ command, status: status ?? 0, reason: reason || `服务器拒绝（HTTP ${status}）`, failedAt: new Date().toISOString() });
      await store.removePending(command.clientCommandId);
      summary.deadLettered += 1;
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
