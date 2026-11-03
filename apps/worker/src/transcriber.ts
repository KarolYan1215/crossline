import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CrosslineStore } from "@crossline/db";
import { RECORDING_VOICEPRINT_CONSENT, TRANSCRIBE_WINDOW, inTranscribeWindow } from "@crossline/core";
import { SpeakerBook, checkDiarization, createDiarizer, enrolVoiceprint, readVoiceprint, voiceprintDir, type Diarizer } from "./diarize";
import { inboxFiles, processInbox, serverRecordingsOn } from "./recording-inbox";
import { checkSenseVoice, createSenseVoice, ffmpegBlocks, transcribeBlocks, type WindowRecogniser } from "./sensevoice";
import { aliveFile, dictateSamples, inboxDir, outboxDir, pcmToSamples } from "./dictate";

/**
 * The transcriber container's process (docs/phone-recording.md 「服务器转写」; started by `deploy/server/run.sh` when
 * `CROSSLINE_SERVER_TRANSCRIBE=1`): every five minutes it looks at each workspace that allowed 录音在服务器转写, and in that workspace's
 * night works through its inbox with SenseVoice on `CROSSLINE_TRANSCRIBE_THREADS` threads (1, matching the container's one CPU). When
 * the model has been loaded and no workspace has anything left in its night, the process exits so the ~400 MB it holds is given back;
 * Docker starts it again, idle. It writes the ledger the web app and the worker share; the digest runs in the worker. With the
 * diarization files beside the model (`diarize.ts`) every recording is split by speaker, and a workspace with 识别本人声音 has its
 * enrolment recording turned into a voiceprint on the next pass, night or day (it is a few seconds of work).
 */
const dataDir = path.resolve(process.env.CROSSLINE_DATA_DIR ?? "data");
const modelDir = process.env.CROSSLINE_SENSEVOICE_DIR ?? "/models/sensevoice";
const threads = Math.max(1, Number(process.env.CROSSLINE_TRANSCRIBE_THREADS) || 1);
const window = process.env.CROSSLINE_TRANSCRIBE_WINDOW?.trim() || TRANSCRIBE_WINDOW;
const store = new CrosslineStore(path.join(dataDir, "crossline.db"));
const log = (type: string, detail: Record<string, unknown> = {}) => console.info(JSON.stringify({ type, at: new Date().toISOString(), ...detail }));

const zoneOf = (workspaceId: string) => {
  try {
    const zone = (JSON.parse(store.getSetting(workspaceId, "schedule.preferences") ?? "{}") as { timeZone?: unknown }).timeZone;
    if (typeof zone === "string") { new Intl.DateTimeFormat("en", { timeZone: zone }); return zone; }
  } catch { /* the default */ }
  return process.env.CROSSLINE_TIME_ZONE ?? "America/Chicago";
};

const problem = await checkSenseVoice(modelDir);
if (problem) {
  // Without the model there is nothing to do; say so once an hour rather than restarting in a loop.
  log("transcriber.model_missing", { modelDir, problem });
  await new Promise((resolve) => setTimeout(resolve, 60 * 60_000));
  process.exit(1);
}

const diarizationProblem = await checkDiarization(modelDir);
if (diarizationProblem) log("transcriber.no_diarization", { problem: diarizationProblem });
const diarizer: Diarizer | undefined = diarizationProblem ? undefined : createDiarizer(modelDir, threads);
const voiceprintOn = (workspaceId: string) => store.getSetting(workspaceId, RECORDING_VOICEPRINT_CONSENT) === "granted";

/** Enrolment recordings waiting: `<workspace>.enrol.<ext>` beside the voiceprints. One without the consent (or without the model) is deleted. */
async function enrolments(): Promise<void> {
  let names: string[] = [];
  try { names = readdirSync(voiceprintDir(dataDir)); } catch { return; }
  for (const name of names) {
    const match = /^(.+)\.enrol\.[a-z0-9]+$/i.exec(name);
    if (!match) continue;
    const workspaceId = match[1]!, file = path.join(voiceprintDir(dataDir), name);
    try {
      if (diarizer && voiceprintOn(workspaceId)) log("transcriber.voiceprint", { workspaceId, ...(await enrolVoiceprint(dataDir, workspaceId, ffmpegBlocks(file), diarizer)) });
    } catch (error) { log("transcriber.voiceprint_failed", { workspaceId, message: error instanceof Error ? error.message.slice(0, 300) : "" }); }
    rmSync(file, { force: true });
  }
}

let recogniser: WindowRecogniser | undefined;
const model = () => (recogniser ??= createSenseVoice(modelDir, threads));
/**
 * One recognition at a time on the container's one CPU, a dictation always first: a person is waiting on it, while a recording's next
 * window can wait the second or two a clip takes (docs/voice-input.md).
 */
const waiting: Array<{ urgent: boolean; start: () => void }> = [];
let busy = false;
function turn(urgent: boolean): Promise<() => void> {
  return new Promise((resolve) => {
    const start = () => { busy = true; resolve(() => { busy = false; const next = waiting.findIndex((item) => item.urgent); const [item] = waiting.splice(next >= 0 ? next : 0, 1); item?.start(); }); };
    if (!busy) start(); else waiting.push({ urgent, start });
  });
}
const queued = (urgent: boolean): WindowRecogniser => async (samples) => { const done = await turn(urgent); try { return await model()(samples); } finally { done(); } };
const recognise = () => queued(false);

/**
 * Voice input's server engine: the worker drops a clip (16 kHz PCM the page decoded) into `dictation/inbox`, this answers in `outbox` and
 * deletes the clip at once. A heartbeat every 30 s tells the worker the engine is up; a dictation in the last ten minutes keeps the model
 * loaded, so the next one does not wait for it.
 */
let lastDictation = 0;
mkdirSync(inboxDir(dataDir), { recursive: true });
mkdirSync(outboxDir(dataDir), { recursive: true });
const beat = () => { const file = aliveFile(dataDir); try { utimesSync(file, new Date(), new Date()); } catch { writeFileSync(file, ""); } };
beat();
setInterval(beat, 30_000).unref();
async function dictations(): Promise<void> {
  for (const name of readdirSync(inboxDir(dataDir)).filter((entry) => /^[0-9a-f-]{36}\.pcm$/.test(entry))) {
    const file = path.join(inboxDir(dataDir), name), answer = path.join(outboxDir(dataDir), name.replace(/\.pcm$/, ".json"));
    let result: Record<string, unknown>;
    try {
      const bytes = readFileSync(file);
      rmSync(file, { force: true });
      const started = Date.now();
      const heard = await dictateSamples(pcmToSamples(bytes), queued(true));
      result = { text: heard.text, ...(heard.language ? { language: heard.language } : {}) };
      log("transcriber.dictation", { seconds: Math.round(bytes.length / 32_000), workMs: Date.now() - started });
    } catch (error) {
      rmSync(file, { force: true });
      result = { error: error instanceof Error ? error.message.slice(0, 120) : "failed" };
    }
    lastDictation = Date.now();
    writeFileSync(`${answer}.part`, JSON.stringify(result));
    renameSync(`${answer}.part`, answer);
  }
}
void (async () => {
  for (;;) {
    await dictations().catch((error: unknown) => log("transcriber.dictation_failed", { message: error instanceof Error ? error.message.slice(0, 200) : "" }));
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
})();
async function pass(): Promise<void> {
  await enrolments();
  let waitingTonight = 0;
  for (const workspace of store.listWorkspaces()) {
    if (!serverRecordingsOn(store, workspace.id) || !inboxFiles(dataDir, workspace.id).length) continue;
    const timeZone = zoneOf(workspace.id);
    if (!inTranscribeWindow(new Date(), timeZone, window)) continue;
    const outcomes = await processInbox(store, workspace.id, { dataDir, timeZone, window, recognise,
      transcribe: (file, run, stop) => transcribeBlocks(ffmpegBlocks(file), run, { stop,
        ...(diarizer ? { speakers: { diarizer, book: new SpeakerBook(voiceprintOn(workspace.id) ? readVoiceprint(dataDir, workspace.id) : undefined) } } : {}) }) });
    if (outcomes.length) log("transcriber.pass", { workspaceId: workspace.id, outcomes });
    if (inboxFiles(dataDir, workspace.id).length && inTranscribeWindow(new Date(), timeZone, window)) waitingTonight += 1;
  }
  if (recogniser && !waitingTonight && Date.now() - lastDictation > 10 * 60_000) { log("transcriber.release"); store.close(); process.exit(0); }
}

log("transcriber.started", { modelDir, threads, window });
for (;;) {
  await pass().catch((error: unknown) => log("transcriber.pass_failed", { message: error instanceof Error ? error.message.slice(0, 300) : "" }));
  await new Promise((resolve) => setTimeout(resolve, 5 * 60_000));
}
