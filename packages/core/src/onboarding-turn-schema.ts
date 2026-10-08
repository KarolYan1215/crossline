import { RELATION_KINDS } from "./flywheel-schema";
import { DATE_EXTRACTION_SCHEMA, type DateExtraction } from "./date-schema";

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
 *   - `slotUpdates`: facts it learned, each tied to the reply or file it came from and, unless it is an
 *     explicit inference, to a verbatim quote from that source — the same grounding rule the rest of
 *     this app already uses, because a profile built on invented facts is worse than an empty one;
 *   - `projectsDetected`: the separate things the person works on inside a line;
 *   - `flywheelCandidates`: connections between lines, always `inferred` here — only the person can
 *     confirm one.
 */
export type TurnQuestion = {
  id: string; text: string; kind: "single" | "multi" | "free";
  options: Array<{ id: string; label: string; detail: string }>;
  allowOther: boolean; identityId: string; projectId: string;
};
export type SlotUpdate = {
  identityId: string; projectId: string; slot: string; value: string;
  status: "confirmed" | "inferred"; sourceRef: string; sourceQuote: string;
};
export type DetectedProject = { id: string; identityId: string; name: string; summary: string };
export type FlywheelCandidate = {
  fromIdentityId: string; toIdentityId: string; kind: (typeof RELATION_KINDS)[number];
  explanation: string; evidenceRefs: string[]; status: "inferred";
};
export type TurnCoverage = { identityId: string; filled: string[]; missing: string[] };

/**
 * Where the interview is (decided 2026-10-08): it starts from nothing and goes, one question at a time, through how the app works, where
 * the person stands, their compass, their energy, their lines, three five-year versions, each line's specifics, and ends in a portrait.
 * A line's own interview (`focusLine`) runs only `details` for that line.
 */
export const ONBOARDING_STAGES = ["orientation", "situation", "compass", "energy", "lines", "odyssey", "details", "blueprint"] as const;
export type OnboardingStage = (typeof ONBOARDING_STAGES)[number];
/** The facts that are about the person rather than one line (their compass, their energy) are filed under this id. */
export const PERSON_LINE = "person";

/**
 * The working portrait, rewritten in full every turn from everything said so far: the problem as the person states it and as it really is
 * (what is gravity — a fact to accept — and what can be designed), their view of work and of life, what gives and drains energy and where
 * they reach flow, the anchor holding them in place, the rule that allocates their attention across lines, and three five-year versions.
 * It is the interviewer's synthesis, shown as such; facts with quotes stay in `slotUpdates`.
 */
export type ProfileModel = {
  problem: string; gravity: string[]; designable: string[]; workView: string; lifeView: string;
  energizing: string[]; draining: string[]; flow: string[]; anchor: string; allocation: string;
  odyssey: Array<{ title: string; summary: string }>;
};
export const EMPTY_PROFILE_MODEL: ProfileModel = { problem: "", gravity: [], designable: [], workView: "", lifeView: "", energizing: [], draining: [],
  flow: [], anchor: "", allocation: "", odyssey: [] };
/** A line the interviewer proposes from what it heard; the person confirms it (and its long-term goal) before it exists. */
export type ProposedLine = { label: string; goal: string; why: string };
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
  linesProposed?: ProposedLine[];
  profile?: ProfileModel;
  /** The portrait as a report, written at the end (`stage: "blueprint"`); "" before. */
  blueprint?: string;
};

/** What the Skill is shown at the start of the interview (later turns only carry the new reply). */
export type OnboardingTurnContext = {
  version: "crossline.onboarding.turn.v1";
  /** `YYYY-MM-DD` in the person's zone, so a date written without a year lands in the right one. */
  today?: string; timeZone?: string;
  identities: Array<{ id: string; label: string }>;
  projects: Array<{ id: string; identityId: string; name: string; summary: string }>;
  facts: Array<{ identityId: string; projectId: string; slot: string; value: string; status: string }>;
  sources: Array<{ id: string; fileName: string; kind: string; projectId: string; text: string }>;
  /** A line's own interview: only this line is asked about. Absent for the full interview. */
  focusLine?: { id: string; label: string; goal: string } | null;
  /** The portrait so far and the stage reached, so a rebuilt thread carries on rather than starting over. */
  profile?: ProfileModel; stage?: OnboardingStage;
  /** Only when the conversation had to be rebuilt in a fresh thread: what was said before, oldest first. User lines carry their `reply-N` id. */
  history?: Array<{ id: string; role: "user" | "assistant"; text: string }>;
  reply: { id: string; text: string };
};

/** What the validator may check a citation against. Never sent to the model. */
export type KnownSources = {
  identities: string[];
  projectIds: string[];
  /** Every user reply so far, by id (`reply-N`), with the full text the quote must appear in. */
  replies: Record<string, string>;
  /** Every extracted document, by id (`src-N`). */
  sources: Record<string, string>;
};

const text = (max: number, min = 1) => ({ type: "string", minLength: min, maxLength: max }) as const;
const slug = { type: "string", minLength: 1, maxLength: 80 } as const;
const object = (properties: Record<string, unknown>) =>
  ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

export const ONBOARDING_TURN_SCHEMA = object({
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
      // "" = about the person generally / about the connections between lines.
      identityId: { type: "string", maxLength: 80 }, projectId: { type: "string", maxLength: 80 }
    })
  },
  slotUpdates: {
    type: "array", maxItems: 40,
    items: object({
      identityId: slug, projectId: { type: "string", maxLength: 80 }, slot: slug, value: text(600),
      status: { type: "string", enum: ["confirmed", "inferred"] },
      // `reply-N`, `src-N`, or `inference`.
      sourceRef: slug, sourceQuote: { type: "string", maxLength: 600 }
    })
  },
  projectsDetected: {
    type: "array", maxItems: 8,
    items: object({ id: slug, identityId: slug, name: text(120), summary: { type: "string", maxLength: 500 } })
  },
  flywheelCandidates: {
    type: "array", maxItems: 12,
    items: object({
      fromIdentityId: slug, toIdentityId: slug, kind: { type: "string", enum: [...RELATION_KINDS] },
      explanation: text(500), evidenceRefs: { type: "array", maxItems: 6, items: slug },
      status: { type: "string", enum: ["inferred"] }
    })
  },
  coverage: {
    type: "array", maxItems: 8,
    items: object({
      identityId: slug,
      filled: { type: "array", maxItems: 30, items: slug }, missing: { type: "array", maxItems: 30, items: slug }
    })
  },
  fileDates: DATE_EXTRACTION_SCHEMA,
  nextAction: { type: "string", enum: ["ask", "ready_for_milestones"] },
  stage: { type: "string", enum: [...ONBOARDING_STAGES] },
  linesProposed: { type: "array", maxItems: 8, items: object({ label: text(20), goal: { type: "string", maxLength: 300 }, why: { type: "string", maxLength: 300 } }) },
  profile: object({
    problem: { type: "string", maxLength: 600 }, gravity: { type: "array", maxItems: 8, items: text(200) }, designable: { type: "array", maxItems: 8, items: text(200) },
    workView: { type: "string", maxLength: 600 }, lifeView: { type: "string", maxLength: 600 },
    energizing: { type: "array", maxItems: 8, items: text(200) }, draining: { type: "array", maxItems: 8, items: text(200) }, flow: { type: "array", maxItems: 8, items: text(200) },
    anchor: { type: "string", maxLength: 600 }, allocation: { type: "string", maxLength: 600 },
    odyssey: { type: "array", maxItems: 3, items: object({ title: text(20), summary: text(800) }) }
  }),
  blueprint: { type: "string", maxLength: 20_000 }
});

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
  for (const line of turn.linesProposed ?? []) if (!line.label.trim()) reject("ONBOARDING_LINE_LABEL_REQUIRED", "提议的主线需要名称。");
  // A turn recorded before the portrait existed has none of it; every live answer carries all of it (strict schema).
  return { ...turn, stage: turn.stage ?? "details", linesProposed: turn.linesProposed ?? [], profile: { ...EMPTY_PROFILE_MODEL, ...(turn.profile ?? {}) }, blueprint: turn.blueprint ?? "" };
}
