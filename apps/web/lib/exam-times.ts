import "server-only";
import { dateItemAttributes, parseTimeRange, urgencyFor, withCourse, type AccessContext, type Ask, type DateCandidate } from "@crossline/core";
import { ensureSeeded, getStore, type PersistedScheduleBlock } from "./crossline";
import type { Translate } from "./i18n";

/**
 * 「几点到几点」 (docs/plans/2026-11-11-walkthrough-decisions.md §2.5): an exam or quiz of a course the person has, adopted from their own
 * file with a day and no time (W-256: ECE 548's Midterm-2 had only 11/24), is required and fixed but cannot be placed. It is asked once;
 * until answered the day shows it as the dated item it already is (an all-day reminder among the day's dates), never as work to place.
 * The answer is written as the same read-only block a timed file date gets (`import:<batch>:<item>`), so it is busy time on the plan;
 * which calendars it reaches is the existing paths' business, unchanged. 「没有固定时间」 is kept and not asked again.
 */
export const EXAM_TIMES_SETTING = "dates.times";
type Answer = { start: string; end: string } | "none";
type Decision = { included?: string[]; superseded?: boolean };

const answers = (ctx: AccessContext): Record<string, Answer> => {
  try { const value = JSON.parse(getStore().getSetting(ctx.workspaceId, EXAM_TIMES_SETTING) ?? "{}") as unknown; return value && typeof value === "object" ? value as Record<string, Answer> : {}; }
  catch { return {}; }
};

/** Adopted untimed sittings of known courses, still to come and not answered: `<batch>:<item>` with the item and its course's name. */
function untimedSittings(ctx: AccessContext, today: string): Array<{ key: string; batchId: string; item: DateCandidate; course: string }> {
  const store = getStore();
  const decisions = new Map<string, Decision>();
  for (const event of store.listEvents(ctx.workspaceId, { type: "dates.decided" })) decisions.set(event.entityId, event.payload as Decision);
  const projects = store.listProjects(ctx.workspaceId);
  const courseOf = (ref: string) => projects.find((project) => project.id === ref) ?? projects.find((project) => project.name.trim().toLowerCase() === ref.trim().toLowerCase());
  const answered = answers(ctx);
  const seen = new Set<string>();
  const out: Array<{ key: string; batchId: string; item: DateCandidate; course: string }> = [];
  for (const event of [...store.listEvents(ctx.workspaceId, { type: "dates.extracted" })].reverse()) {
    const decision = decisions.get(event.entityId);
    if (!decision || decision.superseded) continue;
    const included = new Set(decision.included ?? []);
    for (const item of (event.payload as { dates?: DateCandidate[] }).dates ?? []) {
      const course = courseOf(item.project ?? "");
      if (!included.has(item.id) || item.date < today || !dateItemAttributes(item, Boolean(course)).needsTime || item.kind === "class") continue;
      const key = `${event.entityId}:${item.id}`;
      const same = `${course!.id}|${item.date}|${item.title}`;
      if (answered[key] || seen.has(same)) continue;
      seen.add(same);
      out.push({ key, batchId: event.entityId, item, course: course!.name });
    }
  }
  return out;
}

export function examTimeAsks({ ctx, today, t }: { ctx: AccessContext; today: string; t: Translate }): Ask[] {
  return untimedSittings(ctx, today).map(({ key, item, course }) => {
    const title = withCourse(item.title, course);
    return { id: `exam-time:${key}`, kind: "exam_time" as const, entityId: key, urgency: urgencyFor(item.date, today), dueDay: item.date,
      raisedAt: `${item.date}T00:00:00.000Z`, fingerprint: key, important: true,
      title: t("「{{title}}」几点到几点？", { title }),
      why: t("{{day}}，课程文件只写了日期。填上时间后成为固定日程，排程避开它；填之前那天只列为全天提醒，不当任务排。",
        { day: `${Number(item.date.slice(5, 7))}/${Number(item.date.slice(8, 10))}` }),
      freeText: { placeholder: t("如 12:45-13:15") },
      options: [{ id: "set", label: t("就是这个时间"), recommended: true }, { id: "none", label: t("没有固定时间"), detail: t("那天只列为全天提醒") }] };
  });
}

export function answerExamTime(ctx: AccessContext, key: string, optionId: string, note: string): { ok: true } | { ok: false; code: string } {
  const store = getStore();
  const [batchId = "", itemId = ""] = key.split(":");
  const item = ((store.listEvents(ctx.workspaceId, { type: "dates.extracted", entityId: batchId })[0]?.payload as { dates?: DateCandidate[] } | undefined)?.dates ?? [])
    .find((entry) => entry.id === itemId);
  if (!item) return { ok: false, code: "DATE_ITEM_NOT_FOUND" };
  if (optionId === "none") {
    store.setSetting(ctx.workspaceId, EXAM_TIMES_SETTING, JSON.stringify({ ...answers(ctx), [key]: "none" }));
    return { ok: true };
  }
  const range = parseTimeRange(note);
  if (!range) return { ok: false, code: "EXAM_TIME_INVALID" };
  ensureSeeded(ctx);
  const plan = store.listPlanVersions(ctx.workspaceId)[0];
  if (!plan) return { ok: false, code: "PLAN_NOT_FOUND" };
  const id = `import:${batchId}:${itemId}`;
  const blocks = ((plan.payload as { blocks?: PersistedScheduleBlock[] }).blocks ?? []).filter((block) => block.id !== id);
  store.savePlanVersion({ ...plan, payload: { ...(plan.payload as object), blocks: [...blocks, { id, lane: "human", title: item.title, day: item.date,
    start: range.start, end: range.end, source: "文件导入", readOnly: true }] } }); // i18n-ignore: a stored source marker, as writeItems writes it
  store.setSetting(ctx.workspaceId, EXAM_TIMES_SETTING, JSON.stringify({ ...answers(ctx), [key]: range }));
  return { ok: true };
}
