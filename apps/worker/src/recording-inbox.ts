import { createHash } from "node:crypto";
import { createReadStream, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import {
  RECORDING_INBOX_SEGMENTS, RECORDING_SERVER_CONSENT, RECORDING_SILENT_EVENT, inTranscribeWindow, TRANSCRIBE_WINDOW
} from "@crossline/core";
import type { CrosslineStore } from "@crossline/db";
import { ownerOf } from "./owner";
import { priorRecording, saveTranscript } from "./recordings";
import type { BlockTranscript, WindowRecogniser } from "./sensevoice";

/**
 * The server inbox (docs/phone-recording.md 「服务器转写」): recordings the phone's shortcut uploaded wait in
 * `<dataDir>/recordings/inbox/<workspace>/` as `<received ms>-<id>.<ext>` beside a `.json` with the name the phone gave. The transcriber
 * container takes them in the workspace's night (`TRANSCRIBE_WINDOW` in its own zone), one at a time, and deletes each recording once it
 * is transcribed, found silent, a copy of one already done, or unreadable — the audio is never kept and never backed up. A run cut off by
 * the night ending or the consent being withdrawn leaves the file for the next night.
 */
export const RECORDING_FAILED_EVENT = "recording.failed";
export const inboxDir = (dataDir: string, workspaceId: string) => path.join(dataDir, ...RECORDING_INBOX_SEGMENTS, workspaceId);
export const serverRecordingsOn = (store: CrosslineStore, workspaceId: string) => store.getSetting(workspaceId, RECORDING_SERVER_CONSENT) === "granted";

export type InboxFile = { file: string; name: string; receivedAt: number; size: number };
const AUDIO = /\.(m4a|mp3|wav|aac|opus|ogg|webm|flac)$/i;

/** Uploads waiting, oldest first. */
export function inboxFiles(dataDir: string, workspaceId: string): InboxFile[] {
  const dir = inboxDir(dataDir, workspaceId);
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return []; }
  return names.filter((name) => AUDIO.test(name) && /^\d+-/.test(name)).map((name) => {
    const file = path.join(dir, name);
    let given = name.replace(/^\d+-[^.]+/, "录音");
    try { given = String((JSON.parse(readFileSync(`${file}.json`, "utf8")) as { name?: unknown }).name ?? given) || given; } catch { /* no side file */ }
    let size = 0;
    try { size = statSync(file).size; } catch { /* gone */ }
    return { file, name: given, receivedAt: Number(name.split("-")[0]), size };
  }).sort((a, b) => a.receivedAt - b.receivedAt);
}

const remove = (item: InboxFile) => { rmSync(item.file, { force: true }); rmSync(`${item.file}.json`, { force: true }); };
const sha256Of = async (file: string) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
};

export type InboxDeps = {
  dataDir: string; timeZone: string; window?: string;
  recognise: () => WindowRecogniser;
  transcribe: (file: string, recognise: WindowRecogniser, stop: () => boolean) => Promise<BlockTranscript>;
  now?: () => Date;
};
export type InboxOutcome = { state: "transcribed" | "silent" | "duplicate" | "failed" | "stopped"; name: string };

/** Works through one workspace's inbox while its consent holds and its night lasts. */
export async function processInbox(store: CrosslineStore, workspaceId: string, deps: InboxDeps): Promise<InboxOutcome[]> {
  const now = deps.now ?? (() => new Date());
  const open = () => serverRecordingsOn(store, workspaceId) && inTranscribeWindow(now(), deps.timeZone, deps.window ?? TRANSCRIBE_WINDOW);
  const outcomes: InboxOutcome[] = [];
  for (const item of inboxFiles(deps.dataDir, workspaceId)) {
    if (!open()) break;
    let audioSha: string;
    try { audioSha = await sha256Of(item.file); } catch { continue; }
    if (priorRecording(store, workspaceId, audioSha)) { remove(item); outcomes.push({ state: "duplicate", name: item.name }); continue; }
    const began = now().getTime();
    let result: BlockTranscript;
    try { result = await deps.transcribe(item.file, deps.recognise(), () => !open()); }
    catch (error) {
      store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `${RECORDING_FAILED_EVENT}:${audioSha}`, type: RECORDING_FAILED_EVENT,
        entityId: audioSha, payload: { fileName: item.name, message: error instanceof Error ? error.message.slice(0, 300) : "未知错误" } });
      remove(item);
      outcomes.push({ state: "failed", name: item.name });
      continue;
    }
    // The night ended or the consent was withdrawn: nothing is kept, and the recording waits for the next night (or is deleted with the consent).
    if (result.state === "stopped" || !serverRecordingsOn(store, workspaceId)) { outcomes.push({ state: "stopped", name: item.name }); break; }
    const wallMs = now().getTime() - began;
    if (result.state === "silent") {
      store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `${RECORDING_SILENT_EVENT}:${audioSha}`, type: RECORDING_SILENT_EVENT,
        entityId: audioSha, payload: { fileName: item.name, seconds: result.seconds, speechSeconds: result.speechSeconds, workMs: result.workMs, wallMs, where: "server" } });
    } else {
      // The shortcut uploads when the recording is saved, so it ended about when it arrived.
      saveTranscript(store, workspaceId, { dataDir: deps.dataDir, timeZone: deps.timeZone, label: "手机上传", file: item.name, endedAtMs: item.receivedAt, audioSha,
        where: "服务器转写", result: { ...result, wallMs }, extra: { where: "server", engine: "sensevoice-small" }, now: now() });
    }
    remove(item);
    outcomes.push({ state: result.state, name: item.name });
  }
  return outcomes;
}
