import { randomUUID } from "node:crypto";
import {
  AVAILABILITY_PROPOSED_SETTING, AVAILABILITY_SETTING, DEEP_SECTIONS, EMPTY_PROFILE_MODEL, PROFILE_SECTIONS, PROFILE_SECTIONS_SETTING, mergeProfileSections,
  type ProfileSection, type SectionRecord, GOAL_EDITS_SETTING, SECTION_EMPTY_RUNS_MAX, sectionClosed, citationWarnings, duplicateAttributes, mergeDateExtractions,
  resolveAvailability, sanitizeDateExtraction, withContentIds, withoutDecidedDates, withoutOffHours,
  type DateExtraction, type OnboardingExtraction, type PendingGoalEdit, type ProfileModel, type StoredLineProfile
} from "@crossline/core";
import type { CrosslineStore } from "@crossline/db";

/**
 * What the interview writes to the ledger (2026-10-19): shared by the extraction run, which is now the only writer of facts, projects,
 * dates, line attributes, hours and the portrait. The dialogue writes only the round and the answers the person gave to the app's own
 * questions (`answeredGapFacts`).
 */

/** The portrait so far (`profile.model`), kept in settings so every page and a rebuilt thread read the same. */
export function readProfileModel(store: CrosslineStore, workspaceId: string): ProfileModel {
  try { return { ...EMPTY_PROFILE_MODEL, ...(JSON.parse(store.getSetting(workspaceId, "profile.model") ?? "{}") as Partial<ProfileModel>) }; }
  catch { return EMPTY_PROFILE_MODEL; }
}

export function personTimeZone(store: CrosslineStore, workspaceId: string): string {
  try {
    const raw = store.getSetting(workspaceId, "schedule.preferences");
    const zone = raw ? (JSON.parse(raw) as { timeZone?: unknown }).timeZone : undefined;
    if (typeof zone === "string" && zone) return zone;
  } catch { /* an unreadable setting falls back to the default zone */ }
  return "America/Chicago";
}

export type PersistContext = {
  sessionId: string; ownerId: string;
  /** The files this run read, for the date batch's record. */
  documentIds: string[];
  /** Every reply and file text by id, the date checks' sources. */
  sources: Record<string, string>;
  today: string;
  /** Every file was read again: its dates replace the batch nobody answered. */
  reread: boolean;
  /** The portrait's sections this run was to rewrite whole because their stage is over, and whether it was to write the synthesis. */
  profileTask?: { finalize: ProfileSection[]; synthesize: boolean };
};

export function readSectionRecords(store: CrosslineStore, workspaceId: string): Partial<Record<ProfileSection, SectionRecord>> {
  try { return JSON.parse(store.getSetting(workspaceId, PROFILE_SECTIONS_SETTING) ?? "{}") as Partial<Record<ProfileSection, SectionRecord>>; } catch { return {}; }
}

/** Writes what a validated extraction learned. Facts the person already confirmed are protected by the store. */
export function persistExtraction(store: CrosslineStore, workspaceId: string, extraction: OnboardingExtraction, context: PersistContext): void {
  const now = new Date().toISOString();
  const { sessionId, ownerId } = context;
  // The portrait by section (P3): the deep sections whenever new material bears on them, the synthesis only when the run was asked for it.
  // A line's own interview adds to the facts but does not touch the person's portrait.
  if (!sessionId.startsWith("line-") && context.profileTask) {
    const task = context.profileTask;
    const allowed = new Set<ProfileSection>([...DEEP_SECTIONS, ...(task.synthesize ? ["synthesis" as const] : [])]);
    const sections = extraction.profileSections ?? {};
    if (PROFILE_SECTIONS.some((section) => sections[section] && allowed.has(section)))
      store.setSetting(workspaceId, "profile.model", JSON.stringify(mergeProfileSections(readProfileModel(store, workspaceId), sections, allowed)));
    // What each section rests on, and whether its stage is over. A section asked to be finalized is final once written, or when it already
    // has what it rests on; one that comes back empty stays open to be asked again, and is closed as it stands only after
    // `SECTION_EMPTY_RUNS_MAX` empty runs (one empty answer used to close a section with nothing in it, and the portrait stayed blank).
    const records = readSectionRecords(store, workspaceId);
    for (const section of PROFILE_SECTIONS) {
      const written = Boolean(sections[section] && allowed.has(section));
      const previous = records[section];
      const asked = task.finalize.includes(section);
      if (!written && !asked) continue;
      const emptyRuns = !written && asked && !previous?.sentences?.length ? (previous?.emptyRuns ?? 0) + 1 : 0;
      const final = (asked && (written || Boolean(previous?.sentences?.length) || emptyRuns >= SECTION_EMPTY_RUNS_MAX))
        || (section === "synthesis" && written) || sectionClosed(previous);
      records[section] = { sentences: written ? sections[section]!.sentences ?? [] : previous?.sentences ?? [], final, at: now, ...(emptyRuns ? { emptyRuns } : {}) };
    }
    store.setSetting(workspaceId, PROFILE_SECTIONS_SETTING, JSON.stringify(records));
  }
  // Each line's personal description and attribute candidates, kept by line so a later run or a line's own interview refines one line
  // only. An empty candidate list keeps those on record; new ones replace them, except the attributes split from the adopted goal.
  if (extraction.lineProfiles?.length) {
    let current: Record<string, StoredLineProfile> = {};
    try { current = JSON.parse(store.getSetting(workspaceId, "lines.profiles") ?? "{}") as Record<string, StoredLineProfile>; } catch { /* rebuilt below */ }
    for (const line of extraction.lineProfiles) {
      const previous = current[line.lineId] ?? {};
      const fresh = line.attributeCandidates ?? [];
      const fromGoal = (previous.attributes ?? []).filter((item) => item.sourceRef === "goal"
        && !duplicateAttributes([...fresh.map((other) => other.text), item.text]).some((pair) => pair.includes(item.text)));
      current[line.lineId] = fresh.length
        ? { description: line.description || previous.description || "", attributes: [...fresh, ...fromGoal] }
        : { ...previous, description: line.description || previous.description || "" };
    }
    store.setSetting(workspaceId, "lines.profiles", JSON.stringify(current));
  }
  // A goal change the person asked for waits for their click on the line's card; a newer request for the same line replaces it.
  if (extraction.goalEdits?.length) {
    let edits: Record<string, PendingGoalEdit> = {};
    try { edits = JSON.parse(store.getSetting(workspaceId, GOAL_EDITS_SETTING) ?? "{}") as Record<string, PendingGoalEdit>; } catch { /* rebuilt below */ }
    // In the order the person said them: a change they worded themselves is not reordered.
    for (const edit of extraction.goalEdits) edits[edit.lineId] = { parts: edit.parts.map((part) => part.text), sourceRef: edit.sourceRef, at: now };
    store.setSetting(workspaceId, GOAL_EDITS_SETTING, JSON.stringify(edits));
  }
  // Available hours worked out from what the person said: a proposal, confirmed (or not) on the plan page.
  if (extraction.availability?.windows.length) store.setSetting(workspaceId, AVAILABILITY_PROPOSED_SETTING,
    JSON.stringify({ ...extraction.availability, at: now }));
  for (const project of extraction.projectsDetected) {
    const existing = store.listProjects(workspaceId, { includeArchived: true }).find((item) => item.id === project.id);
    store.saveProject({ id: project.id, ownerId, workspaceId, identityId: project.identityId, name: project.name,
      status: existing?.status ?? "active", summary: project.summary || existing?.summary || "",
      createdAt: existing?.createdAt ?? now, updatedAt: now });
  }
  for (const update of extraction.slotUpdates) {
    store.upsertProfileFact({ workspaceId, identityId: update.identityId, projectId: update.projectId, slot: update.slot,
      value: update.value, status: update.status, sourceRef: update.sourceRef, sourceQuote: update.sourceQuote, sourceSentences: update.sentences ?? [], updatedAt: now });
  }
  // A connection between lines is a guess until the person confirms it, so it is kept as an inferred fact
  // keyed by its two ends and kind, not as a milestone relation (there may not be milestones yet).
  for (const candidate of extraction.flywheelCandidates) {
    store.upsertProfileFact({ workspaceId, identityId: candidate.fromIdentityId, projectId: "",
      slot: `flywheel_${candidate.toIdentityId}_${candidate.kind}`, value: candidate.explanation, status: "inferred",
      sourceRef: candidate.evidenceRefs[0] ?? "inference", sourceQuote: "", sourceSentences: candidate.sentences ?? [], updatedAt: now });
  }
  // Numbers in a confirmed fact that its sentences do not state: recorded to measure, never refused (people write 「九点半」).
  const warnings = citationWarnings(extraction);
  if (warnings.length) store.appendEvent({ ownerId, workspaceId, idempotencyKey: `onboarding:citation-warned:${sessionId}:${randomUUID()}`,
    type: "onboarding.citation_warned", entityId: sessionId, payload: { facts: warnings } });
  persistFileDates(store, workspaceId, extraction, context);
}

/**
 * The dates read out of the files (and fixed weekly arrangements from the replies) become one batch for the person to confirm. Each is
 * checked against its source's own text; what cannot be verified is dropped and counted, and a newer batch retires an older one nobody
 * answered, so re-reading the files never leaves two batches asking about the same dates.
 */
export function persistFileDates(store: CrosslineStore, workspaceId: string, extraction: Pick<OnboardingExtraction, "fileDates" | "availability">,
  context: Pick<PersistContext, "ownerId" | "documentIds" | "sources" | "today" | "reread">): void {
  const { ownerId, documentIds, sources, today, reread } = context;
  const read = extraction.fileDates;
  if (!read || (!read.dates.length && !read.recurring.length && !read.questions.length && !(read.undated ?? []).length)) return;
  let checked;
  try { checked = sanitizeDateExtraction({ dates: read.dates, recurring: read.recurring, questions: read.questions, undated: read.undated ?? [] }, { sources, today }); }
  catch { return; /* nothing it read could be verified: no batch, and the interview itself is not failed over it */ }
  // Meals and sleep are what the available hours already leave out: only filtered against hours the person stated (this run's, the
  // interview's earlier proposal, or what they painted), never against the generic default.
  const stated = extraction.availability?.windows.length ? extraction.availability.windows : (() => {
    const resolved = resolveAvailability({ saved: store.getSetting(workspaceId, AVAILABILITY_SETTING),
      proposed: store.getSetting(workspaceId, AVAILABILITY_PROPOSED_SETTING), facts: [] });
    return resolved.source === "saved" || resolved.source === "interview" ? resolved.windows : undefined;
  })();
  // What the person already confirmed or turned down in an earlier batch is not offered again.
  const decidedEvents = store.listEvents(workspaceId, { type: "dates.decided" })
    .map((event) => ({ id: event.entityId, payload: event.payload as { superseded?: boolean; included?: string[]; excluded?: string[] } }))
    .filter((event) => !event.payload.superseded);
  const extracted = new Map(store.listEvents(workspaceId, { type: "dates.extracted" }).map((event) => [event.entityId, event.payload as unknown as DateExtraction]));
  const decided = decidedEvents.flatMap((event) => {
    const batch = extracted.get(event.id);
    const ids = new Set([...(event.payload.included ?? []), ...(event.payload.excluded ?? [])]);
    return batch ? [...batch.dates, ...batch.recurring].filter((item) => ids.has(item.id)) : [];
  });
  // Ids from what each item is: a fresh run numbers from d1 again, and its d1 must not replace an earlier run's.
  const unseen = withoutDecidedDates(withContentIds(checked.extraction), decided);
  const fresh = { ...unseen, recurring: stated ? withoutOffHours(unseen.recurring, stated,
    store.listProjects(workspaceId, { includeArchived: true })) : unseen.recurring };
  if (!fresh.dates.length && !fresh.recurring.length && !fresh.questions.length && !(fresh.undated ?? []).length) return;
  const answered = new Set(store.listEvents(workspaceId, { type: "dates.decided" }).map((event) => event.entityId));
  const open = store.listEvents(workspaceId, { type: "dates.extracted" }).filter((event) => !answered.has(event.entityId));
  // A re-read replaces what nobody answered; any other run adds to it, so an earlier batch's dates are never lost to a later run.
  const carried = reread ? [] : open.map((event) => event.payload as unknown as DateExtraction & { documentIds?: string[] });
  const merged = mergeDateExtractions(carried, fresh);
  const batchId = randomUUID();
  for (const old of open.map((event) => event.entityId)) {
    store.appendEvent({ ownerId, workspaceId, idempotencyKey: `dates:superseded:${old}`, type: "dates.decided", entityId: old,
      payload: { superseded: true, by: batchId, merged: !reread, included: [], excluded: [], blocks: 0 } });
  }
  store.appendEvent({ ownerId, workspaceId, idempotencyKey: `dates:extracted:${batchId}`, type: "dates.extracted", entityId: batchId,
    payload: { documentIds: [...new Set([...carried.flatMap((batch) => batch.documentIds ?? []), ...documentIds])], dates: merged.dates,
      recurring: merged.recurring, questions: merged.questions, undated: merged.undated ?? [], past: merged.past ?? [], dropped: checked.dropped } });
}
