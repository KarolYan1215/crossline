import { isSecretPath } from "./agent-guard";
import { sourceKindFor, type SourceKind } from "./source-kinds";

/**
 * Folders the person authorized (docs/onboarding-v3.md 「文件夹授权」, decided 2026-10-14): every readable file under them is read —
 * recursively, skipping version control, dependencies, caches and anything that looks like a secret — and kept up to date in the
 * background, so later planning and material preparation start from what the person already has. A file over 50 MB is recorded by
 * name only. A folder belongs to one or more lines, proposed by a model from its name and contents and changeable by the person.
 */
export const SOURCE_FOLDERS_SETTING = "sources.folders";
/** Per folder, what was read: relative path → size, modification time and the document it became. */
export const sourceFolderIndexSetting = (id: string) => `sources.folder.index:${id}`;

export const FOLDER_FILE_LIMIT = 50 * 1024 * 1024;
/** Files read from one folder at most; a folder with more is read up to here and says so. */
export const FOLDER_MAX_FILES = 1000;
/** Entries walked at most, so a folder that is really a whole disk cannot hold the worker. */
export const FOLDER_MAX_ENTRIES = 20_000;

export type SourceFolder = {
  id: string;
  /** The absolute path as the person gave it. */
  path: string;
  label: string;
  addedAt: string;
  /** Lines this folder serves; `linesBy` says who decided — the model's proposal is replaced, the person's never is. */
  lines: string[];
  linesBy: "" | "model" | "person";
  /** The model's reason for its proposal, shown beside it. */
  linesWhy?: string;
  lastScanAt?: string;
  files?: number;
  /** Files recorded by name only (over 50 MB, or a kind the app cannot read yet). */
  nameOnly?: number;
  bytes?: number;
  capped?: boolean;
  lastError?: string;
};

export type FolderIndexEntry = { size: number; mtimeMs: number; documentId: string };

export function readSourceFolders(raw: string | undefined): SourceFolder[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is SourceFolder =>
      typeof item === "object" && item !== null && typeof (item as SourceFolder).id === "string" && typeof (item as SourceFolder).path === "string") : [];
  } catch { return []; }
}

/** Directories never walked into: version control, dependencies, build output, caches, the recycle bin, and anything hidden. */
const SKIP_DIRECTORY = /^(?:\..*|node_modules|__pycache__|venv|env|dist|build|out|target|bin|obj|cache|caches|tmp|temp|\$recycle\.bin|system volume information)$/i;
export const skipFolderDirectory = (name: string) => SKIP_DIRECTORY.test(name);

/** Office files the app records by name until it can read them (slides, spreadsheets, the old Word format). */
const NAME_ONLY = /\.(pptx?|xlsx?|doc|key|numbers|pages)$/i;

/**
 * What to do with one file found in a folder: read it (a kind the app reads, within the limit), keep only its name (too large, or a
 * kind it cannot read yet), or leave it alone entirely (a secret, a hidden file, anything else — pictures and audio included, which
 * are personal and better uploaded on purpose).
 */
export function folderFileAction(relativePath: string, size: number): { action: "read"; kind: SourceKind } | { action: "name_only"; reason: string } | { action: "skip" } {
  const name = relativePath.split(/[\\/]/).pop() ?? relativePath;
  if (!name || name.startsWith(".") || name.startsWith("~$") || isSecretPath(relativePath.replace(/\\/g, "/"))) return { action: "skip" };
  const kind = sourceKindFor(name, "");
  if (kind === "pdf" || kind === "docx" || kind === "text") {
    return size > FOLDER_FILE_LIMIT ? { action: "name_only", reason: "超过 50 MB，只记文件名" } : { action: "read", kind };
  }
  if (NAME_ONLY.test(name)) return { action: "name_only", reason: "这种文件暂时读不了正文，只记文件名" };
  return { action: "skip" };
}

/**
 * Why a path cannot be authorized, in the person's words, or undefined. Not a whole drive, not the user folder itself, not the system's
 * own folders: authorizing those would read far more than anyone meant to hand over.
 */
export function folderPathProblem(path: string, options: { home?: string; appData?: string } = {}): string | undefined {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  if (!/^[A-Za-z]:[\\/]|^\//.test(path.trim())) return "需要完整路径，例如 D:\\课程资料";
  if (/^[A-Za-z]:$/.test(trimmed) || trimmed === "") return "不能授权整个磁盘，请选一个具体的文件夹";
  const lower = trimmed.toLowerCase().replace(/\//g, "\\");
  if (options.home && lower === options.home.toLowerCase().replace(/\//g, "\\").replace(/\\+$/, "")) return "不能授权整个用户文件夹，请选其中一个具体的文件夹";
  if (/^[a-z]:\\(windows|program files( \(x86\))?|programdata)(\\|$)/.test(lower)) return "系统文件夹不能授权";
  // Applications' own data (settings, tokens, browser profiles) — but not the temporary folder, where an unzipped download may sit.
  if (/\\appdata(\\|$)/.test(lower) && !/\\appdata\\local\\temp\\./.test(lower)) return "应用数据文件夹不能授权";
  if (options.appData && lower.startsWith(options.appData.toLowerCase().replace(/\//g, "\\").replace(/\\+$/, ""))) return "Crossline 自己的数据文件夹不能授权";
  return undefined;
}

/** The last part of a path, as the folder's default name. */
export const folderLabel = (path: string) => path.trim().replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;

/** The classifier's answer (Skill `crossline-folder-classifier`): which lines each folder serves, possibly several, possibly none. */
export type FolderLinesAnswer = { folders: Array<{ id: string; lineIds: string[]; why: string }> };
export const FOLDER_LINES_SCHEMA = { type: "object", additionalProperties: false, required: ["folders"], properties: {
  folders: { type: "array", maxItems: 20, items: { type: "object", additionalProperties: false, required: ["id", "lineIds", "why"], properties: {
    id: { type: "string", minLength: 1, maxLength: 40 }, lineIds: { type: "array", maxItems: 8, items: { type: "string", minLength: 1, maxLength: 80 } },
    why: { type: "string", maxLength: 200 } } } } } } as const;

/** Keeps an answer for each folder asked about, with only lines that exist; an unknown folder or line is dropped, not refused. */
export function validateFolderLines(value: unknown, folderIds: string[], lineIds: string[]): FolderLinesAnswer {
  const answer = value as FolderLinesAnswer | undefined;
  if (!answer || !Array.isArray(answer.folders)) throw new Error("FOLDER_LINES_INVALID");
  const asked = new Set(folderIds), lines = new Set(lineIds), seen = new Set<string>();
  return { folders: answer.folders.filter((item) => item && asked.has(item.id) && !seen.has(item.id) && Boolean(seen.add(item.id)))
    .map((item) => ({ id: item.id, lineIds: [...new Set((Array.isArray(item.lineIds) ? item.lineIds : []).filter((id) => lines.has(id)))],
      why: String(item.why ?? "").trim().slice(0, 200) })) };
}
