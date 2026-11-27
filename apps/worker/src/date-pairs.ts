import { adoptedDateItems, provideMaterial, type CrosslineStore, type StoredWorkOrder } from "@crossline/db";
import { courseCodeOf, dateKindOf, NO_NEEDS_PERSON } from "@crossline/core";
import { autoApproveEligible } from "./auto-approval";
import { ownerOf } from "./owner";
import { tOfWorkspace } from "./locale";
import { absorbParts, decideFold, openTasks, recordFold } from "./duplicate-guard";

/** How far ahead a confirmed due date turns into a task (the step planner then places its steps between release and due). */
export const DATE_PAIR_HORIZON_DAYS = 56;

type DateFact = { day: string; kind: "release" | "due"; work: string; number: string; title: string; projectKey: string };

/**
 * Adopted dates → tasks. 「作业 2 发布」 (2026-09-28) and 「作业 2 截止」 (2026-10-12) used to be two flags on the calendar and no work at all
 * between them; now each future due date with its release becomes one task whose window is release → due, default-effective (the person
 * confirmed the dates), and the step planner splits it into steps placed in that window.
 *
 * Which release and which due are one piece of work is the reading model's `work` label (2026-11-22): a homework-number regex paired
 * them before, which knew only homework and misread course codes. A date read before the label existed is not paired (no task is made
 * from it); the backplanner still plans the milestone's work.
 *
 * The dates' `project` is sometimes the project's *name* (「ECE 555」, as the date extractor wrote it) rather than its id, so a project
 * is matched on either. A date whose project cannot be resolved, or with no milestone in that project to attach to, is skipped.
 */
const squashWork = (work: string) => work.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
/** The task id's tail for a piece of work: `hw<n>` when its label carries one number (the ids paired orders always had), else a hash. */
function workKey(work: string): string {
  const numbers = work.match(/\d+/g) ?? [];
  if (numbers.length === 1) return `hw${numbers[0]}`;
  let hash = 5381;
  for (const char of squashWork(work)) hash = ((hash * 33) ^ char.codePointAt(0)!) >>> 0;
  return `w${hash.toString(36)}`;
}

export function materializeDatePairs(store: CrosslineStore, workspaceId: string, now = new Date()): string[] {
  const today = now.toISOString().slice(0, 10);
  const horizon = new Date(now.getTime() + DATE_PAIR_HORIZON_DAYS * 86_400_000).toISOString().slice(0, 10);
  const projects = store.listProjects(workspaceId, { includeArchived: true });
  const projectOf = (key: string) => projects.find((project) => project.id === key || project.name === key || project.name.replace(/\s+/g, "") === key.replace(/\s+/g, ""));
  const facts: DateFact[] = adoptedDateItems(store, workspaceId).flatMap((item) => {
    const kind = dateKindOf(item.kind);
    const work = item.work?.trim() ?? "";
    if (!work || (kind !== "release" && kind !== "due")) return [];
    const number = work.match(/\d+/g)?.length === 1 ? work.match(/\d+/)![0] : "";
    return [{ day: item.date, kind, work, number, title: item.title.trim(), projectKey: item.project }];
  });
  const existing = new Set(store.listWorkOrders(workspaceId).map((order) => order.id));
  // A homework already folded into a task the person had (below) is not written again on the next tick.
  for (const event of store.listEvents(workspaceId, { type: "task.changed", change: "duplicate_prevented" }))
    existing.add(String((event.payload as { candidate?: { id?: string } }).candidate?.id ?? ""));
  const open = openTasks(store, workspaceId);
  const milestones = store.listMilestones(workspaceId).filter((item) => item.status !== "archived");
  const anchors = new Map(store.listMilestoneAnchors(workspaceId).map((anchor) => [anchor.milestoneId, anchor.deadline]));
  const created: string[] = [];
  // The task is written in the workspace's language; the homework's number and course stay as they are.
  const t = tOfWorkspace(store, workspaceId);
  for (const due of facts.filter((fact) => fact.kind === "due" && fact.day >= today && fact.day <= horizon)) {
    const project = projectOf(due.projectKey);
    if (!project) continue;
    const id = `datepair-${project.id}-${workKey(due.work)}`;
    if (existing.has(id)) continue;
    const out = facts.find((fact) => fact.kind === "release" && squashWork(fact.work) === squashWork(due.work) && projectOf(fact.projectKey)?.id === project.id);
    // The milestone this homework counts towards: the project's earliest live milestone due on or after it, else its latest one.
    const candidates = milestones.filter((item) => item.projectId === project.id);
    const milestone = candidates.filter((item) => (anchors.get(item.id) ?? "") >= due.day).sort((a, b) => anchors.get(a.id)!.localeCompare(anchors.get(b.id)!))[0]
      ?? candidates.sort((a, b) => (anchors.get(b.id) ?? "").localeCompare(anchors.get(a.id) ?? ""))[0];
    if (!milestone) continue;
    const intent = t("完成 {{course}} {{work}}", { course: project.name, work: due.work });
    const order: StoredWorkOrder = { id, ownerId: ownerOf(store, workspaceId), workspaceId, identityId: project.identityId, projectId: project.id,
      milestoneId: milestone.id, intent, state: "awaiting_plan_approval", riskTier: "milestone",
      estimate: { p25Minutes: 120, p50Minutes: 180, p85Minutes: 360, source: "identity_prior", observationCount: 0, confidence: "low" },
      // A name that fits the title limit and keeps the homework's number: 「完成 RBT 610 Robot Perception 作业 3」 was cut to
      // 「完成 RBT 610 Robot Percept」, and three homeworks read the same (2026-10-15 walkthrough).
      payload: { title: t("完成 {{course}} {{work}}", { course: courseCodeOf(project.name) ?? project.name, work: due.work }), family: "deep_work", dueDate: due.day, ...(out && out.day > today ? { notBefore: out.day } : {}),
        datePair: { releaseDay: out?.day ?? "", dueDay: due.day, work: due.work, ...(due.number ? { number: due.number } : {}), releaseTitle: out?.title ?? "", dueTitle: due.title },
        humanCore: [{ id: `${id}-core`, intent, quote: due.title, rationale: t("日期已确认"), energy: "high", interruptible: true }],
        // A dated piece of the person's own work: nothing in it is a choice or a login (written by code, so it says so itself).
        needsPerson: NO_NEEDS_PERSON, automationParts: [], materialContract: [],
        evidenceContract: [{ kind: "file", description: t("提交的文件或提交确认截图"), why: t("以提交为准"), required: true }] } };
    // The person may already have this homework on the board (typed in, or planned from the milestone): it gets the dates, not a twin.
    const payload = order.payload as { title: string; dueDate: string; datePair: unknown };
    const fold = decideFold(open, { id, identityId: order.identityId, projectId: order.projectId, milestoneId: order.milestoneId, title: payload.title, intent,
      state: order.state, dueDate: due.day, milestoneDeadline: anchors.get(milestone.id) ?? "", progress: 0, hasStepPlan: false, started: false, dependsOn: [] });
    if (fold) {
      const keep = store.listWorkOrders(workspaceId).find((item) => item.id === fold.keep)!;
      const kept = (keep.payload ?? {}) as { dueDate?: string; datePair?: unknown };
      store.saveWorkOrder({ ...keep, payload: { ...(keep.payload as object), ...(!kept.datePair ? { datePair: payload.datePair } : {}),
        ...(!kept.dueDate || due.day < kept.dueDate ? { dueDate: due.day } : {}) } });
      recordFold(store, workspaceId, fold, { id, title: payload.title, intent, source: "datepair" });
      continue;
    }
    if (store.saveBackplanDrafts(workspaceId, [order], { ownerId: order.ownerId, workspaceId, idempotencyKey: `datepair.created:${id}`,
      type: "goal.changed", entityId: id, payload: { projectId: project.id, releaseDay: out?.day ?? "", dueDay: due.day, change: "datepair_created" } })) created.push(id);
  }
  for (const id of created) absorbParts(store, workspaceId, id);
  if (created.length) autoApproveEligible(store, workspaceId, created);
  return created;
}

const WORKING = new Set(["active", "evidence_review", "accepted", "archived"]);
/** The homework number a file name names (「ECE555-F26-Homework2.docx」, 「HW-3 Solutions」, 「作业3」), never a bare number. */
const fileHomework = (name: string) => /(?:作业|习题|homework|hw|assignment|problem\s*set)\s*[#_-]?\s*0*(\d+)/i.exec(name)?.[1];
const courseKey = (text: string) => courseCodeOf(text)?.replace(/\s+/g, "").toUpperCase();

/**
 * A course schedule's release day is a plan, not the homework being out: on 2026-10-15 「ECE 555 作业 3」 was scheduled from 10/12, the
 * day the schedule named, while the course had not posted it. Each homework task not yet started therefore waits on 「作业 N 发布」, a
 * waiting item due on the planned day: until it is answered the scheduler keeps the work off the calendar (`releaseDayOf`) and Today
 * asks 「到了吗？」 from that day. The homework's own file arriving — uploaded, or read from an authorized folder, named with the course and
 * the number or filed under the course — is the answer too, and closes the wait without asking.
 */
export function releaseWaits(store: CrosslineStore, workspaceId: string): { opened: string[]; arrived: string[] } {
  const owner = ownerOf(store, workspaceId);
  const projects = store.listProjects(workspaceId, { includeArchived: true });
  const waits = new Map(store.listWaitingItems(workspaceId).map((item) => [item.id, item]));
  const documents = store.listSourceDocuments(workspaceId);
  const opened: string[] = [], arrived: string[] = [];
  const t = tOfWorkspace(store, workspaceId);
  for (const order of store.listWorkOrders(workspaceId)) {
    const pair = (order.payload as { datePair?: { releaseDay?: string; number?: string; work?: string } } | undefined)?.datePair;
    if (!pair?.releaseDay || !(pair.number || pair.work) || WORKING.has(order.state)) continue;
    const project = projects.find((item) => item.id === order.projectId);
    const course = courseKey(project?.name ?? "") ?? courseKey(order.projectId);
    const file = pair.number === undefined ? undefined : documents.find((doc) => fileHomework(doc.fileName) === pair.number
      && (doc.projectId === order.projectId || (course !== undefined && courseKey(doc.fileName) === course)));
    const id = `wait-release-${order.id}`;
    const wait = waits.get(id);
    if (wait) {
      if (wait.state === "open" && file && store.answerWaitingItem(workspaceId, id, { kind: "arrived" }, owner).changed) {
        store.appendEvent({ ownerId: owner, workspaceId, idempotencyKey: `waiting.arrived_by_file:${id}`, type: "waiting.changed", entityId: id,
          payload: { documentId: file.id, fileName: file.fileName, change: "arrived_by_file" } });
        arrived.push(id);
      }
      continue;
    }
    if (file) continue;
    const courseName = courseCodeOf(project?.name ?? "") ?? project?.name ?? "";
    const title = (pair.work ? t("{{course}} {{work}} 发布", { course: courseName, work: pair.work })
      : t("{{course}} 作业 {{number}} 发布", { course: courseName, number: pair.number ?? "" })).trim();
    if (store.saveWaitingItem({ id, ownerId: owner, workspaceId, title, who: "", expectedAt: pair.releaseDay, approximate: false,
      followUpAt: pair.releaseDay, state: "open", blocks: [order.id], source: "datepair" }).inserted) opened.push(id);
  }
  return { opened, arrived };
}

/** A provide step that asks for the homework itself (its problems, its sheet), not for some other material of the task. */
const ASKS_FOR_HOMEWORK = /题面|题目|作业\s*\d*\s*(?:文件|原文)|problem\s*set|homework\s*\d*\s*(?:sheet|file|pdf|handout)/i;
/** Done orders keep their history; anything not yet done can still be unblocked by its file. */
const SETTLED = new Set(["accepted", "archived"]);

/**
 * The homework's own file arriving also settles a step that asks the person for it (W-169). On 2026-11-01 「完成 ECE 555 作业 3」 was due
 * the next day with no time on the calendar: its plan had asked on 10/22 for 「ECE 555 作业3题面或 Canvas 公告」, the file
 * 「F26-Homework3-ECE555.docx」 had since come in from the person's Downloads, and nothing but an upload on the task page could settle the
 * step, so every step that used it waited. The file is matched as `releaseWaits` matches it, filed under the course when it has no project,
 * and the step is settled as an upload. Returns the steps settled.
 */
export function settleHomeworkNeeds(store: CrosslineStore, workspaceId: string, now = new Date()): Array<{ workOrderId: string; stepId: string; documentId: string }> {
  const owner = ownerOf(store, workspaceId);
  const projects = store.listProjects(workspaceId, { includeArchived: true });
  const documents = store.listSourceDocuments(workspaceId);
  const settled: Array<{ workOrderId: string; stepId: string; documentId: string }> = [];
  for (const order of store.listWorkOrders(workspaceId)) {
    const number = (order.payload as { datePair?: { number?: string } } | undefined)?.datePair?.number;
    if (!number || SETTLED.has(order.state)) continue;
    const plan = store.getStepPlan(workspaceId, order.id);
    const asks = (plan?.steps ?? []).filter((step) => step.provides && step.status === "planned" && ASKS_FOR_HOMEWORK.test(`${step.title} ${step.deliverable}`));
    if (!asks.length) continue;
    const project = projects.find((item) => item.id === order.projectId);
    const course = courseKey(project?.name ?? "") ?? courseKey(order.projectId);
    const file = documents.find((doc) => fileHomework(doc.fileName) === number
      && (doc.projectId === order.projectId || (course !== undefined && courseKey(doc.fileName) === course)));
    if (!file) continue;
    if (!file.projectId) store.assignSourceDocumentProject(workspaceId, file.id, order.projectId);
    for (const step of asks) if (provideMaterial(store, workspaceId, order.id, step.id, "file", [file.id], owner, now).ok)
      settled.push({ workOrderId: order.id, stepId: step.id, documentId: file.id });
  }
  return settled;
}
