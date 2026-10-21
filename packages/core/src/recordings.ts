/**
 * 录音自动转写 (docs/phone-recording.md, decided 2026-10-20): the person records all day on their phone, the recorder's files reach an
 * authorized folder by iCloud Drive or Syncthing, and the worker transcribes them on this machine one at a time. The consent is
 * `RECORDING_CONSENT` in `source-folders.ts`; what is here is how hard the transcription may work and how its cost is reported.
 */

/** One per recording transcribed, keyed by the audio's sha256: what stops the same audio, renamed or copied, being transcribed twice. */
export const RECORDING_TRANSCRIBED_EVENT = "recording.transcribed";
/** A recording with no speech in it: also never transcribed again. */
export const RECORDING_SILENT_EVENT = "recording.silent";
/** An uploaded recording the server transcriber could not read (its audio is deleted). */
export const RECORDING_FAILED_EVENT = "recording.failed";
/** The person turned 录音自动转写 off and chose to delete the transcripts. */
export const RECORDING_PURGED_EVENT = "recording.transcripts_deleted";
/** Set once when recordings wait for the speech model, so the person is told once and not on every pass. */
export const RECORDING_MODEL_NOTICE = "recordings.modelNoticeAt";

/** A file changed less than this long ago may still be being written or synced; it waits for the next pass. */
export const RECORDING_SETTLE_MS = 2 * 60_000;

/**
 * `full` at night (23:00–07:00 in the person's zone) or while the computer has been idle five minutes; `slow` while the person is using
 * it in the day, when the worker rests twice as long as each piece took — about a third of the CPU it would otherwise take. Unknown idle
 * (no screen reading yet) counts as in use.
 */
export type RecordingPace = "full" | "slow";
export const PACE_IDLE_MS = 5 * 60_000;
export const PACE_REST_FACTOR = 2;
export function recordingPace(input: { idleMs?: number | undefined; at: Date; timeZone: string }): RecordingPace {
  let hour = input.at.getUTCHours();
  try { hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: input.timeZone, hour: "2-digit", hourCycle: "h23" }).format(input.at)) % 24; } catch { /* UTC */ }
  if (hour >= 23 || hour < 7) return "full";
  return input.idleMs !== undefined && input.idleMs >= PACE_IDLE_MS ? "full" : "slow";
}

/** What a transcribed recording's event carries: the file's name, length and hash, never its content. */
export type RecordingTranscribed = { fileName: string; seconds: number; speechSeconds: number; workMs: number; wallMs: number; documentId: string };

/** Minutes of transcription work per hour of recording, over recent recordings; undefined before there is one. */
export function transcriptionCost(recent: Array<Pick<RecordingTranscribed, "seconds" | "workMs">>): { recordings: number; audioHours: number; minutesPerHour: number } | undefined {
  const usable = recent.filter((item) => item.seconds > 0 && item.workMs >= 0);
  const seconds = usable.reduce((sum, item) => sum + item.seconds, 0);
  if (!usable.length || !seconds) return undefined;
  const work = usable.reduce((sum, item) => sum + item.workMs, 0);
  return { recordings: usable.length, audioHours: Math.round((seconds / 3600) * 10) / 10, minutesPerHour: Math.round((work / 60_000) / (seconds / 3600) * 10) / 10 };
}

/**
 * 录音在服务器转写 (docs/phone-recording.md 「服务器转写」, decided 2026-10-20): the phone's shortcut uploads each recording to
 * `POST /api/recordings/upload`, where it waits in the data directory's `recordings/inbox/<workspace>/` until the transcriber container
 * (SenseVoiceSmall through sherpa-onnx, one CPU) takes it in the person's night. Its own consent, off by default, because the audio leaves
 * the person's own devices; the audio is deleted once transcribed and never backed up.
 */
export const RECORDING_SERVER_CONSENT = "recordings.serverTranscribe";
/** Where uploads wait, under the data directory: `<dataDir>/recordings/inbox/<workspaceId>/`. */
export const RECORDING_INBOX_SEGMENTS = ["recordings", "inbox"] as const;

/**
 * 识别本人声音 (decided 2026-10-21): the transcriber separates speakers in every recording, and with this consent it also compares them
 * with the person's own voiceprint, so lines the person spoke read 「本人：」. Its own consent, off by default: a voiceprint is biometric.
 * The voiceprint is one embedding vector (no audio) in `<dataDir>/recordings/voiceprint/<workspace>.json`, made from a recording of the
 * person alone that they upload; it is outside the backups like everything under `recordings/`, and turning the consent off deletes it.
 * Other people's voices are only told apart within one recording and never kept.
 */
export const RECORDING_VOICEPRINT_CONSENT = "recordings.voiceprint";
export const RECORDING_VOICEPRINT_SEGMENTS = ["recordings", "voiceprint"] as const;
/** The speaker label for the person's own lines; others are 「说话人 1」, 「说话人 2」 … in order of first speaking. */
export const SPEAKER_SELF = "本人";
/** An enrolment recording must hold at least this much speech, and at most this much is used. */
export const VOICEPRINT_MIN_SPEECH_SECONDS = 15;
export const VOICEPRINT_MAX_SPEECH_SECONDS = 120;
/** One upload at most, and one workspace's uploads per day (about 25 hours of 64 kbps audio). */
export const RECORDING_UPLOAD_LIMIT = 300 * 1024 * 1024;
export const RECORDING_UPLOAD_DAILY_LIMIT = 3 * 1024 * 1024 * 1024;
/** The hours the transcriber works for a workspace, in its own zone; `CROSSLINE_TRANSCRIBE_WINDOW` overrides it as `HH:MM-HH:MM`. */
export const TRANSCRIBE_WINDOW = "01:00-06:00";

const windowBounds = (window: string) => {
  const parsed = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(window) ?? /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(TRANSCRIBE_WINDOW)!;
  return { from: Number(parsed[1]) * 60 + Number(parsed[2]), to: Number(parsed[3]) * 60 + Number(parsed[4]), start: `${parsed[1]}:${parsed[2]}` };
};
const minuteOfDay = (at: Date, timeZone: string) => {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at).map((part) => [part.type, part.value]));
    return (Number(parts.hour) % 24) * 60 + Number(parts.minute);
  } catch { return at.getUTCHours() * 60 + at.getUTCMinutes(); }
};

/** Whether `at` falls inside `window` (`HH:MM-HH:MM`, which may cross midnight) in `timeZone`. A malformed window falls back to the default. */
export function inTranscribeWindow(at: Date, timeZone: string, window = TRANSCRIBE_WINDOW): boolean {
  const { from, to } = windowBounds(window);
  const minute = minuteOfDay(at, timeZone);
  return from <= to ? minute >= from && minute < to : minute >= from || minute < to;
}

/** The container a recording's opening bytes name, as the extension it is stored under; undefined when they name no audio format. */
export function audioKind(head: Uint8Array): string | undefined {
  const ascii = (from: number, to: number) => String.fromCharCode(...head.subarray(from, to));
  if (ascii(4, 8) === "ftyp") return "m4a";
  if (ascii(0, 4) === "caff") return "m4a";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "wav";
  if (ascii(0, 4) === "OggS") return "ogg";
  if (ascii(0, 4) === "fLaC") return "flac";
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return "webm";
  if (ascii(0, 3) === "ID3") return "mp3";
  if (head[0] === 0xff && head[1] !== undefined && (head[1] & 0xf6) === 0xf0) return "aac";
  if (head[0] === 0xff && head[1] !== undefined && (head[1] & 0xe0) === 0xe0) return "mp3";
  return undefined;
}

/** When the transcriber next takes uploads: 0 inside the window, else the minutes until it opens, with the clock time it opens at. */
export function transcribeWindowOpens(at: Date, timeZone: string, window = TRANSCRIBE_WINDOW): { inMinutes: number; at: string } {
  const { from, start } = windowBounds(window);
  if (inTranscribeWindow(at, timeZone, window)) return { inMinutes: 0, at: start };
  return { inMinutes: (from - minuteOfDay(at, timeZone) + 24 * 60) % (24 * 60), at: start };
}
