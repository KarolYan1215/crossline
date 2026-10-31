import "server-only";
import {
  PRIVACY_LEVELS, PROFILE_CLAIMS_SETTING, PROFILE_CLAIM_STATUS_SETTING, PROFILE_INSTRUMENTS_SETTING, PROFILE_ITEMS, REPORT_PRIVACY_SETTING, REPORT_SECTIONS,
  instrumentClaims, readClaimStatus, readInstrumentAnswers, readPrivacyChoices, reportSections,
  type AccessContext, type ClaimStatus, type InstrumentId, type PrivacyLevel, type ProfileClaim, type ReportSection, type ReportSectionView
} from "@crossline/core";
import { getStore } from "./crossline";

/** One card item as the person answered it, for 「卡片作答」 on the portrait page: what was recorded, and how. */
export type ProfileItemView = {
  id: string; instrument: InstrumentId; text: string; anchors: readonly [string, string, string];
  answer: { by: "tapped" | "mapped" | "skipped" | "pending"; score?: number } | null;
};
export type ProfileReportState = { sections: ReportSectionView[]; items: ProfileItemView[] };

const readJson = <T,>(raw: string | null | undefined, fallback: T): T => { try { return (JSON.parse(raw ?? "null") as T) ?? fallback; } catch { return fallback; } };

/** Every claim the report holds: the cards' (computed now, so an edited answer shows at once) and the writer's (kept at its last run). */
function allClaims(ctx: AccessContext): ProfileClaim[] {
  const store = getStore();
  const answers = readInstrumentAnswers(store.getSetting(ctx.workspaceId, PROFILE_INSTRUMENTS_SETTING));
  const written = readJson<{ at?: string; claims?: ProfileClaim[] }>(store.getSetting(ctx.workspaceId, PROFILE_CLAIMS_SETTING), {});
  const at = written.at ?? new Date().toISOString();
  return [...instrumentClaims(answers, at), ...(written.claims ?? [])];
}

/** The report by section as the person sees it (everything, with their own choices and judgements), and the card items. */
export function loadProfileReport(ctx: AccessContext): ProfileReportState {
  const store = getStore();
  const answers = readInstrumentAnswers(store.getSetting(ctx.workspaceId, PROFILE_INSTRUMENTS_SETTING));
  return {
    sections: reportSections(allClaims(ctx), readPrivacyChoices(store.getSetting(ctx.workspaceId, REPORT_PRIVACY_SETTING)), "private",
      readClaimStatus(store.getSetting(ctx.workspaceId, PROFILE_CLAIM_STATUS_SETTING))),
    items: PROFILE_ITEMS.filter((item) => answers[item.id]).map((item) => ({ id: item.id, instrument: item.instrument, text: item.text, anchors: item.anchors,
      answer: { by: answers[item.id]!.by, ...(answers[item.id]!.score ? { score: answers[item.id]!.score } : {}) } }))
  };
}

const event = (ctx: AccessContext, type: string, payload: Record<string, unknown>) => {
  const store = getStore();
  const at = new Date().toISOString();
  store.appendEvent({ ownerId: store.getWorkspaceOwnerId(ctx.workspaceId) ?? ctx.principalId, workspaceId: ctx.workspaceId,
    idempotencyKey: `${type}:${JSON.stringify(payload)}:${at}`, type, entityId: ctx.workspaceId, payload });
};

export type ProfileReportChange =
  | { action: "privacy"; section: ReportSection; level: PrivacyLevel }
  | { action: "claim_privacy"; claimId: string; level: PrivacyLevel | null }
  | { action: "judge"; claimId: string; status: ClaimStatus | null }
  | { action: "item"; itemId: string; score: number | null };

/** Reads a change from a request body, or null when it is not one. */
export function readProfileReportChange(body: unknown): ProfileReportChange | null {
  const value = body as Record<string, unknown> | null;
  const level = (raw: unknown) => (PRIVACY_LEVELS as readonly unknown[]).includes(raw) ? raw as PrivacyLevel : undefined;
  if (!value || typeof value !== "object") return null;
  if (value.action === "privacy" && (REPORT_SECTIONS as readonly unknown[]).includes(value.section) && level(value.level))
    return { action: "privacy", section: value.section as ReportSection, level: level(value.level)! };
  if (value.action === "claim_privacy" && typeof value.claimId === "string" && (value.level === null || level(value.level)))
    return { action: "claim_privacy", claimId: value.claimId, level: value.level === null ? null : level(value.level)! };
  if (value.action === "judge" && typeof value.claimId === "string" && (value.status === null || value.status === "confirmed" || value.status === "rejected"))
    return { action: "judge", claimId: value.claimId, status: value.status as ClaimStatus | null };
  if (value.action === "item" && typeof value.itemId === "string" && (value.score === null || (Number.isInteger(value.score) && Number(value.score) >= 1 && Number(value.score) <= 5)))
    return { action: "item", itemId: value.itemId, score: value.score as number | null };
  return null;
}

/**
 * Applies the person's change: a section's or one claim's level (docs/profile-and-agent-kit.md §七), 符合/不符合 on a claim (a rejected
 * claim is kept, shown to the person, never exported and never written again), or a card item answered again by a tap (null = skipped).
 */
export function changeProfileReport(ctx: AccessContext, change: ProfileReportChange): { ok: boolean; code?: string } {
  const store = getStore();
  const ws = ctx.workspaceId;
  if (change.action === "privacy" || change.action === "claim_privacy") {
    const choices = readPrivacyChoices(store.getSetting(ws, REPORT_PRIVACY_SETTING));
    if (change.action === "privacy") choices.sections[change.section] = change.level;
    else if (change.level) choices.claims[change.claimId] = change.level; else delete choices.claims[change.claimId];
    store.setSetting(ws, REPORT_PRIVACY_SETTING, JSON.stringify(choices));
    event(ctx, "profile.privacy_set", change);
    return { ok: true };
  }
  if (change.action === "judge") {
    const claim = allClaims(ctx).find((item) => item.id === change.claimId);
    if (!claim) return { ok: false, code: "PROFILE_CLAIM_UNKNOWN" };
    const status = readClaimStatus(store.getSetting(ws, PROFILE_CLAIM_STATUS_SETTING));
    if (change.status) status[claim.id] = { status: change.status, at: new Date().toISOString(), statement: claim.statement }; else delete status[claim.id];
    store.setSetting(ws, PROFILE_CLAIM_STATUS_SETTING, JSON.stringify(status));
    event(ctx, "profile.claim_judged", { claimId: claim.id, section: claim.section, status: change.status });
    return { ok: true };
  }
  if (!PROFILE_ITEMS.some((item) => item.id === change.itemId)) return { ok: false, code: "PROFILE_ITEM_UNKNOWN" };
  const answers = readInstrumentAnswers(store.getSetting(ws, PROFILE_INSTRUMENTS_SETTING));
  // The person's own correction replaces whatever was recorded, a mapping included: it is set, not merged.
  answers[change.itemId] = change.score === null ? { itemId: change.itemId, by: "skipped", at: new Date().toISOString() }
    : { itemId: change.itemId, score: change.score, by: "tapped", at: new Date().toISOString() };
  store.setSetting(ws, PROFILE_INSTRUMENTS_SETTING, JSON.stringify(answers));
  event(ctx, "profile.item_answered", { itemId: change.itemId, score: change.score, via: "portrait" });
  return { ok: true };
}
