import { credentialName, folderFileAction, sensitiveName, skipFolderDirectory } from "@crossline/core";

/** At most this many files go up from one picked folder: the model's screening picks them, or else the most recently changed. */
export const FOLDER_UPLOAD_LIMIT = 60;

export type PickedFile = { path: string; size: number; modified: number };
export type FolderUploadPlan = {
  /** Every readable file, most recently changed first: what the model's screening chooses from. */
  readable: string[];
  /** Without the screening: the most recently changed readable files, up to the limit. */
  upload: string[];
  /** Look like private papers: skipped in a folder (D15, 2026-11-22); a paper the person wants read is given on its own. */
  sensitive: Array<{ path: string; reason: string }>;
  /** Never uploaded. */
  credentials: number;
  /** Kinds the app cannot read, hidden and dependency folders, and files over the size limit. */
  skipped: number;
  /** Readable files past the limit (the oldest), when there is no screening. */
  over: number;
};

/**
 * What a folder picked in the browser may send up (2026-10-16). The hosted app cannot read a path on the person's computer, so the browser
 * uploads the files; the rules are the authorized folder's own (`@crossline/core` source-folders), applied before anything leaves the
 * machine: hidden and dependency folders skipped, credentials never sent, private-looking papers skipped.
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
  return { readable: readable.map((file) => file.path), upload: readable.slice(0, FOLDER_UPLOAD_LIMIT).map((file) => file.path), sensitive, credentials, skipped,
    over: Math.max(0, readable.length - FOLDER_UPLOAD_LIMIT) };
}
