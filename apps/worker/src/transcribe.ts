import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tFor, type Locale } from "@crossline/core";

/**
 * Turning a recording into text, on this machine.
 *
 * The audio never leaves the computer: the model is downloaded once, with the person's consent, and from then
 * on the recogniser is told it may not reach the network at all. Everything that touches the model or the audio
 * decoder sits behind `TranscriptionEngine`, so the parts that matter here — the consent gate, the status the
 * screen reads, how long recordings are cut up and how the transcript is written — are tested without either.
 */
export const WHISPER_MODEL = {
  id: "onnx-community/whisper-small",
  source: "https://huggingface.co/onnx-community/whisper-small",
  /** The 8-bit quantised encoder (92 MB) and merged decoder (157 MB) plus tokenizer files: what is actually fetched. */
  approxMegabytes: 255
} as const;

export type TranscriptChunk = { start: number; end: number; text: string };
export type TranscriptionEngine = {
  /** True once the model files are on disk, so recognising needs no network. */
  modelReady(): Promise<boolean>;
  download(onProgress: (fraction: number) => void): Promise<void>;
  /**
   * 16 kHz mono samples in, text out. Never touches the network. `language` is a Whisper code (`zh`, `en`…); left out, the
   * engine listens to the recording and picks one — Whisper does not do that on its own here, it silently assumes English,
   * which turns a Chinese lecture into confident nonsense.
   */
  recognise(samples: Float32Array, language?: string): Promise<{ text: string; chunks: TranscriptChunk[]; language?: string }>;
};

/** The languages the recording is matched against, with how they are named to the reader. Anything else is heard as the closest of these. */
export const TRANSCRIPTION_LANGUAGES: Record<string, string> = {
  // i18n-ignore: each language named in itself (autonyms), the same in either interface language
  zh: "中文", yue: "粤语", en: "English", ja: "日本語", ko: "한국어", de: "Deutsch", fr: "Français", es: "Español", ru: "Русский", it: "Italiano", pt: "Português"
};
export type DecodedAudio = { sampleRate: number; channels: Float32Array[] };
export type AudioDecoder = (bytes: Uint8Array, fileName: string) => Promise<DecodedAudio>;

export type TranscriptionStatus =
  | { state: "ready" }
  | { state: "needs_download"; model: string; source: string; approxMegabytes: number }
  | { state: "downloading"; progress: number }
  | { state: "unavailable"; code: string; message: string };

export type TranscriptionOutcome =
  | { state: "transcribed"; characters: number; seconds: number }
  | { state: "needs_download" }
  | { state: "failed"; code: string; message: string };

const TARGET_RATE = 16_000;
/** A recording longer than this is refused rather than left to run for hours on a laptop. */
export const MAX_SECONDS = 3 * 60 * 60;

/** Averages the channels and resamples to 16 kHz, which is what the recogniser was trained on. */
export function toMono16k(audio: DecodedAudio): Float32Array {
  const length = audio.channels[0]?.length ?? 0;
  const mono = new Float32Array(length);
  for (const channel of audio.channels) for (let i = 0; i < length; i += 1) mono[i]! += (channel[i] ?? 0) / audio.channels.length;
  if (audio.sampleRate === TARGET_RATE) return mono;
  const ratio = audio.sampleRate / TARGET_RATE;
  const out = new Float32Array(Math.floor(length / ratio));
  for (let i = 0; i < out.length; i += 1) {
    const position = i * ratio, base = Math.floor(position), fraction = position - base;
    out[i] = (mono[base] ?? 0) * (1 - fraction) + (mono[base + 1] ?? mono[base] ?? 0) * fraction;
  }
  return out;
}

const clock = (seconds: number) => {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return `${h ? `${h}:` : ""}${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

/** One line per stretch of speech with its start time, so a later quote can be placed in the recording. */
export function formatTranscript(chunks: TranscriptChunk[], fallbackText: string): string {
  const lines = chunks.map((chunk) => ({ ...chunk, text: chunk.text.trim() })).filter((chunk) => chunk.text)
    .map((chunk) => `[${clock(chunk.start)}] ${chunk.text}`);
  return (lines.length ? lines.join("\n") : fallbackText.trim()).slice(0, 200_000);
}

export type TranscriberOptions = {
  engine: TranscriptionEngine; decode: AudioDecoder; modelsDir: string;
  /** Traditional → simplified Chinese, applied to a transcript only when the language heard was Chinese. Defaults to OpenCC. */
  simplify?: (text: string) => Promise<string>;
};

/**
 * Whisper writes Chinese in traditional characters about as often as not (「下週一的七中考試」), and a reader of this app writes
 * simplified. OpenCC converts the characters only; it never rewrites words, so a mis-heard 「期中」 stays mis-heard. If the library
 * is not installed the text is returned as it was rather than the transcript failing.
 */
export async function simplifyChinese(text: string): Promise<string> {
  try {
    const moduleName = "opencc-js";
    const opencc = await import(/* @vite-ignore */ moduleName) as { default?: { Converter: (o: { from: string; to: string }) => (t: string) => string }; Converter?: (o: { from: string; to: string }) => (t: string) => string };
    const Converter = opencc.Converter ?? opencc.default?.Converter;
    return Converter ? Converter({ from: "tw", to: "cn" })(text) : text;
  } catch { return text; }
}

/** Remembers that the person agreed and the model arrived, so a restart does not ask again. */
const markerPath = (dir: string) => path.join(dir, "whisper-small.ready.json");

export function createTranscriber(options: TranscriberOptions) {
  let downloading: { progress: number } | undefined;

  // The status and failures are shown to the person, in the language asked for (the workspace's).
  async function status(locale?: Locale): Promise<TranscriptionStatus> {
    const t = tFor(locale);
    if (downloading) return { state: "downloading", progress: downloading.progress };
    try {
      if (existsSync(markerPath(options.modelsDir)) && await options.engine.modelReady()) return { state: "ready" };
    } catch (error) {
      // A message the engine wrote itself (a missing component) has English too; anything else is shown as it came.
      return { state: "unavailable", code: "TRANSCRIBER_UNAVAILABLE", message: error instanceof Error ? t(error.message) : t("语音识别组件不可用。") };
    }
    return { state: "needs_download", model: WHISPER_MODEL.id, source: WHISPER_MODEL.source, approxMegabytes: WHISPER_MODEL.approxMegabytes };
  }

  /** Only ever called after the person pressed the button that names the source and size. */
  async function download(locale?: Locale): Promise<TranscriptionStatus> {
    const t = tFor(locale);
    if (downloading) return { state: "downloading", progress: downloading.progress };
    downloading = { progress: 0 };
    try {
      await options.engine.download((fraction) => { if (downloading) downloading.progress = Math.max(0, Math.min(1, fraction)); });
      mkdirSync(options.modelsDir, { recursive: true });
      writeFileSync(markerPath(options.modelsDir), JSON.stringify({ model: WHISPER_MODEL.id, downloadedAt: new Date().toISOString() }));
    } catch (error) {
      downloading = undefined;
      return { state: "unavailable", code: "MODEL_DOWNLOAD_FAILED", message: t("模型没有下载成功：{{reason}}", { reason: error instanceof Error ? error.message.slice(0, 200) : t("未知错误") }) };
    }
    downloading = undefined;
    return status(locale);
  }

  async function transcribe(bytes: Uint8Array, fileName: string, language?: string, locale?: Locale): Promise<{ text: string } & TranscriptionOutcome> {
    const t = tFor(locale);
    const current = await status(locale);
    if (current.state === "needs_download" || current.state === "downloading") return { state: "needs_download", text: "" };
    if (current.state === "unavailable") return { state: "failed", code: current.code, message: current.message, text: "" };
    let samples: Float32Array;
    try { samples = toMono16k(await options.decode(bytes, fileName)); }
    catch { return { state: "failed", code: "AUDIO_DECODE_FAILED", message: t("这段录音的格式读不了；可以转成 mp3 或 wav 再传。"), text: "" }; }
    const seconds = samples.length / TARGET_RATE;
    if (seconds < 1) return { state: "failed", code: "AUDIO_EMPTY", message: t("录音里没有可识别的内容。"), text: "" };
    if (seconds > MAX_SECONDS) return { state: "failed", code: "AUDIO_TOO_LONG", message: t("这段录音超过 3 小时；请切成几段再传。"), text: "" };
    try {
      const result = await options.engine.recognise(samples, language);
      const spoken = result.language === "zh" ? await (options.simplify ?? simplifyChinese)(formatTranscript(result.chunks, result.text)) : formatTranscript(result.chunks, result.text);
      const body = spoken;
      if (!body.trim()) return { state: "failed", code: "TRANSCRIPT_EMPTY", message: t("没有识别出任何文字。"), text: "" };
      // The language is stated at the top, so a wrong guess is visible to the person and to whatever reads the transcript next.
      const named = result.language ? TRANSCRIPTION_LANGUAGES[result.language] ?? result.language : "";
      const text = named ? `${language ? t("[语言：{{name}}]", { name: named }) : t("[语言：{{name}}，自动识别]", { name: named })}\n${body}` : body;
      return { state: "transcribed", characters: text.length, seconds: Math.round(seconds), text };
    } catch (error) {
      return { state: "failed", code: "TRANSCRIPTION_FAILED", message: t("识别没有完成：{{reason}}", { reason: error instanceof Error ? error.message.slice(0, 200) : t("未知错误") }), text: "" };
    }
  }

  return { status, download, transcribe };
}

/**
 * The real engine: Whisper (small) through transformers.js on the CPU, and `audio-decode` for mp3/wav/m4a/ogg/flac.
 * Both are imported on use, so a machine without them reports `unavailable` instead of failing to start, and the
 * network is only ever allowed inside `download`.
 */
export function createWhisperEngine(modelsDir: string): { engine: TranscriptionEngine; decode: AudioDecoder } {
  type Transformers = {
    env: { cacheDir: string; allowRemoteModels: boolean; allowLocalModels: boolean };
    pipeline: (task: string, model: string, options: Record<string, unknown>) => Promise<WhisperPipeline>;
    Tensor: new (type: string, data: BigInt64Array, dims: number[]) => unknown;
  };
  type WhisperPipeline = ((audio: Float32Array, options: Record<string, unknown>) => Promise<{ text: string; chunks?: Array<{ timestamp: [number, number | null]; text: string }> }>) & {
    processor: (audio: Float32Array) => Promise<Record<string, unknown>>;
    tokenizer: { convert_tokens_to_ids(tokens: string[]): number[] };
    model: (inputs: Record<string, unknown>) => Promise<{ logits: { data: Float32Array; dims: number[] } }>;
  };
  const load = async (): Promise<Transformers> => {
    const moduleName = "@huggingface/transformers";
    try { return await import(/* @vite-ignore */ moduleName) as Transformers; }
    catch { throw new Error("还没有安装语音识别组件（@huggingface/transformers）。"); }
  };
  const open = async (remote: boolean, onProgress?: (fraction: number) => void) => {
    const { env, pipeline } = await load();
    env.cacheDir = modelsDir; env.allowLocalModels = true; env.allowRemoteModels = remote;
    const seen = new Map<string, { loaded: number; total: number }>();
    return pipeline("automatic-speech-recognition", WHISPER_MODEL.id, {
      dtype: "q8", device: "cpu", local_files_only: !remote,
      progress_callback: (event: { status?: string; file?: string; loaded?: number; total?: number }) => {
        if (!onProgress || event.status !== "progress" || !event.file || !event.total) return;
        seen.set(event.file, { loaded: event.loaded ?? 0, total: event.total });
        const all = [...seen.values()];
        onProgress(all.reduce((sum, item) => sum + item.loaded, 0) / Math.max(1, all.reduce((sum, item) => sum + item.total, 0)));
      }
    });
  };
  /**
   * Which language is being spoken: ask the model for its first decoding step and read the scores it gives each language token
   * (Whisper's decoder begins by naming the language). Three half-minute clips from across the recording are summed, so a silent
   * or musical intro cannot decide it. Verified on Windows text-to-speech voices: Chinese audio scored `zh` 30.2 against `en` 23.7,
   * English `en` 30.8 against 21.2.
   */
  const detectLanguage = async (run: WhisperPipeline, samples: Float32Array): Promise<string> => {
    const { Tensor } = await load();
    const clip = 30 * TARGET_RATE;
    const starts = samples.length <= clip ? [0] : [0.1, 0.4, 0.7].map((fraction) => Math.min(Math.floor(samples.length * fraction), samples.length - clip));
    const codes = Object.keys(TRANSCRIPTION_LANGUAGES);
    const ids = codes.map((code) => run.tokenizer.convert_tokens_to_ids([`<|${code}|>`])[0]!);
    const start = run.tokenizer.convert_tokens_to_ids(["<|startoftranscript|>"])[0]!;
    const totals = new Float64Array(codes.length);
    for (const at of starts) {
      const inputs = await run.processor(samples.subarray(at, at + clip));
      const out = await run.model({ ...inputs, decoder_input_ids: new Tensor("int64", BigInt64Array.from([BigInt(start)]), [1, 1]) });
      ids.forEach((id, index) => { totals[index]! += out.logits.data[id] ?? -Infinity; });
    }
    let best = 0;
    for (let index = 1; index < codes.length; index += 1) if (totals[index]! > totals[best]!) best = index;
    return codes[best]!;
  };
  const engine: TranscriptionEngine = {
    async modelReady() {
      try { await open(false); return true; } catch (error) {
        if (error instanceof Error && error.message.includes("@huggingface/transformers")) throw error;
        return false;
      }
    },
    async download(onProgress) { await open(true, onProgress); },
    async recognise(samples, language) {
      const run = await open(false);
      const chosen = language ?? await detectLanguage(run, samples);
      // 30-second windows overlapped by 5 seconds, which is how Whisper is meant to be fed a long recording.
      const result = await run(samples, { chunk_length_s: 30, stride_length_s: 5, return_timestamps: true, task: "transcribe", language: chosen });
      return { text: result.text, chunks: (result.chunks ?? []).map((chunk) => ({ start: chunk.timestamp[0], end: chunk.timestamp[1] ?? chunk.timestamp[0], text: chunk.text })), language: chosen };
    }
  };
  const decode: AudioDecoder = async (bytes, fileName) => {
    const moduleName = "audio-decode";
    // audio-decode 3.x answers `{ channelData, sampleRate }`; earlier majors answered an AudioBuffer. Both are read.
    type Decoded = { sampleRate: number; channelData?: Float32Array[]; numberOfChannels?: number; getChannelData?: (index: number) => Float32Array };
    let decoder: (buffer: Uint8Array) => Promise<Decoded>;
    try { decoder = ((await import(/* @vite-ignore */ moduleName)) as { default: typeof decoder }).default; }
    // i18n-ignore: never shown — the caller replaces any decode failure with its own message
    catch { throw new Error(`没有安装音频解码组件（audio-decode），无法读取 ${fileName}。`); }
    const buffer = await decoder(bytes);
    const channels = buffer.channelData ?? Array.from({ length: buffer.numberOfChannels ?? 0 }, (_, index) => buffer.getChannelData!(index));
    return { sampleRate: buffer.sampleRate, channels };
  };
  return { engine, decode };
}

/** Where the model lives: inside the data directory, so it is found again after a restart and never in the repository. */
export const modelsDirectory = (dataDir: string) => path.join(dataDir, "models");
