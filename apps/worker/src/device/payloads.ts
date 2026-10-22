import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  ACTIVITY_HOURLY, ACTIVITY_LAST_ACTIVE, ACTIVITY_LONG_GAPS, AGENT_HISTORY_CONSENT, AGENT_HISTORY_SUMMARY, DEVICE_LIMITS, INPUT_RHYTHM_BUCKETS, INPUT_RHYTHM_CONSENT,
  RECORDING_SILENT_EVENT, RECORDING_TRANSCRIBED_EVENT, SLEEP_TRACKING_CONSENT, SOURCE_FOLDERS_SETTING, readSourceFolders,
  type ActivityHour, type AgentHistorySummary, type DeviceActivityPayload, type DeviceDocument, type DeviceFolder, type DeviceSilent, type DeviceTranscript,
  type InputRhythmBucket
} from "@crossline/core";
import type { CrosslineStore } from "@crossline/db";
import { ACTIVITY_DETAIL_CONSENT, LOCAL_ACTIVITY_CONSENT } from "../activity-recorder";
import { folderDocuments } from "../source-folders";

/**
 * What a linked computer sends (docs/device-mode.md), built from its own staging ledger — the local install's ledger and workspace, where
 * the activity reader, the folder reader and the transcriber keep writing as they always did. Nothing here reads a window title: the
 * segments come from `listActivitySegments`, which has none, and the app in each is replaced by a salted hash only this machine can
 * reverse, used on the other side only to count switches.
 */
export type DeviceState = {
  /** Never leaves the machine: what turns an app name into an opaque token. */
  salt: string;
  /** Local document id → the original file's sha256, for every folder document already queued. */
  documents: Record<string, string>;
  /** Audio sha256s whose transcript or silence was queued. */
  recordings: string[];
  activityHash?: string;
  foldersHash?: string;
  /** Whether the first activity send (with the last weeks' history) was queued. */
  backfilled?: boolean;
  /** Recordings waiting for the speech model, as the transcriber last said. */
  modelNeeded?: number;
  lastPassAt?: string;
};

export type QueuedItem = { id: string; route: string; body: unknown; supersedes?: string };

const stateFile = (dir: string) => path.join(dir, "state.json");
export function readDeviceState(dir: string): DeviceState {
  try {
    const state = JSON.parse(readFileSync(stateFile(dir), "utf8")) as Partial<DeviceState>;
    if (typeof state.salt === "string" && state.salt.length >= 32) return { documents: {}, recordings: [], ...state, salt: state.salt };
  } catch { /* first run */ }
  return { salt: randomBytes(32).toString("hex"), documents: {}, recordings: [] };
}
export function writeDeviceState(dir: string, state: DeviceState): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${stateFile(dir)}.part`, JSON.stringify(state));
  renameSync(`${stateFile(dir)}.part`, stateFile(dir));
}

const read = <T>(raw: string | undefined, fallback: T): T => { try { return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; } };
const hashOf = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
/** An app name as the hosted side sees it: eight hex characters of an HMAC under this machine's own salt. */
export const appToken = (salt: string, app: string) => app ? createHmac("sha256", salt).update(app).digest("hex").slice(0, 8) : "";

/**
 * The activity snapshot: the consents as they stand here, and what each one covers. The first send carries the last weeks (daily rows two
 * weeks, hours four, rhythm two, segments three days); every later one the last two days, which is what can still change.
 */
export function buildActivityPayload(store: CrosslineStore, workspaceId: string, state: DeviceState, now = new Date()): DeviceActivityPayload {
  const granted = (key: string) => store.getSetting(workspaceId, key) === "granted";
  const consents = { activity: granted(LOCAL_ACTIVITY_CONSENT), detail: granted(ACTIVITY_DETAIL_CONSENT), sleep: granted(SLEEP_TRACKING_CONSENT),
    rhythm: granted(INPUT_RHYTHM_CONSENT), agentHistory: store.getSetting(workspaceId, AGENT_HISTORY_CONSENT) === "on" };
  const days = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
  const first = !state.backfilled;
  const dailySince = days(first ? 14 : 2).slice(0, 10);
  const daily = consents.activity || consents.detail ? store.listEnergyObservations(workspaceId)
    .filter((item) => item.id.startsWith("local-activity:") && item.id.slice("local-activity:".length) >= dailySince)
    .map((item) => {
      const aggregate = (item.aggregate ?? {}) as Record<string, number>;
      return { day: item.id.slice("local-activity:".length), activeMinutes: aggregate.activeMinutes ?? 0, idleMinutes: aggregate.idleMinutes ?? 0,
        windowSwitches: aggregate.windowSwitches ?? 0, sampleCount: aggregate.sampleCount ?? 0 };
    }).sort((a, b) => a.day.localeCompare(b.day)).slice(-DEVICE_LIMITS.daily) : [];
  const hourly = consents.activity || consents.detail ? read<ActivityHour[]>(store.getSetting(workspaceId, ACTIVITY_HOURLY), [])
    .filter((hour) => hour.start >= days(first ? 28 : 2)).slice(-DEVICE_LIMITS.hourly) : [];
  const gaps = consents.sleep ? read<Array<{ from: string; to: string }>>(store.getSetting(workspaceId, ACTIVITY_LONG_GAPS), []).slice(-DEVICE_LIMITS.gaps) : [];
  const lastActive = consents.sleep ? store.getSetting(workspaceId, ACTIVITY_LAST_ACTIVE) : undefined;
  const rhythm = consents.rhythm ? read<InputRhythmBucket[]>(store.getSetting(workspaceId, INPUT_RHYTHM_BUCKETS), [])
    .filter((bucket) => bucket.start >= days(first ? 14 : 2)).slice(-DEVICE_LIMITS.rhythm) : [];
  const since = new Date(`${days(first ? 3 : 1).slice(0, 10)}T00:00:00.000Z`).toISOString();
  // Built field by field: a segment's title is not even in the type `listActivitySegments` returns, and its app goes through `appToken`.
  const segments = consents.detail ? store.listActivitySegments(workspaceId, since).filter((segment) => segment.start >= since)
    .map((segment) => ({ start: segment.start, end: segment.end, category: segment.category, idle: segment.idle, app: appToken(state.salt, segment.app) }))
    .slice(-DEVICE_LIMITS.segments) : [];
  const agentHistory = consents.agentHistory ? read<AgentHistorySummary | null>(store.getSetting(workspaceId, AGENT_HISTORY_SUMMARY), null) : null;
  return { consents, daily, hourly, gaps, ...(lastActive ? { lastActive } : {}), rhythm, ...(consents.detail ? { segmentsSince: since } : {}), segments, agentHistory };
}

/** The activity snapshot as an outbox item, or nothing when it is the same as the last one queued. */
export function activityItem(store: CrosslineStore, workspaceId: string, state: DeviceState, now = new Date()): QueuedItem | undefined {
  const payload = buildActivityPayload(store, workspaceId, state, now);
  const hash = hashOf(payload);
  if (hash === state.activityHash) return undefined;
  state.activityHash = hash;
  state.backfilled = true;
  return { id: `activity:${hash}`, route: "/api/device/activity", body: payload, supersedes: "activity" };
}

/** Local documents that are a recording's transcript (they go as recordings, not as folder files). */
function transcriptDocuments(store: CrosslineStore, workspaceId: string): Set<string> {
  return new Set(store.listEvents(workspaceId, { type: RECORDING_TRANSCRIBED_EVENT })
    .map((event) => String((event.payload as { documentId?: unknown }).documentId ?? "")).filter(Boolean));
}

/**
 * Folder files not yet queued (by the original file's sha256), in batches of a few files and a few megabytes; removals for files the
 * folder reader dropped since (an exclusion, a revoked folder); and the folders' labels and lines when they changed. Marks what it
 * queued in `state`.
 */
export function sourceItems(store: CrosslineStore, workspaceId: string, state: DeviceState): QueuedItem[] {
  const items: QueuedItem[] = [];
  const folders = readSourceFolders(store.getSetting(workspaceId, SOURCE_FOLDERS_SETTING));
  const meta: DeviceFolder[] = folders.map((folder) => ({ id: folder.id, label: folder.label, lines: folder.lines ?? [],
    ...(folder.linesBy === "person" || folder.linesBy === "model" ? { linesBy: folder.linesBy } : {}), files: folder.files ?? 0,
    ...(folder.lastScanAt ? { lastScanAt: folder.lastScanAt } : {}) }));
  const metaHash = hashOf(meta.map(({ lastScanAt: _skip, ...rest }) => rest));
  if (metaHash !== state.foldersHash) {
    state.foldersHash = metaHash;
    items.push({ id: `folders:${metaHash}`, route: "/api/device/sources", body: { folders: meta }, supersedes: "folders" });
  }

  const byDocument = folderDocuments(store, workspaceId);
  const transcripts = transcriptDocuments(store, workspaceId);
  const docs = store.listSourceDocuments(workspaceId).filter((doc) => byDocument.has(doc.id) && !transcripts.has(doc.id));
  const present = new Set(docs.map((doc) => doc.id));
  const removed = Object.entries(state.documents).filter(([id]) => !present.has(id));
  if (removed.length) {
    const shas = removed.map(([, sha]) => sha);
    for (const [id] of removed) delete state.documents[id];
    for (let start = 0; start < shas.length; start += DEVICE_LIMITS.remove) {
      const batch = shas.slice(start, start + DEVICE_LIMITS.remove);
      items.push({ id: `remove:${hashOf(batch)}`, route: "/api/device/sources", body: { remove: batch } });
    }
  }

  let batch: DeviceDocument[] = [];
  let bytes = 0;
  const flush = () => { if (batch.length) items.push({ id: `sources:${hashOf(batch.map((doc) => doc.sha256))}`, route: "/api/device/sources", body: { documents: batch } }); batch = []; bytes = 0; };
  for (const doc of docs) {
    if (state.documents[doc.id] === doc.sha256 || doc.extractionStatus === "pending") continue;
    const folder = byDocument.get(doc.id)!;
    const text = doc.extractedText.slice(0, DEVICE_LIMITS.text);
    if (batch.length >= 5 || bytes + text.length > 3_000_000) flush();
    batch.push({ sha256: doc.sha256, fileName: doc.fileName, folderId: folder.id, status: doc.extractionStatus, ...(doc.extractionNote ? { note: doc.extractionNote } : {}),
      text, createdAt: doc.createdAt });
    bytes += text.length;
    state.documents[doc.id] = doc.sha256;
  }
  flush();
  return items;
}

/** Transcripts and silent recordings not yet queued, a few to an item. Marks what it queued in `state`. */
export function recordingItems(store: CrosslineStore, workspaceId: string, state: DeviceState): QueuedItem[] {
  const sent = new Set(state.recordings);
  const labels = new Map(readSourceFolders(store.getSetting(workspaceId, SOURCE_FOLDERS_SETTING)).map((folder) => [folder.id, folder.label]));
  const docs = new Map(store.listSourceDocuments(workspaceId).map((doc) => [doc.id, doc]));
  const transcripts: DeviceTranscript[] = [];
  const silent: DeviceSilent[] = [];
  for (const event of store.listEvents(workspaceId, { type: [RECORDING_TRANSCRIBED_EVENT, RECORDING_SILENT_EVENT] })) {
    const audioSha = event.entityId;
    const payload = event.payload as { fileName?: string; seconds?: number; speechSeconds?: number; workMs?: number; wallMs?: number; documentId?: string; folderId?: string; where?: string };
    if (sent.has(audioSha) || !/^[a-f0-9]{64}$/.test(audioSha) || payload.where === "device") continue;
    const base = { audioSha, fileName: String(payload.fileName ?? "录音"), folderId: String(payload.folderId ?? ""), seconds: Number(payload.seconds ?? 0),
      speechSeconds: Number(payload.speechSeconds ?? 0), workMs: Number(payload.workMs ?? 0) };
    if (event.type === RECORDING_SILENT_EVENT) silent.push(base);
    else {
      const doc = docs.get(String(payload.documentId ?? ""));
      if (!doc?.extractedText) continue;
      transcripts.push({ ...base, label: labels.get(base.folderId) ?? "录音", text: doc.extractedText.slice(0, DEVICE_LIMITS.text), wallMs: Number(payload.wallMs ?? 0) });
    }
    sent.add(audioSha);
  }
  state.recordings = [...sent];
  const items: QueuedItem[] = [];
  for (let start = 0; start < transcripts.length; start += 3) {
    const batch = transcripts.slice(start, start + 3);
    items.push({ id: `recordings:${hashOf(batch.map((item) => item.audioSha))}`, route: "/api/device/recordings", body: { transcripts: batch } });
  }
  for (let start = 0; start < silent.length; start += DEVICE_LIMITS.silent) {
    const batch = silent.slice(start, start + DEVICE_LIMITS.silent);
    items.push({ id: `silent:${hashOf(batch.map((item) => item.audioSha))}`, route: "/api/device/recordings", body: { silent: batch } });
  }
  return items;
}
