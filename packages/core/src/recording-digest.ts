/**
 * What a recording's transcript becomes (docs/phone-recording.md 「录音之后」, 2026-10-20): Skill `crossline-recording-digest` reads it and
 * decides whether it is worth keeping (a meeting, a lecture, a call, the person's own spoken note) or not (small talk, a video playing,
 * noise); for a kept one it writes a summary, and pulls out the commitments the person made, facts about the person and their work, and
 * the days named. The worker turns those into the ledger's own things: a commitment of the person's becomes a capture (analysed like
 * anything typed into the box), a fact an inferred profile fact citing the recording, the summary a document the interview and planning
 * read instead of the raw transcript.
 *
 * There is no speaker separation: the model judges who spoke from the words (「我来…」「你下周给我…」), and anything it cannot place is
 * `unclear` and only listed in the summary — a capture is made only from what the person said they would do. Every item quotes the
 * transcript; a quote that is not in it drops the item.
 */
export const RECORDING_DIGESTED_EVENT = "recording.digested";
/** A transcript with less speech than this (timestamps and the header left out) is noise by rule, never sent to a model. */
export const DIGEST_MIN_CHARS = 60;
/** Text of one transcript a run reads at most; a longer one is cut in the middle, keeping its opening and close. */
export const DIGEST_TEXT_LIMIT = 40_000;
/** Commitments turned into captures from one recording at most: a meeting with twenty action items is summarised, not turned into twenty tasks. */
export const DIGEST_CAPTURES_PER_RECORDING = 5;
/** What others promised the person, turned into waiting items from one recording at most; one with no day named is expected in `DIGEST_WAIT_DEFAULT_DAYS`. */
export const DIGEST_WAITS_PER_RECORDING = 3;
export const DIGEST_WAIT_DEFAULT_DAYS = 7;

export const RECORDING_KINDS = ["meeting", "lecture", "call", "conversation", "self_note", "small_talk", "media", "noise"] as const;
export type RecordingKind = typeof RECORDING_KINDS[number];
/** Kinds whose content is not kept: their summary is not written and nothing is taken from them. */
export const DISCARDED_KINDS: readonly RecordingKind[] = ["small_talk", "media", "noise"];
export const RECORDING_KIND_LABEL: Record<RecordingKind, string> = {
  meeting: "会议", lecture: "课堂或讲座", call: "通话", conversation: "交谈", self_note: "本人口述笔记", small_talk: "闲聊", media: "视频或音乐", noise: "噪声"
};

/** `who`: the other party as the recording names them (「王老师」), empty when it does not; only read for `by: "other"`. */
export type DigestCommitment = { text: string; by: "person" | "other" | "unclear"; who: string; due: string; quote: string };
export type DigestFact = { identityId: string; projectId: string; slot: string; value: string; quote: string };
export type DigestDate = { title: string; date: string; time: string; quote: string };
export type RecordingDigestItem = {
  id: string; kind: RecordingKind; title: string; summary: string; lineIds: string[]; projectId: string;
  commitments: DigestCommitment[]; facts: DigestFact[]; dates: DigestDate[];
};
export type RecordingDigestAnswer = { recordings: RecordingDigestItem[] };

const text = (max: number) => ({ type: "string", maxLength: max }) as const;
export const RECORDING_DIGEST_SCHEMA = { type: "object", additionalProperties: false, required: ["recordings"], properties: {
  recordings: { type: "array", maxItems: 8, items: { type: "object", additionalProperties: false,
    required: ["id", "kind", "title", "summary", "lineIds", "projectId", "commitments", "facts", "dates"], properties: {
      id: { type: "string", minLength: 1, maxLength: 80 },
      kind: { type: "string", enum: [...RECORDING_KINDS] },
      title: text(40), summary: text(1200),
      lineIds: { type: "array", maxItems: 4, items: text(80) }, projectId: text(80),
      commitments: { type: "array", maxItems: 12, items: { type: "object", additionalProperties: false, required: ["text", "by", "who", "due", "quote"], properties: {
        text: { type: "string", minLength: 1, maxLength: 120 }, by: { type: "string", enum: ["person", "other", "unclear"] }, who: text(40), due: text(10),
        quote: { type: "string", minLength: 1, maxLength: 300 } } } },
      facts: { type: "array", maxItems: 12, items: { type: "object", additionalProperties: false, required: ["identityId", "projectId", "slot", "value", "quote"], properties: {
        identityId: { type: "string", minLength: 1, maxLength: 80 }, projectId: text(80), slot: { type: "string", minLength: 1, maxLength: 60 },
        value: { type: "string", minLength: 1, maxLength: 200 }, quote: { type: "string", minLength: 1, maxLength: 300 } } } },
      dates: { type: "array", maxItems: 12, items: { type: "object", additionalProperties: false, required: ["title", "date", "time", "quote"], properties: {
        title: { type: "string", minLength: 1, maxLength: 80 }, date: text(10), time: text(5), quote: { type: "string", minLength: 1, maxLength: 300 } } } }
    } } } } } as const;

/** A transcript's spoken text only: the header, the language line and the line times left out. */
export function spokenText(transcript: string): string {
  return transcript.split(/\r?\n/).filter((line) => !/^\[(录音|语言)：/.test(line)).map((line) => line.replace(/^\[\d{1,2}(:\d{2}){1,2}\]\s*/, "")).join("\n").trim();
}
/** What a run is shown: the spoken text, cut in the middle when long, so the opening (who and what) and the close (what was agreed) stay. */
export function digestText(transcript: string, limit = DIGEST_TEXT_LIMIT): string {
  if (transcript.length <= limit) return transcript;
  const half = Math.floor((limit - 20) / 2);
  return `${transcript.slice(0, half)}\n[……中间省略……]\n${transcript.slice(-half)}`;
}

/** Letters and digits only, so a quote copied with other punctuation or spacing still matches. */
const squash = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const SLOT = /^[a-z][a-z0-9_]{1,59}$/;

/**
 * Keeps an answer for each recording asked about; drops what cannot be checked. A recording missing from the answer, or an unknown id,
 * is refused (the run is repaired); an item whose quote is not in that transcript, an unknown line or project, a malformed day or slot
 * is dropped silently — one bad line must not cost the rest.
 */
export function validateRecordingDigest(value: unknown, input: { transcripts: Map<string, string>; lineIds: string[]; projectIds: string[] }): RecordingDigestAnswer {
  const answer = value as RecordingDigestAnswer | undefined;
  if (!answer || !Array.isArray(answer.recordings)) throw new Error("RECORDING_DIGEST_INVALID");
  const lines = new Set(input.lineIds), projects = new Set(input.projectIds);
  const seen = new Set<string>();
  const out: RecordingDigestItem[] = [];
  for (const item of answer.recordings) {
    const transcript = item && input.transcripts.get(item.id);
    if (!item || transcript === undefined || seen.has(item.id)) continue;
    seen.add(item.id);
    const body = squash(spokenText(transcript));
    const quoted = (quote: string) => { const q = squash(String(quote ?? "")); return q.length >= 2 && body.includes(q); };
    const discarded = DISCARDED_KINDS.includes(item.kind);
    out.push({ id: item.id, kind: RECORDING_KINDS.includes(item.kind) ? item.kind : "noise",
      title: String(item.title ?? "").trim().slice(0, 40), summary: discarded ? "" : String(item.summary ?? "").trim().slice(0, 1200),
      lineIds: [...new Set((item.lineIds ?? []).filter((id) => lines.has(id)))], projectId: projects.has(item.projectId) ? item.projectId : "",
      commitments: discarded ? [] : (item.commitments ?? []).filter((c) => c && quoted(c.quote) && ["person", "other", "unclear"].includes(c.by))
        .map((c) => ({ text: c.text.trim().slice(0, 120), by: c.by, who: String(c.who ?? "").trim().slice(0, 40), due: DAY.test(c.due) ? c.due : "", quote: c.quote })),
      facts: discarded ? [] : (item.facts ?? []).filter((f) => f && quoted(f.quote) && SLOT.test(f.slot) && (f.identityId === "person" || lines.has(f.identityId)))
        .map((f) => ({ identityId: f.identityId, projectId: projects.has(f.projectId) ? f.projectId : "", slot: f.slot, value: f.value.trim().slice(0, 200), quote: f.quote })),
      dates: discarded ? [] : (item.dates ?? []).filter((d) => d && quoted(d.quote) && DAY.test(d.date))
        .map((d) => ({ title: d.title.trim().slice(0, 80), date: d.date, time: TIME.test(d.time) ? d.time : "", quote: d.quote })) });
  }
  const missing = [...input.transcripts.keys()].filter((id) => !seen.has(id));
  if (missing.length) throw new Error(`RECORDING_DIGEST_MISSING: 少了这些录音的整理：${missing.join("、")}`);
  return { recordings: out };
}

/** The digest as a document: what the interview and the planners read instead of the whole transcript. */
export function digestDocument(item: RecordingDigestItem, source: { fileName: string; startedAt: string; minutes: number }): string {
  const lines = [`# ${item.title || source.fileName}`, "", `录音：${source.fileName}，约 ${source.startedAt} 开始，${source.minutes} 分钟；类型：${RECORDING_KIND_LABEL[item.kind]}`, "", item.summary];
  const mine = item.commitments.filter((c) => c.by === "person"), others = item.commitments.filter((c) => c.by !== "person");
  if (mine.length) lines.push("", "## 本人答应做的", ...mine.map((c) => `- ${c.text}${c.due ? `（${c.due} 前）` : ""}：「${c.quote}」`));
  if (others.length) lines.push("", "## 别人答应的或说不清是谁", ...others.map((c) => `- ${c.who ? `${c.who}：` : ""}${c.text}${c.due ? `（${c.due}）` : ""}${c.by === "unclear" ? "（说话人不确定）" : ""}：「${c.quote}」`));
  if (item.dates.length) lines.push("", "## 提到的日期", ...item.dates.map((d) => `- ${d.date}${d.time ? ` ${d.time}` : ""} ${d.title}：「${d.quote}」`));
  if (item.facts.length) lines.push("", "## 关于本人与工作的信息", ...item.facts.map((f) => `- ${f.value}：「${f.quote}」`));
  return lines.join("\n");
}
