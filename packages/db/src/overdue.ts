import type { CrosslineStore, StoredWorkOrder } from "./index";

/**
 * Started work whose own due day passed (docs/plans/closed-loop-1030.md §4, the owner's decisions of 2026-10-30). The month simulation
 * found 「ECE 555 作业 3」 due 11/2 still 「进行中」 on 11/27, neither scheduled nor asked about: the daily pass only moved milestones, the
 * return tidy-up only archived what was never started, and the weekly commitment only cut what was never started. Two kinds:
 *
 * - **external** — a course's date, homework from a course's schedule, or a date read from someone else's text (an analysis quote, an
 *   import): not the system's to decide. The person is asked whether it can still be handed in and by when (`overdue_task` on 待确认).
 * - **self-set** — a due day the person typed, or one the system moved (the weekly commitment's 推, an earlier move of this pass): moved
 *   by the daily pass to the cautious finish at the measured pace plus two days, at most twice, then asked like an external one.
 *
 * Work whose due day is only its milestone's is the milestone's to settle (`date-advance.ts` step 2) and is not listed here.
 */
export const DUE_ADVANCED_EVENT = "work_order.due_advanced";
/** The person answered the overdue question for one due day (`overdue_task`). */
export const OVERDUE_TASK_RESOLVED = "task.overdue_resolved";
/** How many times a self-set due day is moved by itself before it is asked about instead. */
export const SILENT_TASK_SHIFTS_MAX = 2;
const OPEN = new Set(["approved", "preparing", "ready_for_human", "active", "blocked"]);
const GRADED = new Set(["quiz", "exam", "homework_due", "homework_out", "project_due"]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Projects that are courses: a grade breakdown on record, homework dated from the course's files, or graded items read from them. */
export function courseProjectIds(store: CrosslineStore, workspaceId: string): Set<string> {
  const out = new Set<string>();
  for (const fact of store.listProfileFacts(workspaceId)) if (fact.slot === "grading" && fact.projectId) out.add(fact.projectId);
  for (const order of store.listWorkOrders(workspaceId)) if (order.id.startsWith("datepair-") && order.projectId) out.add(order.projectId);
  for (const event of store.listEvents(workspaceId, { type: "dates.extracted" }))
    for (const item of (event.payload as { dates?: Array<{ project?: string; kind?: string }> }).dates ?? [])
      if (item.project && item.kind && GRADED.has(item.kind)) out.add(item.project);
  return out;
}

export type OverdueTask = { order: StoredWorkOrder; due: string; external: boolean; why: "course" | "source" | "person" | "system"; shifts: number };

/** Started, open work on the person's board whose own due day is before `today`. */
export function overdueStartedTasks(store: CrosslineStore, workspaceId: string, today: string, onBoard: (order: StoredWorkOrder) => boolean): OverdueTask[] {
  const timed = new Set(store.listExecutions(workspaceId).map((execution) => execution.workOrderId));
  const stepped = new Set(store.listStepPlans(workspaceId).filter((plan) => plan.steps.some((step) => step.status === "done")).map((plan) => plan.workOrderId));
  const provenance = dueProvenance(store, workspaceId);
  return store.listWorkOrders(workspaceId).filter((order) => OPEN.has(order.state) && !order.tombstone && onBoard(order)).flatMap((order): OverdueTask[] => {
    const due = (order.payload as { dueDate?: string } | undefined)?.dueDate;
    if (!due || !DATE.test(due) || due >= today) return [];
    if (!(order.state === "active" || timed.has(order.id) || stepped.has(order.id))) return [];
    return [{ order, due, ...provenance(order) }];
  });
}

/**
 * Who set each order's current own due day: a course (its date, or homework from its schedule), the person (a due-day edit), the system
 * (the weekly commitment's 推, the daily pass's move), else its source (a date read from someone else's text). With how many times the
 * daily pass already moved it.
 */
export function dueProvenance(store: CrosslineStore, workspaceId: string): (order: StoredWorkOrder) => { why: OverdueTask["why"]; external: boolean; shifts: number } {
  const courses = courseProjectIds(store, workspaceId);
  const setBy = new Map<string, Map<string, "person" | "system">>();
  const note = (id: string, day: unknown, by: "person" | "system") => {
    if (typeof day !== "string") return;
    const days = setBy.get(id) ?? new Map<string, "person" | "system">();
    days.set(day, by);
    setBy.set(id, days);
  };
  for (const event of store.listEvents(workspaceId, { type: "work_order.due_changed" })) note(event.entityId, (event.payload as { after?: unknown }).after, "person");
  for (const event of store.listEvents(workspaceId, { type: "work_order.deferred" })) note(event.entityId, (event.payload as { dueAfter?: unknown }).dueAfter, "system");
  const shifts = new Map<string, number>();
  for (const event of store.listEvents(workspaceId, { type: DUE_ADVANCED_EVENT })) {
    note(event.entityId, (event.payload as { to?: unknown }).to, "system");
    shifts.set(event.entityId, (shifts.get(event.entityId) ?? 0) + 1);
  }
  return (order) => {
    const due = (order.payload as { dueDate?: string } | undefined)?.dueDate ?? "";
    const course = courses.has(order.projectId) || order.id.startsWith("datepair-");
    const why = course ? "course" : setBy.get(order.id)?.get(due) ?? "source";
    return { why, external: why === "course" || why === "source", shifts: shifts.get(order.id) ?? 0 };
  };
}
