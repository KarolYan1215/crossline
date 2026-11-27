import { DEVICE_FOLDER_SCREEN_LIMIT, FOLDER_LINES_SCHEMA, FOLDER_SCREEN_SCHEMA, SOURCE_FOLDERS_SETTING, readSourceFolders, sourceFolderIndexSetting, validateFolderLines, validateFolderScreen,
  type FolderIndexEntry, type FolderLinesAnswer, type FolderScreenAnswer } from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";
import { identityLines } from "./lines";
import { localOnlyFile, pdkTermsOf, shownFolderLabel, type ScreenListed } from "./source-folders";

export const FOLDER_CLASSIFIER = "crossline:crossline-line-filer:folder";

/** Files offered to the screening at most (a picked folder's readable files, most recent first; the rest are not offered). */
const SCREEN_OFFERED = 1000;
export type ScreenFile = { path: string; size: number; modified: number };

/**
 * Screens a folder the person picked in the browser before anything goes up (§四.3.3; the hosted app cannot browse the person's disk, so
 * it screens, then imports): the same Skill, asked which of the files code already let through are worth reading, by name, format, size
 * and date, at most `limit`. Answers indexes into `files`; without a model the caller falls back to the most recently changed.
 */
export function createFolderScreener(store: CrosslineStore, workspaceId: string, cwd: string, getClient: () => CodexRpcBoundary | undefined) {
  return async function screen(folder: string, files: ScreenFile[], limit: number): Promise<{ keep: string[]; why: string } | { blocked: string }> {
    const offered = files.slice(0, SCREEN_OFFERED);
    if (offered.length <= 1) return { keep: offered.map((file) => file.path), why: "" };
    const client = getClient();
    if (!client) return { blocked: "CODEX_SUPERVISOR_UNAVAILABLE" };
    let profiles: Record<string, { description?: string }> = {};
    try { profiles = JSON.parse(store.getSetting(workspaceId, "lines.profiles") ?? "{}") ?? {}; } catch { /* none yet */ }
    const lines = identityLines(store, workspaceId).map((line) => ({ label: line.label, description: profiles[line.id]?.description ?? "" }));
    const context = { version: "crossline.folder-screen.v1", folder, limit, lines,
      files: offered.map((file, index) => ({ index, path: file.path, size: file.size, modifiedAt: new Date(file.modified).toISOString().slice(0, 10) })) };
    const result = await runCodexSkill<FolderScreenAnswer>(client, context, { skillName: FOLDER_CLASSIFIER, cwd,
      developerInstructions: "Screen the picked folder: keep the files worth reading to know the person and their work, by name, format, size and date, "
        + "at most `limit`, most useful first. Return raw JSON only.", outputSchema: FOLDER_SCREEN_SCHEMA,
      prepareInput: () => context, validateOutput: (output) => validateFolderScreen(output, offered.length, limit), onAudit: () => {}, timeoutMs: 3 * 60_000 });
    if (!result.ok) return { blocked: result.blocker.code };
    return { keep: result.output.keep.map((index) => offered[index]!.path), why: result.output.why };
  };
}

/** A run that could not happen at all (no runtime, not signed in, no model, no quota): nothing was judged, so nothing is decided. */
const NOT_RUN = /^(CODEX|RUNTIME|MODEL|SPEND|AUTH|ACCOUNT)_/;

/**
 * The screening for this computer's own folders (the person's decision of 2026-11-23, docs/plans/desktop-window-1123.md §6): what a folder
 * held when it was authorized is listed by `syncFolder`, already without credentials and private papers, and this asks the model which of
 * the listed files are worth reading by name, format, size and date, as a linked device asks its site. A run that could not happen leaves
 * the files listed for the next pass (undefined); a run that failed on its own answer keeps the most recently changed ("unavailable").
 */
export function screenListedWith(screen: ReturnType<typeof createFolderScreener>, limit = DEVICE_FOLDER_SCREEN_LIMIT): ScreenListed {
  return async (folder, files) => {
    const answer = await screen(folder, files, limit);
    if ("keep" in answer) return answer.keep;
    return NOT_RUN.test(answer.blocked) ? undefined : "unavailable";
  };
}

/**
 * Proposes the lines each newly read folder serves (decided 2026-10-14: the model files folders, the person can change it). Asked once per
 * folder, after its first read; a folder the person set by hand (`linesBy: "person"`) is never asked about. Low tier, intake work.
 */
export function createFolderClassifier(store: CrosslineStore, workspaceId: string, cwd: string, getClient: () => CodexRpcBoundary | undefined) {
  return async function classify(): Promise<{ filed: number } | { blocked: string }> {
    const folders = readSourceFolders(store.getSetting(workspaceId, SOURCE_FOLDERS_SETTING))
      // A 「仅本地」 folder is never shown to a model, not even by its files' names (docs/plans/execution-gates-1124.md 四.0).
      .filter((folder) => folder.linesBy === "" && !folder.localOnly && folder.lastScanAt && ((folder.files ?? 0) + (folder.nameOnly ?? 0)) > 0);
    const terms = pdkTermsOf(store, workspaceId);
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
      const files = Object.keys(index).filter((name) => !localOnlyFile(folder, name, terms)).slice(0, 40).map((name) => name.replace(/\\/g, "/"));
      const openings = Object.entries(index).filter(([name]) => !localOnlyFile(folder, name, terms)).map(([name, entry]) => ({ name: name.replace(/\\/g, "/"), text: documents.get(entry.documentId)?.extractedText.slice(0, 400) ?? "" }))
        .filter((item) => item.text.trim()).slice(0, 4);
      return { id: folder.id, name: shownFolderLabel(folder, terms), files, openings };
    });
    const projects = store.listProjects(workspaceId).map((project) => ({ name: project.name, lineId: project.identityId }));
    const context = { version: "crossline.folder-lines.v1", lines, projects, folders: asked };
    const result = await runCodexSkill<FolderLinesAnswer>(client, context, { skillName: FOLDER_CLASSIFIER, cwd,
      developerInstructions: "Decide which lines each authorized folder serves, from its name, file names and openings: every line a clear group of "
        + "its files serves, most central first; none when nothing ties it to a line. A stray file does not make a line. Return raw JSON only.", outputSchema: FOLDER_LINES_SCHEMA,
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
