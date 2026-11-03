import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { RECORDING_SILENT_EVENT, RECORDING_TRANSCRIBED_EVENT } from "@crossline/core";
import { isWorkspaceMirror, replaceWorkspaceFrom, type CrosslineStore } from "@crossline/db";
import { folderDocuments } from "../source-folders";
import type { DeviceState } from "./payloads";

/**
 * The device mirror (docs/device-mode.md): the hosted ledger, one way, onto this computer's own workspace, every ten minutes while
 * linked. Nothing goes back up this way (the outbox stays the only way up), so there is nothing to merge and no model work runs twice.
 * Kept from this computer: its own settings (`mirrorLocalSetting`), its screen segments (titles stay here), its daily activity rows, the
 * files its folders read and the recordings it transcribed, with their events — everything the device passes and the `/device` page read.
 */
export const MIRROR_INTERVAL_MS = 10 * 60_000;
export const MIRROR_BACKUPS_KEPT = 3;

export type MirrorState = { at?: string; etag?: string; checkedAt?: string; error?: string; errorAt?: string };

const LOCAL_EVENTS = /^(?:recording\.(?:transcribed|silent)|sources\.folder_)/;

/** Which local rows the device keeps over the mirror. */
export function deviceKeeps(store: CrosslineStore, workspaceId: string): (table: string, row: Record<string, unknown>) => boolean {
  const documents = new Set(folderDocuments(store, workspaceId).keys());
  for (const event of store.listEvents(workspaceId, { type: [RECORDING_TRANSCRIBED_EVENT, RECORDING_SILENT_EVENT] })) {
    const id = (event.payload as { documentId?: unknown }).documentId;
    if (typeof id === "string" && id) documents.add(id);
  }
  return (table, row) => table === "source_documents" ? documents.has(String(row.id))
    : table === "events" ? LOCAL_EVENTS.test(String(row.type))
    : table === "energy_observations" ? String(row.id).startsWith("local-activity:")
    : false;
}

/** One copy of the ledger file a day, before the day's first replace; the last three kept. */
async function backupOnce(store: CrosslineStore, ledger: string, now: Date): Promise<void> {
  const file = `${ledger}.mirror-${now.toISOString().slice(0, 10)}.bak`;
  if (existsSync(file)) return;
  await store.backupTo(file);
  const prefix = `${path.basename(ledger)}.mirror-`;
  const copies = readdirSync(path.dirname(ledger)).filter((name) => name.startsWith(prefix) && name.endsWith(".bak")).sort();
  for (const old of copies.slice(0, -MIRROR_BACKUPS_KEPT)) rmSync(path.join(path.dirname(ledger), old), { force: true });
}

/**
 * Fetches the mirror (with the last ETag, so an unchanged ledger is a 304) and replaces this computer's workspace with it. Records the
 * outcome in `state.mirror`, outside the ledger (the ledger is what gets replaced); a failure is said there and tried again next pass.
 */
export async function mirrorPass(input: { store: CrosslineStore; ledger: string; workspaceId: string | undefined; link: { url: string; token: string | undefined };
  state: DeviceState; fetch?: typeof fetch; now?: Date }): Promise<MirrorState> {
  const { store, workspaceId, link, state } = input;
  const now = input.now ?? new Date();
  const previous = state.mirror ?? {};
  const failed = (error: string) => (state.mirror = { ...previous, error, errorAt: now.toISOString() });
  if (!workspaceId) return failed("DEVICE_NO_LOCAL_WORKSPACE");
  if (!link.token) return failed("DEVICE_TOKEN_UNREADABLE");
  try {
    const response = await (input.fetch ?? fetch)(new URL("/api/device/snapshot", link.url), { signal: AbortSignal.timeout(5 * 60_000),
      headers: { authorization: `Bearer ${link.token}`, ...(previous.etag && !previous.error ? { "if-none-match": previous.etag } : {}) } });
    if (response.status === 304) return (state.mirror = { ...previous, checkedAt: now.toISOString() });
    if (!response.ok) return failed(`DEVICE_MIRROR_HTTP_${response.status}`);
    const mirror = JSON.parse(gunzipSync(Buffer.from(await response.arrayBuffer())).toString("utf8")) as unknown;
    if (!isWorkspaceMirror(mirror)) return failed("DEVICE_MIRROR_INVALID");
    await backupOnce(store, input.ledger, now);
    const recordingShas = () => store.listEvents(workspaceId, { type: [RECORDING_TRANSCRIBED_EVENT, RECORDING_SILENT_EVENT] }).map((event) => event.entityId);
    const ours = new Set(recordingShas());
    replaceWorkspaceFrom(store, mirror, { workspaceId, keep: deviceKeeps(store, workspaceId), spare: ["activity_segments"] });
    // Recordings the site transcribed itself (the phone's inbox) are now in this ledger too: they are the site's, never this device's to send.
    state.recordings = [...new Set([...state.recordings, ...recordingShas().filter((sha) => !ours.has(sha))])];
    return (state.mirror = { at: now.toISOString(), checkedAt: now.toISOString(), etag: response.headers.get("etag") ?? "" });
  } catch (error) {
    return failed(error instanceof Error ? error.message.slice(0, 200) : String(error));
  }
}
