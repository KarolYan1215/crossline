import { DELIVERABLE_CHECK_SCHEMA, DELIVERABLE_JUDGED, onPersonsBoard, readSourceFolders, RESULT_FOLDERS_SETTING, SOURCE_FOLDERS_SETTING, sourceFolderIndexSetting,
  taskTitleOf, validateDeliverableCheck, type DeliverableCheck, type FolderIndexEntry } from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore, StoredSourceDocument, StoredWorkOrder } from "@crossline/db";
import { buildLedgerBrief } from "./ledger-brief";
import { ownerOf } from "./owner";

/**
 * The system's acceptance, the worker's half (docs/plans/attention-ledger-1120.md §7.2, batch 5, 2026-11-21): new files in the person's
 * authorized folders are read by the model against the open and recently finished tasks. A file counts as new only when it was changed
 * after the folder was authorized, so the first reading of a folder completes nothing. A folder the person marked as a project's result
 * folder (`RESULT_FOLDERS_SETTING`) is matched against that project's tasks only. Each judgement is one `deliverable.judged` event; the
 * web closes tasks and asks about gaps from them (`apps/web/lib/deliverables.ts`). Only authorized folders, only text already read and
 * kept (credentials and private papers never are), nothing sent anywhere but the model run.
 */
export const DELIVERABLE_SKILL = "crossline:crossline-deliverable-check";
const OPEN = new Set(["approved", "preparing", "ready_for_human", "active"]);
/** Finished work is checked for this long after it was finished. */
const FINISHED_DAYS = 14;
const DOCS_PER_PASS = 8;
const MAX_TASKS = 40;
const TEXT_CHARS = 6000;
/** A file changed this soon after the folder was authorized belongs to the first reading. */
const SETTLE_MS = 10 * 60_000;

type NewFile = { doc: StoredSourceDocument; folderId: string; relative: string; mtimeMs: number };

/** New files of the authorized folders not judged yet, oldest change first. */
export function newFolderFiles(store: CrosslineStore, workspaceId: string): NewFile[] {
  const judged = new Set(store.listEvents(workspaceId, { type: DELIVERABLE_JUDGED }).map((event) => event.entityId));
  const docs = new Map(store.listSourceDocuments(workspaceId).map((doc) => [doc.id, doc]));
  const out: NewFile[] = [];
  for (const folder of readSourceFolders(store.getSetting(workspaceId, SOURCE_FOLDERS_SETTING))) {
    let index: Record<string, FolderIndexEntry> = {};
    try { index = JSON.parse(store.getSetting(workspaceId, sourceFolderIndexSetting(folder.id)) ?? "{}") as Record<string, FolderIndexEntry>; } catch { continue; }
    const authorized = Date.parse(folder.addedAt);
    for (const [relative, entry] of Object.entries(index)) {
      const doc = entry.documentId ? docs.get(entry.documentId) : undefined;
      if (!doc || judged.has(doc.id) || doc.extractionStatus !== "done" || !doc.extractedText.trim()) continue;
      if (!Number.isFinite(authorized) || entry.mtimeMs < authorized + SETTLE_MS) continue;
      out.push({ doc, folderId: folder.id, relative: relative.replace(/\\/g, "/"), mtimeMs: entry.mtimeMs });
    }
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

const resultFolders = (store: CrosslineStore, workspaceId: string): Record<string, string> => {
  try { return JSON.parse(store.getSetting(workspaceId, RESULT_FOLDERS_SETTING) ?? "{}") as Record<string, string>; } catch { return {}; }
};

/** The tasks a file may belong to: open ones and those finished in the last two weeks, on the person's board, with an electronic deliverable. */
function candidateTasks(store: CrosslineStore, workspaceId: string, now: Date, projectId?: string): StoredWorkOrder[] {
  const since = now.getTime() - FINISHED_DAYS * 86_400_000;
  const accepted = new Map(store.listEvents(workspaceId, { type: "work_order.accepted" }).map((event) => [event.entityId, Date.parse(event.createdAt)]));
  return store.listWorkOrders(workspaceId)
    .filter((order) => onPersonsBoard(order) && !(order.payload as { offline?: boolean } | undefined)?.offline && (!projectId || order.projectId === projectId))
    .filter((order) => OPEN.has(order.state) || (order.state === "accepted" && (accepted.get(order.id) ?? 0) >= since))
    .slice(-MAX_TASKS);
}

export async function deliverableCheckPass(store: CrosslineStore, workspaceId: string, client: CodexRpcBoundary, cwd: string, now = new Date()): Promise<number> {
  const files = newFolderFiles(store, workspaceId).slice(0, DOCS_PER_PASS);
  if (!files.length) return 0;
  const results = resultFolders(store, workspaceId);
  // A result folder is matched against its project; the others against everything. One run per such group.
  const groups = new Map<string, NewFile[]>();
  for (const file of files) { const key = results[file.folderId] ?? ""; groups.set(key, [...(groups.get(key) ?? []), file]); }
  const brief = buildLedgerBrief(store, workspaceId, now);
  const milestones = new Map(store.listMilestones(workspaceId).map((milestone) => [milestone.id, milestone]));
  const projects = new Map(store.listProjects(workspaceId, { includeArchived: true }).map((project) => [project.id, project.name]));
  let judged = 0;
  for (const [projectId, group] of groups) {
    const tasks = candidateTasks(store, workspaceId, now, projectId || undefined);
    const input = {
      version: "crossline.deliverable-check.v1",
      ledger: { lines: brief.lines, milestones: brief.milestones },
      resultFolderOf: projectId ? projects.get(projectId) ?? projectId : "",
      tasks: tasks.map((order) => {
        const milestone = milestones.get(order.milestoneId);
        const steps = store.getStepPlan(workspaceId, order.id)?.steps ?? [];
        return { id: order.id, title: taskTitleOf(order), project: projects.get(order.projectId) ?? "", state: order.state === "accepted" ? "finished" : "open",
          due: (order.payload as { dueDate?: string } | undefined)?.dueDate ?? "",
          doneCriteria: steps.filter((step) => step.executor !== "agent").map((step) => step.doneCriterion).filter(Boolean),
          mustDeliver: ((order.payload as { evidenceContract?: Array<{ description: string }> } | undefined)?.evidenceContract ?? []).map((item) => item.description),
          milestone: milestone ? { title: milestone.title, criteria: milestone.successCriteria.map((item) => item.statement) } : null };
      }),
      files: group.map((file) => ({ id: file.doc.id, name: file.relative, modified: new Date(file.mtimeMs).toISOString(), text: file.doc.extractedText.slice(0, TEXT_CHARS) }))
    };
    const docs = group.map((file) => ({ id: file.doc.id, text: file.doc.extractedText.slice(0, TEXT_CHARS) }));
    const result = await runCodexSkill<DeliverableCheck>(client, input, { skillName: DELIVERABLE_SKILL, cwd,
      developerInstructions: "Judge each new file in `files` against the tasks as the crossline-deliverable-check Skill describes and return only the "
        + "requested JSON: one item per file. Quote the file verbatim. When unsure whether a file is a task's deliverable, it is evidence, not a deliverable.",
      outputSchema: DELIVERABLE_CHECK_SCHEMA as unknown as Record<string, unknown>, prepareInput: () => input, stableKeys: ["ledger"],
      validateOutput: (output) => validateDeliverableCheck(output, docs, tasks.map((order) => order.id)), onAudit: () => {}, timeoutMs: 30 * 60_000 });
    if (!result.ok) continue;
    const byId = new Map(group.map((file) => [file.doc.id, file]));
    for (const item of result.output.items) {
      const file = byId.get(item.doc);
      if (!file) continue;
      store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `${DELIVERABLE_JUDGED}:${item.doc}`, type: DELIVERABLE_JUDGED, entityId: item.doc,
        payload: { ...item, fileName: file.relative, uri: file.doc.uri, folderId: file.folderId } });
      // A file that is a task's deliverable or evidence is filed under the task's project when it had none.
      const order = item.task ? tasks.find((task) => task.id === item.task) : undefined;
      if (order?.projectId && !file.doc.projectId) store.assignSourceDocumentProject(workspaceId, file.doc.id, order.projectId);
      judged += 1;
    }
  }
  return judged;
}
