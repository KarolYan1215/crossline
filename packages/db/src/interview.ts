import { interviewChecklist, PROFILE_CONFIRMED, portraitFingerprint, type ChecklistItem, type ProfileModel } from "@crossline/core";
import type { CrosslineStore } from "./index";

type DateRow = { id: string; project?: string; kind?: string; sourceRef?: string };

/**
 * The interview's completion list (`interviewChecklist`) built from what the ledger holds: the lines and their goals (given by the caller,
 * who knows the installed packs), the interview's line descriptions and working profile, the facts and projects, every dated item read
 * from files or replies (pending or confirmed; an excluded one does not count), the availability, and the person's confirmation of the
 * portrait — which holds only while the portrait is the one they confirmed.
 */
export function interviewChecklistFor(store: CrosslineStore, workspaceId: string,
  lines: Array<{ id: string; label: string; hard: boolean; goals: string[] }>, extras: { unfiledFiles: number | null }): ChecklistItem[] {
  const json = <T,>(key: string, fallback: T): T => { try { return JSON.parse(store.getSetting(workspaceId, key) ?? "null") ?? fallback; } catch { return fallback; } };
  const profiles = json<Record<string, { description?: string; goalCandidates?: string[] }>>("lines.profiles", {});
  const profile = json<Partial<ProfileModel>>("profile.model", {});
  const decided = new Map(store.listEvents(workspaceId, { type: "dates.decided" }).map((event) => [event.entityId,
    event.payload as { superseded?: boolean; included?: string[] }]));
  const dates = store.listEvents(workspaceId, { type: "dates.extracted" }).flatMap((event) => {
    const decision = decided.get(event.entityId);
    if (decision?.superseded) return [];
    const payload = event.payload as { dates?: DateRow[]; recurring?: DateRow[] };
    const keep = (row: DateRow) => !decision || (decision.included ?? []).includes(row.id);
    return [...(payload.dates ?? []).filter(keep).map((row) => ({ row, recurring: false })), ...(payload.recurring ?? []).filter(keep).map((row) => ({ row, recurring: true }))]
      .map(({ row, recurring }) => ({ project: row.project ?? "", kind: row.kind ?? (recurring ? "class" : "other"), recurring, pending: !decision, sourceRef: row.sourceRef ?? "" }));
  });
  const confirmed = json<{ fingerprint?: string } | null>(PROFILE_CONFIRMED, null);
  return interviewChecklist({
    lines,
    descriptions: Object.fromEntries(Object.entries(profiles).map(([id, value]) => [id, { description: value.description ?? "", candidates: (value.goalCandidates ?? []).length }])),
    profile,
    facts: store.listProfileFacts(workspaceId).map(({ identityId, projectId, slot, status, sourceRef }) => ({ identityId, projectId, slot, status, sourceRef })),
    projects: store.listProjects(workspaceId).map(({ id, identityId, name }) => ({ id, identityId, name })),
    dates,
    availability: Boolean(store.getSetting(workspaceId, "schedule.availability.proposed") || store.getSetting(workspaceId, "schedule.availability")),
    unfiledFiles: extras.unfiledFiles,
    portraitConfirmed: Boolean(confirmed?.fingerprint && confirmed.fingerprint === portraitFingerprint(profile))
  });
}
