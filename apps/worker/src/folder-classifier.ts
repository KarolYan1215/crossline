import { FOLDER_LINES_SCHEMA, SOURCE_FOLDERS_SETTING, readSourceFolders, sourceFolderIndexSetting, validateFolderLines, type FolderIndexEntry, type FolderLinesAnswer } from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";
import { identityLines } from "./lines";

export const FOLDER_CLASSIFIER = "crossline:crossline-folder-classifier";

/**
 * Proposes the lines each newly read folder serves (decided 2026-10-14: the model files folders, the person can change it). Asked once per
 * folder, after its first read; a folder the person set by hand (`linesBy: "person"`) is never asked about. Low tier, intake work.
 */
export function createFolderClassifier(store: CrosslineStore, workspaceId: string, cwd: string, getClient: () => CodexRpcBoundary | undefined) {
  return async function classify(): Promise<{ filed: number } | { blocked: string }> {
    const folders = readSourceFolders(store.getSetting(workspaceId, SOURCE_FOLDERS_SETTING))
      .filter((folder) => folder.linesBy === "" && folder.lastScanAt && ((folder.files ?? 0) + (folder.nameOnly ?? 0)) > 0);
    if (!folders.length) return { filed: 0 };
    let profiles: Record<string, { description?: string }> = {};
    try { profiles = JSON.parse(store.getSetting(workspaceId, "lines.profiles") ?? "{}") ?? {}; } catch { /* none yet */ }
    const lines = identityLines(store, workspaceId).map((line) => ({ id: line.id, label: line.label, goals: line.goals ?? [], description: profiles[line.id]?.description ?? "" }));
    if (!lines.length) return { filed: 0 };
    const client = getClient();
    if (!client) return { blocked: "CODEX_SUPERVISOR_UNAVAILABLE" };
    const documents = new Map(store.listSourceDocuments(workspaceId).map((doc) => [doc.id, doc]));
    const asked = folders.slice(0, 10).map((folder) => {
      let index: Record<string, FolderIndexEntry> = {};
      try { index = JSON.parse(store.getSetting(workspaceId, sourceFolderIndexSetting(folder.id)) ?? "{}") as Record<string, FolderIndexEntry>; } catch { /* unread */ }
      const files = Object.keys(index).slice(0, 40).map((name) => name.replace(/\\/g, "/"));
      const openings = Object.entries(index).map(([name, entry]) => ({ name: name.replace(/\\/g, "/"), text: documents.get(entry.documentId)?.extractedText.slice(0, 400) ?? "" }))
        .filter((item) => item.text.trim()).slice(0, 4);
      return { id: folder.id, name: folder.label, files, openings };
    });
    const projects = store.listProjects(workspaceId).map((project) => ({ name: project.name, lineId: project.identityId }));
    const context = { version: "crossline.folder-lines.v1", lines, projects, folders: asked };
    const result = await runCodexSkill<FolderLinesAnswer>(client, context, { skillName: FOLDER_CLASSIFIER, cwd,
      developerInstructions: "Decide which lines each folder serves as the Skill describes. Return raw JSON only.", outputSchema: FOLDER_LINES_SCHEMA,
      prepareInput: () => context, validateOutput: (output) => validateFolderLines(output, asked.map((folder) => folder.id), lines.map((line) => line.id)),
      onAudit: () => {}, timeoutMs: 20 * 60_000 });
    if (!result.ok) return { blocked: result.blocker.code };
    // Read again: the person may have set a folder's lines while the model ran, and theirs stands.
    const answers = new Map(result.output.folders.map((item) => [item.id, item]));
    const current = readSourceFolders(store.getSetting(workspaceId, SOURCE_FOLDERS_SETTING));
    store.setSetting(workspaceId, SOURCE_FOLDERS_SETTING, JSON.stringify(current.map((folder) => {
      const answer = answers.get(folder.id);
      return answer && folder.linesBy !== "person" ? { ...folder, lines: answer.lineIds, linesBy: "model" as const, linesWhy: answer.why } : folder;
    })));
    return { filed: answers.size };
  };
}
