// i18n-exempt: dictated text and file paths
import path from "node:path";
import { DICTATION_SAMPLE_RATE } from "@crossline/core";
import type { WindowRecogniser } from "./sensevoice";
import { withoutHallucinations } from "./transcribe";
import { speechPieces, speechSegments } from "./vad";

/**
 * What both voice-input engines share (docs/voice-input.md): the worker's own (dictation.ts) and the server transcriber's
 * (transcriber.ts), which keeps this file's imports small since it runs with one CPU and no network.
 */
const RATE = DICTATION_SAMPLE_RATE;

export const dictationDir = (dataDir: string) => path.join(dataDir, "dictation");
export const uploadDir = (dataDir: string, workspaceId: string) => path.join(dictationDir(dataDir), "upload", workspaceId);
export const inboxDir = (dataDir: string) => path.join(dictationDir(dataDir), "inbox");
export const outboxDir = (dataDir: string) => path.join(dictationDir(dataDir), "outbox");
export const aliveFile = (dataDir: string) => path.join(dictationDir(dataDir), "transcriber.alive");

/** 16-bit little-endian PCM to the float samples the recogniser reads. */
export function pcmToSamples(bytes: Buffer): Float32Array {
  const samples = new Float32Array(Math.floor(bytes.length / 2));
  for (let index = 0; index < samples.length; index += 1) samples[index] = bytes.readInt16LE(index * 2) / 32768;
  return samples;
}

/** Two pieces of text joined as speech: a space only between two Latin letters or digits. */
const joinHeard = (parts: string[]) => parts.map((part) => part.trim()).filter(Boolean)
  .reduce((text, part) => !text ? part : /[A-Za-z0-9]$/.test(text) && /^[A-Za-z0-9]/.test(part) ? `${text} ${part}` : `${text}${part}`, "");

/**
 * One dictation: the speech in it (silence at either end and long pauses left out), in windows of at most twenty seconds, each recognised
 * and joined. A clip with no speech is empty text, never a guess.
 */
export async function dictateSamples(samples: Float32Array, recognise: WindowRecogniser): Promise<{ text: string; language?: string; speechSeconds: number }> {
  const segments = speechSegments(samples, RATE);
  if (!segments.length) return { text: "", speechSeconds: 0 };
  const languages = new Map<string, number>();
  const chunks: Array<{ start: number; end: number; text: string }> = [];
  let speech = 0;
  for (const [index, piece] of speechPieces(samples, segments, RATE, 20).entries()) {
    const heard = await recognise(piece.samples);
    const seconds = piece.samples.length / RATE;
    speech += seconds;
    if (heard.lang) languages.set(heard.lang, (languages.get(heard.lang) ?? 0) + seconds);
    chunks.push({ start: index, end: index + 1, text: heard.text });
  }
  const language = [...languages].sort((a, b) => b[1] - a[1])[0]?.[0];
  return { text: joinHeard(withoutHallucinations(chunks).map((chunk) => chunk.text)), ...(language ? { language } : {}), speechSeconds: Math.round(speech) };
}

