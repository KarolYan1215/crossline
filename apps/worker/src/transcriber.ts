import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { CrosslineStore } from "@crossline/db";
import { RECORDING_VOICEPRINT_CONSENT, TRANSCRIBE_WINDOW, inTranscribeWindow } from "@crossline/core";
import { SpeakerBook, checkDiarization, createDiarizer, enrolVoiceprint, readVoiceprint, voiceprintDir, type Diarizer } from "./diarize";
import { inboxFiles, processInbox, serverRecordingsOn } from "./recording-inbox";
import { checkSenseVoice, createSenseVoice, ffmpegBlocks, transcribeBlocks, type WindowRecogniser } from "./sensevoice";

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
const recognise = () => (recogniser ??= createSenseVoice(modelDir, threads));
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
  if (recogniser && !waitingTonight) { log("transcriber.release"); store.close(); process.exit(0); }
}

log("transcriber.started", { modelDir, threads, window });
for (;;) {
  await pass().catch((error: unknown) => log("transcriber.pass_failed", { message: error instanceof Error ? error.message.slice(0, 300) : "" }));
  await new Promise((resolve) => setTimeout(resolve, 5 * 60_000));
}
