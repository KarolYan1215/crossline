import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { RECORDING_VOICEPRINT_SEGMENTS, SPEAKER_SELF, VOICEPRINT_MAX_SPEECH_SECONDS, VOICEPRINT_MIN_SPEECH_SECONDS } from "@crossline/core";
import { speechSegments } from "./vad";

/**
 * Who spoke when (docs/phone-recording.md 「说话人」, 2026-10-21): sherpa-onnx's offline diarization — pyannote segmentation 3.0 and the
 * 3D-Speaker CAM++ Chinese speaker embedding — run by the transcriber container beside SenseVoice. A recording is read in ten-minute
 * blocks, so each block is diarized on its own and its speakers are matched across blocks by their embeddings (`SpeakerBook`); with the
 * 识别本人声音 consent a speaker close enough to the person's voiceprint is 「本人」. Thresholds were measured on sherpa-onnx's
 * four-speaker Chinese sample: the same speaker's segments scored 0.64–0.87 cosine, different speakers at most 0.43; clustering inside a
 * block at 0.75 found the four.
 */
export const DIARIZATION_MODEL = {
  files: {
    "segmentation.int8.onnx": "d582f4b4c6b48205de7e0643c57df0df5615a3c176189be3fc461e9d18827b5d",
    "speaker.onnx": "f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11"
  },
  sources: {
    "segmentation.int8.onnx": "csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.int8.onnx",
    "speaker.onnx": "csukuangfj/speaker-embedding-models/resolve/main/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx"
  }
} as const;

const RATE = 16_000;
const CLUSTER_THRESHOLD = 0.75;
/** pyannote windows overlap by 1 − this; 0.1 (the default) found the sample's four speakers in 0.37 s per second of speech, 0.2 in 0.21 s, 0.25 and up merged two of them. */
const WINDOW_SHIFT = 0.2;
/** Two embeddings at least this similar are one speaker across blocks of one recording. */
export const SAME_SPEAKER = 0.55;
/** A speaker at least this similar to the voiceprint is the person: stricter than `SAME_SPEAKER`, since a wrong 「本人」 misattributes a promise. */
export const SELF_SPEAKER = 0.6;
/** Audio a speaker's embedding is taken from, at most, per block. */
const EMBED_SECONDS = 30;

export type DiarizedSegment = { start: number; end: number; speaker: number };
export type Diarizer = {
  /** Speaker turns in one block of 16 kHz mono, in seconds from the block's start; speaker ids are local to the block. */
  segments(samples: Float32Array): Promise<DiarizedSegment[]>;
  /** A unit-length speaker embedding of some speech. */
  embed(samples: Float32Array): Promise<Float32Array>;
};

/** Checks the diarization files against their hashes; undefined when they are all there and right. */
export async function checkDiarization(dir: string): Promise<string | undefined> {
  for (const [name, expected] of Object.entries(DIARIZATION_MODEL.files)) {
    const file = path.join(dir, name);
    if (!existsSync(file)) return `缺少说话人分离模型文件 ${name}`;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
    if (hash.digest("hex") !== expected) return `说话人分离模型文件 ${name} 校验不符`;
  }
  return undefined;
}

export const unit = (vector: ArrayLike<number>): Float32Array => {
  const out = Float32Array.from(vector);
  let norm = 0;
  for (const value of out) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i += 1) out[i]! /= norm;
  return out;
};
export const cosine = (a: Float32Array, b: Float32Array): number => {
  let sum = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) sum += a[i]! * b[i]!;
  return sum;
};

/** The real diarizer, loaded on first use. */
export function createDiarizer(dir: string, threads = 1): Diarizer {
  type Stream = { acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void; inputFinished(): void };
  type Sherpa = {
    OfflineSpeakerDiarization: new (config: Record<string, unknown>) => { process(samples: Float32Array): DiarizedSegment[] };
    SpeakerEmbeddingExtractor: new (config: Record<string, unknown>) => { createStream(): Stream; compute(stream: Stream): Float32Array };
  };
  type Loaded = { diarizer: InstanceType<Sherpa["OfflineSpeakerDiarization"]>; extractor: InstanceType<Sherpa["SpeakerEmbeddingExtractor"]> };
  let loaded: Promise<Loaded> | undefined;
  const open = async (): Promise<Loaded> => {
    const moduleName = "sherpa-onnx-node";
    const imported = await import(/* @vite-ignore */ moduleName) as Sherpa & { default?: Sherpa };
    const sherpa = imported.default ?? imported;
    const embedding = { model: path.join(dir, "speaker.onnx"), numThreads: threads, provider: "cpu", debug: 0 };
    return {
      diarizer: new sherpa.OfflineSpeakerDiarization({ segmentation: { pyannote: { model: path.join(dir, "segmentation.int8.onnx"), windowShiftRatio: Number(process.env.CROSSLINE_DIARIZE_SHIFT) || WINDOW_SHIFT }, numThreads: threads, provider: "cpu", debug: 0 },
        embedding, clustering: { numClusters: -1, threshold: CLUSTER_THRESHOLD }, minDurationOn: 0.3, minDurationOff: 0.5 }),
      extractor: new sherpa.SpeakerEmbeddingExtractor(embedding)
    };
  };
  const load = () => (loaded ??= open().catch((error: unknown) => { loaded = undefined; throw error; }));
  return {
    segments: async (samples) => (await load()).diarizer.process(samples).map((segment) => ({ start: segment.start, end: segment.end, speaker: segment.speaker })),
    embed: async (samples) => {
      const { extractor } = await load();
      const stream = extractor.createStream();
      stream.acceptWaveform({ samples, sampleRate: RATE });
      stream.inputFinished();
      return unit(extractor.compute(stream));
    }
  };
}

/**
 * Speakers across the blocks of one recording. Each block's speaker brings an embedding; it joins the most similar speaker already
 * heard when that is at least `SAME_SPEAKER` similar, else it is a new 「说话人 N」. A voiceprint, when there is one, is checked first.
 * Nothing is kept once the recording is done.
 */
export class SpeakerBook {
  #speakers: Array<{ label: string; sum: Float32Array; count: number }> = [];
  #others = 0;
  constructor(private readonly self?: Float32Array) {}

  label(embedding: Float32Array): string {
    if (this.self && cosine(embedding, this.self) >= SELF_SPEAKER) return SPEAKER_SELF;
    let best: { index: number; score: number } | undefined;
    this.#speakers.forEach((speaker, index) => {
      const score = cosine(embedding, unit(speaker.sum));
      if (score >= SAME_SPEAKER && (!best || score > best.score)) best = { index, score };
    });
    if (best) {
      const speaker = this.#speakers[best.index]!;
      for (let i = 0; i < speaker.sum.length; i += 1) speaker.sum[i]! += embedding[i] ?? 0;
      speaker.count += 1;
      return speaker.label;
    }
    this.#others += 1;
    const label = `说话人 ${this.#others}`;
    this.#speakers.push({ label, sum: Float32Array.from(embedding), count: 1 });
    return label;
  }
}

/** One block's speaker turns with a label each, matched through `book`; a speaker too short to embed keeps its local turn unlabelled. */
export async function labelledTurns(samples: Float32Array, diarizer: Diarizer, book: SpeakerBook): Promise<Array<{ start: number; end: number; speaker: string }>> {
  const turns = (await diarizer.segments(samples)).filter((turn) => turn.end - turn.start >= 0.3).sort((a, b) => a.start - b.start);
  const labels = new Map<number, string>();
  for (const local of new Set(turns.map((turn) => turn.speaker))) {
    const pieces: Float32Array[] = [];
    let seconds = 0;
    for (const turn of turns.filter((item) => item.speaker === local)) {
      if (seconds >= EMBED_SECONDS) break;
      const take = Math.min(turn.end - turn.start, EMBED_SECONDS - seconds);
      pieces.push(samples.subarray(Math.round(turn.start * RATE), Math.round((turn.start + take) * RATE)));
      seconds += take;
    }
    const joined = new Float32Array(pieces.reduce((sum, piece) => sum + piece.length, 0));
    let at = 0;
    for (const piece of pieces) { joined.set(piece, at); at += piece.length; }
    labels.set(local, seconds >= 1 ? book.label(await diarizer.embed(joined)) : "");
  }
  return turns.map((turn) => ({ start: turn.start, end: turn.end, speaker: labels.get(turn.speaker) ?? "" }));
}

/** Where a workspace's voiceprint and its pending enrolment live. */
export const voiceprintDir = (dataDir: string) => path.join(dataDir, ...RECORDING_VOICEPRINT_SEGMENTS);
export const voiceprintFile = (dataDir: string, workspaceId: string) => path.join(voiceprintDir(dataDir), `${workspaceId}.json`);
export const voiceprintFailedFile = (dataDir: string, workspaceId: string) => path.join(voiceprintDir(dataDir), `${workspaceId}.failed.json`);

export function readVoiceprint(dataDir: string, workspaceId: string): Float32Array | undefined {
  try {
    const stored = JSON.parse(readFileSync(voiceprintFile(dataDir, workspaceId), "utf8")) as { vector?: unknown };
    return Array.isArray(stored.vector) && stored.vector.length ? unit(stored.vector as number[]) : undefined;
  } catch { return undefined; }
}

/**
 * Makes the voiceprint from an enrolment recording's blocks: its speech (the same VAD as transcription), at least
 * `VOICEPRINT_MIN_SPEECH_SECONDS` of it, at most `VOICEPRINT_MAX_SPEECH_SECONDS`, embedded in thirty-second pieces and averaged.
 * Writes only the vector; the caller deletes the audio whatever happens.
 */
export async function enrolVoiceprint(dataDir: string, workspaceId: string, blocks: AsyncIterable<Float32Array>, diarizer: Pick<Diarizer, "embed">, now = new Date()): Promise<{ ok: true; seconds: number } | { ok: false; message: string }> {
  const pieces: Float32Array[] = [];
  let seconds = 0;
  for await (const block of blocks) {
    for (const segment of speechSegments(block, RATE)) {
      if (seconds >= VOICEPRINT_MAX_SPEECH_SECONDS) break;
      const piece = block.subarray(segment.start, Math.min(segment.end, segment.start + (VOICEPRINT_MAX_SPEECH_SECONDS - seconds) * RATE));
      pieces.push(piece);
      seconds += piece.length / RATE;
    }
  }
  mkdirSync(voiceprintDir(dataDir), { recursive: true });
  if (seconds < VOICEPRINT_MIN_SPEECH_SECONDS) {
    const message = `录音里只听到约 ${Math.round(seconds)} 秒人声，至少需要 ${VOICEPRINT_MIN_SPEECH_SECONDS} 秒本人说话。`;
    writeFileSync(voiceprintFailedFile(dataDir, workspaceId), JSON.stringify({ message, at: now.toISOString() }));
    return { ok: false, message };
  }
  const joined = new Float32Array(pieces.reduce((sum, piece) => sum + piece.length, 0));
  let at = 0;
  for (const piece of pieces) { joined.set(piece, at); at += piece.length; }
  let total = new Float32Array(0);
  for (let start = 0; start < joined.length; start += EMBED_SECONDS * RATE) {
    const part = joined.subarray(start, Math.min(joined.length, start + EMBED_SECONDS * RATE));
    if (part.length < 3 * RATE) continue;
    const vector = await diarizer.embed(part);
    if (!total.length) total = new Float32Array(vector.length);
    for (let i = 0; i < vector.length; i += 1) total[i]! += vector[i]!;
  }
  writeFileSync(voiceprintFile(dataDir, workspaceId), JSON.stringify({ vector: Array.from(unit(total)), seconds: Math.round(seconds), at: now.toISOString() }));
  rmSync(voiceprintFailedFile(dataDir, workspaceId), { force: true });
  return { ok: true, seconds: Math.round(seconds) };
}
