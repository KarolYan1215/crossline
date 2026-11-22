import { FOLDER_UPLOAD_LIMIT, planFolderUpload } from "./folder-pick";

/**
 * How files reach the interview (docs/plans/2026-11-22-interview-and-import-redesign.md §四.1–2, 6): several files and several folders at
 * once — dropped (every folder walked, `readEntries` read until it answers nothing, since it gives at most about a hundred at a time),
 * picked with the system's folder dialog where the browser has one (`showDirectoryPicker`), or with `webkitdirectory` where it does not —
 * and sent several at a time, one file a request, so one bad file fails alone. Nothing is asked first: pressing is the decision.
 */
export type PickedFolder = { name: string; files: Array<{ path: string; file: File }> };

type Entry = { isFile: boolean; isDirectory: boolean; name: string; fullPath?: string;
  file?: (ok: (file: File) => void, fail: (error: unknown) => void) => void;
  createReader?: () => { readEntries: (ok: (entries: Entry[]) => void, fail: (error: unknown) => void) => void } };

/** Every entry of a dropped folder: `readEntries` answers in batches, so it is called until it answers an empty one. */
async function readAll(directory: Entry): Promise<Entry[]> {
  const reader = directory.createReader?.();
  if (!reader) return [];
  const all: Entry[] = [];
  for (;;) {
    const batch = await new Promise<Entry[]>((resolve) => reader.readEntries(resolve, () => resolve([])));
    if (!batch.length) return all;
    all.push(...batch);
  }
}

async function walk(entry: Entry, prefix: string, into: PickedFolder["files"]): Promise<void> {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile && entry.file) {
    const file = await new Promise<File | undefined>((resolve) => entry.file!(resolve, () => resolve(undefined)));
    if (file) into.push({ path, file });
    return;
  }
  if (entry.isDirectory) for (const child of await readAll(entry)) await walk(child, path, into);
}

/** What was dropped: loose files as they are, and each folder with its files' paths (the folder's own name first, as `webkitdirectory` gives). */
export async function collectDropped(transfer: DataTransfer): Promise<{ loose: File[]; folders: PickedFolder[] }> {
  const items = [...(transfer.items ?? [])].filter((item) => item.kind === "file");
  // Entries must be taken synchronously, before the first await: the list empties once the drop event returns.
  const entries = items.map((item) => (item as DataTransferItem & { webkitGetAsEntry?: () => Entry | null }).webkitGetAsEntry?.() ?? null);
  if (!entries.some((entry) => entry?.isDirectory)) return { loose: [...transfer.files], folders: [] };
  const loose: File[] = [];
  const folders: PickedFolder[] = [];
  for (const [index, entry] of entries.entries()) {
    if (entry?.isDirectory) { const files: PickedFolder["files"] = []; await walk(entry, "", files); folders.push({ name: entry.name, files }); }
    else { const file = items[index]!.getAsFile(); if (file) loose.push(file); }
  }
  return { loose, folders };
}

type HandleChild = { kind: "file" | "directory"; name: string; getFile?: () => Promise<File>; values?: () => AsyncIterable<HandleChild> };
type DirectoryHandle = { name: string; values: () => AsyncIterable<HandleChild> };
/** Whether this browser has the system's folder dialog (Chromium); elsewhere the `webkitdirectory` input is the fallback. */
export const canPickDirectory = () => typeof window !== "undefined" && typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";

async function walkHandle(handle: DirectoryHandle, prefix: string, into: PickedFolder["files"]): Promise<void> {
  for await (const child of handle.values()) {
    const path = `${prefix}/${child.name}`;
    if (child.kind === "file" && child.getFile) into.push({ path, file: await child.getFile() });
    else if (child.kind === "directory" && child.values) await walkHandle({ name: child.name, values: child.values.bind(child) }, path, into);
  }
}

/** One folder from the system's dialog, read in the page (read access only); undefined when the person closed the dialog. */
export async function pickDirectory(): Promise<PickedFolder | undefined> {
  const picker = (window as unknown as { showDirectoryPicker: (options: { mode: "read" }) => Promise<DirectoryHandle> }).showDirectoryPicker;
  const handle = await picker({ mode: "read" }).catch(() => undefined);
  if (!handle) return undefined;
  const files: PickedFolder["files"] = [];
  await walkHandle(handle, handle.name, files);
  return { name: handle.name, files };
}

/** A `webkitdirectory` input's files as one folder (that input gives one folder at a time). */
export function folderFromInput(list: FileList | null): PickedFolder | undefined {
  const files = [...(list ?? [])].map((file) => ({ path: (file.webkitRelativePath || file.name).replace(/\\/g, "/"), file }));
  return files.length ? { name: files[0]!.path.split("/")[0] ?? "", files } : undefined;
}

export type FolderChoice = { files: File[]; left: { credentials: number; sensitive: number; skipped: number; screened: number }; why: string };

/**
 * What goes up from a folder: code first leaves out credentials, private papers (in a folder they are skipped, D15), hidden and dependency
 * folders and what the app cannot read; then the model screens the rest by name, format, size and date (`screen`, the server route);
 * without its answer the most recently changed files up to the limit go.
 */
export async function chooseFromFolder(folder: PickedFolder, screen: (body: unknown) => Promise<{ ok?: boolean; keep?: string[]; why?: string } | undefined>): Promise<FolderChoice> {
  const byPath = new Map(folder.files.map((item) => [item.path, item.file]));
  const plan = planFolderUpload(folder.files.map((item) => ({ path: item.path, size: item.file.size, modified: item.file.lastModified })));
  let keep = plan.upload, why = "";
  if (plan.readable.length > 1) {
    const answer = await screen({ folder: folder.name, limit: FOLDER_UPLOAD_LIMIT,
      files: plan.readable.map((path) => ({ path, size: byPath.get(path)!.size, modified: byPath.get(path)!.lastModified })) }).catch(() => undefined);
    if (answer?.ok && Array.isArray(answer.keep)) { keep = answer.keep.filter((path) => byPath.has(path)).slice(0, FOLDER_UPLOAD_LIMIT); why = answer.why ?? ""; }
  }
  return { files: keep.map((path) => byPath.get(path)!), why,
    left: { credentials: plan.credentials, sensitive: plan.sensitive.length, skipped: plan.skipped, screened: plan.readable.length - keep.length } };
}

/** Requests in flight at once: enough to keep the server's readers busy, few enough not to queue behind each other. */
export const UPLOAD_CONCURRENCY = 5;
export type UploadOutcome = { file: File; ok: boolean; refused?: string; deferred?: boolean };

/** Sends each file on its own request, `UPLOAD_CONCURRENCY` at a time; a failed one is reported and the rest go on. */
export async function uploadInParallel(files: File[], send: (file: File) => Promise<{ ok: boolean; refused?: string; deferred?: boolean }>,
  onProgress?: (done: number) => void): Promise<UploadOutcome[]> {
  const outcomes: UploadOutcome[] = new Array(files.length);
  let next = 0, done = 0;
  const lane = async () => {
    while (next < files.length) {
      const index = next++;
      const file = files[index]!;
      const result = await send(file).catch(() => ({ ok: false }));
      outcomes[index] = { file, ...result };
      onProgress?.(++done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, files.length) }, lane));
  return outcomes;
}
