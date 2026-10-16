import { credentialName, folderFileAction, sensitiveName, skipFolderDirectory } from "@crossline/core";

/** At most this many files go up from one picked folder; past it the most recently changed are kept. */
export const FOLDER_UPLOAD_LIMIT = 60;

export type PickedFile = { path: string; size: number; modified: number };
export type FolderUploadPlan = {
  /** Read and uploaded unless the person unticks one. */
  upload: string[];
  /** Look like private papers: left out unless ticked back, as an authorized folder does. */
  sensitive: Array<{ path: string; reason: string }>;
  /** Never uploaded and cannot be ticked back. */
  credentials: number;
  /** Kinds the app cannot read, hidden and dependency folders, and files over the size limit. */
  skipped: number;
  /** Readable files left out because the folder held more than the limit (the oldest go). */
  over: number;
};

/**
 * What a folder picked in the browser sends up (2026-10-16). The hosted app cannot read a path on the person's computer, so the browser
 * uploads the files; the rules are the authorized folder's own (`@crossline/core` source-folders), applied before anything leaves the
 * machine: hidden and dependency folders skipped, credentials never sent, private-looking papers left out unless ticked back.
 */
export function planFolderUpload(files: PickedFile[], names: readonly string[] = []): FolderUploadPlan {
  const readable: PickedFile[] = [];
  const sensitive: FolderUploadPlan["sensitive"] = [];
  let credentials = 0, skipped = 0;
  for (const file of files) {
    const path = file.path.replace(/\\/g, "/");
    // The first segment is the picked folder itself, which is always read.
    const directories = path.split("/").slice(1, -1);
    if (directories.some(skipFolderDirectory)) { skipped += 1; continue; }
    if (credentialName(path)) { credentials += 1; continue; }
    const action = folderFileAction(path, file.size);
    if (action.action !== "read") { skipped += 1; continue; }
    const reason = sensitiveName(path, names);
    if (reason) { sensitive.push({ path, reason }); continue; }
    readable.push({ ...file, path });
  }
  readable.sort((a, b) => b.modified - a.modified);
  return { upload: readable.slice(0, FOLDER_UPLOAD_LIMIT).map((file) => file.path), sensitive, credentials, skipped,
    over: Math.max(0, readable.length - FOLDER_UPLOAD_LIMIT) };
}
