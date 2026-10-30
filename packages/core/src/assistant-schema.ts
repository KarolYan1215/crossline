/**
 * One change to a task, as the one input box's `task.op` action carries it (「截止改到周五」「第 2 步做完了」「今天没精力」「在等师兄的数据，
 * 下周二」). Carried out by `applyTaskOp` (apps/web/lib/task-ops.ts) after the person confirms the card, undoable like any other operation.
 * The site-wide assistant Skill that first returned these was replaced by `crossline-concierge` (docs/one-input.md).
 */
export type TaskOpType = "due" | "defer" | "estimate" | "step_done" | "step_add" | "replan" | "waiting" | "energy" | "note" | "progress" | "archive" | "start" | "tutorial" | "complete";
export type TaskOp = {
  type: TaskOpType;
  /** due/defer/waiting: YYYY-MM-DD. */ date: string;
  /** estimate: usual minutes. */ minutes: number;
  /** estimate (one step), step_done: a step id of the task; otherwise "". */ stepId: string;
  /** step_add: the new step; replan: what to change; waiting: what is awaited; note/progress: the record; archive: why. */ text: string;
  /** waiting: who provides it. */ who: string;
  /** energy: low | medium | high; otherwise "". */ energy: string;
  /** One line saying the change. */ summary: string;
};
