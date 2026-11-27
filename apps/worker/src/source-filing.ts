import { FILE_PROJECTS_SCHEMA, documentProject, validateFileProjects, type FileProjectsAnswer } from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";
import { FOLDER_CLASSIFIER } from "./folder-classifier";
import { ownerOf } from "./owner";

/**
 * Files each uploaded document that is not yet under a project by its own evidence — its name, else the opening of its text — when that
 * names exactly one known project written out (`documentProject`). A file that names none or several is left for the folder classifier
 * (`createFileProjectReader` below); what stays unfiled after that, if dates were read from it, is asked (`source_project` on 待确认).
 * Recorded as `source.project_inferred` with what decided it.
 */
export function fileSourceDocuments(store: CrosslineStore, workspaceId: string): Array<{ id: string; projectId: string }> {
  const projects = store.listProjects(workspaceId).map((project) => ({ id: project.id, name: project.name, identityId: project.identityId }));
  if (!projects.length) return [];
  const declined = new Set(store.listEvents(workspaceId, { type: "source.changed", change: "project_cleared" }).map((event) => event.entityId));
  const filed: Array<{ id: string; projectId: string }> = [];
  for (const doc of store.listSourceDocuments(workspaceId)) {
    if (doc.projectId || declined.has(doc.id) || doc.extractionStatus !== "done") continue;
    const found = documentProject(doc, projects);
    if (!found) continue;
    fileUnder(store, workspaceId, doc, found.project.id, { basis: found.basis });
    filed.push({ id: doc.id, projectId: found.project.id });
  }
  return filed;
}

function fileUnder(store: CrosslineStore, workspaceId: string, doc: { id: string; fileName: string }, projectId: string, why: Record<string, string>) {
  store.assignSourceDocumentProject(workspaceId, doc.id, projectId);
  store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `source.project_inferred:${doc.id}:${projectId}`,
    type: "source.changed", entityId: doc.id, payload: { projectId, fileName: doc.fileName, ...why, change: "project_inferred" } });
}

/** The files the folder classifier has already been asked about, answered or not: each is asked once. */
export const FILE_PROJECTS_ASKED = "sources.projectsAsked";
const ASKED_AT_MOST = 20;

/**
 * The model's step for files code could not file (2026-11-22, replacing a course-code parser and a 「course part」 word list): the folder
 * classifier reads each one's name and opening against the known projects and names the one it belongs to, or none. Each file is asked
 * once (`FILE_PROJECTS_ASKED`); a file the person cleared, or filed while the model ran, is left as it is; none means the person is asked.
 */
export function createFileProjectReader(store: CrosslineStore, workspaceId: string, cwd: string, getClient: () => CodexRpcBoundary | undefined) {
  return async function read(): Promise<{ filed: number } | { blocked: string }> {
    const projects = store.listProjects(workspaceId).map((project) => ({ id: project.id, name: project.name, lineId: project.identityId, summary: (project.summary ?? "").slice(0, 200) }));
    if (!projects.length) return { filed: 0 };
    let asked: string[] = [];
    try { asked = JSON.parse(store.getSetting(workspaceId, FILE_PROJECTS_ASKED) ?? "[]") as string[]; } catch { /* none yet */ }
    const declined = new Set(store.listEvents(workspaceId, { type: "source.changed", change: "project_cleared" }).map((event) => event.entityId));
    const docs = store.listSourceDocuments(workspaceId)
      .filter((doc) => !doc.projectId && !declined.has(doc.id) && doc.extractionStatus === "done" && !asked.includes(doc.id)).slice(0, ASKED_AT_MOST);
    if (!docs.length) return { filed: 0 };
    const client = getClient();
    if (!client) return { blocked: "CODEX_SUPERVISOR_UNAVAILABLE" };
    const context = { version: "crossline.file-projects.v1", projects,
      files: docs.map((doc) => ({ id: doc.id, name: doc.fileName, opening: doc.extractedText.slice(0, 600) })) };
    const result = await runCodexSkill<FileProjectsAnswer>(client, context, { skillName: FOLDER_CLASSIFIER, cwd,
      developerInstructions: "Name the one known project each file belongs to, from its name and opening; \"\" when its own words do not tie it to "
        + "exactly one. Return raw JSON only.", outputSchema: FILE_PROJECTS_SCHEMA,
      prepareInput: () => context, validateOutput: (output) => validateFileProjects(output, docs.map((doc) => doc.id), projects.map((project) => project.id)),
      onAudit: () => {}, timeoutMs: 10 * 60_000 });
    if (!result.ok) return { blocked: result.blocker.code };
    store.setSetting(workspaceId, FILE_PROJECTS_ASKED, JSON.stringify([...asked, ...docs.map((doc) => doc.id)].slice(-2000)));
    // Read again: the person may have filed or cleared a file while the model ran, and theirs stands.
    const nowDeclined = new Set(store.listEvents(workspaceId, { type: "source.changed", change: "project_cleared" }).map((event) => event.entityId));
    const current = new Map(store.listSourceDocuments(workspaceId).map((doc) => [doc.id, doc]));
    let filed = 0;
    for (const answer of result.output.files) {
      const doc = current.get(answer.id);
      if (!answer.projectId || !doc || doc.projectId || nowDeclined.has(doc.id)) continue;
      fileUnder(store, workspaceId, doc, answer.projectId, { basis: "模型判断", why: answer.why }); // i18n-ignore: a stored basis code, like 「文件名」
      filed += 1;
    }
    return { filed };
  };
}
