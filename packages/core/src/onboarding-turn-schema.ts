import { RELATION_KINDS } from "./flywheel-schema";
import { DATE_EXTRACTION_SCHEMA, type DateExtraction } from "./date-schema";
import { SCHWARTZ_VALUES } from "./portrait";
import {
  ATTRIBUTE_CANDIDATES_MAX, ATTRIBUTE_CANDIDATES_MIN, ATTRIBUTE_KIND_FIELD, ATTRIBUTE_KINDS, ATTRIBUTE_MAX_LENGTH, cleanAttribute, duplicateAttributes, guessKind,
  notAtomic, type AttributeCandidate, type AttributeKind
} from "./line-attributes";

/**
 * One turn of the profile interview.
 *
 * The interview used to be three fill-in boxes plus a chat that proposed milestones straight away. What
 * the person asked for is the opposite order: *learn the person first* — what they are doing, for whom,
 * by when, what is stuck, which files they already have — through a conversation that offers a lot of
 * options to pick from (it is far easier to recognise your own situation in a list than to recall it
 * cold), and only then design milestones from what was learned.
 *
 * So a turn does not return milestones. It returns:
 *   - `questions`: several at once, each with generously many candidate answers;
 *   - `slotUpdates`: facts it learned, each tied, unless it is an explicit inference, to the numbered
 *     sentences of the reply or file it came from (`refs`; the system fills the quote in) — the same
 *     grounding rule the rest of this app already uses, because a profile built on invented facts is
 *     worse than an empty one;
 *   - `projectsDetected`: the separate things the person works on inside a line;
 *   - `flywheelCandidates`: connections between lines, always `inferred` here — only the person can
 *     confirm one.
 */
export type TurnQuestion = {
  id: string; text: string; kind: "single" | "multi" | "free";
  options: Array<{ id: string; label: string; detail: string }>;
  allowOther: boolean; identityId: string; projectId: string;
  /**
   * The question ledger's number of the question this one asks again (`questionLedger`, 「#12」), 0 for a new one (2026-10-19). An answered
   * question asked again is dropped from the round; one of the app's own waiting questions asked in the model's words is not added again.
   */
  repeats?: number;
};
/**
 * A fact as the rest of the app reads it. The model does not write `sourceRef` or `sourceQuote` any more (2026-10-19): it cites numbered
 * sentences (`refs` in `ONBOARDING_TURN_SCHEMA`) and `resolveOnboardingRefs` fills both in from the ledger, with the ids in `sentences`.
 */
export type SlotUpdate = {
  identityId: string; projectId: string; slot: string; value: string;
  status: "confirmed" | "inferred"; sourceRef: string; sourceQuote: string; sentences?: number[];
};
export type DetectedProject = { id: string; identityId: string; name: string; summary: string };
export type FlywheelCandidate = {
  fromIdentityId: string; toIdentityId: string; kind: (typeof RELATION_KINDS)[number];
  explanation: string; evidenceRefs: string[]; status: "inferred"; sentences?: number[];
};
export type TurnCoverage = { identityId: string; filled: string[]; missing: string[] };

/**
 * Where the interview is (decided 2026-10-08, reordered 2026-10-12): the person sets their lines first on a structured screen (identity
 * nouns, order, hard constraints); the interview then goes, a batch of independent questions at a time, in two parts. The front part —
 * `orientation` (read every file first, then the hard lines' rules and the weekly hours) and `lines` (a personal description and 6–12
 * attribute candidates for the long-term goal of each, and each line's current project with its deadline) — gathers the start standard
 * (`readyToStart`); the back part — where they stand, their compass, their energy, and each line's specifics — writes the portrait, in the
 * same interview. A line's own interview (`focusLine`) runs only `details` for that line. The portrait report is written afterwards by its own Skill.
 */
export const ONBOARDING_STAGES = ["orientation", "lines", "situation", "compass", "energy", "details"] as const;
export type OnboardingStage = (typeof ONBOARDING_STAGES)[number];
/**
 * The stages asked one deep question at a time (docs/onboarding-v3.md, decided 2026-10-14): what weighs most, why they work, what life is
 * for, what absorbs and drains them. The others gather facts in a batch of option cards.
 */
export const DEEP_STAGES: ReadonlySet<OnboardingStage> = new Set<OnboardingStage>(["situation", "compass", "energy"]);
/** How the interview talks, chosen by the person at the start (default neutral); a setting, so it can change mid-interview. */
// Two voices since 2026-10-18 (the owner's decision): 「直接犀利」 asked for exactly the 点破/反转 writing that reads as machine-made, so it
// is gone, and an account that chose it reads as neutral (`readTone`).
export const ONBOARDING_TONES = ["neutral", "warm"] as const;
export type OnboardingTone = (typeof ONBOARDING_TONES)[number];
export const ONBOARDING_TONE_SETTING = "onboarding.tone";
export const ONBOARDING_TONE_LABEL: Record<OnboardingTone, { label: string; detail: string }> = {
  neutral: { label: "冷静客观", detail: "就事论事，讲清依据，不带情绪" },
  warm: { label: "温柔体贴", detail: "先回应感受，再问事情，语气柔和" }
};
export function readTone(value: string | null | undefined): OnboardingTone {
  return (ONBOARDING_TONES as readonly string[]).includes(value ?? "") ? value as OnboardingTone : "neutral";
}
/** The facts that are about the person rather than one line (their compass, their energy) are filed under this id. */
export const PERSON_LINE = "person";

/**
 * The working portrait, rewritten in full every turn from everything said so far — the interviewer's synthesis, shown as such; facts with
 * quotes stay in `slotUpdates`. It is what the portrait report is built from.
 */
export type ProfileModel = {
  /** One sentence that sums the person up now, and the contradiction that matters most. */
  portrait: string; coreConflict: string;
  problem: string; gravity: string[]; designable: string[];
  /** A false premise they are stuck on, and the problem reframed. */
  reframes: Array<{ fallacy: string; reframe: string }>;
  workView: string; lifeView: string; consistency: string; trueNorth: string;
  /** Activities placed by skill and liking, and whether they charge or drain. */
  energyMap: Array<{ activity: string; skill: "high" | "low"; love: "high" | "low"; charge: "charge" | "drain" }>;
  flow: string[];
  /** What they say they want, and what their behaviour shows they protect. */
  says: string; does: string;
  /** An idea held long after it stopped working, and what they really want behind it. */
  anchor: string; realWant: string;
  allocation: string;
  /** Schwartz's ten values scored 0–100 from what was said (any subset so far), drawn as a radar while the compass stage runs. */
  values: Array<{ value: string; score: number }>;
};
export const EMPTY_PROFILE_MODEL: ProfileModel = { portrait: "", coreConflict: "", problem: "", gravity: [], designable: [], reframes: [], workView: "",
  lifeView: "", consistency: "", trueNorth: "", energyMap: [], flow: [], says: "", does: "", anchor: "", realWant: "", allocation: "", values: [] };
/**
 * For each line: a personal description from what was said, and 6–12 mutually independent attributes (`attributeCandidates`) the person
 * builds a long-term goal 「成为 A 的、B 的<身份>」 from — each cited to the reply or file it came from and labelled with its kind
 * (decided 2026-10-10; it replaced whole-sentence `goalCandidates`, which the model filled by permuting the same few attributes). An empty
 * list keeps the candidates already on record. `goalCandidates` is only ever on turns stored before.
 */
export type LineProfile = { lineId: string; description: string; attributeCandidates: AttributeCandidate[]; goalCandidates?: string[] };
/**
 * A change to a line's long-term goal the person asked for in so many words (「把目标改成…」), cited to that reply. Never applied by the
 * interview: it waits as a card the person adopts or dismisses.
 */
export type GoalEdit = { lineId: string; parts: Array<{ text: string; kind: AttributeKind }>; sourceRef: string };
/** A weekly pattern of available hours proposed from a hard-constraint line's rules; the person confirms it on the plan page. */
export type AvailabilityProposal = { windows: Array<{ days: number[]; start: string; end: string; energy: "low" | "medium" | "high" }>; why: string };

export type OnboardingTurn = {
  reply: string;
  questions: TurnQuestion[];
  slotUpdates: SlotUpdate[];
  projectsDetected: DetectedProject[];
  flywheelCandidates: FlywheelCandidate[];
  coverage: TurnCoverage[];
  /**
   * Every date a file that arrived in this turn states: class meetings, quizzes, homework, exams, deadlines. Read by the
   * same model that reads the file, in the same turn, and checked in code afterwards (`sanitizeDateExtraction`):
   * each date needs a verbatim quote that really contains the day, and the ones that do not are dropped.
   */
  fileDates?: DateExtraction;
  nextAction: "ask" | "ready_for_milestones";
  stage?: OnboardingStage;
  lineProfiles?: LineProfile[];
  goalEdits?: GoalEdit[];
  /** Filled once a hard-constraint line's rules are known (empty `windows` otherwise). */
  availability?: AvailabilityProposal;
  profile?: ProfileModel;
};

/**
 * What the dialogue is shown at the start of the interview (later turns only carry the new reply). The dialogue cites nothing, so it reads
 * the person's words and the files as they are; numbered sentences go only to the extraction (`OnboardingExtractContext`).
 */
export type OnboardingTurnContext = {
  version: "crossline.onboarding.turn.v1";
  /** `YYYY-MM-DD` in the person's zone, so a date written without a year lands in the right one. */
  today?: string; timeZone?: string;
  identities: Array<{ id: string; label: string }>;
  projects: Array<{ id: string; identityId: string; name: string; summary: string }>;
  facts: Array<{ identityId: string; projectId: string; slot: string; value: string; status: string }>;
  /** Each file's text, cut to the turn's reading budget. */
  sources: Array<{ id: string; fileName: string; kind: string; projectId: string; text: string }>;
  /** A line's own interview: only this line is asked about. Absent for the full interview. */
  focusLine?: { id: string; label: string; goal: string } | null;
  /** The person's lines as set on the opening screen: identity noun, order (null = parallel), hard constraint, chosen goals. */
  lines?: Array<{ id: string; label: string; rank: number | null; hard: boolean; goals: string[]; goalParts?: string[] }>;
  /** The portrait so far and the stage reached, so a rebuilt thread carries on rather than starting over. */
  profile?: ProfileModel; stage?: OnboardingStage;
  /** How the person asked to be spoken to (`ONBOARDING_TONE_SETTING`); also sent with every later turn, since it can change. */
  tone?: OnboardingTone;
  /** The completion list's items still open (`interviewChecklist`): what the interview owes before it may say it is ready, and what waits on the person. */
  checklist?: Array<{ label: string; detail: string; owner: "interview" | "person"; start?: boolean }>;
  /** Hours spent in Codex and Claude Code per folder and when in the day (`agentHistoryLines`), when the person allowed it: habits, not a plan. */
  workHistory?: string[];
  /** The connected calendars' events in the next seven days (`calendarWeek`), when any calendar is connected: what the week already holds. */
  calendar?: Array<{ title: string; weekday: number; start: string; end: string; source: string }>;
  /**
   * The public quick test's result the person chose to bring in (`ASSESS_RESULT_SETTING`): their own 32-statement answer, corroboration only.
   * The portrait's four axes are still scored from the interview's own evidence and never copied from it.
   */
  publicAssessment?: { code: string; typeName: string; axes: Record<string, number>; takenAt: string; note: string };
  /** New files that did not fit this turn's reading budget; they come with the next turns. */
  sourcesWaiting?: number;
  /**
   * How many rounds the interview has spent in its current stage. From the second round on, `moveOn` says to go to the next stage — an
   * interview that waits for an answer the person does not have never ends (a simulated user who said 不确定 kept one in 「能量」 for seven
   * rounds). What the person cannot answer is written as an assumption (「假设：…」) in the same round, by a standing rule of the Skill.
   * The front stages are the exception: while a start item is open there is no `moveOn`, because those items accept only the person's word.
   */
  stageRounds?: number;
  moveOn?: string;
  /** Only when the conversation had to be rebuilt in a fresh thread: what was said before, oldest first. */
  history?: Array<{ id: string; role: "user" | "assistant"; text: string }>;
  /**
   * The question ledger (`ledgerLines`): what was already asked, numbered, with its status and answer — the interview's own, the app's
   * waiting ones (待问) and answered ones. A question that asks one of these again names its number in `repeats`.
   */
  questionLedger?: string[];
  /** The person's reply, as they wrote it. */
  reply: { id: string; text: string };
  /**
   * Facts the background extraction recorded since the dialogue last heard (「research/ece555 · deadline = 12 月中（确认）」): what the
   * ledger now holds, so the dialogue neither asks it again nor contradicts it. Later turns only; the first turn has `facts`.
   */
  recorded?: string[];
};

/**
 * What one extraction run is shown (2026-10-19): a fresh thread each time, so everything it needs is here — the replies and files not
 * yet extracted as numbered sentences, a short index of what the ledger already holds, and tools to read any earlier sentence
 * (`search_evidence`, `read_sentences`) instead of the whole conversation.
 */
export type OnboardingExtractContext = {
  version: "crossline.onboarding.extract.v1";
  today: string; timeZone: string;
  lines: Array<{ id: string; label: string; hard: boolean; goals: string[] }>;
  projects: Array<{ id: string; identityId: string; name: string; summary: string }>;
  /** The ledger's facts, one line each (`identity/project · slot = value（确认|推断）`): what is already known, to update rather than repeat. */
  facts: string[];
  /** Each line's description and attribute candidates on record. */
  lineProfiles: Array<{ lineId: string; description: string; attributes: string[] }>;
  /** The portrait so far; null for a line's own interview, which does not rewrite it. */
  profile: ProfileModel | null;
  stage: OnboardingStage;
  focusLine: { id: string; label: string } | null;
  /** The person's replies not yet extracted, oldest first, each with the questions it answers and its numbered sentences. */
  replies: Array<{ id: string; asked: string[]; sentences: string }>;
  /** Files not yet extracted, as numbered sentences within the run's reading budget. */
  sources: Array<{ id: string; fileName: string; kind: string; projectId: string; sentences: string }>;
  /** Files that did not fit this run; the next run takes them. */
  sourcesWaiting?: number;
  /** Every file is being read again: dates it states replace the batch nobody answered. */
  reread: boolean;
};

/** What the validator may check a citation against. Never sent to the model. */
export type KnownSources = {
  identities: string[];
  projectIds: string[];
  /** Every user reply so far, by id (`reply-N`), with the full text the quote must appear in. */
  replies: Record<string, string>;
  /** Every extracted document, by id (`src-N`). */
  sources: Record<string, string>;
  /** The numbered sentences the model was shown, by id: which reply or file each is in and where (`resolveOnboardingRefs`). */
  sentences?: Map<number, EvidenceSentence>;
};
/** One citable sentence: the reply (`reply-N`) or file (`src-N`) it is in, and its offsets in that text. */
export type EvidenceSentence = { ref: string; start: number; end: number; text: string };

const text = (max: number, min = 1) => ({ type: "string", minLength: min, maxLength: max }) as const;
const slug = { type: "string", minLength: 1, maxLength: 80 } as const;
const object = (properties: Record<string, unknown>) =>
  ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
/** Sentence numbers (2026-10-19): the model points at what it was shown instead of copying it, and the system fills the words in. */
export const REFS = { type: "array", maxItems: 8, items: { type: "integer", minimum: 1 } } as const;

/**
 * The ids a turn may name, as enums made for that turn (2026-10-19): a line or project the model names is then one the schema itself
 * offers, instead of a string the validator refuses after the fact. Without them (`undefined`) a field is a plain slug, which is what
 * the exported schemas below carry for the conformance check and the strict-mode rules.
 */
export type TurnIds = { lines: string[]; projects?: string[] };
const enumOf = (values: string[], fallback: object) => values.length ? { type: "string", enum: [...new Set(values)] } : fallback;

/** Every field either layer of a turn may write, made once so the two schemas below never drift apart. */
function turnFields(ids?: TurnIds) {
  // A line the answer names (never "person"); a line or the person; what a question is about ("" for the person in general or across lines).
  const line = ids ? enumOf(ids.lines.filter((id) => id !== PERSON_LINE), slug) : slug;
  const lineOrPerson = ids ? enumOf([...ids.lines, PERSON_LINE], slug) : slug;
  const about = ids ? enumOf(["", PERSON_LINE, ...ids.lines], { type: "string", maxLength: 80 }) : { type: "string", maxLength: 80 };
  // A question may only be about a project on record; a fact may also name one the same answer detects.
  const askedProject = ids?.projects ? enumOf(["", ...ids.projects], { type: "string", maxLength: 80 }) : { type: "string", maxLength: 80 };
  return {
    reply: text(1500),
    questions: {
      // A batch of questions that do not depend on each other (decided 2026-10-08): answered one by one on screen and sent together. A question
      // whose answer depends on another's waits for the next turn.
      type: "array", maxItems: 5,
      items: object({
        id: slug, text: text(400), kind: { type: "string", enum: ["single", "multi", "free"] },
        options: {
          type: "array", maxItems: 14,
          items: object({ id: slug, label: text(120), detail: { type: "string", maxLength: 300 } })
        },
        allowOther: { type: "boolean" },
        identityId: about, projectId: askedProject,
        // The ledger number of the question this one repeats (`questionLedger`), 0 when it is new.
        repeats: { type: "integer", minimum: 0 }
      })
    },
    slotUpdates: {
      type: "array", maxItems: 40,
      items: object({
        identityId: lineOrPerson, projectId: { type: "string", maxLength: 80 }, slot: slug, value: text(600),
        status: { type: "string", enum: ["confirmed", "inferred"] },
        // The numbered sentences the fact rests on; empty for an inference.
        refs: REFS
      })
    },
    projectsDetected: {
      type: "array", maxItems: 8,
      items: object({ id: slug, identityId: lineOrPerson, name: text(120), summary: { type: "string", maxLength: 500 } })
    },
    flywheelCandidates: {
      type: "array", maxItems: 12,
      items: object({
        fromIdentityId: lineOrPerson, toIdentityId: lineOrPerson, kind: { type: "string", enum: [...RELATION_KINDS] },
        explanation: text(500), refs: REFS,
        status: { type: "string", enum: ["inferred"] }
      })
    },
    coverage: {
      type: "array", maxItems: 8,
      items: object({
        identityId: lineOrPerson,
        filled: { type: "array", maxItems: 30, items: slug }, missing: { type: "array", maxItems: 30, items: slug }
      })
    },
    fileDates: DATE_EXTRACTION_SCHEMA,
    nextAction: { type: "string", enum: ["ask", "ready_for_milestones"] },
    stage: { type: "string", enum: [...ONBOARDING_STAGES] },
    lineProfiles: { type: "array", maxItems: 8, items: object({ lineId: line, description: { type: "string", maxLength: 800 },
      attributeCandidates: { type: "array", maxItems: ATTRIBUTE_CANDIDATES_MAX,
        items: object({ text: text(ATTRIBUTE_MAX_LENGTH), kind: ATTRIBUTE_KIND_FIELD, refs: REFS }) } }) },
    goalEdits: { type: "array", maxItems: 8, items: object({ lineId: line,
      parts: { type: "array", maxItems: 12, items: object({ text: text(ATTRIBUTE_MAX_LENGTH), kind: ATTRIBUTE_KIND_FIELD }) }, refs: REFS }) },
    availability: object({ windows: { type: "array", maxItems: 14, items: object({ days: { type: "array", maxItems: 7, items: { type: "integer", minimum: 0, maximum: 6 } },
      startMinute: { type: "integer", minimum: 0, maximum: 1440 }, endMinute: { type: "integer", minimum: 0, maximum: 1440 },
      energy: { type: "string", enum: ["low", "medium", "high"] } }) }, why: { type: "string", maxLength: 400 } }),
    profile: object({
      portrait: { type: "string", maxLength: 300 }, coreConflict: { type: "string", maxLength: 400 }, problem: { type: "string", maxLength: 600 },
      gravity: { type: "array", maxItems: 8, items: text(200) }, designable: { type: "array", maxItems: 8, items: text(200) },
      reframes: { type: "array", maxItems: 4, items: object({ fallacy: text(200), reframe: text(300) }) },
      workView: { type: "string", maxLength: 600 }, lifeView: { type: "string", maxLength: 600 }, consistency: { type: "string", maxLength: 600 }, trueNorth: { type: "string", maxLength: 300 },
      energyMap: { type: "array", maxItems: 12, items: object({ activity: text(80), skill: { type: "string", enum: ["high", "low"] }, love: { type: "string", enum: ["high", "low"] },
        charge: { type: "string", enum: ["charge", "drain"] } }) },
      flow: { type: "array", maxItems: 8, items: text(200) }, says: { type: "string", maxLength: 400 }, does: { type: "string", maxLength: 400 },
      anchor: { type: "string", maxLength: 400 }, realWant: { type: "string", maxLength: 400 }, allocation: { type: "string", maxLength: 600 },
      values: { type: "array", maxItems: 10, items: object({ value: { type: "string", enum: SCHWARTZ_VALUES.map((value) => value.name) }, score: { type: "integer", minimum: 0, maximum: 100 } }) }
    })
  };
}

/**
 * The two layers of an interview turn (2026-10-19, P2 of the redesign). The person waits only for the **dialogue**: what was taken in,
 * and the next questions. The **extraction** — facts with their sentence numbers, projects, dates, line attributes, hours, the
 * portrait — is written by its own run in the background, so its repairs never hold the conversation up.
 */
export const DIALOGUE_KEYS = ["reply", "questions", "coverage", "nextAction", "stage"] as const;
export const EXTRACT_KEYS = ["slotUpdates", "projectsDetected", "flywheelCandidates", "fileDates", "lineProfiles", "goalEdits", "availability", "profile"] as const;
const pick = <K extends string>(fields: Record<string, unknown>, keys: readonly K[]) => Object.fromEntries(keys.map((key) => [key, fields[key]]));
export const onboardingDialogueSchema = (ids?: TurnIds) => object(pick(turnFields(ids), DIALOGUE_KEYS));
export const onboardingExtractSchema = (ids?: TurnIds) => object(pick(turnFields(ids), EXTRACT_KEYS));
export const ONBOARDING_DIALOGUE_SCHEMA = onboardingDialogueSchema();
export const ONBOARDING_EXTRACT_SCHEMA = onboardingExtractSchema();
/** What the person waits for, and what is stored as the round. */
export type OnboardingDialogue = Pick<OnboardingTurn, "reply" | "questions" | "coverage" | "nextAction" | "stage">;
/** What the background run writes to the ledger. */
export type OnboardingExtraction = Pick<OnboardingTurn, "slotUpdates" | "projectsDetected" | "flywheelCandidates" | "lineProfiles" | "goalEdits"
  | "availability" | "profile"> & { fileDates?: DateExtraction };

const SLOT = /^[a-z][a-z0-9_]{1,39}$/;
const ID = /^[a-zA-Z0-9_-]{1,80}$/;
/** Collapses runs of whitespace so a quote survives a PDF line break or Word's paragraph spacing. */
const squash = (value: string) => value.replace(/\s+/g, " ").trim();
/** Letters and digits only, for comparing a quote with its source. */
const loose = (value: string) => value.replace(/[^\p{L}\p{N}]+/gu, "");

function reject(code: string, detail: string): never {
  const error = new Error(code);
  (error as Error & { detail?: string }).detail = detail.slice(0, 400);
  throw error;
}

export function validateOnboardingTurn(value: unknown, known: KnownSources): OnboardingTurn {
  const turn = value as OnboardingTurn | undefined;
  if (!turn || typeof turn.reply !== "string" || !Array.isArray(turn.questions) || !Array.isArray(turn.slotUpdates)
    || !Array.isArray(turn.projectsDetected) || !Array.isArray(turn.flywheelCandidates) || !Array.isArray(turn.coverage)
    || (turn.nextAction !== "ask" && turn.nextAction !== "ready_for_milestones")) {
    reject("ONBOARDING_TURN_SCHEMA_INVALID", "输出结构不符合要求。");
  }
  const identities = new Set([...known.identities, PERSON_LINE]);
  const projectIds = new Set(known.projectIds);
  for (const project of turn.projectsDetected) {
    if (!ID.test(project.id)) reject("ONBOARDING_PROJECT_ID_INVALID", `项目 id「${project.id}」只能含字母、数字、下划线和连字符。`);
    if (!identities.has(project.identityId)) reject("ONBOARDING_IDENTITY_UNKNOWN", `项目「${project.name}」的主线「${project.identityId}」不存在。`);
    projectIds.add(project.id);
  }

  const citable = (ref: string) => ref in known.replies || ref in known.sources;
  const sourceText = (ref: string) => known.replies[ref] ?? known.sources[ref] ?? "";

  for (const update of turn.slotUpdates) {
    if (!identities.has(update.identityId)) reject("ONBOARDING_IDENTITY_UNKNOWN", `事实里的主线「${update.identityId}」不存在。`);
    if (update.projectId && !projectIds.has(update.projectId)) reject("ONBOARDING_PROJECT_UNKNOWN", `事实引用了不存在的项目「${update.projectId}」。`);
    if (!SLOT.test(update.slot)) reject("ONBOARDING_SLOT_INVALID", `槽位名「${update.slot}」只能是小写字母、数字和下划线。`);
    if (update.sourceRef === "inference") {
      // An inference is allowed to be exactly that, but it may not pass for something the person said.
      if (update.status !== "inferred") reject("ONBOARDING_INFERENCE_NOT_CONFIRMED", `「${update.slot}」是推断，不能标成 confirmed。`);
      continue;
    }
    if (!citable(update.sourceRef)) reject("ONBOARDING_UNKNOWN_SOURCE_REF", `事实「${update.slot}」引用了不存在的来源「${update.sourceRef}」。`);
    if (!update.sourceQuote.trim()) reject("ONBOARDING_QUOTE_REQUIRED", `事实「${update.slot}」需要一条来自 ${update.sourceRef} 的原文引用。`);
    // Words and numbers in order, not punctuation or markup: a model copying a bulleted line as 「阶段：只有用户自己在用。」 from
    // 「- 阶段：**只有用户自己在用**」 quoted the right words (a real run failed twice over exactly this, on a profile written in Markdown).
    if (!loose(sourceText(update.sourceRef)).includes(loose(update.sourceQuote)) || !loose(update.sourceQuote)) {
      reject("ONBOARDING_QUOTE_NOT_VERBATIM", `事实「${update.slot}」的引用不是 ${update.sourceRef} 的原文逐字内容：「${update.sourceQuote.slice(0, 60)}」`);
    }
  }

  for (const candidate of turn.flywheelCandidates) {
    if (!identities.has(candidate.fromIdentityId) || !identities.has(candidate.toIdentityId)) reject("ONBOARDING_IDENTITY_UNKNOWN", "飞轮候选里有不存在的主线。");
    if (candidate.fromIdentityId === candidate.toIdentityId) reject("ONBOARDING_RELATION_SELF_LOOP", "飞轮候选的两端不能是同一条主线。");
    for (const ref of candidate.evidenceRefs) {
      if (ref !== "inference" && !citable(ref)) reject("ONBOARDING_UNKNOWN_SOURCE_REF", `飞轮候选引用了不存在的来源「${ref}」。`);
    }
  }

  const questionIds = new Set<string>();
  for (const question of turn.questions) {
    if (questionIds.has(question.id)) reject("ONBOARDING_QUESTION_DUPLICATE", `问题 id「${question.id}」重复。`);
    questionIds.add(question.id);
    if (question.identityId && !identities.has(question.identityId)) reject("ONBOARDING_IDENTITY_UNKNOWN", `问题「${question.id}」的主线不存在。`);
    if (question.projectId && !projectIds.has(question.projectId)) reject("ONBOARDING_PROJECT_UNKNOWN", `问题「${question.id}」引用了不存在的项目。`);
    const optionIds = new Set(question.options.map((option) => option.id));
    if (optionIds.size !== question.options.length) reject("ONBOARDING_OPTION_DUPLICATE", `问题「${question.id}」的选项 id 有重复。`);
    if (question.kind !== "free" && question.options.length < 2) {
      reject("ONBOARDING_OPTIONS_REQUIRED", `问题「${question.id}」是选择题，至少要给 2 个候选；难以回忆的内容要多给候选。`);
    }
  }
  if (turn.nextAction === "ask" && !turn.questions.length) reject("ONBOARDING_QUESTION_REQUIRED", "还没问完，这一轮必须至少提出一个问题。");
  for (const line of turn.lineProfiles ?? []) {
    if (!identities.has(line.lineId) || line.lineId === PERSON_LINE) reject("ONBOARDING_IDENTITY_UNKNOWN", `主线描述里的主线「${line.lineId}」不存在。`);
    const problem = attributeProblem(line.attributeCandidates ?? [], citable);
    if (problem) reject(problem.code, `主线「${line.lineId}」的定语候选：${problem.detail}`);
  }
  for (const edit of turn.goalEdits ?? []) {
    if (!identities.has(edit.lineId) || edit.lineId === PERSON_LINE) reject("ONBOARDING_IDENTITY_UNKNOWN", `长期目标修改里的主线「${edit.lineId}」不存在。`);
    // Only what the person asked for in so many words: a change the interview thought of itself is not a change they asked for.
    if (!(edit.sourceRef in known.replies)) reject("ONBOARDING_GOAL_EDIT_UNASKED", `长期目标修改必须引用本人提出修改的那条回复（reply-N），「${edit.sourceRef}」不是。`);
    const texts = edit.parts.map((part) => cleanAttribute(part.text)).filter(Boolean);
    if (!texts.length) reject("ONBOARDING_GOAL_EDIT_EMPTY", `主线「${edit.lineId}」的长期目标修改没有任何定语。`);
    const duplicate = duplicateAttributes(texts)[0];
    if (duplicate) reject("ONBOARDING_ATTRIBUTE_DUPLICATE", `长期目标修改里「${duplicate[0]}」与「${duplicate[1]}」重复：去掉「的」和标点后一个包含另一个，只保留一个。`);
  }
  for (const window of turn.availability?.windows ?? []) if (!/^\d{2}:\d{2}$/.test(window.start) || !/^\d{2}:\d{2}$/.test(window.end) || window.end <= window.start)
    reject("ONBOARDING_AVAILABILITY_INVALID", `可用时段 ${window.start}–${window.end} 不合法：startMinute 和 endMinute 是从零点起的分钟数（0–1440），结束晚于开始。`);
  // A turn recorded before the portrait existed has none of it; every live answer carries all of it (strict schema).
  return { ...turn, stage: turn.stage ?? "details", questions: turn.questions.map((question) => ({ ...question, kind: questionKind(question) })),
    lineProfiles: (turn.lineProfiles ?? []).map((line) => ({ ...line, attributeCandidates: cleanCandidates(line.attributeCandidates ?? []) })),
    goalEdits: (turn.goalEdits ?? []).map((edit) => ({ ...edit, parts: edit.parts.map((part) => ({ text: cleanAttribute(part.text), kind: kindOf(part) })).filter((part) => part.text) })),
    availability: turn.availability ?? { windows: [], why: "" },
    profile: withValues({ ...EMPTY_PROFILE_MODEL, ...(turn.profile ?? {}) }) };
}

/**
 * Whether a question takes several answers at once. `kind` says so (`multi`), and the Skill is told when to use it; a choice question
 * whose own words ask for several — 「哪些」, 「哪几」, a goal (「本学期最重要的目标？」: a grade and a skill can both be goals) — is read as
 * `multi` even when the model wrote `single`, because a single choice there forces a wrong answer. A goal measured as one number
 * (目标分数, 目标成绩) stays single.
 */
const MANY = /哪些|哪几|多选|可多选|都有什么|目标(?!分|成绩|绩点|线|是多少)/u;
export function questionKind(question: Pick<TurnQuestion, "kind" | "text">): TurnQuestion["kind"] {
  return question.kind === "single" && MANY.test(question.text) ? "multi" : question.kind;
}

/** Known values only, each once, scores clamped: a profile from before values existed has none. */
function withValues(profile: ProfileModel): ProfileModel {
  const names = new Set(SCHWARTZ_VALUES.map((value) => value.name as string));
  const seen = new Set<string>();
  const values = (Array.isArray(profile.values) ? profile.values : []).filter((item) => names.has(item.value) && !seen.has(item.value) && Boolean(seen.add(item.value)))
    .map((item) => ({ value: item.value, score: Math.max(0, Math.min(100, Math.round(Number(item.score) || 0))) }));
  return { ...profile, values };
}

const kindOf = (part: { text: string; kind?: string }): AttributeKind =>
  (ATTRIBUTE_KINDS as readonly string[]).includes(part.kind ?? "") ? part.kind as AttributeKind : guessKind(part.text);
const cleanCandidates = (list: AttributeCandidate[]) => list.map((item) => ({ text: cleanAttribute(item.text), kind: kindOf(item), sourceRef: item.sourceRef }))
  .filter((item) => item.text);

/**
 * What is wrong with one line's attribute candidates, if anything: an empty list is allowed (it keeps the ones on record); otherwise
 * 6–12, each cited to a reply or file, each one thing, and no two saying the same (after removing 「的」 and punctuation, one contains
 * the other). The detail names the offending attributes so the repair has something to act on.
 */
function attributeProblem(list: AttributeCandidate[], citable: (ref: string) => boolean): { code: string; detail: string } | undefined {
  if (!list.length) return undefined;
  for (const item of list) {
    if (!citable(item.sourceRef)) return { code: "ONBOARDING_UNKNOWN_SOURCE_REF", detail: `「${item.text}」没有引用本轮给出的句子；每个定语在 refs 里写出它来自的句子编号。` };
    if (!cleanAttribute(item.text)) return { code: "ONBOARDING_ATTRIBUTE_EMPTY", detail: "有一个定语是空的。" };
    if (notAtomic(item.text)) return { code: "ONBOARDING_ATTRIBUTE_NOT_ATOMIC", detail: `「${item.text}」含有并列，一个定语只写一件事，拆成两个。` };
  }
  const duplicate = duplicateAttributes(list.map((item) => cleanAttribute(item.text)))[0];
  if (duplicate) return { code: "ONBOARDING_ATTRIBUTE_DUPLICATE", detail: `「${duplicate[0]}」与「${duplicate[1]}」重复：去掉「的」和标点后一个包含另一个，只保留一个或改成互不重叠的两个。` };
  if (list.length < ATTRIBUTE_CANDIDATES_MIN || list.length > ATTRIBUTE_CANDIDATES_MAX) {
    return { code: "ONBOARDING_ATTRIBUTES_COUNT", detail: `写 ${ATTRIBUTE_CANDIDATES_MIN}–${ATTRIBUTE_CANDIDATES_MAX} 个，现在是 ${list.length} 个；信息还不够时留空数组并继续追问。` };
  }
  return undefined;
}

/** The candidates that pass on their own (cited, one thing, not repeating an earlier one); fewer than six left means none (keep those on record). */
function keepCandidates(list: AttributeCandidate[], citable: (ref: string) => boolean): AttributeCandidate[] {
  const kept: AttributeCandidate[] = [];
  for (const item of list) {
    const text = cleanAttribute(item.text);
    if (!text || !citable(item.sourceRef) || notAtomic(text) || duplicateAttributes([...kept.map((other) => other.text), text]).length) continue;
    kept.push({ text, kind: kindOf(item), sourceRef: item.sourceRef });
  }
  return kept.length >= ATTRIBUTE_CANDIDATES_MIN ? kept.slice(0, ATTRIBUTE_CANDIDATES_MAX) : [];
}

/**
 * When the repairs ran out on a turn whose trouble is one item — a fact with a malformed slot or a quote that is not verbatim, a
 * candidate or question naming a line that does not exist, a bad availability window — keeps the rest of the turn without those items
 * (a real run lost a whole turn, profile and line descriptions included, to one fact named 「指南针」). Returns undefined when what is
 * left still does not validate, so a turn that is wrong as a whole stays refused.
 */
/**
 * How many items `keepOnboardingTurn` left out of an answer: facts, questions, projects, feeds, goal edits, attribute candidates and
 * availability windows. The interview keeps a pruned turn at once when this is small (`ONBOARDING_KEEP_EARLY_MAX`) rather than asking
 * the model to rewrite the whole answer, which costs a full regeneration (2026-10-16: two repairs were two thirds of a 174 s turn).
 */
export function droppedOnboardingItems(original: unknown, kept: Partial<OnboardingTurn>): number {
  const turn = original as Partial<OnboardingTurn> | undefined;
  const count = (list: unknown) => Array.isArray(list) ? list.length : 0;
  const candidates = (lines: unknown) => Array.isArray(lines)
    ? lines.reduce((sum: number, line: { attributeCandidates?: unknown }) => sum + count(line?.attributeCandidates), 0) : 0;
  const lost = (key: "slotUpdates" | "questions" | "projectsDetected" | "flywheelCandidates" | "goalEdits") => Math.max(0, count(turn?.[key]) - count(kept[key]));
  return lost("slotUpdates") + lost("questions") + lost("projectsDetected") + lost("flywheelCandidates") + lost("goalEdits")
    + Math.max(0, candidates(turn?.lineProfiles) - candidates(kept.lineProfiles))
    + Math.max(0, count(turn?.availability?.windows) - count(kept.availability?.windows));
}
/** At most this many items are dropped from a turn to keep it without a repair. */
export const ONBOARDING_KEEP_EARLY_MAX = 2;

export function keepOnboardingTurn(value: unknown, known: KnownSources): OnboardingTurn | undefined {
  const turn = value as OnboardingTurn | undefined;
  if (!turn || !Array.isArray(turn.slotUpdates) || !Array.isArray(turn.questions) || !Array.isArray(turn.projectsDetected)) return undefined;
  const identities = new Set([...known.identities, PERSON_LINE]);
  const projects = turn.projectsDetected.filter((project) => ID.test(project.id) && identities.has(project.identityId));
  const projectIds = new Set([...known.projectIds, ...projects.map((project) => project.id)]);
  const sourceText = (ref: string) => known.replies[ref] ?? known.sources[ref];
  const factOk = (update: OnboardingTurn["slotUpdates"][number]) => identities.has(update.identityId) && (!update.projectId || projectIds.has(update.projectId))
    && SLOT.test(update.slot) && (update.sourceRef === "inference" ? update.status === "inferred"
      : sourceText(update.sourceRef) !== undefined && Boolean(loose(update.sourceQuote)) && loose(sourceText(update.sourceRef)!).includes(loose(update.sourceQuote)));
  const seen = new Set<string>();
  const questions = turn.questions.filter((question) => !seen.has(question.id) && Boolean(seen.add(question.id))
    && (!question.identityId || identities.has(question.identityId)) && (!question.projectId || projectIds.has(question.projectId))
    && new Set(question.options.map((option) => option.id)).size === question.options.length && (question.kind === "free" || question.options.length >= 2));
  const pruned: OnboardingTurn = { ...turn, projectsDetected: projects, slotUpdates: turn.slotUpdates.filter(factOk), questions,
    flywheelCandidates: (turn.flywheelCandidates ?? []).filter((candidate) => identities.has(candidate.fromIdentityId) && identities.has(candidate.toIdentityId)
      && candidate.fromIdentityId !== candidate.toIdentityId && candidate.evidenceRefs.every((ref) => ref === "inference" || sourceText(ref) !== undefined)),
    lineProfiles: (turn.lineProfiles ?? []).filter((line) => identities.has(line.lineId) && line.lineId !== PERSON_LINE)
      .map((line) => ({ ...line, attributeCandidates: keepCandidates(line.attributeCandidates ?? [], (ref) => sourceText(ref) !== undefined) })),
    goalEdits: (turn.goalEdits ?? []).filter((edit) => identities.has(edit.lineId) && edit.lineId !== PERSON_LINE && edit.sourceRef in known.replies
      && edit.parts.some((part) => cleanAttribute(part.text)) && !duplicateAttributes(edit.parts.map((part) => cleanAttribute(part.text)).filter(Boolean)).length),
    ...(turn.availability ? { availability: { ...turn.availability, windows: turn.availability.windows.filter((window) => /^\d{2}:\d{2}$/.test(window.start)
      && /^\d{2}:\d{2}$/.test(window.end) && window.end > window.start) } } : {}) };
  try { return validateOnboardingTurn(pruned, known); } catch { return undefined; }
}
