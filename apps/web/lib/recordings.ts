import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RECORDING_CONSENT, RECORDING_MODEL_NOTICE, RECORDING_PURGED_EVENT, RECORDING_SILENT_EVENT, RECORDING_TRANSCRIBED_EVENT, SOURCE_FOLDERS_SETTING,
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
};

const entries = (store: CrosslineStore, workspaceId: string) => readSourceFolders(store.getSetting(workspaceId, SOURCE_FOLDERS_SETTING)).flatMap((folder) => {
  let index: Record<string, FolderIndexEntry> = {};
  try { index = JSON.parse(store.getSetting(workspaceId, sourceFolderIndexSetting(folder.id)) ?? "{}") as Record<string, FolderIndexEntry>; } catch { /* unreadable counts as empty */ }
  return Object.entries(index).filter(([, entry]) => entry.audio).map(([relative, entry]) => ({ folder, relative, entry }));
});

export function recordingOverview(store: CrosslineStore, workspaceId: string): RecordingOverview {
  const all = entries(store, workspaceId);
  const recent = store.listEvents(workspaceId, { type: RECORDING_TRANSCRIBED_EVENT }).slice(-20).map((event) => event.payload as RecordingTranscribed);
  const cost = transcriptionCost(recent);
  return { on: store.getSetting(workspaceId, RECORDING_CONSENT) === "granted",
    folders: readSourceFolders(store.getSetting(workspaceId, SOURCE_FOLDERS_SETTING)).length,
    queued: all.filter((item) => item.entry.audio === "queued").length,
    done: store.listEvents(workspaceId, { type: RECORDING_TRANSCRIBED_EVENT }).length,
    silent: store.listEvents(workspaceId, { type: RECORDING_SILENT_EVENT }).length,
    failed: all.filter((item) => item.entry.audio === "failed").slice(0, 5).map((item) => ({ file: `${item.folder.label}/${item.relative.replace(/\\/g, "/")}`, note: item.entry.note ?? "" })),
    ...(cost ? { cost } : {}) };
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
  const sources = path.resolve(options.dataDir, "sources");
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
  store.appendEvent({ ownerId: options.ownerId, workspaceId, idempotencyKey: `${RECORDING_PURGED_EVENT}:${Date.now()}`, type: RECORDING_PURGED_EVENT, entityId: workspaceId, payload: { deleted } });
  return { deleted };
}
