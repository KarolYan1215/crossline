import type { EligibilityTerm, EligibilityVerdict, Feasibility, Opportunity, OpportunityDecision } from "@crossline/core";

/** A found opportunity as kept: the contract's record, the read terms (what each accepts), the verdict and the person's answer. */
export type StoredOpportunity = Opportunity & { terms: EligibilityTerm[]; verdict: EligibilityVerdict; decision?: OpportunityDecision | undefined;
  decidedAt?: string | undefined; laterUntil?: string | undefined; confirmedBy?: string | undefined; updatedAt: string;
  /** The time–space verdict when it was found (§17.6); an infeasible one is kept for dedupe and never shown. */
  feasibility?: Feasibility | undefined };

/**
 * A project is one thing the person is actually working on inside an identity (a paper, a product, a
 * channel). Until now a project was a bare string on a milestone, `${identity}-default` for nearly all
 * of them, so a person with two research projects had no way to say so. Named `workspace_projects`
 * because a table called `projects` was retired in migration 4 and the restore path refuses that name.
 */
export type StoredProject = {
  id: string; ownerId: string; workspaceId: string; identityId: string; name: string;
  status: "active" | "paused" | "done" | "archived"; summary: string; createdAt: string; updatedAt: string;
};

/** A file the person gave us, with the text pulled out of it: the only form in which a model ever sees it. */
export type StoredSourceDocument = {
  id: string; ownerId: string; workspaceId: string; projectId?: string;
  /** The `src-N` number, fixed at upload (migration 16); set by the store, never by a caller. */
  refNo?: number;
  kind: "pdf" | "docx" | "image" | "audio" | "text";
  fileName: string; mediaType: string; sha256: string; uri: string;
  extractedText: string; extractionStatus: "pending" | "done" | "failed" | "unsupported";
  extractionNote?: string; createdAt: string;
};

/**
 * One passage of a document's text in the full-text index (migration 19, docs/context-selection.md): what the model's `read_chunk` returns
 * and a search hit points at. `heading` is 「文件名 · 项目 · 线」, indexed with the text, so a query naming the course finds its files.
 */
export type DocChunk = { id: number; documentId: string; ord: number; start: number; heading: string; body: string;
  fileName: string; projectId?: string; identityId?: string };
export type DocChunkHit = DocChunk & { score: number };

export type StoredOnboardingSession = {
  id: string; ownerId: string; workspaceId: string; codexThreadId?: string;
  state: "active" | "complete"; coverage: Record<string, unknown>; createdAt: string; updatedAt: string;
};
export type StoredOnboardingMessage = {
  sessionId: string; workspaceId: string; seq: number; role: "assistant" | "user";
  content: unknown; createdAt: string;
};

/** One thing known about the person, with where it came from. `inferred` means nobody has confirmed it. */
export type StoredProfileFact = {
  workspaceId: string; identityId: string; projectId: string; slot: string; value: string;
  status: "confirmed" | "inferred"; sourceRef: string; sourceQuote: string; updatedAt: string;
  /**
   * The numbered sentences (`evidence_sentences`) the fact rests on; `sourceQuote` is their text, filled by the system. Empty for a
   * fact no sentence stands behind (an inference, a fact another Skill wrote from text it was given).
   */
  sourceSentences?: number[];
  /** How often an answer that took effect cited it, and when last (migration 20); present only once it has been used. */
  useCount?: number; lastUsedAt?: string;
};
/** One numbered sentence of a reply or a file (`segmentText`). Ids are per workspace and never reused or renumbered. */
export type StoredSentence = {
  id: number; sourceKind: "reply" | "document"; sourceId: string; ord: number; start: number; end: number; text: string; retired: boolean;
};

export type StoredPreference = {
  workspaceId: string; id: string;
  source: "correction" | "retrospective" | "estimate" | "importance" | "standard_confirmed" | "relation_rejected" | "postpone"
    /** The person turned down an opportunity agent's need or offer: what not to propose again (docs/opportunity-agent.md §8). */
    | "opportunity_declined"
    /** A sentence the person added to 「少来」 on an opportunity (docs/opportunity-agent.md §17.4), read by the next derivation. */
    | "opportunity_less"
    /** A wording the person taught by editing dictated text (docs/voice-input.md); scope `dictation`, read only by the dictation corrector. */
    | "dictation";
  /** A line id, `task:<id>`, `archetype:<id>` or `all`. */
  scope: string; text: string;
  /** How much it counts: a stated correction 1, a measured pattern more, a single manual edit less. */
  weight: number; refId: string; createdAt: string; deletedAt: string | null;
  /** How often an answer that took effect cited it, and when last (migration 20); present only once it has been used. */
  useCount?: number; lastUsedAt?: string;
  /** Lapsed unused (`expireUnused`): kept and shown, never given to a model, restorable. */
  invalidatedAt?: string;
  /** The person kept it (restored a lapsed one): it never lapses again. */
  confirmedAt?: string;
};

/**
 * One lesson from past runs (migration 20, docs/token-economy.md §2): drawn by rule from the ledger or imported once from Codex's memories,
 * for a line and a task archetype (either empty for every one). `source` is the rule (`rule:review_note` …) or `codex-memory`.
 */
export type StoredLesson = {
  workspaceId: string; id: string; lineId: string | null; archetypeId: string | null; kind: "failure" | "preference" | "knowledge";
  text: string; source: string; sourceRef: string; keywords: string; createdAt: string; useCount: number; lastUsedAt: string | null;
  invalidatedAt: string | null;
};
/** Something a model was given and cited (`usedRefs`), counted when its answer takes effect. */
export type UsedRef = { kind: "fact"; identityId: string; projectId: string; slot: string } | { kind: "pref"; id: string } | { kind: "lesson"; id: string };
/** Preferences the person stated (not read off an edit): they come first in a context. */
export const STATED_PREFERENCE_SOURCES: ReadonlySet<string> = new Set(["correction", "retrospective", "standard_confirmed", "relation_rejected", "opportunity_declined", "opportunity_less"]);
/** Preferences read off an edit, which lapse after `PREFERENCE_LAPSE_DAYS` unused (decided 2026-10-21). */
export const LAPSING_PREFERENCE_SOURCES: ReadonlySet<string> = new Set(["estimate", "importance", "postpone"]);
export const PREFERENCE_LAPSE_DAYS = 30;
export const LESSON_LAPSE_DAYS = 60;

export type StoredDiligenceReport = {
  id: string; ownerId: string; workspaceId: string; scope: string; question: string;
  findings: unknown; proposals: unknown; sources: unknown;
  status: "queued" | "running" | "done" | "failed"; note?: string; runAt: string;
};

export type StoredBackgroundFact = { key: string; value: string; why: string; sourceQuote: string; updatedAt: string };
