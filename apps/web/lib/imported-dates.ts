import "server-only";
import { randomUUID } from "node:crypto";
import { expandRecurring, matchesItem, mergeDecision, requiredApproval, type AccessContext, type DateCandidate, type RecurringMeeting } from "@crossline/core";
import { ensureSeeded, getStore, type PersistedScheduleBlock } from "./crossline";
import { localeFor } from "./locale";
import { tFor, weekdayShort, type Locale } from "./i18n";
import { decidePair, fixedTimedItems, readMerges, timedItemOf } from "./event-merges";
import { identityLines } from "./lines";

/**
 * The line a date with no known project is filed under: the workspace's first line. It was always `research`, which a workspace that
 * has no research line (the lite edition) never shows, so such dates went nowhere.
 */
const fallbackLine = (ctx: AccessContext) => identityLines(ctx)[0]?.id ?? "research";

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

type Dropped = { title?: string; code?: string };
type ExtractedPayload = { documentIds?: string[]; dates?: DateCandidate[]; recurring?: RecurringMeeting[]; questions?: string[]; dropped?: Dropped[] };

/** Why a reading left an item out, in the person's words (W-228): every drop used to be called 「no sentence states this day」. */
const DROP_WHY: Record<string, string> = {
  DATE_QUOTE_DOES_NOT_SUPPORT_DATE: "原文里找不到写着这一天的句子", DATE_TIME_INVALID: "时间不完整：没有结束时间，或结束不晚于开始",
  DATE_INVALID: "起止日期不完整", DATE_OUT_OF_RANGE: "日期离今天太远，可能年份读错了", DATE_UNKNOWN_SOURCE: "引用对不上原文",
  DATE_QUOTE_NOT_VERBATIM: "引用对不上原文", DATE_NOTHING_VERIFIABLE: "一条都没能在原文里核实", OFF_HOURS: "在本人说的可用时间之外，当作作息没有写入",
  NOT_KEPT: "没通过检查", DATE_PASSED: "等确认期间日期已过，没有再列出", LIMIT_REACHED: "一次读取只能记这么多，后面的可能没有读到；需要的话在回答里补上"
};
/** The drops as list lines, newest first, one per title; a duplicate is the same item twice and is not listed. */
function droppedLines(lists: Dropped[][], locale: Locale, recorded: Set<string> = new Set()): string[] {
  const t = tFor(locale);
  const seen = new Set<string>();
  return lists.flat().flatMap((item) => {
    const title = typeof item?.title === "string" && item.title.trim() ? item.title.trim() : t("（未命名的一项）");
    if (item?.code === "DATE_DUPLICATE_ID" || seen.has(title) || recorded.has(title)) return [];
    seen.add(title);
    const why = item?.code ? DROP_WHY[item.code] : undefined;
    return [why ? t("{{title}}（{{why}}）", { title, why: t(why) }) : title];
  });
}


/** A class that already met is history, not a plan: only today and later reach the calendar. */
const upcomingDays = (meeting: Parameters<typeof expandRecurring>[0], today: string) => expandRecurring(meeting).filter((day) => day >= today);
const todayIso = () => (process.env.CROSSLINE_FIXED_NOW ? new Date(process.env.CROSSLINE_FIXED_NOW) : new Date()).toISOString().slice(0, 10);

export function loadPendingDateBatch(ctx: AccessContext): PendingBatch | null {
  const store = getStore();
  const locale = localeFor(ctx);
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
      when: tFor(locale)("每周{{days}} {{start}}–{{end}}，{{from}} 至 {{to}}（还剩 {{count}} 次）", {
        days: locale === "en" ? item.weekdays.map((day) => weekdayShort(locale, day)).join(", ") : item.weekdays.map((day) => weekdayShort(locale, day).slice(1)).join("、"),
        start: item.startTime, end: item.endTime, from: item.from, to: item.to, count: days.length }),
      quote: item.quote, sourceRef: item.sourceRef, note: item.location, checked: item.confidence !== "low", blocks: days.length };
  });
  // What passed while the batch waited is not offered, and is said (W-228): it used to vanish from the list without a word.
  const passed = [...(payload.dates ?? []).filter((item) => item.date < today), ...(payload.recurring ?? []).filter((item) => item.to < today)]
    .map((item) => ({ title: item.title, code: "DATE_PASSED" }));
  return { id: batch.entityId, documentCount: payload.documentIds?.length ?? 0, items: [...recurring, ...dates], questions: payload.questions ?? [],
    // The titles, not just a count: 「另有 6 项…已丢弃」 left the person no way to tell what to add by hand (W-10). Each with why (W-228).
    dropped: droppedLines([payload.dropped ?? [], passed], locale) };
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
  const projects = store.listProjects(ctx.workspaceId, { includeArchived: true });
  let facts = 0;
  const now = new Date().toISOString();

  for (const item of (payload.dates ?? []).filter((candidate) => included.has(candidate.id))) {
    if (item.startTime) {
      blocks.push({ id: `import:${batchId}:${item.id}`, lane: "human", title: item.title, day: item.date, start: item.startTime,
        end: item.endTime || item.startTime, source: "文件导入", readOnly: true }); // i18n-ignore: a stored source marker
    }
    // Untimed dates are deadlines and exam days, not blocks of time. They are kept as profile facts so the
    // milestone design can start from them instead of from nothing.
    const project = projectNamed(projects, item.project);
    store.upsertProfileFact({ workspaceId: ctx.workspaceId, identityId: project?.identityId ?? fallbackLine(ctx), projectId: project?.id ?? item.project,
      slot: dateSlot(item), value: `${item.date} ${item.title}`, status: "confirmed",
      sourceRef: item.sourceRef, sourceQuote: item.quote, updatedAt: now });
    facts += 1;
  }
  for (const meeting of (payload.recurring ?? []).filter((candidate) => included.has(candidate.id))) {
    for (const day of upcomingDays(meeting, todayIso())) {
      blocks.push({ id: `import:${batchId}:${meeting.id}:${day}`, lane: "human", title: meeting.title, day,
        start: meeting.startTime, end: meeting.endTime, source: "文件导入", readOnly: true }); // i18n-ignore: a stored source marker
    }
  }

  const plan = store.listPlanVersions(ctx.workspaceId)[0];
  let written = 0;
  if (plan && blocks.length) {
    const existing = ((plan.payload as { blocks?: PersistedScheduleBlock[] }).blocks ?? []);
    const known = new Set(existing.map((block) => block.id));
    // A syllabus lists the class both as a weekly pattern and as each dated lecture: one slot, one block — the dated one, which says
    // what that lecture covers. Twice, the day panel counted 2.5 fixed hours for one 75-minute class (2026-10-15 walkthrough). The dated
    // one wins whichever batch came first (W-228: a midterm adopted after its class's weekly pattern was dropped for the class's block).
    const slot = (block: PersistedScheduleBlock) => `${block.day}|${block.start}|${block.end}`;
    const weekly = (block: PersistedScheduleBlock) => block.id.split(":").length === 4; // import:<batch>:<meeting>:<day>
    const holder = new Map(existing.filter((block) => block.id.startsWith("import:")).map((block) => [slot(block), block]));
    const replaced = new Set<string>();
    const ordered = [...blocks.filter((block) => !weekly(block)), ...blocks.filter(weekly)];
    const fresh = ordered.filter((block) => !known.has(block.id)).filter((block) => {
      const held = holder.get(slot(block));
      if (held && !(weekly(held) && !weekly(block))) return false;
      if (held) replaced.add(held.id);
      holder.set(slot(block), block);
      return true;
    });
    mergeIntoExisting(ctx, fresh);
    store.savePlanVersion({ ...plan, payload: { ...(plan.payload as object), blocks: [...existing.filter((block) => !replaced.has(block.id)), ...fresh] } });
    written = fresh.length;
  }
  endClassesAtFinal(ctx);
  // What reached the calendar, not what was read: the count said a block was written that the slot rule had left out.
  return { blocks: written, facts };
}

/** A final exam's title, in the file's or the reply's words: the course ends with it. */
const FINAL_EXAM = /期末|final/iu; // i18n-ignore: matched in the source's own words

/**
 * A course's weekly classes end with its final exam. A weekly pattern with no end in its source runs half a year (`OPEN_ENDED_DAYS`), so
 * 「这学期两门课」 stood on the calendar into May: 132 fixed items for a term whose final is on 12-15 (2026-11-06 walkthrough, W-243).
 * Run whenever dates are written, so it holds in either order — the classes adopted first and the final later, or the other way round.
 */
function endClassesAtFinal(ctx: AccessContext): void {
  const store = getStore();
  const projects = store.listProjects(ctx.workspaceId, { includeArchived: true });
  const finals = new Map<string, string>();
  for (const fact of store.listProfileFacts(ctx.workspaceId)) {
    const day = fact.slot.match(/^date_(\d{4})(\d{2})(\d{2})_exam$/u);
    if (!day || !FINAL_EXAM.test(fact.value)) continue;
    const id = projectNamed(projects, fact.projectId)?.id ?? fact.projectId;
    const date = `${day[1]}-${day[2]}-${day[3]}`;
    if ((finals.get(id) ?? "") < date) finals.set(id, date);
  }
  if (!finals.size) return;
  const endOf = new Map<string, string>();
  for (const event of store.listEvents(ctx.workspaceId, { type: ["dates.extracted"] })) {
    for (const meeting of (event.payload as ExtractedPayload).recurring ?? []) {
      const final = finals.get(projectNamed(projects, meeting.project)?.id ?? meeting.project);
      if (final) endOf.set(`${event.entityId}:${meeting.id}`, final);
    }
  }
  const plan = store.listPlanVersions(ctx.workspaceId)[0];
  const blocks = (plan?.payload as { blocks?: PersistedScheduleBlock[] } | undefined)?.blocks ?? [];
  const kept = blocks.filter((block) => {
    const [kind, batch, meeting, day] = block.id.split(":");
    if (kind !== "import" || !day) return true;
    const final = endOf.get(`${batch}:${meeting}`);
    return !final || !block.day || block.day <= final;
  });
  if (plan && kept.length < blocks.length) store.savePlanVersion({ ...plan, payload: { ...(plan.payload as object), blocks: kept } });
}
/**
 * The project a date names: by its id, or by its name, which the model writes as often as the id when it reads a reply. Matched by id only,
 * 「MoS₂ 存内计算研究」 was filed under the workspace's first line with the name as its project (2026-11-06 walkthrough, W-242).
 */
function projectNamed<T extends { id: string; name: string }>(projects: T[], ref: string): T | undefined {
  const key = ref.trim().toLowerCase();
  return key ? projects.find((project) => project.id === ref) ?? projects.find((project) => project.name.trim().toLowerCase() === key) : undefined;
}
const dateSlot = (item: DateCandidate) => `date_${item.date.replaceAll("-", "")}_${item.kind}`;

/**
 * A file's dated item that the person's calendar or an event they added already holds (same day, starts within 15 minutes, titles alike)
 * is that item (2026-11-03): the pair is merged by the system, by series, so the class shows once every week. Answers already on record
 * (the person's 「两个都留」 or 「不是同一件事」) are left as they are.
 */
function mergeIntoExisting(ctx: AccessContext, fresh: PersistedScheduleBlock[]): void {
  const days = [...new Set(fresh.map((block) => block.day).filter((day): day is string => Boolean(day)))];
  if (!days.length) return;
  const existing = fixedTimedItems(ctx, new Date(), days).filter((item) => item.kind === "calendar" || item.kind === "event");
  const book = readMerges(ctx);
  const done = new Set<string>();
  for (const block of fresh) {
    const item = timedItemOf(block);
    const match = item && existing.find((other) => matchesItem(item, other));
    if (!item || !match) continue;
    const { key } = mergeDecision(item, match, "merge", "system", "");
    if (book[key] || done.has(key)) continue;
    done.add(key);
    decidePair(ctx, item, match, "merge", "system");
  }
}

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
  const locale = localeFor(ctx);
  const decisions = new Map(store.listEvents(ctx.workspaceId, { type: "dates.decided" }).map((event) => [event.entityId, event.payload as Decision]));
  const today = todayIso();
  const seen = new Set<string>();
  const items: AdoptedItem[] = [];
  const drops: Dropped[][] = [];
  for (const event of [...store.listEvents(ctx.workspaceId, { type: "dates.extracted" })].reverse()) {
    const decision = decisions.get(event.entityId);
    if (!decision || decision.superseded) continue;
    const included = new Set(decision.included ?? []);
    const payload = event.payload as ExtractedPayload;
    drops.push(payload.dropped ?? []);
    const rows: AdoptedItem[] = [
      ...(payload.recurring ?? []).filter((item) => item.to >= today).map((item) => ({ ...pendingOf(item, "recurring", locale), batchId: event.entityId, adopted: included.has(item.id) })),
      ...(payload.dates ?? []).filter((item) => item.date >= today).map((item) => ({ ...pendingOf(item, "date", locale), batchId: event.entityId, adopted: included.has(item.id) }))
    ];
    for (const row of rows) {
      const key = `${row.title}|${row.when}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(row);
    }
  }
  // A reading with nothing left to offer writes no batch, only its drops (W-228); an item recorded since is no longer listed as dropped.
  const unrecorded = [...store.listEvents(ctx.workspaceId, { type: "dates.unrecorded" })].reverse().map((event) => (event.payload as { dropped?: Dropped[] }).dropped ?? []);
  const dropped = droppedLines([...unrecorded, ...drops], locale, new Set(items.map((item) => item.title)));
  return { items: items.sort((a, b) => Number(b.adopted) - Number(a.adopted)), dropped };
}

/** An item as a list row, the same wording as the pending card. */
function pendingOf(item: DateCandidate | RecurringMeeting, kind: "date" | "recurring", locale: Locale): PendingItem {
  if (kind === "date") {
    const date = item as DateCandidate;
    return { id: date.id, kind, title: date.title, project: date.project, confidence: date.confidence,
      when: `${date.date}${date.startTime ? ` ${date.startTime}${date.endTime ? `–${date.endTime}` : ""}` : ""}`,
      quote: date.quote, sourceRef: date.sourceRef, note: date.note, checked: date.confidence !== "low", blocks: date.startTime ? 1 : 0 };
  }
  const meeting = item as RecurringMeeting;
  const days = upcomingDays(meeting, todayIso());
  return { id: meeting.id, kind, title: meeting.title, project: meeting.project, confidence: meeting.confidence,
    when: tFor(locale)("每周{{days}} {{start}}–{{end}}，至 {{to}}", {
      days: locale === "en" ? meeting.weekdays.map((day) => weekdayShort(locale, day)).join(", ") : meeting.weekdays.map((day) => weekdayShort(locale, day).slice(1)).join("、"),
      start: meeting.startTime, end: meeting.endTime, to: meeting.to }),
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
      const project = projectNamed(store.listProjects(ctx.workspaceId, { includeArchived: true }), date.project);
      const known = project?.identityId;
      // A date filed before the fallback followed the workspace's lines sits under `research`; one filed before W-242 under the
      // first line with the project's name as its project.
      for (const identityId of new Set([known ?? fallbackLine(ctx), fallbackLine(ctx), ...(known ? [] : ["research"])])) {
        for (const projectId of new Set([project?.id ?? date.project, date.project])) store.deleteProfileFact(ctx.workspaceId, identityId, projectId, dateSlot(date));
      }
    }
    included.delete(itemId);
  }
  store.appendEvent({
    ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `dates:changed:${batchId}:${itemId}:${randomUUID()}`, type: "dates.decided", entityId: batchId,
    payload: { included: [...included], excluded: all.filter((id) => !included.has(id)), by: "person", changed: itemId, include }
  });
  return { ok: true };
}
