import { clockOf, type DateExtraction } from "./date-schema";
import { keepOnboardingTurn, validateOnboardingTurn, type EvidenceSentence, type KnownSources, type OnboardingTurn } from "./onboarding-turn-schema";
import { numbersSupported } from "./sentences";

/**
 * Turns an interview answer as the model writes it (sentence numbers in `refs`, times in minutes) into the turn the rest of the app reads
 * (`sourceRef`, `sourceQuote`, `HH:MM`), filling every quote from the ledger (2026-10-19). A quote is the cited sentences of the first
 * source cited, from the first to the last, so it is always a span of that text and the old verbatim check can never fail on it.
 *
 * `strict` is the validator's mode: a number the model was not shown, or a confirmed fact citing nothing, is refused with a message in
 * numbers the model can act on. Otherwise (keeping what is valid after the repairs) the item is left with no source and the keep step
 * drops it. Dates are never refused here: `sanitizeDateExtraction` drops one that cannot be verified and keeps the rest.
 */
type Index = Map<number, EvidenceSentence>;
type Span = { sourceRef: string; quote: string; ids: number[]; refs: string[]; unknown: number[] };

/** The longest quote a citation fills in; a span past it keeps only its first sentence. */
const QUOTE_MAX = 600;

export function citedSpan(raw: unknown, index: Index, texts: Record<string, string>): Span {
  const ids = [...new Set(Array.isArray(raw) ? raw.filter((id): id is number => Number.isInteger(id)) : [])];
  const unknown = ids.filter((id) => !index.has(id));
  const known = ids.filter((id) => index.has(id)).map((id) => ({ id, ...index.get(id)! }));
  const refs = [...new Set(known.map((entry) => entry.ref))];
  const first = known[0];
  if (!first) return { sourceRef: "", quote: "", ids: [], refs: [], unknown };
  const same = known.filter((entry) => entry.ref === first.ref);
  const start = Math.min(...same.map((entry) => entry.start)), end = Math.max(...same.map((entry) => entry.end));
  const whole = (texts[first.ref] ?? "").slice(start, end);
  return { sourceRef: first.ref, quote: whole && whole.length <= QUOTE_MAX ? whole : first.text, ids: known.map((entry) => entry.id), refs, unknown };
}

function reject(code: string, detail: string): never {
  const error = new Error(code);
  (error as Error & { detail?: string }).detail = detail.slice(0, 400);
  throw error;
}

const numbers = (ids: number[]) => ids.map((id) => `[${id}]`).join("");
type Wire = Record<string, unknown>;
const list = (value: unknown): Wire[] => Array.isArray(value) ? value.filter((item): item is Wire => Boolean(item) && typeof item === "object") : [];

export function resolveOnboardingRefs(value: unknown, known: { replies: Record<string, string>; sources: Record<string, string>; sentences?: Index },
  options: { strict: boolean }): unknown {
  if (!value || typeof value !== "object") return value;
  const turn = value as Wire;
  const index = known.sentences ?? new Map<number, EvidenceSentence>();
  const texts = { ...known.sources, ...known.replies };
  const span = (raw: unknown, label: string, required: boolean): Span => {
    const cited = citedSpan(raw, index, texts);
    if (options.strict && cited.unknown.length) reject("ONBOARDING_REF_UNKNOWN",
      `${label}引用了不存在的句子 ${numbers(cited.unknown)}：只能写本轮和之前给出的方括号编号。`);
    if (options.strict && required && !cited.ids.length) reject("ONBOARDING_REF_REQUIRED",
      `${label}需要在 refs 里写出依据的句子编号（如 [12]）；是你自己的推断就标 inferred、refs 留空。`);
    return cited;
  };

  const slotUpdates = list(turn.slotUpdates).map((update) => {
    const cited = span(update.refs, `事实「${String(update.slot ?? "")}」`, update.status === "confirmed");
    const { refs: _refs, ...rest } = update;
    return { ...rest, sourceRef: cited.ids.length ? cited.sourceRef : "inference", sourceQuote: cited.quote, sentences: cited.ids };
  });
  const flywheelCandidates = list(turn.flywheelCandidates).map((candidate) => {
    const cited = span(candidate.refs, "飞轮候选", false);
    const { refs: _refs, ...rest } = candidate;
    return { ...rest, evidenceRefs: cited.refs.length ? cited.refs : ["inference"], sentences: cited.ids };
  });
  const lineProfiles = list(turn.lineProfiles).map((line) => ({ ...line, attributeCandidates: list(line.attributeCandidates).map((item) => {
    const cited = span(item.refs, `定语「${String(item.text ?? "")}」`, true);
    const { refs: _refs, ...rest } = item;
    return { ...rest, sourceRef: cited.sourceRef };
  }) }));
  const goalEdits = list(turn.goalEdits).map((edit) => {
    const cited = span(edit.refs, "长期目标修改", true);
    // Only what the person asked for in so many words: the edit must rest on one of their replies.
    const reply = cited.refs.find((ref) => ref in known.replies) ?? "";
    if (options.strict && !reply) reject("ONBOARDING_GOAL_EDIT_UNASKED", "长期目标修改必须引用本人提出修改的那句回复的编号，不能只引用文件。");
    const { refs: _refs, ...rest } = edit;
    return { ...rest, sourceRef: reply };
  });
  const availability = turn.availability && typeof turn.availability === "object" ? (() => {
    const proposal = turn.availability as Wire;
    return { ...proposal, windows: list(proposal.windows).map(({ startMinute, endMinute, ...window }) =>
      ({ ...window, start: clockOf(startMinute), end: clockOf(endMinute) })) };
  })() : turn.availability;
  return { ...turn, slotUpdates, flywheelCandidates, lineProfiles, goalEdits, availability,
    ...(turn.fileDates && typeof turn.fileDates === "object" ? { fileDates: resolveDateRefs(turn.fileDates, index, texts) } : {}) };
}

/** A date answer with sentence numbers and minutes, as the `DateExtraction` the checks and the ledger read. */
export function resolveDateRefs(value: unknown, index: Index, texts: Record<string, string>): DateExtraction {
  const out = value as Wire;
  const cite = (item: Wire) => { const cited = citedSpan(item.refs, index, texts); return { sourceRef: cited.sourceRef, quote: cited.quote }; };
  return {
    dates: list(out.dates).map(({ refs: _refs, startMinute, endMinute, ...item }) =>
      ({ ...item, startTime: clockOf(startMinute), endTime: clockOf(endMinute), ...cite({ refs: _refs }) })) as unknown as DateExtraction["dates"],
    recurring: list(out.recurring).map(({ refs: _refs, startMinute, endMinute, ...item }) =>
      ({ ...item, startTime: clockOf(startMinute), endTime: clockOf(endMinute), ...cite({ refs: _refs }) })) as unknown as DateExtraction["recurring"],
    questions: Array.isArray(out.questions) ? out.questions.filter((question): question is string => typeof question === "string") : [],
    undated: list(out.undated).map(({ refs: _refs, ...item }) => ({ ...item, ...cite({ refs: _refs }) })) as unknown as NonNullable<DateExtraction["undated"]>
  };
}

/**
 * Confirmed facts whose numbers do not appear in the sentences they cite: a warning for the record, never a refusal, because people
 * write 「九点半」 or 「一个半小时」 and a check of spellings would refuse their own words.
 */
export function citationWarnings(turn: Pick<OnboardingTurn, "slotUpdates">): Array<{ slot: string; value: string; sentences: number[] }> {
  return turn.slotUpdates.filter((update) => update.status === "confirmed" && update.sourceQuote && !numbersSupported(update.value, update.sourceQuote))
    .map((update) => ({ slot: update.slot, value: update.value, sentences: update.sentences ?? [] }));
}

/** The numbered form of a text the model reads: one sentence per line, each after its number. */
export function numberedText(sentences: Array<{ id: number; text: string }>): string {
  return sentences.map((sentence) => `[${sentence.id}] ${sentence.text}`).join("\n");
}

/** The validator the interview runs on the model's answer: numbers resolved strictly, then every rule the turn has always been held to. */
export function validateOnboardingAnswer(value: unknown, known: KnownSources): OnboardingTurn {
  return validateOnboardingTurn(resolveOnboardingRefs(value, known, { strict: true }), known);
}

/** What is valid in an answer once the repairs are spent: an item citing a number it was not shown goes, the rest stays. */
export function keepOnboardingAnswer(value: unknown, known: KnownSources): OnboardingTurn | undefined {
  return keepOnboardingTurn(resolveOnboardingRefs(value, known, { strict: false }), known);
}
