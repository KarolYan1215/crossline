import "server-only";
import { randomUUID } from "node:crypto";
import { expandRecurring, requiredApproval, type AccessContext, type DateCandidate, type RecurringMeeting } from "@crossline/core";
import { ensureSeeded, getStore, type PersistedScheduleBlock } from "./crossline";

/**
 * Dates read out of the person's own files, waiting for their confirmation.
 *
 * A batch is two ledger events: `dates.extracted` (what was read, with the quote for each item) and, once the
 * person answers, `dates.decided`. A batch with no decision is pending. Nothing reaches the calendar until it
 * is decided, and everything that does carries the block id `import:<batch>:<item>`, which calendar sync
 * leaves alone because it only ever rewrites `graph_calendar:` blocks.
 */
export type PendingItem = {
  id: string; kind: "date" | "recurring"; title: string; project: string; confidence: "high" | "medium" | "low";
  when: string; quote: string; sourceRef: string; note: string; checked: boolean; blocks: number;
};
export type PendingBatch = { id: string; documentCount: number; items: PendingItem[]; questions: string[]; dropped: number };

type ExtractedPayload = { documentIds?: string[]; dates?: DateCandidate[]; recurring?: RecurringMeeting[]; questions?: string[]; dropped?: unknown[] };

const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];

/** A class that already met is history, not a plan: only today and later reach the calendar. */
const upcomingDays = (meeting: Parameters<typeof expandRecurring>[0], today: string) => expandRecurring(meeting).filter((day) => day >= today);
const todayIso = () => (process.env.CROSSLINE_FIXED_NOW ? new Date(process.env.CROSSLINE_FIXED_NOW) : new Date()).toISOString().slice(0, 10);

export function loadPendingDateBatch(ctx: AccessContext): PendingBatch | null {
  const store = getStore();
  const decided = new Set(store.listEvents(ctx.workspaceId, { type: "dates.decided" }).map((event) => event.entityId));
  const batch = [...store.listEvents(ctx.workspaceId, { type: "dates.extracted" })].reverse()
    .find((event) => !decided.has(event.entityId));
  if (!batch) return null;
  const payload = batch.payload as ExtractedPayload;
  const dates = (payload.dates ?? []).map((item): PendingItem => ({
    id: item.id, kind: "date", title: item.title, project: item.project, confidence: item.confidence,
    when: `${item.date}${item.startTime ? ` ${item.startTime}${item.endTime ? `–${item.endTime}` : ""}` : ""}`,
    quote: item.quote, sourceRef: item.sourceRef, note: item.note, checked: item.confidence !== "low", blocks: item.startTime ? 1 : 0
  }));
  const recurring = (payload.recurring ?? []).map((item): PendingItem => {
    const days = upcomingDays(item, todayIso());
    return { id: item.id, kind: "recurring", title: item.title, project: item.project, confidence: item.confidence,
      when: `每周${item.weekdays.map((day) => WEEKDAY[day]).join("、")} ${item.startTime}–${item.endTime}，${item.from} 至 ${item.to}（还剩 ${days.length} 次）`,
      quote: item.quote, sourceRef: item.sourceRef, note: item.location, checked: item.confidence !== "low", blocks: days.length };
  });
  return { id: batch.entityId, documentCount: payload.documentIds?.length ?? 0, items: [...recurring, ...dates], questions: payload.questions ?? [], dropped: payload.dropped?.length ?? 0 };
}

/** Writes the confirmed items and records the decision. Returns how many calendar blocks were added. */
export function decideDateBatch(ctx: AccessContext, batchId: string, includedIds: string[]): { ok: true; blocks: number; facts: number } | { ok: false; code: string } {
  // Listed in the approval table so the policy lives in one place; the confirmation itself is the person's click.
  if (requiredApproval("import_dated_items") !== "batch") return { ok: false, code: "APPROVAL_POLICY_CHANGED" };
  const store = getStore();
  const event = store.listEvents(ctx.workspaceId, { type: "dates.extracted", entityId: batchId })[0];
  if (!event) return { ok: false, code: "DATE_BATCH_NOT_FOUND" };
  if (store.listEvents(ctx.workspaceId, { type: "dates.decided", entityId: batchId }).length) return { ok: false, code: "DATE_BATCH_ALREADY_DECIDED" };
  ensureSeeded(ctx);

  const payload = event.payload as ExtractedPayload;
  const included = new Set(includedIds);
  const blocks: PersistedScheduleBlock[] = [];
  const projectIdentity = new Map(store.listProjects(ctx.workspaceId, { includeArchived: true }).map((project) => [project.id, project.identityId]));
  let facts = 0;
  const now = new Date().toISOString();

  for (const item of (payload.dates ?? []).filter((candidate) => included.has(candidate.id))) {
    if (item.startTime) {
      blocks.push({ id: `import:${batchId}:${item.id}`, lane: "human", title: item.title, day: item.date, start: item.startTime,
        end: item.endTime || item.startTime, source: "文件导入", readOnly: true });
    }
    // Untimed dates are deadlines and exam days, not blocks of time. They are kept as profile facts so the
    // milestone design can start from them instead of from nothing.
    store.upsertProfileFact({ workspaceId: ctx.workspaceId, identityId: projectIdentity.get(item.project) ?? "research", projectId: item.project,
      slot: `date_${item.date.replaceAll("-", "")}_${item.kind}`, value: `${item.date} ${item.title}`, status: "confirmed",
      sourceRef: item.sourceRef, sourceQuote: item.quote, updatedAt: now });
    facts += 1;
  }
  for (const meeting of (payload.recurring ?? []).filter((candidate) => included.has(candidate.id))) {
    for (const day of upcomingDays(meeting, todayIso())) {
      blocks.push({ id: `import:${batchId}:${meeting.id}:${day}`, lane: "human", title: meeting.title, day,
        start: meeting.startTime, end: meeting.endTime, source: "文件导入", readOnly: true });
    }
  }

  const plan = store.listPlanVersions(ctx.workspaceId)[0];
  if (plan && blocks.length) {
    const existing = ((plan.payload as { blocks?: PersistedScheduleBlock[] }).blocks ?? []);
    const known = new Set(existing.map((block) => block.id));
    store.savePlanVersion({ ...plan, payload: { ...(plan.payload as object), blocks: [...existing, ...blocks.filter((block) => !known.has(block.id))] } });
  }
  store.appendEvent({
    ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `dates:decided:${batchId}:${randomUUID()}`,
    type: "dates.decided", entityId: batchId,
    payload: { included: [...included], excluded: [...(payload.dates ?? []), ...(payload.recurring ?? [])].map((item) => item.id).filter((id) => !included.has(id)), blocks: blocks.length }
  });
  return { ok: true, blocks: blocks.length, facts };
}
