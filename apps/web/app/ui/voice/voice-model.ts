/**
 * Voice input's pure parts (docs/voice-input.md): which engine a page can use, where dictated text goes in the box, how it is told apart
 * from what the person typed afterwards, and the audio conversion for Crossline's own engine. `voice-input.tsx` is the interface on top.
 */

export type VoiceServerState = "ready" | "model_missing" | "downloading" | "unavailable";
/** `browser`: the browser's own recogniser (Chrome → Google, Edge → Microsoft, Safari → Apple); `server`: Crossline's SenseVoice. */
export type VoiceEngine = "browser" | "server" | "model_needed" | "none";

export type EngineFacts = {
  hasSpeechRecognition: boolean;
  /** The home-screen app on an iPhone or iPad: WebKit gives it no speech recognition that works (WebKit bug 225298). */
  iosStandalone: boolean;
  online: boolean;
  /** The browser's recogniser failed in this tab before (a desktop shell answers `network`), so it is not offered again. */
  browserBroken: boolean;
  server: VoiceServerState;
  mode: "server" | "local";
};

/** The browser's recogniser first, Crossline's engine where it is missing or broken, the model's download where this machine needs it. */
export function chooseEngine(facts: EngineFacts): VoiceEngine {
  if (facts.hasSpeechRecognition && !facts.iosStandalone && facts.online && !facts.browserBroken) return "browser";
  if (facts.server === "ready") return "server";
  if (facts.mode === "local" && (facts.server === "model_missing" || facts.server === "downloading")) return "model_needed";
  return "none";
}

export function isIosStandalone(nav: { userAgent: string; standalone?: boolean; maxTouchPoints?: number }, standaloneDisplay: boolean): boolean {
  const ios = /iPad|iPhone|iPod/.test(nav.userAgent) || (/Macintosh/.test(nav.userAgent) && (nav.maxTouchPoints ?? 0) > 1);
  return ios && (nav.standalone === true || standaloneDisplay);
}

export const isSafari = (userAgent: string) => /^((?!chrome|chromium|crios|edg|android).)*safari/i.test(userAgent);

/**
 * A microphone frame counts as sound when its peak is this far from silence (of 128, about −20 dBFS), and a recording heard sound when
 * at least this many frames (about 170 ms at 60 frames a second) did. Room noise under automatic gain stays well below it.
 */
export const SOUND_PEAK = 12;
export const SOUND_FRAMES = 10;

/**
 * The browser's recogniser ended with nothing. The microphone's own level tells the two cases apart: nothing was said (`silent`), or the
 * recogniser heard nothing although the microphone did — Chrome 156 on the owner's machine only ever answered `no-speech`, real voice or
 * not (2026-11-02) — in which case it is not offered again in this tab and the recording goes to Crossline's engine where there is one.
 */
export function afterEmptyBrowser(heardSound: boolean, facts: EngineFacts): "silent" | Exclude<VoiceEngine, "browser"> {
  if (!heardSound) return "silent";
  return chooseEngine({ ...facts, browserBroken: true }) as Exclude<VoiceEngine, "browser">;
}

/** Errors after which the browser's recogniser is not worth trying again in this tab. */
export const BROWSER_BROKEN_ERRORS = new Set(["network", "service-not-allowed", "language-not-supported", "audio-capture-unsupported"]);

/** Dictated text placed where the caret was: a space only between two Latin letters or digits, nothing between Chinese characters. */
export function insertDictation(value: string, start: number, end: number, text: string, maxLength?: number): { value: string; at: number; inserted: string } {
  const before = value.slice(0, start), after = value.slice(end);
  const lead = before && /[A-Za-z0-9.,;:!?]$/.test(before) && /^[A-Za-z0-9]/.test(text) ? " " : "";
  const tail = after && /[A-Za-z0-9]$/.test(text) && /^[A-Za-z0-9]/.test(after) ? " " : "";
  let inserted = `${lead}${text}${tail}`;
  if (maxLength && maxLength > 0) inserted = [...inserted].slice(0, Math.max(0, maxLength - [...before].length - [...after].length)).join("");
  return { value: `${before}${inserted}${after}`, at: before.length + lead.length, inserted: inserted.slice(lead.length, inserted.length - (tail && inserted.endsWith(tail) ? tail.length : 0)) };
}

/** Where a dictated span sits: what is before and after it when it went in. */
export type DictatedSpan = { prefix: string; suffix: string; text: string };

/** The span's text now, while what is around it is untouched; `undefined` once the person changed something outside it (or sent it). */
export function spanNow(span: DictatedSpan, value: string): string | undefined {
  if (value.length < span.prefix.length + span.suffix.length) return undefined;
  if (!value.startsWith(span.prefix) || !value.endsWith(span.suffix)) return undefined;
  return value.slice(span.prefix.length, value.length - span.suffix.length);
}

/** `0:42` for the recording's timer. */
export const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

/** Float samples at any rate to 16 kHz mono 16-bit PCM by linear interpolation (the page resamples before sending). */
export function toPcm16(samples: Float32Array, rate: number, target = 16_000): Uint8Array {
  const length = Math.max(0, Math.floor(samples.length * target / rate));
  const out = new DataView(new ArrayBuffer(length * 2));
  const step = rate / target;
  for (let index = 0; index < length; index += 1) {
    const at = index * step, left = Math.floor(at), right = Math.min(samples.length - 1, left + 1), fraction = at - left;
    const value = (samples[left] ?? 0) * (1 - fraction) + (samples[right] ?? 0) * fraction;
    out.setInt16(index * 2, Math.max(-32768, Math.min(32767, Math.round(value * 32767))), true);
  }
  return new Uint8Array(out.buffer);
}

/** Several channels mixed down to one. */
export function mixDown(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0]!;
  const out = new Float32Array(channels[0]?.length ?? 0);
  for (const channel of channels) for (let index = 0; index < out.length; index += 1) out[index]! += (channel[index] ?? 0) / channels.length;
  return out;
}
