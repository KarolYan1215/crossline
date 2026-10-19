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
export type PendingBatch = { id: string; documentCount: number; items: PendingItem[]; questions: string[]; dropped: string[] };

type ExtractedPayload = { documentIds?: string[]; dates?: DateCandidate[]; recurring?: RecurringMeeting[]; questions?: string[]; dropped?: Array<{ title?: string }> };

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
  // Batches read before past dates were set apart still hold them: what is over is not offered (it is history, not a plan).
  const today = todayIso();
  const dates = (payload.dates ?? []).filter((item) => item.date >= today).map((item): PendingItem => ({
    id: item.id, kind: "date", title: item.title, project: item.project, confidence: item.confidence,
    when: `${item.date}${item.startTime ? ` ${item.startTime}${item.endTime ? `–${item.endTime}` : ""}` : ""}`,
    quote: item.quote, sourceRef: item.sourceRef, note: item.note, checked: item.confidence !== "low", blocks: item.startTime ? 1 : 0
  }));
  const recurring = (payload.recurring ?? []).filter((item) => item.to >= today).map((item): PendingItem => {
    const days = upcomingDays(item, todayIso());
    return { id: item.id, kind: "recurring", title: item.title, project: item.project, confidence: item.confidence,
      when: `每周${item.weekdays.map((day) => WEEKDAY[day]).join("、")} ${item.startTime}–${item.endTime}，${item.from} 至 ${item.to}（还剩 ${days.length} 次）`,
      quote: item.quote, sourceRef: item.sourceRef, note: item.location, checked: item.confidence !== "low", blocks: days.length };
  });
  return { id: batch.entityId, documentCount: payload.documentIds?.length ?? 0, items: [...recurring, ...dates], questions: payload.questions ?? [],
    // The titles, not just a count: 「另有 6 项…已丢弃」 left the person no way to tell what to add by hand (W-10).
    dropped: (payload.dropped ?? []).map((item) => (typeof item?.title === "string" && item.title.trim() ? item.title.trim() : "（未命名的一项）")) };
}

/** Writes the confirmed items and records the decision. Returns how many calendar blocks were added. */
export function decideDateBatch(ctx: AccessContext, batchId: string, includedIds: string[], by: "person" | "system" = "person"):
  { ok: true; blocks: number; facts: number } | { ok: false; code: string } {
  // Listed in the approval table so the policy lives in one place.
  if (requiredApproval("import_dated_items") !== "automatic") return { ok: false, code: "APPROVAL_POLICY_CHANGED" };
  const store = getStore();
  const event = store.listEvents(ctx.workspaceId, { type: "dates.extracted", entityId: batchId })[0];
  if (!event) return { ok: false, code: "DATE_BATCH_NOT_FOUND" };
  if (store.listEvents(ctx.workspaceId, { type: "dates.decided", entityId: batchId }).length) return { ok: false, code: "DATE_BATCH_ALREADY_DECIDED" };
  ensureSeeded(ctx);
  const payload = event.payload as ExtractedPayload;
  const included = new Set(includedIds);
  const written = writeItems(ctx, batchId, payload, included);
  store.appendEvent({
    ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `dates:decided:${batchId}:${randomUUID()}`,
    type: "dates.decided", entityId: batchId,
    payload: { included: [...included], excluded: [...(payload.dates ?? []), ...(payload.recurring ?? [])].map((item) => item.id).filter((id) => !included.has(id)),
      blocks: written.blocks, by }
  });
  return { ok: true, ...written };
}

/** The calendar blocks and profile facts for the chosen items of a batch. */
function writeItems(ctx: AccessContext, batchId: string, payload: ExtractedPayload, included: Set<string>): { blocks: number; facts: number } {
  const store = getStore();
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
      slot: dateSlot(item), value: `${item.date} ${item.title}`, status: "confirmed",
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
    // A syllabus lists the class both as a weekly pattern and as each dated lecture: one slot, one block — the dated one, which says
    // what that lecture covers. Twice, the day panel counted 2.5 fixed hours for one 75-minute class (2026-10-15 walkthrough).
    const slot = (block: PersistedScheduleBlock) => `${block.day}|${block.start}|${block.end}`;
    const taken = new Set(existing.filter((block) => block.id.startsWith("import:")).map(slot));
    const fresh = blocks.filter((block) => !known.has(block.id)).filter((block) => {
      if (taken.has(slot(block))) return false;
      taken.add(slot(block));
      return true;
    });
    store.savePlanVersion({ ...plan, payload: { ...(plan.payload as object), blocks: [...existing, ...fresh] } });
  }
  return { blocks: blocks.length, facts };
}
const dateSlot = (item: DateCandidate) => `date_${item.date.replaceAll("-", "")}_${item.kind}`;

/**
 * Dates read from files are adopted without a click (2026-10-19, the owner's decision: what the files and the calendar say is taken, not
 * asked). Every batch still waiting is decided by the system with the items the reader was sure enough of; the rest stay listed, unadopted.
 */
export function adoptPendingDates(ctx: AccessContext): number {
  let adopted = 0;
  for (let guard = 0; guard < 5; guard += 1) {
    const batch = loadPendingDateBatch(ctx);
    if (!batch) break;
    const result = decideDateBatch(ctx, batch.id, batch.items.filter((item) => item.checked).map((item) => item.id), "system");
    if (!result.ok) break;
    adopted += batch.items.filter((item) => item.checked).length;
  }
  return adopted;
}

/** One line of the file-read list: an item of a decided batch, adopted or left out. */
export type AdoptedItem = PendingItem & { batchId: string; adopted: boolean };
type Decision = { included?: string[]; excluded?: string[]; superseded?: boolean; by?: string };

/** What was read from the files and taken (or left out), newest reading first, one line per thing; past items are history and not listed. */
export function loadAdoptedDates(ctx: AccessContext): { items: AdoptedItem[]; dropped: string[] } {
  const store = getStore();
  const decisions = new Map(store.listEvents(ctx.workspaceId, { type: "dates.decided" }).map((event) => [event.entityId, event.payload as Decision]));
  const today = todayIso();
  const seen = new Set<string>();
  const items: AdoptedItem[] = [];
  let dropped: string[] = [];
  for (const event of [...store.listEvents(ctx.workspaceId, { type: "dates.extracted" })].reverse()) {
    const decision = decisions.get(event.entityId);
    if (!decision || decision.superseded) continue;
    const included = new Set(decision.included ?? []);
    const payload = event.payload as ExtractedPayload;
    if (!dropped.length) dropped = (payload.dropped ?? []).map((item) => (typeof item?.title === "string" && item.title.trim() ? item.title.trim() : "（未命名的一项）"));
    const rows: AdoptedItem[] = [
      ...(payload.recurring ?? []).filter((item) => item.to >= today).map((item) => ({ ...pendingOf(item, "recurring"), batchId: event.entityId, adopted: included.has(item.id) })),
      ...(payload.dates ?? []).filter((item) => item.date >= today).map((item) => ({ ...pendingOf(item, "date"), batchId: event.entityId, adopted: included.has(item.id) }))
    ];
    for (const row of rows) {
      const key = `${row.title}|${row.when}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(row);
    }
  }
  return { items: items.sort((a, b) => Number(b.adopted) - Number(a.adopted)), dropped };
}

/** An item as a list row, the same wording as the pending card. */
function pendingOf(item: DateCandidate | RecurringMeeting, kind: "date" | "recurring"): PendingItem {
  if (kind === "date") {
    const date = item as DateCandidate;
    return { id: date.id, kind, title: date.title, project: date.project, confidence: date.confidence,
      when: `${date.date}${date.startTime ? ` ${date.startTime}${date.endTime ? `–${date.endTime}` : ""}` : ""}`,
      quote: date.quote, sourceRef: date.sourceRef, note: date.note, checked: date.confidence !== "low", blocks: date.startTime ? 1 : 0 };
  }
  const meeting = item as RecurringMeeting;
  const days = upcomingDays(meeting, todayIso());
  return { id: meeting.id, kind, title: meeting.title, project: meeting.project, confidence: meeting.confidence,
    when: `每周${meeting.weekdays.map((day) => WEEKDAY[day]).join("、")} ${meeting.startTime}–${meeting.endTime}，至 ${meeting.to}`,
    quote: meeting.quote, sourceRef: meeting.sourceRef, note: meeting.location, checked: meeting.confidence !== "low", blocks: days.length };
}

/**
 * Takes one item off the list (its blocks and its fact go) or puts one back on, and records the batch's new decision as the person's.
 */
export function changeAdoptedDate(ctx: AccessContext, batchId: string, itemId: string, include: boolean): { ok: true } | { ok: false; code: string } {
  const store = getStore();
  const event = store.listEvents(ctx.workspaceId, { type: "dates.extracted", entityId: batchId })[0];
  const decision = store.listEvents(ctx.workspaceId, { type: "dates.decided", entityId: batchId }).at(-1)?.payload as Decision | undefined;
  if (!event || !decision || decision.superseded) return { ok: false, code: "DATE_BATCH_NOT_FOUND" };
  const payload = event.payload as ExtractedPayload;
  const all = [...(payload.dates ?? []), ...(payload.recurring ?? [])].map((item) => item.id);
  if (!all.includes(itemId)) return { ok: false, code: "DATE_ITEM_NOT_FOUND" };
  const included = new Set(decision.included ?? []);
  if (include === included.has(itemId)) return { ok: true };
  if (include) {
    writeItems(ctx, batchId, payload, new Set([itemId]));
    included.add(itemId);
  } else {
    const plan = store.listPlanVersions(ctx.workspaceId)[0];
    if (plan) {
      const blocks = (plan.payload as { blocks?: PersistedScheduleBlock[] }).blocks ?? [];
      const own = (id: string) => id === `import:${batchId}:${itemId}` || id.startsWith(`import:${batchId}:${itemId}:`);
      if (blocks.some((block) => own(block.id))) store.savePlanVersion({ ...plan, payload: { ...(plan.payload as object), blocks: blocks.filter((block) => !own(block.id)) } });
    }
    const date = (payload.dates ?? []).find((item) => item.id === itemId);
    if (date) {
      const identityId = store.listProjects(ctx.workspaceId, { includeArchived: true }).find((project) => project.id === date.project)?.identityId ?? "research";
      store.deleteProfileFact(ctx.workspaceId, identityId, date.project, dateSlot(date));
    }
    included.delete(itemId);
  }
  store.appendEvent({
    ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `dates:changed:${batchId}:${itemId}:${randomUUID()}`, type: "dates.decided", entityId: batchId,
    payload: { included: [...included], excluded: all.filter((id) => !included.has(id)), by: "person", changed: itemId, include }
  });
  return { ok: true };
}
