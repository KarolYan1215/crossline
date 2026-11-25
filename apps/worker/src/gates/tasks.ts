import { GATE_JUDGED, GATE_OVERRIDDEN, latestGateJudgements, onPersonsBoard, OPEN_TASK_STATES, PRIORITY_LABELS, taskTitleOf, verdictOf } from "@crossline/core";
import type { CrosslineStore, StoredWorkOrder } from "@crossline/db";

/** What the gates show the model about a task: never its state or the person's own claim about it (§四.0 防宽松 1). */
export type GateTask = {
  subject: string; title: string; project: string; line: string; due: string;
  doneCriteria: string[]; mustDeliver: string[]; milestone: { title: string; criteria: string[]; due: string } | null;
  executor: "person" | "agent" | "mixed"; minutes: number | null;
};

export const isOpen = (order: StoredWorkOrder) => OPEN_TASK_STATES.has(order.state);
export const isFinished = (order: StoredWorkOrder) => order.state === "accepted";

export function gateTask(store: CrosslineStore, workspaceId: string, order: StoredWorkOrder,
  lookups: { projects: Map<string, string>; milestones: Map<string, { title: string; successCriteria: Array<{ statement: string }> }>; anchors: Map<string, string> }): GateTask {
  const steps = store.getStepPlan(workspaceId, order.id)?.steps ?? [];
  const payload = order.payload as { dueDate?: string; evidenceContract?: Array<{ description: string }>; estimateMinutes?: number } | undefined;
  const milestone = lookups.milestones.get(order.milestoneId);
  const people = steps.filter((step) => step.executor !== "agent").length;
  return {
    subject: order.id, title: taskTitleOf(order), project: lookups.projects.get(order.projectId) ?? "", line: order.identityId, due: payload?.dueDate ?? "",
    doneCriteria: steps.filter((step) => step.executor !== "agent").map((step) => step.doneCriterion).filter(Boolean),
    mustDeliver: (payload?.evidenceContract ?? []).map((item) => item.description),
    milestone: milestone ? { title: milestone.title, criteria: milestone.successCriteria.map((item) => item.statement), due: lookups.anchors.get(order.milestoneId) ?? "" } : null,
    executor: !steps.length || people === steps.length ? "person" : people === 0 ? "agent" : "mixed",
    minutes: typeof payload?.estimateMinutes === "number" ? payload.estimateMinutes : null
  };
}

export function gateLookups(store: CrosslineStore, workspaceId: string) {
  return {
    projects: new Map(store.listProjects(workspaceId, { includeArchived: true }).map((project) => [project.id, project.name])),
    milestones: new Map(store.listMilestones(workspaceId).map((milestone) => [milestone.id, milestone])),
    anchors: new Map(store.listMilestoneAnchors(workspaceId).map((anchor) => [anchor.milestoneId, anchor.deadline]))
  };
}

/** The person's tasks the gates look at: on the board, not tombstoned. */
export const boardTasks = (store: CrosslineStore, workspaceId: string) => store.listWorkOrders(workspaceId).filter((order) => !order.tombstone && onPersonsBoard(order));

export type PriorityLabel = { p1: boolean; external: boolean };
const NEITHER: PriorityLabel = { p1: false, external: false };

/** The current P1 and outward labels (J1a), the person's overrides applied. */
export function priorityLabels(store: CrosslineStore, workspaceId: string): Map<string, PriorityLabel> {
  const events = [...store.listEvents(workspaceId, { type: GATE_JUDGED }), ...store.listEvents(workspaceId, { type: GATE_OVERRIDDEN })];
  const out = new Map<string, PriorityLabel>();
  for (const judgement of latestGateJudgements(events, "priority").values()) out.set(judgement.payload.subject.id, PRIORITY_LABELS[verdictOf(judgement)] ?? NEITHER);
  return out;
}
