/**
 * Runs the server transcriber's engine for real on this machine (docs/phone-recording.md 「服务器转写」): checks the SenseVoice files'
 * hashes, decodes each recording through ffmpeg in blocks, and prints the transcript, speech seconds and the real-time factor.
 *
 *   pnpm exec tsx scripts/sensevoice-check.ts <model dir> <recording> [more recordings…]
 *
 * `CROSSLINE_TRANSCRIBE_THREADS` sets the threads (1, as on the server's one CPU, by default). With the diarization files
 * (`segmentation.int8.onnx`, `speaker.onnx`) in `CROSSLINE_DIARIZE_DIR` (default: the model dir) each line names its speaker, and
 * `CROSSLINE_VOICEPRINT=<recording of one person>` enrols that voice first, so its lines read 「本人」. Peak memory is printed too.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SpeakerBook, checkDiarization, createDiarizer, enrolVoiceprint, readVoiceprint } from "../apps/worker/src/diarize";
import { checkSenseVoice, createSenseVoice, ffmpegBlocks, transcribeBlocks } from "../apps/worker/src/sensevoice";

const [dir, ...files] = process.argv.slice(2);
if (!dir || !files.length) { console.error("usage: tsx scripts/sensevoice-check.ts <model dir> <recording>…"); process.exit(2); }
const problem = await checkSenseVoice(dir);
if (problem) { console.error(problem); process.exit(1); }
const threads = Number(process.env.CROSSLINE_TRANSCRIBE_THREADS) || 1;
const recognise = createSenseVoice(dir, threads);
const diarizeDir = process.env.CROSSLINE_DIARIZE_DIR || dir;
const diarizationProblem = await checkDiarization(diarizeDir);
if (diarizationProblem) console.error(`no speakers: ${diarizationProblem}`);
const timing = { segments: 0, embed: 0 };
const real = diarizationProblem ? undefined : createDiarizer(diarizeDir, threads);
const timed = <A extends unknown[], R>(key: keyof typeof timing, run: (...args: A) => Promise<R>) => async (...args: A) => { const t = Date.now(); try { return await run(...args); } finally { timing[key] += Date.now() - t; } };
const diarizer = real && { segments: timed("segments", real.segments), embed: timed("embed", real.embed) };
let self: Float32Array | undefined;
if (diarizer && process.env.CROSSLINE_VOICEPRINT) {
  const scratch = mkdtempSync(path.join(tmpdir(), "crossline-voiceprint-"));
  console.log(JSON.stringify({ voiceprint: await enrolVoiceprint(scratch, "check", ffmpegBlocks(process.env.CROSSLINE_VOICEPRINT), diarizer) }));
  self = readVoiceprint(scratch, "check");
  rmSync(scratch, { recursive: true, force: true });
}
let peak = 0;
const sample = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 200);
for (const file of files) {
  const started = Date.now();
  const result = await transcribeBlocks(ffmpegBlocks(file), recognise, diarizer ? { speakers: { diarizer, book: new SpeakerBook(self) } } : {});
  const wall = Date.now() - started;
  console.log(JSON.stringify({ file, ...result, wallMs: wall, realTimeFactor: "seconds" in result && result.seconds ? +(wall / 1000 / result.seconds).toFixed(3) : null }, null, 2));
}
clearInterval(sample);
console.log(JSON.stringify({ diarizeMs: timing }));
console.log(JSON.stringify({ peakRssMb: Math.round(Math.max(peak, process.memoryUsage().rss) / 1e6) }));
