import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { TranscriptChunk } from "./transcribe";
import { withoutHallucinations } from "./transcribe";
import { labelledTurns, type Diarizer, type SpeakerBook } from "./diarize";
import { speechSegments } from "./vad";

/**
 * Server transcription (docs/phone-recording.md 「服务器转写」, 2026-10-20): SenseVoiceSmall, int8, through sherpa-onnx on the CPU. Chosen
 * over Whisper small for the 2-CPU server: its authors report it over five times faster with better Chinese, and it is not a decoder that
 * writes on through silence. The model files are fetched by `deploy/server/run.sh` and checked against these hashes; nothing here reaches
 * the network.
 */
export const SENSEVOICE_MODEL = {
  id: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
  source: "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/",
  files: {
    "model.int8.onnx": "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51",
    "tokens.txt": "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc"
  }
} as const;

const RATE = 16_000;
/** SenseVoice is not a long-form model: each call gets at most this much speech. */
const WINDOW_SECONDS = 20;
/** Audio is read from ffmpeg in blocks of this length, so a three-hour file never sits in memory whole (that alone would be 690 MB). */
export const BLOCK_SECONDS = 600;

/** One short window of 16 kHz mono speech in, its text and the language heard out. */
export type WindowRecogniser = (samples: Float32Array) => Promise<{ text: string; lang: string }>;

/** Checks the model files against their hashes before anything is loaded: a truncated download or a swapped file is refused. */
export async function checkSenseVoice(dir: string): Promise<string | undefined> {
  for (const [name, expected] of Object.entries(SENSEVOICE_MODEL.files)) {
    const file = path.join(dir, name);
    if (!existsSync(file)) return `缺少语音识别模型文件 ${name}`;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
    if (hash.digest("hex") !== expected) return `语音识别模型文件 ${name} 校验不符`;
  }
  return undefined;
}

/** The real recogniser: sherpa-onnx's offline SenseVoice, loaded on first use, `threads` CPU threads. */
export function createSenseVoice(dir: string, threads = 1): WindowRecogniser {
  type Sherpa = { OfflineRecognizer: new (config: Record<string, unknown>) => {
    createStream(): { acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void };
    decodeAsync(stream: unknown): Promise<void>;
    getResult(stream: unknown): { text: string; lang: string };
  } };
  let recogniser: Promise<InstanceType<Sherpa["OfflineRecognizer"]>> | undefined;
  const load = async () => {
    const moduleName = "sherpa-onnx-node";
    const loaded = await import(/* @vite-ignore */ moduleName) as Sherpa & { default?: Sherpa };
    const sherpa = loaded.default ?? loaded;
    return new sherpa.OfflineRecognizer({ featConfig: { sampleRate: RATE, featureDim: 80 },
      modelConfig: { senseVoice: { model: path.join(dir, "model.int8.onnx"), useInverseTextNormalization: 1 }, tokens: path.join(dir, "tokens.txt"),
        numThreads: threads, provider: "cpu", debug: 0 } });
  };
  return async (samples) => {
    const run = await (recogniser ??= load().catch((error: unknown) => { recogniser = undefined; throw error; }));
    const stream = run.createStream();
    stream.acceptWaveform({ samples, sampleRate: RATE });
    await run.decodeAsync(stream);
    const result = run.getResult(stream);
    return { text: result.text ?? "", lang: String(result.lang ?? "").replace(/[<|>]/g, "") };
  };
}

/**
 * Any audio file as 16 kHz mono blocks, decoded by ffmpeg (m4a, aac, mp3, opus, webm, wav …): the server image has it, and it is what
 * keeps memory flat. `ffmpeg` must be on the path, or `CROSSLINE_FFMPEG`.
 */
export async function* ffmpegBlocks(file: string, blockSeconds = BLOCK_SECONDS): AsyncGenerator<Float32Array> {
  const child = spawn(process.env.CROSSLINE_FFMPEG || "ffmpeg", ["-nostdin", "-v", "error", "-i", file, "-ac", "1", "-ar", String(RATE), "-f", "f32le", "pipe:1"],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let errors = "";
  child.stderr.on("data", (data: Buffer) => { errors = (errors + data.toString()).slice(-400); });
  const exited = new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? 1)));
  const size = blockSeconds * RATE * 4;
  let pending: Buffer = Buffer.alloc(0);
  for await (const data of child.stdout as AsyncIterable<Buffer>) {
    pending = pending.length ? Buffer.concat([pending, data]) : data;
    while (pending.length >= size) {
      yield new Float32Array(pending.buffer.slice(pending.byteOffset, pending.byteOffset + size));
      pending = pending.subarray(size);
    }
  }
  if ((await exited) !== 0) throw new Error(`ffmpeg 读不了这个录音：${errors.trim() || "未知错误"}`);
  const whole = pending.length - (pending.length % 4);
  if (whole) yield new Float32Array(pending.buffer.slice(pending.byteOffset, pending.byteOffset + whole));
}

export type BlockTranscript = { state: "transcribed" | "silent"; text: string; seconds: number; speechSeconds: number; workMs: number; language?: string } | { state: "stopped" };

/**
 * Transcribes a recording block by block: each block's speech is found (`vad.ts`), cut into windows of at most twenty seconds, and each
 * window becomes one timestamped line. `stop` is asked before every window, so the night ending or the consent being withdrawn leaves the
 * file for later instead of half-written text. With `speakers`, a block that has speech is diarized instead and each speaker turn is
 * recognised in its own windows, so every line says who spoke (`[00:20] 说话人 1：…`); a block the diarizer finds no turn in falls back
 * to the speech windows without a label.
 */
export async function transcribeBlocks(blocks: AsyncIterable<Float32Array>, recognise: WindowRecogniser,
  options: { stop?: () => boolean; now?: () => number; speakers?: { diarizer: Diarizer; book: SpeakerBook } } = {}): Promise<BlockTranscript> {
  const now = options.now ?? Date.now;
  const started = now();
  const chunks: TranscriptChunk[] = [];
  const languages = new Map<string, number>();
  let offset = 0, speech = 0;
  for await (const block of blocks) {
    const voiced = speechSegments(block, RATE);
    let regions: Array<{ start: number; end: number; speaker: string }> = voiced.map((segment) => ({ ...segment, speaker: "" }));
    if (voiced.length && options.speakers) {
      if (options.stop?.()) return { state: "stopped" };
      // Only the speech is diarized: a day's recording is mostly quiet, and pyannote reads every window it is given.
      const compact = new Float32Array(voiced.reduce((sum, segment) => sum + segment.end - segment.start, 0));
      const pieces: Array<{ at: number; start: number; length: number }> = [];
      for (const segment of voiced) {
        const at = pieces.length ? pieces.at(-1)!.at + pieces.at(-1)!.length : 0;
        compact.set(block.subarray(segment.start, segment.end), at);
        pieces.push({ at, start: segment.start, length: segment.end - segment.start });
      }
      const turns = await labelledTurns(compact, options.speakers.diarizer, options.speakers.book);
      const mapped = turns.flatMap((turn) => pieces.flatMap((piece) => {
        const from = Math.max(Math.round(turn.start * RATE), piece.at), to = Math.min(Math.round(turn.end * RATE), piece.at + piece.length);
        return to - from >= 0.3 * RATE ? [{ start: piece.start + from - piece.at, end: piece.start + to - piece.at, speaker: turn.speaker }] : [];
      }));
      if (mapped.length) regions = mapped;
    }
    for (const region of regions) {
      for (let start = region.start; start < region.end; start += WINDOW_SECONDS * RATE) {
        if (options.stop?.()) return { state: "stopped" };
        const end = Math.min(region.end, start + WINDOW_SECONDS * RATE);
        const heard = await recognise(block.subarray(start, end));
        speech += (end - start) / RATE;
        if (heard.lang) languages.set(heard.lang, (languages.get(heard.lang) ?? 0) + (end - start));
        chunks.push({ start: offset + start / RATE, end: offset + end / RATE, text: heard.text, ...(region.speaker ? { speaker: region.speaker } : {}) });
      }
    }
    offset += block.length / RATE;
  }
  const kept = withoutHallucinations(chunks);
  const language = [...languages].sort((a, b) => b[1] - a[1])[0]?.[0];
  const clock = (seconds: number) => { const total = Math.floor(seconds); const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    return `${h ? `${h}:` : ""}${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`; };
  const body = kept.map((chunk) => `[${clock(chunk.start)}] ${chunk.speaker ? `${chunk.speaker}：` : ""}${chunk.text.trim()}`).join("\n");
  const base = { seconds: Math.round(offset), speechSeconds: Math.round(speech), workMs: now() - started };
  if (!body.trim()) return { state: "silent", text: "", ...base };
  const named = language === "zh" ? "中文" : language === "en" ? "English" : language === "yue" ? "粤语" : language === "ja" ? "日本語" : language === "ko" ? "한국어" : language;
  return { state: "transcribed", text: named ? `[语言：${named}，自动识别]\n${body}` : body, ...base, ...(language ? { language } : {}) };
}
