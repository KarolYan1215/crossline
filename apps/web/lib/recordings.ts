import { readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RECORDING_CONSENT, RECORDING_DIGESTED_EVENT, RECORDING_FAILED_EVENT, RECORDING_FILE, RECORDING_INBOX_SEGMENTS, RECORDING_VOICEPRINT_CONSENT, RECORDING_VOICEPRINT_SEGMENTS, RECORDING_MODEL_NOTICE, RECORDING_SERVER_CONSENT, RECORDING_PURGED_EVENT,
  RECORDING_SILENT_EVENT, RECORDING_TRANSCRIBED_EVENT, SOURCE_FOLDERS_SETTING, TRANSCRIBE_WINDOW,
  readSourceFolders, sourceFolderIndexSetting, transcribeWindowOpens, transcriptionCost, type FolderIndexEntry, type RecordingTranscribed
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
  server?: ServerRecordings;
};

/**
 * The server path's own counts. Before 2026-10-21 the card showed only what still waited, so a recording transcribed in the night read
 * as 「等待转写 0 个」 the next morning, as if nothing had arrived.
 */
export type ServerRecordings = {
  on: boolean;
  transcribed: number; silent: number; waiting: number; failedCount: number;
  /** When the transcriber next takes the inbox, in the person's zone: 0 while its night window is open. */
  opens: { inMinutes: number; at: string; timeZone: string };
  failed: Array<{ file: string; note: string }>;
  /** The last few transcripts, with whether their digest exists yet (it waits for the model quota). */
  recent: Array<{ file: string; at: string; documentId: string; minutes: number; digested: boolean }>;
  voiceprint: VoiceprintState;
};
/** 识别本人声音: the consent, and whether a voiceprint exists, waits to be made from an uploaded recording, or could not be made. */
export type VoiceprintState = { on: boolean; state: "none" | "pending" | "ready" | "failed"; seconds?: number; at?: string; message?: string };

const entries = (store: CrosslineStore, workspaceId: string) => readSourceFolders(store.getSetting(workspaceId, SOURCE_FOLDERS_SETTING)).flatMap((folder) => {
  let index: Record<string, FolderIndexEntry> = {};
  try { index = JSON.parse(store.getSetting(workspaceId, sourceFolderIndexSetting(folder.id)) ?? "{}") as Record<string, FolderIndexEntry>; } catch { /* unreadable counts as empty */ }
  return Object.entries(index).filter(([, entry]) => entry.audio).map(([relative, entry]) => ({ folder, relative, entry }));
});

export function recordingOverview(store: CrosslineStore, workspaceId: string, dataDir?: string, timeZone = "America/Chicago", now = new Date()): RecordingOverview {
  const all = entries(store, workspaceId);
  const transcribed = store.listEvents(workspaceId, { type: RECORDING_TRANSCRIBED_EVENT });
  const recent = transcribed.slice(-20).map((event) => event.payload as RecordingTranscribed);
  const cost = transcriptionCost(recent);
  return { on: store.getSetting(workspaceId, RECORDING_CONSENT) === "granted",
    folders: readSourceFolders(store.getSetting(workspaceId, SOURCE_FOLDERS_SETTING)).length,
    queued: all.filter((item) => item.entry.audio === "queued").length,
    done: transcribed.length,
    silent: store.listEvents(workspaceId, { type: RECORDING_SILENT_EVENT }).length,
    failed: all.filter((item) => item.entry.audio === "failed").slice(0, 5).map((item) => ({ file: `${item.folder.label}/${item.relative.replace(/\\/g, "/")}`, note: item.entry.note ?? "" })),
    ...(cost ? { cost } : {}),
    ...(serverTranscribeAvailable() && dataDir ? { server: serverRecordings(store, workspaceId, dataDir, timeZone, now) } : {}) };
}

const fromServer = (event: { payload: unknown }) => (event.payload as { where?: unknown }).where === "server";

/** What the server path did for this workspace: transcribed, silent, waiting in the inbox (and when the night window opens), failed. */
export function serverRecordings(store: CrosslineStore, workspaceId: string, dataDir: string, timeZone: string, now = new Date()): ServerRecordings {
  const transcribed = store.listEvents(workspaceId, { type: RECORDING_TRANSCRIBED_EVENT }).filter(fromServer);
  const failed = store.listEvents(workspaceId, { type: RECORDING_FAILED_EVENT });
  const digested = new Set(store.listEvents(workspaceId, { type: RECORDING_DIGESTED_EVENT }).map((event) => event.entityId));
  return { on: store.getSetting(workspaceId, RECORDING_SERVER_CONSENT) === "granted",
    transcribed: transcribed.length,
    silent: store.listEvents(workspaceId, { type: RECORDING_SILENT_EVENT }).filter(fromServer).length,
    waiting: serverInboxCount(dataDir, workspaceId),
    failedCount: failed.length,
    opens: { ...transcribeWindowOpens(now, timeZone, process.env.CROSSLINE_TRANSCRIBE_WINDOW?.trim() || TRANSCRIBE_WINDOW), timeZone },
    failed: failed.slice(-5).reverse()
      .map((event) => ({ file: String((event.payload as { fileName?: unknown }).fileName ?? ""), note: String((event.payload as { message?: unknown }).message ?? "") })),
    recent: transcribed.slice(-5).reverse().map((event) => {
      const payload = event.payload as RecordingTranscribed;
      return { file: payload.fileName, at: event.createdAt, documentId: payload.documentId, minutes: Math.round(payload.seconds / 60), digested: digested.has(payload.documentId) };
    }),
    voiceprint: voiceprintState(store, workspaceId, dataDir) };
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

/** Where the voiceprint, a failed attempt and a pending enrolment recording live (`apps/worker/src/diarize.ts` reads the same names). */
export const voiceprintDir = (dataDir: string) => path.join(dataDir, ...RECORDING_VOICEPRINT_SEGMENTS);
const voiceprintFiles = (dataDir: string, workspaceId: string) => {
  try { return readdirSync(voiceprintDir(dataDir)).filter((name) => name.startsWith(`${workspaceId}.`)); } catch { return []; }
};

export function voiceprintState(store: CrosslineStore, workspaceId: string, dataDir: string): VoiceprintState {
  const on = store.getSetting(workspaceId, RECORDING_VOICEPRINT_CONSENT) === "granted";
  const files = voiceprintFiles(dataDir, workspaceId);
  const read = (name: string) => { try { return JSON.parse(readFileSync(path.join(voiceprintDir(dataDir), name), "utf8")) as Record<string, unknown>; } catch { return undefined; } };
  if (files.some((name) => name.includes(".enrol."))) return { on, state: "pending" };
  const ready = files.includes(`${workspaceId}.json`) ? read(`${workspaceId}.json`) : undefined;
  if (ready) return { on, state: "ready", ...(typeof ready.seconds === "number" ? { seconds: ready.seconds } : {}), ...(typeof ready.at === "string" ? { at: ready.at } : {}) };
  const failed = files.includes(`${workspaceId}.failed.json`) ? read(`${workspaceId}.failed.json`) : undefined;
  if (failed) return { on, state: "failed", message: String(failed.message ?? "") };
  return { on, state: "none" };
}

/** Turns 识别本人声音 on or off. Off deletes the voiceprint and anything waiting to become one; nothing else holds the person's voice. */
export function setVoiceprintConsent(store: CrosslineStore, workspaceId: string, on: boolean, dataDir: string): { deleted: number } {
  store.setSetting(workspaceId, RECORDING_VOICEPRINT_CONSENT, on ? "granted" : "denied");
  if (on) return { deleted: 0 };
  const files = voiceprintFiles(dataDir, workspaceId);
  for (const name of files) rmSync(path.join(voiceprintDir(dataDir), name), { force: true });
  return { deleted: files.length };
}
