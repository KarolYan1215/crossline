/**
 * Runs the server transcriber's engine for real on this machine (docs/phone-recording.md 「服务器转写」): checks the SenseVoice files'
 * hashes, decodes each recording through ffmpeg in blocks, and prints the transcript, speech seconds and the real-time factor.
 *
 *   pnpm exec tsx scripts/sensevoice-check.ts <model dir> <recording> [more recordings…]
 *
 * `CROSSLINE_TRANSCRIBE_THREADS` sets the threads (1, as on the server's one CPU, by default).
 */
import { checkSenseVoice, createSenseVoice, ffmpegBlocks, transcribeBlocks } from "../apps/worker/src/sensevoice";

const [dir, ...files] = process.argv.slice(2);
if (!dir || !files.length) { console.error("usage: tsx scripts/sensevoice-check.ts <model dir> <recording>…"); process.exit(2); }
const problem = await checkSenseVoice(dir);
if (problem) { console.error(problem); process.exit(1); }
const recognise = createSenseVoice(dir, Number(process.env.CROSSLINE_TRANSCRIBE_THREADS) || 1);
for (const file of files) {
  const started = Date.now();
  const result = await transcribeBlocks(ffmpegBlocks(file), recognise);
  const wall = Date.now() - started;
  console.log(JSON.stringify({ file, ...result, wallMs: wall, realTimeFactor: "seconds" in result && result.seconds ? +(wall / 1000 / result.seconds).toFixed(3) : null }, null, 2));
}
