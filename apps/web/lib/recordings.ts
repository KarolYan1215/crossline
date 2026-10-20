import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RECORDING_CONSENT, RECORDING_FILE, RECORDING_INBOX_SEGMENTS, RECORDING_MODEL_NOTICE, RECORDING_SERVER_CONSENT, RECORDING_PURGED_EVENT, RECORDING_SILENT_EVENT, RECORDING_TRANSCRIBED_EVENT, SOURCE_FOLDERS_SETTING,
  readSourceFolders, sourceFolderIndexSetting, transcriptionCost, type FolderIndexEntry, type RecordingTranscribed
} from "@crossline/core";
import type { CrosslineStore } from "@crossline/db";

/**
 * 录音自动转写 on the web side (docs/phone-recording.md): what the settings card shows, and turning it off — with the transcripts kept
 * or deleted, as the person chooses. The transcription itself is the worker's (`apps/worker/src/recordings.ts`).
 */
export type RecordingOverview = {
  on: boolean; folders: number; queued: number; done: number; silent: number;
  failed: Array<{ file: string; note: string }>;
  cost?: { recordings: number; audioHours: number; minutesPerHour: number };
  /** 录音在服务器转写, when this deployment runs the transcriber: whether it is on, what waits, and the last few that failed. */
  server?: { on: boolean; waiting: number; failed: Array<{ file: string; note: string }> };
};

const entries = (store: CrosslineStore, workspaceId: string) => readSourceFolders(store.getSetting(workspaceId, SOURCE_FOLDERS_SETTING)).flatMap((folder) => {
  let index: Record<string, FolderIndexEntry> = {};
  try { index = JSON.parse(store.getSetting(workspaceId, sourceFolderIndexSetting(folder.id)) ?? "{}") as Record<string, FolderIndexEntry>; } catch { /* unreadable counts as empty */ }
  return Object.entries(index).filter(([, entry]) => entry.audio).map(([relative, entry]) => ({ folder, relative, entry }));
});

export function recordingOverview(store: CrosslineStore, workspaceId: string, dataDir?: string): RecordingOverview {
  const all = entries(store, workspaceId);
  const recent = store.listEvents(workspaceId, { type: RECORDING_TRANSCRIBED_EVENT }).slice(-20).map((event) => event.payload as RecordingTranscribed);
  const cost = transcriptionCost(recent);
  return { on: store.getSetting(workspaceId, RECORDING_CONSENT) === "granted",
    folders: readSourceFolders(store.getSetting(workspaceId, SOURCE_FOLDERS_SETTING)).length,
    queued: all.filter((item) => item.entry.audio === "queued").length,
    done: store.listEvents(workspaceId, { type: RECORDING_TRANSCRIBED_EVENT }).length,
    silent: store.listEvents(workspaceId, { type: RECORDING_SILENT_EVENT }).length,
    failed: all.filter((item) => item.entry.audio === "failed").slice(0, 5).map((item) => ({ file: `${item.folder.label}/${item.relative.replace(/\\/g, "/")}`, note: item.entry.note ?? "" })),
    ...(cost ? { cost } : {}),
    ...(serverTranscribeAvailable() && dataDir ? { server: { on: store.getSetting(workspaceId, RECORDING_SERVER_CONSENT) === "granted", waiting: serverInboxCount(dataDir, workspaceId),
      failed: store.listEvents(workspaceId, { type: "recording.failed" }).slice(-5).reverse()
        .map((event) => ({ file: String((event.payload as { fileName?: unknown }).fileName ?? ""), note: String((event.payload as { message?: unknown }).message ?? "") })) } } : {}) };
}

/**
 * Turns 录音自动转写 on or off. Off stops the worker at its next piece; with `keep: false` every transcript it made is deleted too (its
 * row and its text file in `sources/`, unless something else still reads that file) and the recordings stay marked done, so turning it
 * on again does not transcribe them anew.
 */
export function setRecordingConsent(store: CrosslineStore, workspaceId: string, on: boolean, options: { keep?: boolean; dataDir: string; ownerId: string }): { deleted: number } {
  store.setSetting(workspaceId, RECORDING_CONSENT, on ? "granted" : "denied");
  // A later lack of the model is said again.
  if (on) store.deleteSetting(workspaceId, RECORDING_MODEL_NOTICE);
  if (on || options.keep !== false) return { deleted: 0 };
  return { deleted: purgeRecordingTranscripts(store, workspaceId, options.dataDir, options.ownerId) };
}

/** Whether this deployment runs the transcriber container (`deploy/server/run.sh` with `CROSSLINE_SERVER_TRANSCRIBE=1`). */
export const serverTranscribeAvailable = () => process.env.CROSSLINE_SERVER_TRANSCRIBE === "1";
const inbox = (dataDir: string, workspaceId: string) => path.join(dataDir, ...RECORDING_INBOX_SEGMENTS, workspaceId);

/** Uploads waiting in this workspace's server inbox. */
export function serverInboxCount(dataDir: string, workspaceId: string): number {
  try { return readdirSync(inbox(dataDir, workspaceId)).filter((name) => RECORDING_FILE.test(name)).length; } catch { return 0; }
}

/**
 * Turns 录音在服务器转写 on or off. Off refuses further uploads, deletes every recording still waiting in the inbox (the audio was only
 * ever there to be transcribed) and, with `keep: false`, the transcripts too.
 */
export function setServerRecordingConsent(store: CrosslineStore, workspaceId: string, on: boolean, options: { keep?: boolean; dataDir: string; ownerId: string }): { deleted: number; discarded: number } {
  store.setSetting(workspaceId, RECORDING_SERVER_CONSENT, on ? "granted" : "denied");
  if (on) return { deleted: 0, discarded: 0 };
  const discarded = serverInboxCount(options.dataDir, workspaceId);
  rmSync(inbox(options.dataDir, workspaceId), { recursive: true, force: true });
  const deleted = options.keep === false ? purgeRecordingTranscripts(store, workspaceId, options.dataDir, options.ownerId) : 0;
  return { deleted, discarded };
}

/** Deletes every transcript made from a recording (row and file) and marks the recordings done, so they are not transcribed again. */
function purgeRecordingTranscripts(store: CrosslineStore, workspaceId: string, dataDir: string, ownerId: string): number {
  const sources = path.resolve(dataDir, "sources");
  let deleted = 0;
  for (const event of store.listEvents(workspaceId, { type: RECORDING_TRANSCRIBED_EVENT })) {
    const gone = store.deleteSourceDocument(workspaceId, String((event.payload as { documentId?: unknown }).documentId ?? ""));
    if (!gone) continue;
    deleted += 1;
    if (gone.uriInUse) continue;
    try { const file = fileURLToPath(gone.uri); if (path.resolve(file).startsWith(sources + path.sep)) rmSync(file, { force: true }); } catch { /* not a local copy */ }
  }
  for (const folder of readSourceFolders(store.getSetting(workspaceId, SOURCE_FOLDERS_SETTING))) {
    const key = sourceFolderIndexSetting(folder.id);
    let index: Record<string, FolderIndexEntry> = {};
    try { index = JSON.parse(store.getSetting(workspaceId, key) ?? "{}") as Record<string, FolderIndexEntry>; } catch { continue; }
    let changed = false;
    for (const entry of Object.values(index)) if (entry.audio === "done" && entry.documentId) { entry.documentId = ""; entry.note = "转写已按本人选择删除"; changed = true; }
    if (changed) store.setSetting(workspaceId, key, JSON.stringify(index));
  }
  store.appendEvent({ ownerId, workspaceId, idempotencyKey: `${RECORDING_PURGED_EVENT}:${Date.now()}`, type: RECORDING_PURGED_EVENT, entityId: workspaceId, payload: { deleted } });
  return deleted;
}
