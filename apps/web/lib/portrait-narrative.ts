import "server-only";
import { NARRATIVE_RATE_AFTER_MS, PORTRAIT_NARRATIVE_SETTING, PROFILE_CLAIM_STATUS_SETTING, narrativeRatable, narrativeSectionKey, rateNarrativeSection,
  readClaimStatus, readSavedNarrative, type AccessContext, type NarrativeRating } from "@crossline/core";
import { getStore } from "./crossline";

export type NarrativeView = {
  at: string;
  sections: Array<{ key: string; heading: string; paragraphs: string[]; level: 1 | 2 | 3; ratable: boolean; ratableAt: string | null; rating: NarrativeRating | null }>;
};

const now = () => process.env.CROSSLINE_FIXED_NOW ? new Date(process.env.CROSSLINE_FIXED_NOW) : new Date();

/**
 * The narrative as the page shows it (docs/plans/portrait-depth-1122.md §四): no basis lines, the level-3 sections last, each with when
 * it may be rated. Null before a narrative was written.
 */
export function loadNarrative(ctx: AccessContext): NarrativeView | null {
  const saved = readSavedNarrative(getStore().getSetting(ctx.workspaceId, PORTRAIT_NARRATIVE_SETTING));
  if (!saved) return null;
  const at = now();
  const ordered = [...saved.sections.filter((section) => section.level !== 3), ...saved.sections.filter((section) => section.level === 3)];
  return { at: saved.at, sections: ordered.map((section) => {
    const key = narrativeSectionKey(section.heading);
    const ratable = narrativeRatable(section, saved.at, at);
    return { key, heading: section.heading, level: section.level,
      paragraphs: section.body.split(/\n\s*\n/).map((part) => part.replace(/\*\*|__/g, "").replace(/^\s*[-*]\s+/gm, "").trim()).filter(Boolean),
      ratable, ratableAt: ratable ? null : new Date(Date.parse(saved.at) + NARRATIVE_RATE_AFTER_MS).toISOString(), rating: saved.ratings?.[key] ?? null };
  }) };
}

/** The person's verdict on one section; 不准 joins the claims the next portrait does not repeat. */
export function rateNarrative(ctx: AccessContext, input: { key: string; verdict: NarrativeRating["verdict"]; note?: string }): { ok: true } | { ok: false; code: string } {
  const store = getStore();
  const saved = readSavedNarrative(store.getSetting(ctx.workspaceId, PORTRAIT_NARRATIVE_SETTING));
  if (!saved) return { ok: false, code: "NARRATIVE_NONE" };
  const result = rateNarrativeSection(saved, readClaimStatus(store.getSetting(ctx.workspaceId, PROFILE_CLAIM_STATUS_SETTING)), { ...input, now: now() });
  if (!result.ok) return result;
  store.setSetting(ctx.workspaceId, PORTRAIT_NARRATIVE_SETTING, JSON.stringify(result.saved));
  store.setSetting(ctx.workspaceId, PROFILE_CLAIM_STATUS_SETTING, JSON.stringify(result.status));
  const at = new Date().toISOString();
  store.appendEvent({ ownerId: store.getWorkspaceOwnerId(ctx.workspaceId) ?? ctx.principalId, workspaceId: ctx.workspaceId,
    idempotencyKey: `portrait.narrative_rated:${input.key}:${at}`, type: "portrait.narrative_rated", entityId: ctx.workspaceId,
    payload: { key: input.key, verdict: input.verdict } });
  return { ok: true };
}
