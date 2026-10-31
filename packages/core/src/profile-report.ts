/**
 * The profile report as claims (docs/profile-and-agent-kit.md §五–§七, decided with the owner on 2026-10-31). The page and the export
 * package share one structure: numbered sections, each holding claims with what they rest on and who may see them. The 16-type poster
 * stays as the fun layer of the overview; everything else is a claim the person can read back to its evidence.
 */
import type { Administration, InstrumentId } from "./profile-instruments";

export const REPORT_SECTIONS = [
  "collaboration", "overview", "personality", "values", "motivation", "narrative", "interests", "work_style", "lifestyle",
  "tensions", "crossline", "system", "milestones"
] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];

export const REPORT_SECTION_LABEL: Record<ReportSection, string> = {
  collaboration: "和此人协作的说明", overview: "总览", personality: "人格", values: "价值与取舍", motivation: "动机",
  narrative: "生涯叙事", interests: "职业兴趣", work_style: "工作方式", lifestyle: "生活方式", tensions: "张力与成长",
  crossline: "Crossline 适配", system: "系统接轨", milestones: "里程碑附录"
};

/** The sections the portrait writer fills; the overview is the poster, the two appendices come from the plan. */
export const WRITER_SECTIONS = REPORT_SECTIONS.filter((section) => !["overview", "system", "milestones"].includes(section)) as ReportSection[];
/** What the writer returns per claim: a statement, how it knows, and a verbatim span of the person's own words it rests on. */
export type WrittenClaim = { section: ReportSection; statement: string; kind: "self_reported" | "inferred"; confidence: number; quote: string };
export const WRITTEN_CLAIMS_MAX = 40;
export const WRITTEN_CLAIMS_SCHEMA = {
  type: "array", maxItems: WRITTEN_CLAIMS_MAX, items: { type: "object", additionalProperties: false, required: ["section", "statement", "kind", "confidence", "quote"],
    properties: { section: { type: "string", enum: WRITER_SECTIONS }, statement: { type: "string", minLength: 1, maxLength: 200 },
      kind: { type: "string", enum: ["self_reported", "inferred"] }, confidence: { type: "number", minimum: 0, maximum: 1 },
      quote: { type: "string", maxLength: 80 } } }
} as const;

/** `public`: on the share card; `agent`: in the export (the default); `private`: only on the person's own page. */
export type PrivacyLevel = "public" | "agent" | "private";
export const PRIVACY_LEVELS: readonly PrivacyLevel[] = ["public", "agent", "private"];
export const DEFAULT_SECTION_PRIVACY: Record<ReportSection, PrivacyLevel> = {
  collaboration: "agent", overview: "public", personality: "agent", values: "agent", motivation: "agent", narrative: "agent",
  interests: "agent", work_style: "agent", lifestyle: "agent", tensions: "private", crossline: "agent", system: "agent", milestones: "agent"
};
/** Where the person's own privacy choices are kept: `{ sections: {section: level}, claims: {claimId: level} }`. */
export const REPORT_PRIVACY_SETTING = "profile.privacy";
export type PrivacyChoices = { sections: Partial<Record<ReportSection, PrivacyLevel>>; claims: Record<string, PrivacyLevel> };

export type ClaimKind = "self_reported" | "inferred" | "measured" | "observed";
export type ClaimBasis =
  /** `sentenceId` when the quote's numbered sentence was found. */
  | { sentenceId?: number; quote: string }
  | { instrument: InstrumentId; items: string[]; administration: Administration }
  | { behaviour: string; window: string };

export type ProfileClaim = {
  id: string;
  section: ReportSection;
  statement: string;
  kind: ClaimKind;
  /** 0–1. */
  confidence: number;
  basis: ClaimBasis[];
  /** Set by the person on the claim itself; else the section's level applies. */
  privacy?: PrivacyLevel;
  /** The day it is asked about again in the weekly review (§七). */
  reviewBy?: string;
  confirmedAt?: string;
};

const RANK: Record<PrivacyLevel, number> = { public: 0, agent: 1, private: 2 };

/** Who may see a claim: the claim's own choice, else the section's (the person's, else the default). */
export function claimPrivacy(claim: ProfileClaim, choices?: PrivacyChoices): PrivacyLevel {
  return choices?.claims[claim.id] ?? claim.privacy ?? choices?.sections[claim.section] ?? DEFAULT_SECTION_PRIVACY[claim.section];
}

/** Claims visible at a level: the share card sees `public` only, an agent sees `public` and `agent`, the person sees everything. */
export function visibleClaims(claims: readonly ProfileClaim[], audience: PrivacyLevel, choices?: PrivacyChoices): ProfileClaim[] {
  return claims.filter((claim) => RANK[claimPrivacy(claim, choices)] <= RANK[audience]);
}

/**
 * What a claim must have to be stored: a statement, a known section and kind, a confidence in range and at least one basis; a measured
 * claim rests on an instrument and an observed one on a behaviour with its window. Returns the problem, or null.
 */
export function claimProblem(claim: ProfileClaim): string | null {
  if (!claim.statement.trim()) return "CLAIM_EMPTY";
  if (!(REPORT_SECTIONS as readonly string[]).includes(claim.section)) return "CLAIM_SECTION_UNKNOWN";
  if (!(claim.confidence >= 0 && claim.confidence <= 1)) return "CLAIM_CONFIDENCE_RANGE";
  if (claim.basis.length === 0) return "CLAIM_BASIS_MISSING";
  if (claim.kind === "measured" && !claim.basis.some((basis) => "instrument" in basis)) return "CLAIM_MEASURE_MISSING";
  if (claim.kind === "observed" && !claim.basis.some((basis) => "behaviour" in basis && basis.window.trim())) return "CLAIM_WINDOW_MISSING";
  return null;
}

export function readPrivacyChoices(raw: string | null | undefined): PrivacyChoices {
  try {
    const value = JSON.parse(raw ?? "{}") as Partial<PrivacyChoices>;
    const pick = <K extends string>(record: unknown, keys?: readonly string[]) => Object.fromEntries(Object.entries(
      record && typeof record === "object" ? record as Record<string, unknown> : {})
      .filter(([key, level]) => (!keys || keys.includes(key)) && PRIVACY_LEVELS.includes(level as PrivacyLevel))) as Record<K, PrivacyLevel>;
    return { sections: pick<ReportSection>(value.sections, REPORT_SECTIONS), claims: pick<string>(value.claims) };
  } catch { return { sections: {}, claims: {} }; }
}
