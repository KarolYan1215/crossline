/**
 * The planner reports one blocker per unplaced *step*, and a 「Q4_」 blocker for work it deliberately leaves for later (no due date,
 * beyond the horizon, before its latest start). People count tasks: the plan page's note and the impact preview both count here, so
 * the preview's 「未排入的任务 5 → 6」 cannot disagree with the page's 「3 个任务未排入，1 个任务部分步骤未排入」 (2026-10-18 walkthrough).
 */
export function unplacedTaskIds(blockers: ReadonlyArray<{ taskId: string; code: string }>): Set<string> {
  return new Set(blockers.filter((blocker) => !blocker.code.startsWith("Q4_")).map((blocker) => blocker.taskId.split("#")[0]!));
}
