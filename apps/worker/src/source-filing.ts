import { documentProject } from "@crossline/core";
import type { CrosslineStore } from "@crossline/db";
import { ownerOf } from "./owner";

/**
 * Files each uploaded document that is not yet under a project by its own evidence — its name, else the opening of its text — when that
 * names exactly one known project (`documentProject`). A file that names none or several stays unfiled; if dates were read from it, the
 * person is asked (`source_project` on 待确认). Recorded as `source.project_inferred` with what decided it.
 */
export function fileSourceDocuments(store: CrosslineStore, workspaceId: string): Array<{ id: string; projectId: string }> {
  const projects = store.listProjects(workspaceId).map((project) => ({ id: project.id, name: project.name, identityId: project.identityId }));
  if (!projects.length) return [];
  const declined = new Set(store.listEvents(workspaceId, { type: "source.project_cleared" }).map((event) => event.entityId));
  const filed: Array<{ id: string; projectId: string }> = [];
  for (const doc of store.listSourceDocuments(workspaceId)) {
    if (doc.projectId || declined.has(doc.id) || doc.extractionStatus !== "done") continue;
    const found = documentProject(doc, projects);
    if (!found) continue;
    store.assignSourceDocumentProject(workspaceId, doc.id, found.project.id);
    store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `source.project_inferred:${doc.id}:${found.project.id}`,
      type: "source.project_inferred", entityId: doc.id, payload: { projectId: found.project.id, basis: found.basis, fileName: doc.fileName } });
    filed.push({ id: doc.id, projectId: found.project.id });
  }
  return filed;
}
