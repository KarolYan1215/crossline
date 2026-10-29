/**
 * Step dates that follow the task's deadline (walkthrough W-155, 2026-10-29). A step's `notBefore`/`dueBy` are the plan's pacing, written
 * when the plan was made; when the deadline moves later (the daily date advance, the return tidy-up, the person's own edit) the plan is
 * not rewritten, so a task due 10/31 still showed its steps at 「10/22 → 10/23」 and its description 「在10月23日前」.
 *
 * `stepDatesFollowingDue` moves the open steps' dates with the deadline once they have fallen behind: when the latest open step's
 * `dueBy` has passed and the task is due later, every open step shifts by the days the deadline moved past it, held to the deadline;
 * a `notBefore` still in the past after that is dropped (it no longer holds anything back). Done steps keep their dates. The scheduler
 * already treats a past step date as pacing only, so this changes what is shown, not where work is placed.
 */
type DatedStep = { status: string; dueBy: string; notBefore: string };
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayNumber = (day: string) => Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
const dayOf = (number: number) => new Date(number * 86_400_000).toISOString().slice(0, 10);

export function stepDatesFollowingDue<T extends DatedStep>(steps: readonly T[], taskDue: string | undefined, today: string): T[] {
  const open = (step: DatedStep) => step.status !== "done" && step.status !== "skipped";
  const latest = steps.filter(open).map((step) => step.dueBy).filter((day) => DAY.test(day)).sort().at(-1);
  if (!latest || latest >= today || !taskDue || !DAY.test(taskDue) || taskDue < today) return [...steps];
  const shift = dayNumber(taskDue) - dayNumber(latest);
  const due = dayNumber(taskDue), now = dayNumber(today);
  return steps.map((step) => {
    if (!open(step)) return step;
    const move = (day: string) => DAY.test(day) ? Math.min(due, dayNumber(day) + Math.max(0, shift)) : undefined;
    const dueBy = move(step.dueBy), notBefore = move(step.notBefore);
    return { ...step, dueBy: dueBy === undefined || dueBy < now ? "" : dayOf(dueBy),
      notBefore: notBefore === undefined || notBefore < now ? "" : dayOf(notBefore) };
  });
}

/**
 * Dates a model-written description names that have passed while the task is still due later (「在10月23日前」 on a task now due 10/31):
 * the description is the model's text and is not rewritten; the page says the deadline moved beside it. Reads 「10月23日」「10月23号」
 * and 「10/23」 where it reads as a day (「在 10/23」「10/23 前」, never 「3/4 的题」); the year is the one that puts the day within half a year of today.
 */
export function staleDateMentions(text: string, today: string, taskDue: string | undefined): string[] {
  if (!taskDue || !DAY.test(taskDue) || taskDue < today || !DAY.test(today)) return [];
  const year = Number(today.slice(0, 4));
  const found = new Set<string>();
  for (const match of text.matchAll(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]|(?<=(?:在|于|截止|due|by)\s*)(\d{1,2})\/(\d{1,2})(?![\d/])|(?<![\d/])(\d{1,2})\/(\d{1,2})(?=\s*(?:前|之前|截止|号|日))/gi)) {
    const month = Number(match[1] ?? match[3] ?? match[5]), date = Number(match[2] ?? match[4] ?? match[6]);
    if (month < 1 || month > 12 || date < 1 || date > 31) continue;
    let day = `${year}-${String(month).padStart(2, "0")}-${String(date).padStart(2, "0")}`;
    if (dayNumber(day) - dayNumber(today) > 183) day = `${year - 1}${day.slice(4)}`;
    else if (dayNumber(today) - dayNumber(day) > 183) day = `${year + 1}${day.slice(4)}`;
    if (day < today && day < taskDue) found.add(day);
  }
  return [...found].sort();
}
