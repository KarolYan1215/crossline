import type { CrosslineStore, StoredWorkOrder } from "@crossline/db";
import { courseCodeOf } from "@crossline/core";
import { autoApproveEligible } from "./auto-approval";
import { ownerOf } from "./owner";

/** How far ahead a confirmed due date turns into a task (the step planner then places its steps between release and due). */
export const DATE_PAIR_HORIZON_DAYS = 56;

type DateFact = { day: string; kind: "homework_out" | "homework_due"; number: string; title: string; projectKey: string; identityId: string };

/**
 * Confirmed course dates → tasks. 「作业 2 发布」 (2026-09-28) and 「作业 2 截止」 (2026-10-12) used to be two flags on the calendar and no
 * work at all between them; now each future due date with its release becomes one task whose window is release → due, default-effective
 * (the person confirmed the dates), and the step planner splits it into steps placed in that window.
 *
 * The facts' `projectId` is sometimes the project's *name* (「ECE 555」, as the date extractor wrote it) rather than its id, so a project
 * is matched on either. A date whose project cannot be resolved, or with no milestone in that project to attach to, is skipped.
 */
/**
 * The homework's own number: the one after 作业 / HW / Homework / Assignment, else the first number once the course code is taken out.
 * 「RBT 610 作业 3 截止」 became 「作业 610」 when the first number in the title was taken (2026-10-15 walkthrough).
 */
export function homeworkNumber(title: string): string | undefined {
  const named = /(?:作业|习题|homework|hw|assignment|problem\s*set|ps)\s*#?\s*(\d+)/i.exec(title)?.[1];
  if (named) return named;
  // A course code (「RBT 610」, 「ece555」) is not the homework's number.
  const rest = courseCodeOf(title) ? title.replace(/[A-Za-z]{2,5}\s?\d{3,4}[A-Za-z]?(?![\dA-Za-z])/, " ") : title;
  return rest.match(/\d+/)?.[0];
}

export function materializeDatePairs(store: CrosslineStore, workspaceId: string, now = new Date()): string[] {
  const today = now.toISOString().slice(0, 10);
  const horizon = new Date(now.getTime() + DATE_PAIR_HORIZON_DAYS * 86_400_000).toISOString().slice(0, 10);
  const projects = store.listProjects(workspaceId, { includeArchived: true });
  const projectOf = (key: string) => projects.find((project) => project.id === key || project.name === key || project.name.replace(/\s+/g, "") === key.replace(/\s+/g, ""));
  const facts: DateFact[] = store.listProfileFacts(workspaceId).filter((fact) => fact.status === "confirmed").flatMap((fact) => {
    const match = /^date_\d{8}_(homework_out|homework_due)$/.exec(fact.slot);
    const value = /^(\d{4}-\d{2}-\d{2})\s+(.*)$/.exec(fact.value);
    const number = value ? homeworkNumber(value[2]!) : undefined;
    return match && value && number ? [{ day: value[1]!, kind: match[1] as DateFact["kind"], number, title: value[2]!.trim(), projectKey: fact.projectId, identityId: fact.identityId }] : [];
  });
  const existing = new Set(store.listWorkOrders(workspaceId).map((order) => order.id));
  const milestones = store.listMilestones(workspaceId).filter((item) => item.status !== "archived");
  const anchors = new Map(store.listMilestoneAnchors(workspaceId).map((anchor) => [anchor.milestoneId, anchor.deadline]));
  const created: string[] = [];
  for (const due of facts.filter((fact) => fact.kind === "homework_due" && fact.day >= today && fact.day <= horizon)) {
    const project = projectOf(due.projectKey);
    if (!project) continue;
    const id = `datepair-${project.id}-hw${due.number}`;
    if (existing.has(id)) continue;
    const out = facts.find((fact) => fact.kind === "homework_out" && fact.number === due.number && projectOf(fact.projectKey)?.id === project.id);
    // The milestone this homework counts towards: the project's earliest live milestone due on or after it, else its latest one.
    const candidates = milestones.filter((item) => item.projectId === project.id);
    const milestone = candidates.filter((item) => (anchors.get(item.id) ?? "") >= due.day).sort((a, b) => anchors.get(a.id)!.localeCompare(anchors.get(b.id)!))[0]
      ?? candidates.sort((a, b) => (anchors.get(b.id) ?? "").localeCompare(anchors.get(a.id) ?? ""))[0];
    if (!milestone) continue;
    const intent = `完成 ${project.name} 作业 ${due.number}`;
    const order: StoredWorkOrder = { id, ownerId: ownerOf(store, workspaceId), workspaceId, identityId: project.identityId, projectId: project.id,
      milestoneId: milestone.id, intent, state: "awaiting_plan_approval", riskTier: "milestone",
      estimate: { p25Minutes: 120, p50Minutes: 180, p85Minutes: 360, source: "identity_prior", observationCount: 0, confidence: "low" },
      // A name that fits the title limit and keeps the homework's number: 「完成 RBT 610 Robot Perception 作业 3」 was cut to
      // 「完成 RBT 610 Robot Percept」, and three homeworks read the same (2026-10-15 walkthrough).
      payload: { title: `完成 ${courseCodeOf(project.name) ?? project.name} 作业 ${due.number}`, family: "deep_work", dueDate: due.day, ...(out && out.day > today ? { notBefore: out.day } : {}),
        datePair: { releaseDay: out?.day ?? "", dueDay: due.day, number: due.number, releaseTitle: out?.title ?? "", dueTitle: due.title },
        humanCore: [{ id: `${id}-core`, intent, quote: due.title, rationale: "课程日期已确认", energy: "high", interruptible: true }],
        automationParts: [], materialContract: [],
        evidenceContract: [{ kind: "file", description: "提交的作业文件或提交确认截图", why: "作业以提交为准", required: true }] } };
    if (store.saveBackplanDrafts(workspaceId, [order], { ownerId: order.ownerId, workspaceId, idempotencyKey: `datepair.created:${id}`,
      type: "datepair.created", entityId: id, payload: { projectId: project.id, releaseDay: out?.day ?? "", dueDay: due.day } })) created.push(id);
  }
  if (created.length) autoApproveEligible(store, workspaceId, created);
  return created;
}
