import { randomUUID } from "node:crypto";
import {
  AVAILABILITY_PROPOSED_SETTING, AVAILABILITY_SETTING, INTERVIEW_SETTINGS, mergeInterviewSettings, readInterviewSettings, DEEP_SECTIONS, EMPTY_PROFILE_MODEL, PROFILE_SECTIONS, PROFILE_SECTIONS_SETTING, mergeProfileSections,
  type ProfileSection, type SectionRecord, GOAL_EDITS_SETTING, SECTION_EMPTY_RUNS_MAX, sectionClosed, citationWarnings, duplicateAttributes, mergeDateExtractions,
  resolveAvailability, sanitizeDateExtraction, withContentIds, withoutDecidedDates, withoutOffHours,
  type DateDrop, type DateExtraction, type OnboardingExtraction, type PendingGoalEdit, type ProfileModel, type StoredLineProfile,
  PROFILE_INSTRUMENTS_SETTING, mergeInstrumentAnswers, mergeProfileInsights, readInstrumentAnswers, applyPointChanges, readPoints, numberNewHypotheses
} from "@crossline/core";
import type { CrosslineStore } from "@crossline/db";
import { identityLines } from "./lines";

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
  // The same default the web uses (`effectiveSchedulePreferences`): the server's configured zone first. The 2026-11-12 replay 4 had no
  // device zone, read America/Chicago, and researched US internships (the Federal Reserve) for a student in China.
  return process.env.CROSSLINE_TIME_ZONE?.trim() || "America/Chicago";
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
  /**
   * The points rules (2026-11-12): a section is written only when its stage is over (or the synthesis when owed); what the replies settle
   * until then goes into the points ledger (`pointChanges`).
   */
  rules?: boolean;
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
    // Under the points rules a stage's view is written once, when it is over: not reworded every run while the stage is under way.
    const allowed = new Set<ProfileSection>([...(context.rules ? task.finalize : DEEP_SECTIONS), ...(task.synthesize ? ["synthesis" as const] : [])]);
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
  // The points ledger (the points rules): added, revised and retracted points, each resting on the person's words; a change that does not
  // hold is left out (`applyPointChanges`). A line's own interview never touches it.
  if (context.rules && !sessionId.startsWith("line-") && extraction.pointChanges?.length) {
    const profile = readProfileModel(store, workspaceId);
    const { points } = applyPointChanges(readPoints(profile.points), extraction.pointChanges, now);
    store.setSetting(workspaceId, "profile.model", JSON.stringify({ ...profile, points }));
  }
  // The hypothesis log, career directions and dimension notes (contract B): the run sends only what is new or changed, merged by id
  // (`mergeProfileInsights`, 2026-11-12); what it did not name stays. The person's 准/不准 on a hypothesis stays with its id. Written by
  // a lane of its own (`EXTRACT_LANE_KEYS.insights`), which owes no portrait section; a line's own interview never touches them.
  const { hypotheses, careers, dimensions, dropCareers } = extraction;
  if (!sessionId.startsWith("line-") && (hypotheses?.length || careers?.length || dimensions?.length || dropCareers?.length)) {
    const profile = readProfileModel(store, workspaceId);
    // New hypotheses take the log's own numbering (`h<n>`), never a card's (`c<seq>`).
    const numbered = numberNewHypotheses(profile.hypotheses ?? [], hypotheses ?? [], careers ?? []);
    store.setSetting(workspaceId, "profile.model", JSON.stringify({ ...profile,
      ...mergeProfileInsights(profile, { ...(hypotheses ? { hypotheses: numbered.hypotheses } : {}), ...(careers ? { careers: numbered.careers } : {}), ...(dimensions ? { dimensions } : {}),
        ...(dropCareers ? { dropCareers } : {}) }, now) }));
  }
  // Card items the person answered in words: scored as `mapped` only for items still waiting to be read (a tap is never replaced).
  if (!sessionId.startsWith("line-") && extraction.itemScores?.length) {
    const kept = readInstrumentAnswers(store.getSetting(workspaceId, PROFILE_INSTRUMENTS_SETTING));
    const mapped = extraction.itemScores.filter((item) => kept[item.itemId]?.by === "pending").map((item) => ({ itemId: item.itemId, score: item.score,
      by: "mapped" as const, confidence: Math.max(0, Math.min(1, item.confidence)), refs: item.sentences ?? [], at: now }));
    if (mapped.length) store.setSetting(workspaceId, PROFILE_INSTRUMENTS_SETTING, JSON.stringify(mergeInstrumentAnswers(kept, mapped)));
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
  // Settings the person stated: kept for them to apply in the start confirmation (or 待决事项), never applied here.
  if (extraction.settings?.length) store.setSetting(workspaceId, INTERVIEW_SETTINGS, JSON.stringify(mergeInterviewSettings(
    readInterviewSettings(store.getSetting(workspaceId, INTERVIEW_SETTINGS)), extraction.settings.map((item) => ({ ...item, quote: item.sourceQuote })), now,
    { milestones: new Set(), tasks: new Set(), lines: new Set() })));
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
  context: Pick<PersistContext, "ownerId" | "documentIds" | "sources" | "today" | "reread"> & { sessionId?: string }): void {
  const { ownerId, documentIds, sources, today, reread } = context;
  const read = extraction.fileDates;
  if (!read || (!read.dates.length && !read.recurring.length && !read.questions.length && !(read.undated ?? []).length)) return;
  let checked;
  // Nothing verified is still recorded (W-228): the drops are what the person and the next round of the interview are told, where a
  // `catch { return }` here once lost a whole reply's dates without a word.
  try { checked = sanitizeDateExtraction({ dates: read.dates, recurring: read.recurring, questions: read.questions, undated: read.undated ?? [] }, { sources, today }, { allowEmpty: true }); }
  catch (error) {
    recordDateDrops(store, workspaceId, ownerId, context.sessionId, [...read.dates, ...read.recurring].map((item) =>
      ({ id: item.id, title: item.title, reason: (error as Error).message, code: (error as Error).message })));
    return;
  }
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
  // Every line's own arrangements are kept, not only a hard line's (W-228: 健康's weekly run was dropped as if it were a meal).
  const fresh = { ...unseen, recurring: stated ? withoutOffHours(unseen.recurring, stated,
    store.listProjects(workspaceId, { includeArchived: true }),
    identityLines(store, workspaceId).map((line) => ({ id: line.id, label: line.label }))) : unseen.recurring };
  const offHours = unseen.recurring.filter((item) => !fresh.recurring.includes(item))
    .map((item): DateDrop => ({ id: item.id, title: item.title, reason: "OFF_HOURS", code: "OFF_HOURS" }));
  const dropped = [...checked.dropped, ...offHours];
  recordDateDrops(store, workspaceId, ownerId, context.sessionId, dropped);
  if (!fresh.dates.length && !fresh.recurring.length && !fresh.questions.length && !(fresh.undated ?? []).length) return;
  const answered = new Set(store.listEvents(workspaceId, { type: "dates.decided" }).map((event) => event.entityId));
  const open = store.listEvents(workspaceId, { type: "dates.extracted" }).filter((event) => !answered.has(event.entityId));
  // A re-read replaces what nobody answered; any other run adds to it, so an earlier batch's dates are never lost to a later run.
  const carried = reread ? [] : open.map((event) => event.payload as unknown as DateExtraction & { documentIds?: string[]; dropped?: DateDrop[] });
  const merged = mergeDateExtractions(carried, fresh);
  const batchId = randomUUID();
  for (const old of open.map((event) => event.entityId)) {
    store.appendEvent({ ownerId, workspaceId, idempotencyKey: `dates:superseded:${old}`, type: "dates.decided", entityId: old,
      payload: { superseded: true, by: batchId, merged: !reread, included: [], excluded: [], blocks: 0 } });
  }
  store.appendEvent({ ownerId, workspaceId, idempotencyKey: `dates:extracted:${batchId}`, type: "dates.extracted", entityId: batchId,
    payload: { documentIds: [...new Set([...carried.flatMap((batch) => batch.documentIds ?? []), ...documentIds])], dates: merged.dates,
      recurring: merged.recurring, questions: merged.questions, undated: merged.undated ?? [], past: merged.past ?? [],
      // What the batches it replaces could not record stays listed with it (only the newest list used to be kept).
      dropped: [...new Map([...carried.flatMap((batch) => batch.dropped ?? []), ...dropped].map((item) => [item.title, item])).values()] } });
}

/** The event the drops of one reading are kept in: the date list shows them with their reasons, and the interview asks about them again. */
export const DATES_UNRECORDED_EVENT = "dates.unrecorded";
/** The same for facts, projects and hours keeping an extraction's answer left out (`prunedOnboardingItems`). */
export const ONBOARDING_UNRECORDED_EVENT = "onboarding.unrecorded";

/**
 * What a reading could not record, said (W-228). A duplicate is the same item twice, and an off-hours arrangement a meal or a commute the
 * hours already leave out; both are listed for the person but not asked about again.
 */
function recordDateDrops(store: CrosslineStore, workspaceId: string, ownerId: string, sessionId: string | undefined, dropped: DateDrop[]): void {
  if (!dropped.length) return;
  store.appendEvent({ ownerId, workspaceId, idempotencyKey: `dates:unrecorded:${randomUUID()}`, type: DATES_UNRECORDED_EVENT, entityId: sessionId ?? "",
    payload: { dropped: dropped.map(({ title, code }) => ({ title, code })) } });
}
