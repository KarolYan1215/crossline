import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  PACE_REST_FACTOR, RECORDING_CONSENT, RECORDING_MODEL_NOTICE, RECORDING_SILENT_EVENT, RECORDING_TRANSCRIBED_EVENT, SOURCE_FOLDERS_SETTING,
  readSourceFolders, recordingPace, sourceFolderIndexSetting, type FolderIndexEntry, type RecordingTranscribed, type SourceFolder
} from "@crossline/core";
import type { CrosslineStore } from "@crossline/db";
import { ownerOf } from "./owner";
import type { SpeechOutcome } from "./transcribe";

/**
 * 录音自动转写 (docs/phone-recording.md, 2026-10-20). The folder pass queues recordings that land in an authorized folder (`syncFolder`
 * marks their index entry `audio: "queued"`); this takes them oldest first, a few at once (`transcribeConcurrency`), and turns each into a text document in the
 * person's materials, where the interview, filing and capture analysis read it like any other file. The audio is read where it lies and
 * never copied: the transcript keeps the recording's name, length and sha256, nothing else of it.
 *
 * The same audio is never transcribed twice: every result is an event keyed by the audio's sha256, so a renamed or re-synced copy only
 * points its entry at the transcript that exists. Turning the consent off stops the run at the next piece and nothing of it is kept.
 */
export type RecordingDeps = {
  transcriber: { transcribeSpeech: (bytes: Uint8Array, fileName: string, run: { language?: string; rest?: (pieceMs: number) => Promise<void>; stop?: () => boolean }) => Promise<SpeechOutcome> };
  dataDir: string;
  timeZone: string;
  language?: string;
  /** Milliseconds since the last input on this computer (the screen-activity reader's), held in memory only; undefined before a reading. */
  idleMs: () => number | undefined;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Told once, with how many recordings wait, that the speech model has not been downloaded. */
  modelNeeded?: (waiting: number) => void;
  /** Recordings another lane of this pass has taken (`folderId:relative`), so two lanes never transcribe the same file. */
  claimed?: Set<string>;
};

/**
 * How many recordings are transcribed at once. The owner asked for more than one (2026-10-20). Whisper's ONNX session already spreads one
 * recording over every core, so a second lane mostly overlaps decoding and the decoder loop with the other's matrix work: worth it on four
 * cores or more, not a multiple. `CROSSLINE_TRANSCRIBE_CONCURRENCY` overrides it.
 */
export function transcribeConcurrency(cores = os.cpus().length, freeBytes = os.freemem(), env = process.env.CROSSLINE_TRANSCRIBE_CONCURRENCY): number {
  const set = Number(env);
  if (Number.isInteger(set) && set >= 1) return Math.min(set, 8);
  // About 0.8 GB per lane once the shared model is loaded (decoded audio of a three-hour file is the large part).
  return Math.max(1, Math.min(4, Math.max(2, Math.floor(cores / 4)), Math.floor(freeBytes / 800_000_000)));
}

export type RecordingOutcome =
  | { state: "off" | "idle" | "waiting_for_model" | "stopped" }
  | { state: "transcribed" | "silent" | "duplicate" | "failed" | "missing"; file: string };

export const recordingsOn = (store: CrosslineStore, workspaceId: string) => store.getSetting(workspaceId, RECORDING_CONSENT) === "granted";

const readIndex = (store: CrosslineStore, workspaceId: string, id: string): Record<string, FolderIndexEntry> => {
  try { return JSON.parse(store.getSetting(workspaceId, sourceFolderIndexSetting(id)) ?? "{}") as Record<string, FolderIndexEntry>; } catch { return {}; }
};

const claimKey = (folderId: string, relative: string) => `${folderId}:${relative}`;

/** Recordings waiting, oldest first, leaving out those another lane has taken. */
export function queuedRecordings(store: CrosslineStore, workspaceId: string, claimed?: Set<string>): Array<{ folder: SourceFolder; relative: string; entry: FolderIndexEntry }> {
  return readSourceFolders(store.getSetting(workspaceId, SOURCE_FOLDERS_SETTING))
    .flatMap((folder) => Object.entries(readIndex(store, workspaceId, folder.id)).filter(([, entry]) => entry.audio === "queued")
      .filter(([relative]) => !claimed?.has(claimKey(folder.id, relative))).map(([relative, entry]) => ({ folder, relative, entry })))
    .sort((a, b) => a.entry.mtimeMs - b.entry.mtimeMs || a.relative.localeCompare(b.relative));
}

/**
 * Writes one entry's outcome, read afresh: the folder pass may have rewritten the index meanwhile. A file that changed while it was
 * being transcribed has been queued again as the new version, and is left to be.
 */
function settle(store: CrosslineStore, workspaceId: string, folderId: string, relative: string, seen: FolderIndexEntry, patch: Partial<FolderIndexEntry> | "remove"): void {
  const index = readIndex(store, workspaceId, folderId);
  const current = index[relative];
  if (!current || current.size !== seen.size || current.mtimeMs !== seen.mtimeMs) return;
  if (patch === "remove") delete index[relative]; else index[relative] = { ...current, ...patch };
  store.setSetting(workspaceId, sourceFolderIndexSetting(folderId), JSON.stringify(index));
}

const clock = (seconds: number) => {
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = Math.floor(seconds % 60);
  return `${h ? `${h}:` : ""}${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};
const localTime = (at: Date, zone: string) => {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(at).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  } catch { return at.toISOString().slice(0, 16).replace("T", " "); }
};

/** Transcribes the oldest waiting recording no other lane holds, or says why nothing was done. */
export async function transcribeNextRecording(store: CrosslineStore, workspaceId: string, deps: RecordingDeps): Promise<RecordingOutcome> {
  if (!recordingsOn(store, workspaceId)) return { state: "off" };
  const queue = queuedRecordings(store, workspaceId, deps.claimed);
  const next = queue[0];
  if (!next) return { state: "idle" };
  const key = claimKey(next.folder.id, next.relative);
  deps.claimed?.add(key);
  try { return await transcribeOne(store, workspaceId, deps, next, queue.length); }
  finally { deps.claimed?.delete(key); }
}

async function transcribeOne(store: CrosslineStore, workspaceId: string, deps: RecordingDeps,
  { folder, relative, entry }: { folder: SourceFolder; relative: string; entry: FolderIndexEntry }, waiting: number): Promise<RecordingOutcome> {
  const file = relative.replace(/\\/g, "/");
  const now = deps.now ?? (() => new Date());
  let bytes: Buffer;
  try { bytes = readFileSync(path.join(folder.path, relative)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") { settle(store, workspaceId, folder.id, relative, entry, "remove"); return { state: "missing", file }; }
    // An iCloud file kept only online is fetched on read; offline, or with the folder not kept on this device, the read fails.
    settle(store, workspaceId, folder.id, relative, entry, { audio: "failed", note: "读不到这个录音文件；若在 iCloud 文件夹里，请把文件夹设为「始终保留在此设备上」。" });
    return { state: "failed", file };
  }
  const audioSha = createHash("sha256").update(bytes).digest("hex");
  const prior = store.listEvents(workspaceId, { type: [RECORDING_TRANSCRIBED_EVENT, RECORDING_SILENT_EVENT], entityId: audioSha }).at(-1);
  if (prior) {
    const documentId = prior.type === RECORDING_TRANSCRIBED_EVENT ? String((prior.payload as { documentId?: unknown }).documentId ?? "") : "";
    const exists = documentId && store.listSourceDocuments(workspaceId).some((doc) => doc.id === documentId);
    settle(store, workspaceId, folder.id, relative, entry, { audio: prior.type === RECORDING_SILENT_EVENT ? "silent" : "done", documentId: exists ? documentId : "" });
    return { state: "duplicate", file };
  }

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const began = now().getTime();
  const result = await deps.transcriber.transcribeSpeech(new Uint8Array(bytes), path.basename(relative), {
    ...(deps.language ? { language: deps.language } : {}),
    // While the person is at the computer in the day, rest twice as long as each piece took.
    rest: async (pieceMs) => { if (recordingPace({ idleMs: deps.idleMs(), at: now(), timeZone: deps.timeZone }) === "slow") await sleep(pieceMs * PACE_REST_FACTOR); },
    stop: () => !recordingsOn(store, workspaceId)
  });
  // Turned off while it ran: nothing is kept, and the entry waits in case it is turned on again.
  if (result.state === "stopped" || !recordingsOn(store, workspaceId)) return { state: "stopped" };
  if (result.state === "needs_download") {
    if (!store.getSetting(workspaceId, RECORDING_MODEL_NOTICE)) {
      store.setSetting(workspaceId, RECORDING_MODEL_NOTICE, now().toISOString());
      deps.modelNeeded?.(waiting);
    }
    return { state: "waiting_for_model" };
  }
  if (result.state === "failed") {
    settle(store, workspaceId, folder.id, relative, entry, { audio: "failed", note: result.message });
    return { state: "failed", file };
  }
  const owner = ownerOf(store, workspaceId);
  const wallMs = now().getTime() - began;
  if (result.state === "silent") {
    store.appendEvent({ ownerId: owner, workspaceId, idempotencyKey: `${RECORDING_SILENT_EVENT}:${audioSha}`, type: RECORDING_SILENT_EVENT, entityId: audioSha,
      payload: { fileName: file, seconds: result.seconds, speechSeconds: result.speechSeconds, workMs: result.workMs, wallMs, folderId: folder.id } });
    settle(store, workspaceId, folder.id, relative, entry, { audio: "silent" });
    return { state: "silent", file };
  }

  // The recorder writes the file when the recording ends, so its start is about its modification time less its length.
  const started = localTime(new Date(entry.mtimeMs - result.seconds * 1000), deps.timeZone);
  const text = `[录音：${file}，约 ${started} 开始，时长 ${clock(result.seconds)}]\n${result.text}`;
  const textBytes = Buffer.from(text, "utf8");
  const sha256 = createHash("sha256").update(textBytes).digest("hex");
  const root = path.resolve(deps.dataDir, "sources");
  const target = path.join(root, `${sha256}.txt`);
  mkdirSync(root, { recursive: true });
  writeFileSync(target, textBytes);
  const id = randomUUID();
  const doc = store.saveSourceDocument({ id, ownerId: owner, workspaceId, kind: "text", fileName: `${folder.label}/${file} 转写.txt`.slice(-200),
    mediaType: "text/plain", sha256, uri: pathToFileURL(target).href, extractedText: text, extractionStatus: "done",
    extractionNote: `本机转写：录音 ${Math.max(1, Math.round(result.seconds / 60))} 分钟，有人声约 ${Math.round(result.speechSeconds / 60)} 分钟；录音没有保存副本（sha256 ${audioSha.slice(0, 12)}）。`,
    createdAt: now().toISOString() });
  const payload: RecordingTranscribed & { folderId: string } = { fileName: file, seconds: result.seconds, speechSeconds: result.speechSeconds,
    workMs: result.workMs, wallMs, documentId: doc.id, folderId: folder.id };
  store.appendEvent({ ownerId: owner, workspaceId, idempotencyKey: `${RECORDING_TRANSCRIBED_EVENT}:${audioSha}`, type: RECORDING_TRANSCRIBED_EVENT, entityId: audioSha, payload });
  settle(store, workspaceId, folder.id, relative, entry, { audio: "done", documentId: doc.id, ...(doc.id === id ? { created: true } : {}) });
  return { state: "transcribed", file };
}

/**
 * Works through the queue in `lanes` parallel lanes until it is empty, the model is missing, or the consent is turned off. A lane that
 * finds nothing left stops; the others finish what they hold.
 */
export async function recordingPass(store: CrosslineStore, workspaceId: string, deps: RecordingDeps, lanes = 1): Promise<RecordingOutcome[]> {
  const outcomes: RecordingOutcome[] = [];
  const shared = { ...deps, claimed: deps.claimed ?? new Set<string>() };
  const lane = async () => {
    for (;;) {
      const outcome = await transcribeNextRecording(store, workspaceId, shared);
      if (!("file" in outcome)) return;
      outcomes.push(outcome);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, lanes) }, lane));
  return outcomes;
}
