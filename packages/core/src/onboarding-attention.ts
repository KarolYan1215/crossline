/**
 * Attention time in the interview (decided 2026-10-12, `docs/loop-and-scout.md` §7): only the time the person's attention is on the app
 * counts towards the setup targets (start standard ≤ 30 minutes, complete ≤ 90) — the page visible and some input in the last minute.
 * The model's thinking time while the person is away does not count. The page sends a beat every 15 seconds while visible; the server
 * adds the time since the previous beat, capped, and notes once when the start standard and the full checklist were first reached.
 */
export const ATTENTION_SETTING = "onboarding.attention";
/** No input for longer than this: the person is not attending, and the beat adds nothing. */
export const ATTENTION_IDLE_MS = 60_000;
/** The most one beat adds: a page that stopped beating (a closed lid, a lost connection) does not count the whole gap. */
export const ATTENTION_BEAT_CAP_MS = 20_000;

export type AttentionMark = { seconds: number; rounds: number; at: string };
export type AttentionRecord = { seconds: number; lastBeatAt: string; ready?: AttentionMark; complete?: AttentionMark };
export type AttentionBeat = { at: string; inputAgoMs: number; rounds: number; ready: boolean; complete: boolean };

export function addAttentionBeat(record: AttentionRecord | undefined, beat: AttentionBeat): AttentionRecord {
  const previous = record ? Date.parse(record.lastBeatAt) : Number.NaN;
  const gap = Date.parse(beat.at) - previous;
  const attending = beat.inputAgoMs <= ATTENTION_IDLE_MS;
  const added = attending && Number.isFinite(gap) && gap > 0 ? Math.min(gap, ATTENTION_BEAT_CAP_MS) / 1000 : 0;
  const seconds = Math.round(((record?.seconds ?? 0) + added) * 1000) / 1000;
  const mark = { seconds, rounds: beat.rounds, at: beat.at };
  return {
    seconds, lastBeatAt: gap > 0 || !record ? beat.at : record.lastBeatAt,
    ...(record?.ready ? { ready: record.ready } : beat.ready ? { ready: mark } : {}),
    ...(record?.complete ? { complete: record.complete } : beat.complete ? { complete: mark } : {})
  };
}

/** The setup targets the attention time is held to (docs/loop-and-scout.md §7): the start standard within 30 minutes, everything within 90. */
export const ATTENTION_TARGET_MINUTES = { ready: 30, complete: 90 } as const;

export type AttentionSummary = {
  /** Attention minutes in the interview so far. */
  minutes: number;
  /** When each target was first reached: attention minutes, rounds, and whether within its target; absent until reached. */
  ready?: { minutes: number; rounds: number; withinTarget: boolean };
  complete?: { minutes: number; rounds: number; withinTarget: boolean };
};

/** The interview's attention record as 系统体检 shows it (2026-10-20: it was written and never read); undefined before any beat. */
export function attentionSummary(record: AttentionRecord | undefined): AttentionSummary | undefined {
  if (!record) return undefined;
  const minutes = (seconds: number) => Math.round(seconds / 6) / 10;
  const mark = (item: AttentionMark | undefined, target: number) => item ? { minutes: minutes(item.seconds), rounds: item.rounds, withinTarget: item.seconds <= target * 60 } : undefined;
  const ready = mark(record.ready, ATTENTION_TARGET_MINUTES.ready), complete = mark(record.complete, ATTENTION_TARGET_MINUTES.complete);
  return { minutes: minutes(record.seconds), ...(ready ? { ready } : {}), ...(complete ? { complete } : {}) };
}
