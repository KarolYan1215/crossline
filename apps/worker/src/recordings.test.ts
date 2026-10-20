import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { RECORDING_CONSENT, RECORDING_TRANSCRIBED_EVENT, recordingPace, sourceFolderIndexSetting, type FolderIndexEntry, type SourceFolder } from "@crossline/core";
import { CrosslineStore } from "@crossline/db";
import { recordingPass, transcribeNextRecording, type RecordingDeps } from "./recordings";
import { addFolder, syncFolder } from "./source-folders";
import { RATE, signal } from "./testing/audio";
import { createTranscriber, type TranscriptionEngine } from "./transcribe";

let store: CrosslineStore;
let workspaceId: string;
let root: string;
let data: string;
let folder: SourceFolder;
/** Lengths, in seconds, of what the recogniser was given. */
let heard: number[];
const later = () => Date.now() + 10 * 60_000;

// The decoder reads the stand-in file's text: 「silent」 is two minutes of room noise, anything else has speech at 20–30 s.
const decode = async (bytes: Uint8Array) => ({ sampleRate: RATE, channels: [Buffer.from(bytes).toString("utf8").startsWith("silent")
  ? signal(120, []) : signal(120, [[20, 30]])] });
const engine = (ready = true): TranscriptionEngine => ({
  modelReady: async () => ready,
  download: async () => undefined,
  recognise: async (samples) => { heard.push(samples.length / RATE); return { text: "今天下午三点组会", chunks: [{ start: 0.5, end: 3, text: "今天下午三点组会" }], language: "en" }; }
});
const folderDeps = (audio: boolean) => ({ dataDir: data, home: path.join(root, "home"), readText: async () => ({ status: "done" as const, text: "" }), audio, now: later });
const deps = async (over: Partial<RecordingDeps> = {}, ready = true): Promise<RecordingDeps> => {
  const transcriber = createTranscriber({ engine: engine(ready), decode, modelsDir: path.join(data, "models") });
  if (ready) await transcriber.download();
  return { transcriber, dataDir: data, timeZone: "America/Chicago", idleMs: () => 10 * 60_000, sleep: async () => undefined, ...over };
};
const put = (name: string, content: string) => { const full = path.join(root, "phone", name); mkdirSync(path.dirname(full), { recursive: true }); writeFileSync(full, content); return full; };
const index = () => JSON.parse(store.getSetting(workspaceId, sourceFolderIndexSetting(folder.id)) ?? "{}") as Record<string, FolderIndexEntry>;
const transcripts = () => store.listSourceDocuments(workspaceId).filter((doc) => doc.fileName.endsWith("转写.txt"));

beforeEach(async () => {
  store = new CrosslineStore(":memory:");
  workspaceId = store.createPrincipalWithWorkspace("user-1", "个人 workspace").workspace.id;
  root = mkdtempSync(path.join(tmpdir(), "crossline-recordings-"));
  data = path.join(root, "data");
  heard = [];
  put("syllabus.md", "# notes");
  put("2026-10-20 09.30.m4a", "speech one");
  const added = await addFolder(store, workspaceId, path.join(root, "phone"), folderDeps(false));
  if (added.state !== "added") throw new Error("not added");
  folder = added.folder;
});
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

test("with the consent off, recordings are left alone and nothing is transcribed", async () => {
  await syncFolder(store, workspaceId, folder, folderDeps(false));
  expect(Object.keys(index())).toEqual(["syllabus.md"]);
  store.setSetting(workspaceId, RECORDING_CONSENT, "denied");
  expect(await transcribeNextRecording(store, workspaceId, await deps())).toEqual({ state: "off" });
  expect(heard).toEqual([]);
  expect(transcripts()).toEqual([]);
});

test("a new recording is queued by the folder pass and becomes a transcript in the materials, with no copy of the audio", async () => {
  store.setSetting(workspaceId, RECORDING_CONSENT, "granted");
  // Still being written or synced: it waits for a later pass.
  await syncFolder(store, workspaceId, folder, { ...folderDeps(true), now: () => Date.now() });
  expect(index()["2026-10-20 09.30.m4a"]).toBeUndefined();
  await syncFolder(store, workspaceId, folder, folderDeps(true));
  expect(index()["2026-10-20 09.30.m4a"]).toMatchObject({ audio: "queued", documentId: "" });
  expect(await recordingPass(store, workspaceId, await deps())).toEqual([{ state: "transcribed", file: "2026-10-20 09.30.m4a" }]);
  const [doc] = transcripts();
  expect(doc).toMatchObject({ kind: "text", fileName: "phone/2026-10-20 09.30.m4a 转写.txt", extractionStatus: "done" });
  expect(doc!.extractedText).toContain("时长 02:00");
  // The line is placed at its time in the recording, not in the packed speech.
  expect(doc!.extractedText).toContain("[00:20] 今天下午三点组会");
  expect(doc!.extractionNote).toContain("录音没有保存副本");
  expect(index()["2026-10-20 09.30.m4a"]).toMatchObject({ audio: "done", documentId: doc!.id, created: true });
  expect(readdirSync(path.join(data, "sources")).every((name) => name.endsWith(".txt"))).toBe(true);
  expect(store.listEvents(workspaceId, { type: RECORDING_TRANSCRIBED_EVENT })[0]!.payload).toMatchObject({ fileName: "2026-10-20 09.30.m4a", seconds: 120 });
  // Seen again unchanged: not queued again.
  await syncFolder(store, workspaceId, folder, folderDeps(true));
  expect(index()["2026-10-20 09.30.m4a"]!.audio).toBe("done");
});

test("only speech reaches the model, and a recording with none is never sent to it", async () => {
  store.setSetting(workspaceId, RECORDING_CONSENT, "granted");
  put("silent.m4a", "silent pocket");
  await syncFolder(store, workspaceId, folder, folderDeps(true));
  const outcomes = await recordingPass(store, workspaceId, await deps());
  expect(outcomes.map((item) => item.state).sort()).toEqual(["silent", "transcribed"]);
  // One call, for the ten seconds of speech (with padding), out of two minutes.
  expect(heard).toHaveLength(1);
  expect(heard[0]).toBeLessThan(13);
  expect(index()["silent.m4a"]).toMatchObject({ audio: "silent", documentId: "" });
  expect(transcripts()).toHaveLength(1);
});

test("the same audio under another name, or turned up again, is not transcribed twice", async () => {
  store.setSetting(workspaceId, RECORDING_CONSENT, "granted");
  await syncFolder(store, workspaceId, folder, folderDeps(true));
  await recordingPass(store, workspaceId, await deps());
  copyFileSync(path.join(root, "phone", "2026-10-20 09.30.m4a"), path.join(root, "phone", "copy-same.m4a"));
  await syncFolder(store, workspaceId, folder, folderDeps(true));
  expect(await recordingPass(store, workspaceId, await deps())).toEqual([{ state: "duplicate", file: "copy-same.m4a" }]);
  expect(heard).toHaveLength(1);
  expect(transcripts()).toHaveLength(1);
  expect(index()["copy-same.m4a"]).toMatchObject({ audio: "done", documentId: transcripts()[0]!.id });
});

test("without the model, recordings wait and the person is told once", async () => {
  store.setSetting(workspaceId, RECORDING_CONSENT, "granted");
  await syncFolder(store, workspaceId, folder, folderDeps(true));
  const told: number[] = [];
  const waiting = await deps({ modelNeeded: (count) => told.push(count) }, false);
  expect(await transcribeNextRecording(store, workspaceId, waiting)).toEqual({ state: "waiting_for_model" });
  expect(await transcribeNextRecording(store, workspaceId, waiting)).toEqual({ state: "waiting_for_model" });
  expect(told).toEqual([1]);
  expect(index()["2026-10-20 09.30.m4a"]!.audio).toBe("queued");
});

test("turning the consent off while a recording is transcribed keeps nothing of it", async () => {
  store.setSetting(workspaceId, RECORDING_CONSENT, "granted");
  await syncFolder(store, workspaceId, folder, folderDeps(true));
  const run = await deps();
  const stopping: RecordingDeps = { ...run, transcriber: { transcribeSpeech: async (...args) => {
    const result = await run.transcriber.transcribeSpeech(...args);
    store.setSetting(workspaceId, RECORDING_CONSENT, "denied");
    return result;
  } } };
  expect(await transcribeNextRecording(store, workspaceId, stopping)).toEqual({ state: "stopped" });
  expect(transcripts()).toEqual([]);
  // Off, the folder pass keeps the waiting entry, so turning it on again picks the recording up.
  await syncFolder(store, workspaceId, folder, folderDeps(false));
  expect(index()["2026-10-20 09.30.m4a"]!.audio).toBe("queued");
});

test("in the day, with the person at the computer, the worker rests between pieces; at night or when idle it does not", async () => {
  store.setSetting(workspaceId, RECORDING_CONSENT, "granted");
  // Two pieces: twelve minutes of speech in a fifteen-minute recording.
  const long = async () => ({ sampleRate: RATE, channels: [signal(15 * 60, [[60, 13 * 60]])] });
  await syncFolder(store, workspaceId, folder, folderDeps(true));
  const rests: number[] = [];
  let clock = Date.parse("2026-10-20T15:00:00Z");
  const transcriber = createTranscriber({ engine: { ...engine(), recognise: async (samples) => { clock += 60_000; heard.push(samples.length / RATE); return { text: "x", chunks: [{ start: 0, end: 1, text: "x" }] }; } },
    decode: long, modelsDir: path.join(data, "models") });
  await transcriber.download();
  const transcribeSpeech: RecordingDeps["transcriber"]["transcribeSpeech"] = (bytes, name, run) => transcriber.transcribeSpeech(bytes, name, { ...run, now: () => clock });
  await transcribeNextRecording(store, workspaceId, { ...(await deps()), transcriber: { transcribeSpeech }, idleMs: () => 30_000,
    now: () => new Date(clock), sleep: async (ms) => { rests.push(ms); } });
  expect(heard).toHaveLength(2);
  expect(rests).toEqual([120_000]);
  expect(recordingPace({ idleMs: 30_000, at: new Date("2026-10-20T15:00:00Z"), timeZone: "America/Chicago" })).toBe("slow");
  expect(recordingPace({ idleMs: 30_000, at: new Date("2026-10-21T05:00:00Z"), timeZone: "America/Chicago" })).toBe("full");
  expect(recordingPace({ idleMs: 10 * 60_000, at: new Date("2026-10-20T15:00:00Z"), timeZone: "America/Chicago" })).toBe("full");
  expect(recordingPace({ at: new Date("2026-10-20T15:00:00Z"), timeZone: "America/Chicago" })).toBe("slow");
});
