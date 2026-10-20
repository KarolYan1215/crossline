/**
 * 录音自动转写 (docs/phone-recording.md, decided 2026-10-20): the person records all day on their phone, the recorder's files reach an
 * authorized folder by iCloud Drive or Syncthing, and the worker transcribes them on this machine one at a time. The consent is
 * `RECORDING_CONSENT` in `source-folders.ts`; what is here is how hard the transcription may work and how its cost is reported.
 */

/** One per recording transcribed, keyed by the audio's sha256: what stops the same audio, renamed or copied, being transcribed twice. */
export const RECORDING_TRANSCRIBED_EVENT = "recording.transcribed";
/** A recording with no speech in it: also never transcribed again. */
export const RECORDING_SILENT_EVENT = "recording.silent";
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
