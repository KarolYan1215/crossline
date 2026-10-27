import { isSecretPath } from "./agent-guard";
import { sourceKindFor, type SourceKind } from "./source-kinds";
import { tFor, type Locale } from "./i18n";

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
/** Files read from one folder at most; a folder with more reads its most recently changed files up to here and says how many are left. */
export const FOLDER_MAX_FILES = 1000;
/**
 * Entries walked at most, so a folder that is really a whole disk cannot hold the worker. Files whose name rules them out are never
 * stat'ed, so this is a count of names, not of disk reads.
 */
// ponytail: a real desktop holds ~160k entries; past 200k the scan stops and says so — a persisted walk cursor if anyone needs more.
export const FOLDER_MAX_ENTRIES = 200_000;

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
  /** Readable files beyond `FOLDER_MAX_FILES` (the least recently changed), not read. */
  over?: number;
  /** Copies whose content equals a file already read here, read once. */
  duplicates?: number;
  lastError?: string;
  /**
   * The person's exclusions, kept with the authorization and obeyed on every scan: relative paths with `/`, a pattern with `*`/`**`, or a
   * subfolder (which excludes everything under it).
   */
  exclude?: string[];
  /** Files the scan suspected as sensitive that the person chose to have read anyway. */
  include?: string[];
  /** The last scan's suspected-sensitive files, left unread unless the person includes them; `hard` ones (credentials) never are. */
  autoExcluded?: Array<{ relative: string; reason: string; hard?: true }>;
  /** The person's own names (the account's, given when authorizing), for spotting records that carry them. */
  names?: string[];
};

/**
 * `hard`: the text held a credential, so it is never read even if the person asks.
 * `created`: this folder's read made the document (rather than meeting an upload with the same content), so removing the folder's
 * content may delete it. `sensitive`: the file's text looked sensitive when read, so nothing was kept. `flagged`: it did, but the person
 * included it, so it was kept — and goes again if they take that back.
 */
export type FolderIndexEntry = { size: number; mtimeMs: number; documentId: string; created?: boolean; sensitive?: string; flagged?: string; hard?: true;
  /**
   * A recording (docs/phone-recording.md), seen while 录音自动转写 was on: `queued` waits for the one transcription at a time, `done`
   * became the transcript `documentId` names, `silent` held no speech, `failed` says why in `note`. The audio itself is never copied.
   */
  audio?: "queued" | "done" | "silent" | "failed"; note?: string };

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
 * 录音自动转写 (docs/phone-recording.md, 2026-10-20): whether recordings that land in an authorized folder — a phone recorder's files
 * synced by iCloud Drive or Syncthing — are transcribed on this machine. Off by default; `granted` turns it on.
 */
export const RECORDING_CONSENT = "recordings.autoTranscribe";
/** The formats phone recorders write. */
export const RECORDING_FILE = /\.(m4a|mp3|wav|aac|opus|ogg|webm|flac)$/i;
/** A recording larger than this is recorded by name only (an hour of uncompressed stereo is about 600 MB). */
export const RECORDING_FILE_LIMIT = 500 * 1024 * 1024;

/**
 * What to do with one file found in a folder: read it (a kind the app reads, within the limit), keep only its name (too large, or a
 * kind it cannot read yet), transcribe it (a recording, only with `audio`, which is 录音自动转写), or leave it alone entirely (a secret,
 * a hidden file, anything else — pictures included, and audio without that consent, which are personal and better uploaded on purpose).
 */
export function folderFileAction(relativePath: string, size: number, options: { audio?: boolean; locale?: Locale | undefined } = {}):
  { action: "read"; kind: SourceKind } | { action: "name_only"; reason: string } | { action: "audio" } | { action: "skip" } {
  const t = tFor(options.locale);
  const name = relativePath.split(/[\\/]/).pop() ?? relativePath;
  if (!name || name.startsWith(".") || name.startsWith("~$") || isSecretPath(relativePath.replace(/\\/g, "/"))) return { action: "skip" };
  if (options.audio && RECORDING_FILE.test(name)) return size > RECORDING_FILE_LIMIT ? { action: "name_only", reason: t("录音超过 500 MB，没有转写") } : { action: "audio" };
  const kind = sourceKindFor(name, "");
  if (kind === "pdf" || kind === "docx" || kind === "text") {
    return size > FOLDER_FILE_LIMIT ? { action: "name_only", reason: t("超过 50 MB，只记文件名") } : { action: "read", kind };
  }
  if (NAME_ONLY.test(name)) return { action: "name_only", reason: t("这种文件暂时读不了正文，只记文件名") };
  return { action: "skip" };
}

/**
 * A file name read as words: camelCase, letter–digit seams and `_ - () [] .` all split, lower case, wrapped in spaces so a rule can ask
 * for whole words (` tax `). `YanKai9262026TaxDocs.pdf` → ` yan kai 9262026 tax docs pdf `. Chinese stays in runs, matched as text.
 */
export function nameWords(path: string): string {
  return ` ${path.replace(/\\/g, "/")
    .replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2").replace(/(\d)([A-Za-z])/g, "$1 $2")
    .toLowerCase()
    .replace(/([a-z0-9])(?=[㐀-鿿])/g, "$1 ").replace(/([㐀-鿿])(?=[a-z0-9])/g, "$1 ")
    .replace(/[^a-z0-9㐀-鿿]+/g, " ").trim()} `;
}

/**
 * Credentials: never read and never offered back (the owner's decision of 2026-10-15, after Downloads held an `AccessKey.txt` and two
 * API-key exports). The worker enforces it whatever the page sends. A word that only looks like one (a lecture on tokens) is left out
 * too: a credential handed to a model cannot be taken back, a lecture can be uploaded on purpose.
 */
const CREDENTIAL_WORDS = / (api ?keys?|access ?keys?|secrets?|tokens?|credentials?|passwords?|passwd|private keys?|recovery codes?|backup codes?|seed phrase) |私钥|密钥|密码(?!学)|恢复码|助记词/;
const CREDENTIAL_FILE = /\.(pem|key|p12|pfx)$|(^|\/)\.env(\.[^/]*)?$/i;
export function credentialName(relativePath: string): string | undefined {
  const path = relativePath.replace(/\\/g, "/");
  return CREDENTIAL_FILE.test(path) || CREDENTIAL_WORDS.test(nameWords(path)) ? "凭据" : undefined;
}

/** A key in a text file's opening (the first 2 KB): a known key format, a PEM block, or a long key-like string beside key/secret. */
export function credentialText(text: string): string | undefined {
  const head = text.slice(0, 2048);
  if (/(?<![A-Za-z0-9])(sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|xox[bp]-[A-Za-z0-9-]{10,})|-----BEGIN /.test(head)) return "凭据";
  return head.split(/\r?\n/).some((line) => /key|secret|token|密钥/i.test(line) && /(?<![A-Za-z0-9+/])([A-Za-z0-9+/]{32,}={0,2}|[0-9a-fA-F]{32,})(?![A-Za-z0-9+/])/.test(line))
    ? "凭据" : undefined;
}

/**
 * Files that look like the person's private papers (decided 2026-10-15, after a real Downloads and Desktop held proof of funds, a Social
 * Security application, tax documents, immigration forms, receipts, an offer and reports carrying the person's name and student number):
 * not read unless the person ticks them back. Judged on the words of the name and its folders, in English and Chinese; a wrong guess
 * costs one tick in the preview, a missed one hands a model an ID.
 */
const SENSITIVE_NAMES: Array<[string, RegExp]> = [
  ["证件", / (passports?|driver( s)? licen[cs]es?|id cards?) |护照|身份证|驾照|驾驶证/],
  ["移民与签证", / (imm \d{4}|i 20|i 9[045]|i 901|sevis|ds 160|visas?|permits?) |签证|移民|居留/],
  // Bare 「ssn」 is also a spiking neural network (「Memory-Based-Learning-SSN-HDC.pptx」), so it counts only beside a card, number or form.
  ["社安号", / (social security|ssn (cards?|numbers?|applications?|pdf|jpe?g|png)) |社安号|社会安全号/],
  ["银行与流水", / bank statements? |银行|流水(?!线)|对账单/],
  ["税表", / (tax|taxes|w 2|1040) |税/],
  ["资金证明", / (affidavit|financial support) |资金证明|存款证明/],
  ["付款与收据", / (receipts?|payments?|invoices?) |发票|收据|报价单|缴费/],
  ["保险与医疗", / (insurance|dental|medical|vaccinations?|consent forms?|benefits? summary) |保险|疫苗|知情同意|病历|体检/],
  ["录用与薪资", / (onboarding|offer letters?|fellowships?|stipends?|salary|salaries|payroll) |工资|录用/],
  ["车辆与证件申请", / (mv \d+|application forms?) |申请表/],
  ["合同与租约", / leases? |合同|租约/],
  ["个人档案", / (enrollment|employment|income) verification |查重报告|检测报告|报告单|智评|在读证明|在职证明/]
];

/** A digit run that is a student or account number rather than a date or timestamp (`20260129…`). */
const idNumber = (digits: string) => digits.length >= 7 && !/^(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])/.test(digits);

/**
 * A report or record that carries the person: a Chinese name (two to four characters) right beside a long number, as in
 * 「颜开2254009毕业论文开题报告」 or 「[颜开_2254009]」, or one of the person's own names anywhere in the path with such a number.
 */
function personalRecord(path: string, names: readonly string[]): boolean {
  const runs = path.match(/[㐀-鿿]+|\d+|[_\- ]|[^㐀-鿿\d_\- ]+/g) ?? [];
  const cjkName = (run: string | undefined) => Boolean(run && /^[㐀-鿿]{2,4}$/.test(run));
  for (let index = 0; index < runs.length; index += 1) {
    if (!/^\d+$/.test(runs[index]!) || !idNumber(runs[index]!)) continue;
    const before = /^[_\- ]$/.test(runs[index - 1] ?? "") ? runs[index - 2] : runs[index - 1];
    const after = /^[_\- ]$/.test(runs[index + 1] ?? "") ? runs[index + 2] : runs[index + 1];
    if (cjkName(before) || cjkName(after)) return true;
  }
  const words = nameWords(path);
  if (!(words.match(/ \d+ /g) ?? []).some((run) => idNumber(run.trim()))) return false;
  return names.some((name) => {
    if (/[㐀-鿿]/.test(name)) return path.includes(name.trim());
    const parts = nameWords(name).trim().split(" ").filter((part) => part && !/^\d+$/.test(part));
    if (!parts.length) return false;
    return words.includes(` ${parts.join(" ")} `) || (parts.length > 1 && words.includes(` ${[...parts].reverse().join(" ")} `));
  });
}

/** The kind of private paper a path suggests, in the person's words, or undefined. `names` are the person's own names, if known. */
export function sensitiveName(relativePath: string, names: readonly string[] = []): string | undefined {
  const path = relativePath.replace(/\\/g, "/");
  const words = nameWords(path);
  // A Chinese e-invoice is saved as 「<seller's unified social credit code>_<invoice number>.pdf」: the code is 18 characters with letters.
  if (/(?<![0-9a-z])(?=[0-9a-z]*[a-z])[0-9a-hj-npqrtuwxy]{2}\d{6}[0-9a-hj-npqrtuwxy]{10}(?![0-9a-z])/i.test(path)) return "付款与收据";
  return SENSITIVE_NAMES.find(([, pattern]) => pattern.test(words))?.[0] ?? (personalRecord(path, names) ? "个人档案" : undefined);
}

const luhn = (digits: string) => {
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
  }
  return sum % 10 === 0;
};
/** GB 11643 check digit of an 18-digit resident ID. */
const chineseIdValid = (id: string) => {
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const sum = weights.reduce((total, weight, index) => total + weight * Number(id[index]), 0);
  return "10X98765432"[sum % 11] === id[17]!.toUpperCase();
};

/** Text read from a file's opening (the first 2 KB is enough) that carries an ID or account number; undefined when none. */
export function sensitiveText(text: string): string | undefined {
  const head = text.slice(0, 2048);
  if (/(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/.test(head)) return "社安号";
  for (const match of head.matchAll(/(?<![\dA-Za-z])\d{17}[\dXx](?![\dA-Za-z])/g)) if (chineseIdValid(match[0])) return "身份证号";
  for (const match of head.matchAll(/(?<!\d)(?:\d{4}[ -]?){3}\d{1,7}(?!\d)/g)) {
    const digits = match[0].replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && !/^(\d)\1+$/.test(digits) && luhn(digits)) return "银行卡号";
  }
  return undefined;
}

const globSource = (pattern: string) => pattern.split("/").map((part) => part === "**" ? "\u0000"
  : part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")).join("/")
  .replace(/\u0000\//g, "(?:.*/)?").replace(/\/?\u0000/g, "(?:/.*)?");
/**
 * Whether a person's exclusion pattern covers a relative path. A plain path covers itself and, as a subfolder, everything under it; a
 * glob matches paths as written, `*` inside one folder and `**` across folders — so `*` alone is the folder's own top-level files.
 * Case-insensitive, as Windows paths are.
 */
export function folderPatternMatches(pattern: string, relativePath: string): boolean {
  const path = relativePath.replace(/\\/g, "/");
  const clean = pattern.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!clean) return false;
  return new RegExp(`^${globSource(clean)}${/[*?]/.test(clean) ? "" : "(?:/.*)?"}$`, "i").test(path);
}
/** The pattern that leaves out one preview group: a subfolder by name, or the folder's own top-level files. */
export const groupPattern = (group: string) => group || "*";
export const excludedByRules = (relativePath: string, exclude: readonly string[] | undefined) =>
  (exclude ?? []).some((pattern) => folderPatternMatches(pattern, relativePath));

/** The top-level subfolder a file sits in, or "" for the folder's own files: the preview's groups. */
export const folderGroup = (relativePath: string) => { const parts = relativePath.replace(/\\/g, "/").split("/"); return parts.length > 1 ? parts[0]! : ""; };

/** The rules as stored: relative patterns only (no drive, no `..`), trimmed, unique, bounded. Anything else is dropped. */
export function cleanFolderRules(value: { exclude?: unknown; include?: unknown } | undefined): { exclude: string[]; include: string[] } {
  const clean = (list: unknown) => [...new Set((Array.isArray(list) ? list : []).filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""))
    .filter((item) => item && item.length <= 300 && !/^[A-Za-z]:/.test(item) && !item.split("/").includes("..")))].slice(0, 500);
  return { exclude: clean(value?.exclude), include: clean(value?.include) };
}

/** The person's names as given with an authorization: short strings only, at most eight. */
export const cleanFolderNames = (value: unknown) => [...new Set((Array.isArray(value) ? value : [])
  .filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter((item) => item.length >= 2 && item.length <= 60))].slice(0, 8);

/**
 * Why a path cannot be authorized, in the person's words, or undefined. Not a whole drive, not the user folder itself, not the system's
 * own folders: authorizing those would read far more than anyone meant to hand over.
 */
export function folderPathProblem(path: string, options: { home?: string; appData?: string; locale?: Locale } = {}): string | undefined {
  const t = tFor(options.locale);
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  if (!/^[A-Za-z]:[\\/]|^\//.test(path.trim())) return t("需要完整路径，例如 D:\\课程资料");
  if (/^[A-Za-z]:$/.test(trimmed) || trimmed === "") return t("不能授权整个磁盘，请选一个具体的文件夹");
  const lower = trimmed.toLowerCase().replace(/\//g, "\\");
  if (options.home && lower === options.home.toLowerCase().replace(/\//g, "\\").replace(/\\+$/, "")) return t("不能授权整个用户文件夹，请选其中一个具体的文件夹");
  if (/^[a-z]:\\(windows|program files( \(x86\))?|programdata)(\\|$)/.test(lower)) return t("系统文件夹不能授权");
  // Applications' own data (settings, tokens, browser profiles) — but not the temporary folder, where an unzipped download may sit.
  if (/\\appdata(\\|$)/.test(lower) && !/\\appdata\\local\\temp\\./.test(lower)) return t("应用数据文件夹不能授权");
  if (options.appData && lower.startsWith(options.appData.toLowerCase().replace(/\//g, "\\").replace(/\\+$/, ""))) return t("Crossline 自己的数据文件夹不能授权");
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
