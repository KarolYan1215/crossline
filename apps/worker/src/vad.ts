/**
 * Voice activity detection for all-day recordings (docs/phone-recording.md): a phone left recording all day is mostly silence, room
 * noise and long pauses, and Whisper pads every input to thirty seconds and tends to invent words in silence. So only the stretches with
 * speech go to the model, packed together, and every line of the transcript is put back at its time in the original recording.
 *
 * Energy against an adaptive noise floor, not Silero: Silero's ONNX file is one more model to download and agree to, while energy needs
 * nothing new and is what decides most of a recorder's day (silence is quiet). The threshold sits 10 dB over the recording's own quiet
 * (its 15th percentile frame), never above −30 dBFS — so a recording that is talk from end to end still passes — and never below −50, so
 * a dead-silent file is not read as speech.
 */
export const VAD = {
  frameMs: 30,
  marginDb: 10,
  /** The threshold is clamped to this range of dBFS. */
  lowestDb: -50,
  highestDb: -30,
  /** Speech frames keep the segment open this long after them (the tail of a word, a breath). */
  hangoverMs: 400,
  /** Two segments this close become one. */
  mergeGapMs: 1000,
  /** A segment with less speech than this is a click or a cough. */
  minSpeechMs: 300,
  /** Kept either side of a segment, so the first and last syllable are not cut. */
  padMs: 300
} as const;

export type SpeechSegment = { start: number; end: number };

/** Stretches with speech, as sample indices, in order. */
export function speechSegments(samples: Float32Array, rate = 16_000): SpeechSegment[] {
  const frame = Math.max(1, Math.round((rate * VAD.frameMs) / 1000));
  const frames = Math.floor(samples.length / frame);
  if (!frames) return [];
  const db = new Float64Array(frames);
  for (let index = 0; index < frames; index += 1) {
    let sum = 0;
    for (let at = index * frame; at < (index + 1) * frame; at += 1) sum += samples[at]! * samples[at]!;
    db[index] = 10 * Math.log10(sum / frame + 1e-12);
  }
  const sorted = Float64Array.from(db).sort();
  const floor = sorted[Math.floor(frames * 0.15)]!;
  const threshold = Math.min(VAD.highestDb, Math.max(VAD.lowestDb, floor + VAD.marginDb));
  const toFrames = (ms: number) => Math.round(ms / VAD.frameMs);
  const segments: Array<{ from: number; to: number; speech: number }> = [];
  for (let index = 0; index < frames; index += 1) {
    if (db[index]! < threshold) continue;
    const last = segments.at(-1);
    if (last && index <= last.to + toFrames(VAD.hangoverMs) + toFrames(VAD.mergeGapMs)) { last.to = index; last.speech += 1; }
    else segments.push({ from: index, to: index, speech: 1 });
  }
  const pad = toFrames(VAD.padMs), hang = toFrames(VAD.hangoverMs);
  return segments.filter((segment) => segment.speech >= toFrames(VAD.minSpeechMs))
    .map((segment) => ({ start: Math.max(0, (segment.from - pad) * frame), end: Math.min(samples.length, (segment.to + 1 + hang + pad) * frame) }))
    // Padding can make neighbours touch; they become one.
    .reduce<SpeechSegment[]>((all, segment) => {
      const last = all.at(-1);
      if (last && segment.start <= last.end) last.end = Math.max(last.end, segment.end); else all.push({ ...segment });
      return all;
    }, []);
}

/** Where each run of a piece came from: `at` seconds into the piece is `from` seconds into the recording, for `length` seconds. */
export type TimeMap = Array<{ at: number; from: number; length: number }>;
export type SpeechPiece = { samples: Float32Array; map: TimeMap };

/** Half a second of silence between packed segments, so two sentences are not read as one word. */
const GAP_SECONDS = 0.5;

/**
 * The speech packed into pieces of at most `maxSeconds` each, split between segments where possible (a segment longer than a piece is
 * cut). Each piece is one call to the recogniser, and the pause the worker takes between pieces is what lets it slow down.
 */
export function speechPieces(samples: Float32Array, segments: SpeechSegment[], rate = 16_000, maxSeconds = 600): SpeechPiece[] {
  const max = Math.round(maxSeconds * rate), gap = Math.round(GAP_SECONDS * rate);
  const parts: SpeechSegment[] = [];
  for (const segment of segments) for (let start = segment.start; start < segment.end; start += max) parts.push({ start, end: Math.min(segment.end, start + max) });
  const pieces: Array<SpeechSegment[]> = [];
  let length = 0;
  for (const part of parts) {
    const size = part.end - part.start;
    if (!pieces.length || length + gap + size > max) { pieces.push([part]); length = size; }
    else { pieces.at(-1)!.push(part); length += gap + size; }
  }
  return pieces.map((group) => {
    const total = group.reduce((sum, part) => sum + part.end - part.start, 0) + gap * (group.length - 1);
    const out = new Float32Array(total);
    const map: TimeMap = [];
    let at = 0;
    for (const part of group) {
      out.set(samples.subarray(part.start, part.end), at);
      map.push({ at: at / rate, from: part.start / rate, length: (part.end - part.start) / rate });
      at += part.end - part.start + gap;
    }
    return { samples: out, map };
  });
}

/** A time in a piece, back in the original recording: inside a run it maps exactly; in a packed gap it belongs to the run before. */
export function originalTime(map: TimeMap, seconds: number): number {
  let run = map[0];
  for (const item of map) if (item.at <= seconds) run = item; else break;
  if (!run) return seconds;
  return run.from + Math.min(Math.max(0, seconds - run.at), run.length);
}
