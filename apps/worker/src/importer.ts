import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import {
  IMPORT_BATCHES_KEEP, IMPORT_BATCHES_SETTING, IMPORT_BATCH_MAX, IMPORT_DAILY_CAPTURES, IMPORT_DAILY_HOURS, IMPORT_KIND_LABEL, IMPORT_SEEN_SETTING,
  IMPORT_SERVICE_KINDS, IMPORT_SOURCES_SETTING, IMPORT_TRIAGE_CHUNK, IMPORT_TRIAGE_SCHEMA, importCaptureId, importDuplicateOf, importOrigin, importSecretName,
  itemsFromCsv, itemsFromNotion, itemsFromText, itemsFromTickTick, itemsFromTodoist, readImportBatches, readImportSeen, readImportSources, requiredApproval,
  ruleSuggestion, seenKey, ticked, validateImportTriage, type ImportBatch, type ImportBatchItem, type ImportItem, type ImportKind, type ImportServiceKind,
  type ImportSource, type ImportSuggestion, type ImportTriage, type MergeTask
} from "@crossline/core";
import {
  closeTodoistTask, listNotionDatabases, readNotionDatabase, readTickTick, readTodoist, TaskImportError, type ImportFetch, type SecretStore
} from "@crossline/connectors";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";
import { openTasks, recordFold } from "./duplicate-guard";
import { identityLines } from "./lines";
import { ownerOf } from "./owner";
import { tOfWorkspace } from "./locale";
import { sayToPerson } from "./workflow-smith";
import type { PictureToDescribe } from "./note-media";
import type { MediaDescription } from "@crossline/core";

/**
 * Bringing another tool's list in (docs/personal-agent.md §9; the shared shapes and parsers are in `packages/core/src/task-import.ts`).
 * A source is read, its items not seen before are put in a batch, `crossline-import-triage` sorts them a chunk at a time (intake work,
 * low tier), and the person confirms the batch once on the 「导入核对」 screen. Confirming writes the kept items as captures — analysed at
 * once like anything typed — folds the merged ones into the task they repeat, and remembers every item so it is never offered again.
 *
 * A connected tool is read again every day when the person left that on; its new items are sorted and applied by themselves (at most
 * `IMPORT_DAILY_CAPTURES` a day, the person told once), because they already agreed to the source. Todoist alone is written back to,
 * and only when its account's 「完成后在 Todoist 里关闭」 is on: an imported task finished here closes there.
 */
export const IMPORT_TRIAGE_SKILL = "crossline:crossline-import-triage";
/** Files the web writes for a paste, a CSV or a screenshot (`<dataDir>/imports/<workspace>/<name>`), read once and deleted. */
export const IMPORT_FILE = /^[a-z0-9-]{8,40}\.(png|jpg|webp|gif|csv|txt)$/;
const FILE_MAX = 8_000_000;

export type ImportDescribe = (pictures: PictureToDescribe[], notes: Array<{ id: string; title: string; desc: string; tags: string[] }>) => Promise<MediaDescription[]>;
export type ImportDeps = {
  store: CrosslineStore; secrets: SecretStore; dataDir: string; cwd: string;
  client: (workspaceId: string) => CodexRpcBoundary | undefined;
  /** Quota, engagement and the intake pause (sorting is intake work). */
  sortAllowed: (workspaceId: string) => Promise<boolean>;
  /** The picture reader on the account's own Codex (`crossline-media-describer`), for screenshots. */
  describe?: (workspaceId: string) => ImportDescribe | undefined;
  timeZone?: (workspaceId: string) => string | undefined;
  fetch?: ImportFetch; now?: () => Date;
  /** Items became captures: the analysis may start now. */
  onCaptured?: (workspaceId: string) => void;
  log?: (event: Record<string, unknown>) => void;
};

const nowOf = (deps: ImportDeps) => deps.now?.() ?? new Date();
const zoneOf = (deps: ImportDeps, workspaceId: string) => deps.timeZone?.(workspaceId) ?? "UTC";
export const importSources = (store: CrosslineStore, workspaceId: string) => readImportSources(store.getSetting(workspaceId, IMPORT_SOURCES_SETTING));
const saveSources = (store: CrosslineStore, workspaceId: string, list: ImportSource[]) => store.setSetting(workspaceId, IMPORT_SOURCES_SETTING, JSON.stringify(list));
const patchSource = (store: CrosslineStore, workspaceId: string, id: string, patch: Partial<ImportSource>) =>
  saveSources(store, workspaceId, importSources(store, workspaceId).map((item) => item.id === id ? { ...item, ...patch } : item));
export const importBatches = (store: CrosslineStore, workspaceId: string) => readImportBatches(store.getSetting(workspaceId, IMPORT_BATCHES_SETTING));
const saveBatches = (store: CrosslineStore, workspaceId: string, list: ImportBatch[]) =>
  store.setSetting(workspaceId, IMPORT_BATCHES_SETTING, JSON.stringify(list.slice(-IMPORT_BATCHES_KEEP)));
const seenOf = (store: CrosslineStore, workspaceId: string) => readImportSeen(store.getSetting(workspaceId, IMPORT_SEEN_SETTING));
function remember(store: CrosslineStore, workspaceId: string, items: ImportItem[]): void {
  const seen = seenOf(store, workspaceId);
  for (const item of items) {
    const list = new Set(seen[item.kind] ?? []);
    list.add(item.externalId);
    seen[item.kind] = [...list].slice(-5000);
  }
  store.setSetting(workspaceId, IMPORT_SEEN_SETTING, JSON.stringify(seen));
}
/** Items not brought in or set aside before, and not waiting in a batch already. */
function unseen(store: CrosslineStore, workspaceId: string, items: ImportItem[]): ImportItem[] {
  const seen = seenOf(store, workspaceId);
  const waiting = new Set(importBatches(store, workspaceId).flatMap((batch) => batch.items.map(seenKey)));
  return items.filter((item) => !(seen[item.kind] ?? []).includes(item.externalId) && !waiting.has(seenKey(item)));
}

const errorText = (deps: ImportDeps, workspaceId: string, error: unknown) => {
  const t = tOfWorkspace(deps.store, workspaceId);
  return error instanceof TaskImportError ? { code: error.code, message: t(error.message) } : { code: "IMPORT_FAILED", message: t("这个服务没有正常回应，稍后再试。") };
};

/** What one source holds now, as items. */
async function readSource(deps: ImportDeps, workspaceId: string, source: Pick<ImportSource, "kind" | "databaseId">, token: string): Promise<ImportItem[]> {
  const zone = zoneOf(deps, workspaceId);
  if (source.kind === "todoist") { const read = await readTodoist(token, deps.fetch); return itemsFromTodoist(read.tasks, read.projects, zone); }
  if (source.kind === "ticktick") return itemsFromTickTick(await readTickTick(token, deps.fetch), zone);
  return itemsFromNotion(await readNotionDatabase(token, source.databaseId ?? "", deps.fetch), zone);
}

/** What the settings card and the confirmation screen show: sources without tokens, and the batches waiting. */
export function importView(store: CrosslineStore, workspaceId: string) {
  const lines = identityLines(store, workspaceId).map((line) => ({ id: line.id, label: line.label }));
  return { sources: importSources(store, workspaceId), batches: importBatches(store, workspaceId), lines };
}

/**
 * Connects a tool after one successful read. A Notion token with no database chosen answers with the databases shared with it instead
 * (nothing is kept); the person picks one and sends both again.
 */
export async function connectSource(deps: ImportDeps, workspaceId: string, input: { kind: string; token: string; databaseId?: string; label?: string }):
  Promise<{ ok: true; source: ImportSource; batchId?: string } | { ok: true; databases: Array<{ id: string; title: string }> } | { ok: false; code: string; message: string }> {
  const t = tOfWorkspace(deps.store, workspaceId);
  const kind = input.kind as ImportServiceKind;
  if (!IMPORT_SERVICE_KINDS.includes(kind)) return { ok: false, code: "IMPORT_KIND_UNKNOWN", message: t("不认识这个来源。") };
  const token = input.token.trim();
  if (!token || token.length > 400 || /\s/.test(token)) return { ok: false, code: "IMPORT_TOKEN_REQUIRED", message: t("请粘贴完整的令牌。") };
  const databaseId = (input.databaseId ?? "").replace(/-/g, "").trim();
  try {
    if (kind === "notion" && !databaseId) {
      const databases = await listNotionDatabases(token, deps.fetch);
      if (!databases.length) return { ok: false, code: "IMPORT_NOTION_NO_DATABASE", message: t("这个集成还看不到任何数据库：在 Notion 里打开要导入的数据库，点右上角「…」→「连接」，选这个集成。") };
      return { ok: true, databases };
    }
    const items = await readSource(deps, workspaceId, { kind, databaseId }, token);
    const id = randomUUID().slice(0, 8);
    await deps.secrets.write(workspaceId, importSecretName(id), token);
    const databaseTitle = kind === "notion" ? (await listNotionDatabases(token, deps.fetch).catch(() => [])).find((item) => item.id.replace(/-/g, "") === databaseId)?.title : undefined;
    const source: ImportSource = { id, kind, label: input.label?.trim().slice(0, 40) || databaseTitle || IMPORT_KIND_LABEL[kind], addedAt: nowOf(deps).toISOString(),
      ...(kind === "notion" ? { databaseId, ...(databaseTitle ? { databaseTitle } : {}) } : {}), daily: true, writeBack: false,
      lastReadAt: nowOf(deps).toISOString(), lastItems: items.length };
    saveSources(deps.store, workspaceId, [...importSources(deps.store, workspaceId), source]);
    deps.store.appendEvent({ ownerId: ownerOf(deps.store, workspaceId), workspaceId, idempotencyKey: `import.connected:${id}`, type: "import.connected", entityId: id,
      payload: { kind, label: source.label } });
    const batch = startBatch(deps, workspaceId, { kind, sourceId: id, label: source.label, items });
    return { ok: true, source, ...(batch ? { batchId: batch.id } : {}) };
  } catch (error) { return { ok: false, ...errorText(deps, workspaceId, error) }; }
}

/** Disconnects a tool: its token is deleted at once; what was imported stays, and is still never offered again. */
export function removeSource(deps: ImportDeps, workspaceId: string, id: string): boolean {
  const list = importSources(deps.store, workspaceId);
  if (!list.some((item) => item.id === id)) return false;
  saveSources(deps.store, workspaceId, list.filter((item) => item.id !== id));
  void deps.secrets.remove(workspaceId, importSecretName(id));
  saveBatches(deps.store, workspaceId, importBatches(deps.store, workspaceId).filter((batch) => batch.sourceId !== id));
  deps.store.appendEvent({ ownerId: ownerOf(deps.store, workspaceId), workspaceId, idempotencyKey: `import.removed:${id}`, type: "import.removed", entityId: id, payload: {} });
  return true;
}

/** The daily read and, for Todoist, write-back, per source. */
export function setSourceOptions(store: CrosslineStore, workspaceId: string, id: string, options: { daily?: boolean; writeBack?: boolean }): boolean {
  const source = importSources(store, workspaceId).find((item) => item.id === id);
  if (!source) return false;
  patchSource(store, workspaceId, id, { ...(options.daily !== undefined ? { daily: options.daily } : {}),
    ...(options.writeBack !== undefined && source.kind === "todoist" ? { writeBack: options.writeBack } : {}) });
  return true;
}

/** A new batch of what was not seen before, offered with the rules' suggestions at once and sorted by the model in the background. */
export function startBatch(deps: ImportDeps, workspaceId: string, input: { kind: ImportKind; sourceId: string; label: string; items: ImportItem[] }): ImportBatch | undefined {
  const fresh = unseen(deps.store, workspaceId, input.items);
  if (!fresh.length) return undefined;
  const open = openTasks(deps.store, workspaceId);
  const items: ImportBatchItem[] = fresh.slice(0, IMPORT_BATCH_MAX).map((item, index) => ({ ...item, key: `i${index + 1}`, suggestion: ruleSuggestion(item, "", open) }));
  const batch: ImportBatch = { id: randomUUID().slice(0, 8), kind: input.kind, sourceId: input.sourceId, label: input.label, createdAt: nowOf(deps).toISOString(),
    state: "sorting", sorted: false, more: Math.max(0, fresh.length - IMPORT_BATCH_MAX), items };
  saveBatches(deps.store, workspaceId, [...importBatches(deps.store, workspaceId), batch]);
  return batch;
}

/** Sorts a batch a chunk at a time. Without a model (none connected, the quota, a failed run) the rules' suggestions stand and the batch is ready. */
export async function sortBatch(deps: ImportDeps, workspaceId: string, batchId: string): Promise<ImportBatch | undefined> {
  const batch = importBatches(deps.store, workspaceId).find((item) => item.id === batchId);
  if (!batch) return undefined;
  const client = deps.client(workspaceId);
  const open = openTasks(deps.store, workspaceId);
  const lines = identityLines(deps.store, workspaceId);
  const suggestions = new Map<string, ImportSuggestion>();
  let sorted = Boolean(client) && batch.items.length > 0 && await deps.sortAllowed(workspaceId).catch(() => false);
  if (sorted && client) {
    const openShown = open.slice(0, 80);
    for (let start = 0; start < batch.items.length; start += IMPORT_TRIAGE_CHUNK) {
      const chunk = batch.items.slice(start, start + IMPORT_TRIAGE_CHUNK);
      const input = {
        today: nowOf(deps).toISOString().slice(0, 10), source: IMPORT_KIND_LABEL[batch.kind],
        lines: lines.map((line) => ({ id: line.id, label: line.label })),
        openTasks: openShown.map((task) => ({ id: task.id, title: task.title.slice(0, 120), lineId: task.identityId, dueDate: task.dueDate })),
        items: chunk.map((item) => ({ key: item.key, title: item.title, notes: item.notes.slice(0, 300), due: item.due, labels: item.labels, list: item.list, done: item.done,
          createdAt: item.createdAt.slice(0, 10) }))
      };
      const result = await runCodexSkill<ImportTriage>(client, input, {
        skillName: IMPORT_TRIAGE_SKILL, cwd: deps.cwd, outputSchema: IMPORT_TRIAGE_SCHEMA as unknown as Record<string, unknown>,
        developerInstructions: "Sort each imported item once as the Skill describes: keep, merge (with the open task's id), done, drop (stale) or someday; "
          + "the line it belongs to or empty; its project as written; its due day as YYYY-MM-DD or empty. Return raw JSON only.",
        // The prompt cache (docs/token-economy.md §2.5): the lines and the open tasks every chunk shares, before this chunk's items.
        stableKeys: ["source", "lines", "openTasks"],
        prepareInput: () => input, validateOutput: (output) => validateImportTriage(output, chunk.map((item) => item.key), lines.map((line) => line.id), openShown.map((task) => task.id)),
        onAudit: () => {}, timeoutMs: 20 * 60_000
      });
      if (!result.ok) { sorted = false; deps.log?.({ type: "import.triage_failed", workspaceId, batchId, code: result.blocker.code }); break; }
      for (const answer of result.output.items) {
        const item = chunk.find((entry) => entry.key === answer.key);
        if (!item) continue;
        suggestions.set(answer.key, mergeSuggestion(item, answer, open));
      }
    }
  }
  const latest = importBatches(deps.store, workspaceId);
  const current = latest.find((item) => item.id === batchId);
  if (!current) return undefined;
  const done: ImportBatch = { ...current, state: "ready", sorted: sorted && suggestions.size === current.items.length,
    items: current.items.map((item) => suggestions.has(item.key) ? { ...item, suggestion: suggestions.get(item.key)! } : item) };
  saveBatches(deps.store, workspaceId, latest.map((item) => item.id === batchId ? done : item));
  return done;
}

/**
 * The model's answer checked against the rules: a merge must name an open task (else it is a keep), and a keep the rules find on the
 * board already becomes a merge into that task — the board never gains a second copy because the model missed one.
 */
function mergeSuggestion(item: ImportItem, answer: ImportTriage["items"][number], open: readonly MergeTask[]): ImportSuggestion {
  const named = answer.decision === "merge" ? open.find((task) => task.id === answer.duplicateOf) : undefined;
  const byRule = answer.decision === "keep" ? importDuplicateOf({ title: item.title, notes: item.notes, lineId: answer.lineId, due: answer.due || item.due }, open) : undefined;
  const target = named ?? byRule;
  const decision = target ? "merge" : answer.decision === "merge" ? "keep" : answer.decision;
  return { decision, lineId: answer.lineId || target?.identityId || "", project: answer.project, due: answer.due || item.due, duplicateOf: target?.id ?? "",
    duplicateTitle: target?.title ?? "", why: answer.why.slice(0, 120) };
}

export type ImportChoice = { key: string; keep: boolean; lineId?: string };

/**
 * Carries out the person's confirmation: kept items become captures (`import-<kind>-<id>`, idempotent on the item), merged ones are
 * recorded on the task they repeat, and every item of the batch is remembered so it is never offered again. Choices the person did not
 * send follow the ticked suggestion.
 */
export function confirmBatch(deps: ImportDeps, workspaceId: string, batchId: string, choices: ImportChoice[] = []):
  { ok: true; captured: number; merged: number; skipped: number } | { ok: false; code: string } {
  const batch = importBatches(deps.store, workspaceId).find((item) => item.id === batchId);
  if (!batch) return { ok: false, code: "IMPORT_BATCH_NOT_FOUND" };
  const outcome = applyItems(deps, workspaceId, batch, (item) => {
    const choice = choices.find((entry) => entry.key === item.key);
    return { keep: choice ? choice.keep : ticked(item.suggestion.decision), lineId: choice?.lineId ?? item.suggestion.lineId };
  });
  saveBatches(deps.store, workspaceId, importBatches(deps.store, workspaceId).filter((item) => item.id !== batchId));
  deps.store.appendEvent({ ownerId: ownerOf(deps.store, workspaceId), workspaceId, idempotencyKey: `import.confirmed:${batchId}`, type: "import.confirmed", entityId: batchId,
    payload: { kind: batch.kind, sourceId: batch.sourceId, items: batch.items.length, ...outcome } });
  if (outcome.captured) { try { deps.onCaptured?.(workspaceId); } catch { /* the analysis runs at the next intake anyway */ } }
  return { ok: true, ...outcome };
}

export function discardBatch(deps: ImportDeps, workspaceId: string, batchId: string, remembered = false): boolean {
  const batch = importBatches(deps.store, workspaceId).find((item) => item.id === batchId);
  if (!batch) return false;
  // 「都不要」 remembers the items, so a daily read does not offer them again; a plain close lets the next read offer them anew.
  if (remembered) remember(deps.store, workspaceId, batch.items);
  saveBatches(deps.store, workspaceId, importBatches(deps.store, workspaceId).filter((item) => item.id !== batchId));
  return true;
}

function applyItems(deps: ImportDeps, workspaceId: string, batch: ImportBatch, decide: (item: ImportBatchItem) => { keep: boolean; lineId: string }, cap = Infinity):
  { captured: number; merged: number; skipped: number } {
  const t = tOfWorkspace(deps.store, workspaceId);
  const ownerId = ownerOf(deps.store, workspaceId);
  const lines = new Map(identityLines(deps.store, workspaceId).map((line) => [line.id, line.label]));
  const open = openTasks(deps.store, workspaceId);
  const source = IMPORT_KIND_LABEL[batch.kind];
  let captured = 0, merged = 0, skipped = 0;
  const handled: ImportItem[] = [];
  for (const item of batch.items) {
    const choice = decide(item);
    const target = item.suggestion.decision === "merge" ? open.find((task) => task.id === item.suggestion.duplicateOf) : undefined;
    if (!choice.keep) { skipped += 1; handled.push(item); continue; }
    if (target) {
      recordFold(deps.store, workspaceId, { kind: "duplicate", keep: target.id, keepTitle: target.title,
        why: t("从 {{source}} 导入的「{{title}}」与「{{target}}」重复", { source: t(source), title: item.title, target: target.title }) },
      { id: importCaptureId(item), title: item.title, intent: item.notes || item.title, source: "import" });
      deps.store.appendEvent({ ownerId, workspaceId, idempotencyKey: `import.item_merged:${seenKey(item)}`, type: "import.item_merged", entityId: target.id,
        payload: { kind: item.kind, externalId: item.externalId, sourceId: batch.sourceId, title: item.title } });
      merged += 1; handled.push(item); continue;
    }
    if (captured >= cap) continue;
    const id = importCaptureId(item);
    const due = item.suggestion.due || item.due;
    const line = choice.lineId ? lines.get(choice.lineId) : undefined;
    const parts = [t("从 {{source}} 导入", { source: t(source) }) + (item.list ? t("（原清单「{{list}}」）", { list: item.list }) : ""),
      ...(line ? [t("主线：{{line}}（本人在导入核对时选定）", { line })] : []),
      ...(due ? [t("截止：{{due}}", { due })] : []),
      ...(item.labels.length ? [t("标签：{{labels}}", { labels: item.labels.join(", ") })] : []),
      ...(item.notes ? [t("备注：{{notes}}", { notes: item.notes })] : [])];
    deps.store.capture({ id, ownerId, workspaceId, title: item.title.slice(0, 240), context: parts.join("\n").slice(0, 1200) }, `import:${seenKey(item)}`);
    deps.store.appendEvent({ ownerId, workspaceId, idempotencyKey: `import.item_captured:${seenKey(item)}`, type: "import.item_captured", entityId: id,
      payload: { kind: item.kind, externalId: item.externalId, sourceId: batch.sourceId, dueDate: due, lineId: choice.lineId } });
    captured += 1; handled.push(item);
  }
  remember(deps.store, workspaceId, handled);
  return { captured, merged, skipped };
}

/** The day an imported item carried, for a work order the analysis promoted without reading one (`recordWaitingAndDates`). */
export function importedDueDate(store: CrosslineStore, workspaceId: string, id: string): string | undefined {
  if (!importOrigin(id)) return undefined;
  const event = store.listEvents(workspaceId, { type: "import.item_captured", entityId: id }).at(-1);
  const due = (event?.payload as { dueDate?: string } | undefined)?.dueDate;
  return due && /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : undefined;
}

/**
 * A paste, a CSV or a screenshot the web stored under `<dataDir>/imports/<workspace>/`: read once and deleted. A screenshot's text is read
 * by the picture reader (Codex only); its lines are then a pasted list.
 */
export async function importFile(deps: ImportDeps, workspaceId: string, input: { file: string; kind: string; name?: string }):
  Promise<{ ok: true; batchId?: string; items: number } | { ok: false; code: string; message: string }> {
  const t = tOfWorkspace(deps.store, workspaceId);
  if (!IMPORT_FILE.test(input.file) || !["text", "csv", "image"].includes(input.kind)) return { ok: false, code: "IMPORT_FILE_INVALID", message: t("没有读到上传的内容，请重新上传。") };
  const file = path.join(deps.dataDir, "imports", workspaceId, input.file);
  if (!existsSync(file) || statSync(file).size > FILE_MAX) return { ok: false, code: "IMPORT_FILE_INVALID", message: t("没有读到上传的内容，请重新上传。") };
  try {
    let items: ImportItem[];
    if (input.kind === "image") {
      const describe = deps.describe?.(workspaceId);
      if (!describe) return { ok: false, code: "IMPORT_IMAGE_UNAVAILABLE", message: t("读截图要用 ChatGPT 登录的模型；可以改为粘贴文字或上传 CSV。") };
      const answers = await describe([{ id: "shot", file, note: "import", kind: "image", position: 1 }],
        // i18n-ignore: the describer's context (model-facing)
        [{ id: "import", title: "待办清单截图", desc: "从其他待办工具截下的清单。逐行抄下可见文字，一行一条，保留勾选状态（已勾选写 [x]）和日期。", tags: [] }]);
      items = itemsFromText(answers[0]?.text ?? "", "image");
    } else {
      const text = readFileSync(file, "utf8");
      items = input.kind === "csv" ? itemsFromCsv(text, zoneOf(deps, workspaceId)) : itemsFromText(text);
    }
    if (!items.length) return { ok: false, code: "IMPORT_NOTHING_READ", message: t("没有读到任何条目：每行写一条，或上传带标题列的 CSV。") };
    const kind = input.kind as ImportKind;
    const batch = startBatch(deps, workspaceId, { kind, sourceId: "", label: input.name?.trim().slice(0, 60) || t(IMPORT_KIND_LABEL[kind]), items });
    return { ok: true, items: items.length, ...(batch ? { batchId: batch.id } : {}) };
  } catch (error) {
    deps.log?.({ type: "import.file_failed", workspaceId, kind: input.kind, message: error instanceof Error ? error.message.slice(0, 200) : "" });
    return { ok: false, code: "IMPORT_FILE_FAILED", message: input.kind === "image" ? t("这张截图没有读出来，稍后再试，或改为粘贴文字。") : t("没有读到上传的内容，请重新上传。") };
  } finally { rmSync(file, { force: true }); }
}

/** Reads one connected tool now: new items become a batch for the person. */
export async function readSourceNow(deps: ImportDeps, workspaceId: string, id: string):
  Promise<{ ok: true; batchId?: string; items: number } | { ok: false; code: string; message: string }> {
  const source = importSources(deps.store, workspaceId).find((item) => item.id === id);
  if (!source) return { ok: false, code: "IMPORT_SOURCE_NOT_FOUND", message: tOfWorkspace(deps.store, workspaceId)("这个来源已经断开。") };
  const token = await deps.secrets.read(workspaceId, importSecretName(id)).catch(() => undefined);
  if (!token) {
    const message = tOfWorkspace(deps.store, workspaceId)("这台电脑上没有这个来源的令牌，请断开后重新接入。");
    patchSource(deps.store, workspaceId, id, { lastError: message });
    return { ok: false, code: "IMPORT_TOKEN_MISSING", message };
  }
  try {
    const items = await readSource(deps, workspaceId, source, token);
    const { lastError: _cleared, ...rest } = source;
    saveSources(deps.store, workspaceId, importSources(deps.store, workspaceId).map((item) => item.id === id ? { ...rest, lastReadAt: nowOf(deps).toISOString(), lastItems: items.length } : item));
    const batch = startBatch(deps, workspaceId, { kind: source.kind, sourceId: id, label: source.label, items });
    return { ok: true, items: items.length, ...(batch ? { batchId: batch.id } : {}) };
  } catch (error) {
    const said = errorText(deps, workspaceId, error);
    patchSource(deps.store, workspaceId, id, { lastReadAt: nowOf(deps).toISOString(), lastError: said.message });
    return { ok: false, ...said };
  }
}

/**
 * The tick's pass: each tool due for its daily read is read, its new items sorted and applied (at most `IMPORT_DAILY_CAPTURES` kept a
 * day; the rest wait in a batch), and the person told once. Then Todoist write-back for accounts that have it on.
 */
export async function importDailyPass(deps: ImportDeps, workspaceId: string): Promise<{ read: number; captured: number; closed: number }> {
  let read = 0, captured = 0;
  const now = nowOf(deps);
  for (const source of importSources(deps.store, workspaceId)) {
    if (!source.daily || (source.lastReadAt && now.getTime() - Date.parse(source.lastReadAt) < IMPORT_DAILY_HOURS * 3_600_000)) continue;
    // A batch the person has not looked at yet is not doubled by the next day's read.
    if (importBatches(deps.store, workspaceId).some((batch) => batch.sourceId === source.id)) continue;
    const outcome = await readSourceNow(deps, workspaceId, source.id);
    read += 1;
    if (!outcome.ok || !outcome.batchId) continue;
    const batch = await sortBatch(deps, workspaceId, outcome.batchId);
    // Only a batch the model sorted is applied by itself; one the rules alone sorted waits for the person.
    if (!batch?.sorted) continue;
    const applied = applyItems(deps, workspaceId, batch, (item) => ({ keep: ticked(item.suggestion.decision), lineId: item.suggestion.lineId }), IMPORT_DAILY_CAPTURES);
    const left = batch.items.filter((item) => !readImportSeen(deps.store.getSetting(workspaceId, IMPORT_SEEN_SETTING))[item.kind]?.includes(item.externalId));
    saveBatches(deps.store, workspaceId, importBatches(deps.store, workspaceId).flatMap((item) => item.id !== batch.id ? [item] : left.length ? [{ ...item, items: left }] : []));
    captured += applied.captured;
    if (applied.captured || applied.merged) {
      const t = tOfWorkspace(deps.store, workspaceId);
      sayToPerson(deps.store, workspaceId, t("{{source}} 有 {{count}} 条新任务：{{captured}} 条已收进收集箱，{{merged}} 条并入已有任务。", {
        source: source.label, count: batch.items.length, captured: applied.captured, merged: applied.merged }),
      "import_daily", `import-daily:${source.id}:${now.toISOString().slice(0, 10)}`, [{ label: t("查看导入"), href: "/settings#import" }], now);
      if (applied.captured) { try { deps.onCaptured?.(workspaceId); } catch { /* next intake */ } }
    }
  }
  const closed = await writeBackPass(deps, workspaceId);
  return { read, captured, closed };
}

/**
 * Closes in Todoist what was imported from it and is finished here: the work order the capture became, or the task an imported item was
 * merged into. Only for accounts with write-back on; each item once (`import.closed_upstream`).
 */
export async function writeBackPass(deps: ImportDeps, workspaceId: string): Promise<number> {
  if (requiredApproval("close_imported_task") === "never") return 0;
  const sources = importSources(deps.store, workspaceId).filter((source) => source.kind === "todoist" && source.writeBack);
  if (!sources.length) return 0;
  const accepted = new Set(deps.store.listWorkOrders(workspaceId).filter((order) => order.state === "accepted").map((order) => order.id));
  const closedAlready = new Set(deps.store.listEvents(workspaceId, { type: "import.closed_upstream" }).map((event) => event.entityId));
  const mapped = [...deps.store.listEvents(workspaceId, { type: "import.item_captured" }), ...deps.store.listEvents(workspaceId, { type: "import.item_merged" })]
    .map((event) => ({ taskId: event.entityId, ...(event.payload as { kind?: string; externalId?: string; sourceId?: string }) }))
    .filter((item) => item.kind === "todoist" && item.externalId && accepted.has(item.taskId) && !closedAlready.has(`todoist:${item.externalId}`));
  let closed = 0;
  for (const source of sources) {
    const mine = mapped.filter((item) => item.sourceId === source.id);
    if (!mine.length) continue;
    const token = await deps.secrets.read(workspaceId, importSecretName(source.id)).catch(() => undefined);
    if (!token) continue;
    for (const item of mine.slice(0, 20)) {
      try {
        await closeTodoistTask(token, item.externalId!, deps.fetch);
        deps.store.appendEvent({ ownerId: ownerOf(deps.store, workspaceId), workspaceId, idempotencyKey: `import.closed_upstream:todoist:${item.externalId}`,
          type: "import.closed_upstream", entityId: `todoist:${item.externalId}`, payload: { sourceId: source.id, taskId: item.taskId } });
        closed += 1;
      } catch (error) {
        patchSource(deps.store, workspaceId, source.id, { lastError: errorText(deps, workspaceId, error).message });
        break;
      }
    }
  }
  return closed;
}

/** The supervisor's `/v1/import*` routes. */
export function createImportService(deps: ImportDeps) {
  const sorting = new Set<string>();
  const sortSoon = (workspaceId: string, batchId: string | undefined) => {
    if (!batchId || sorting.has(batchId)) return;
    sorting.add(batchId);
    void sortBatch(deps, workspaceId, batchId).catch((error) => {
      deps.log?.({ type: "import.sort_failed", workspaceId, batchId, message: error instanceof Error ? error.message.slice(0, 200) : "" });
      // A batch never stays 「整理中」: the rules' suggestions stand.
      saveBatches(deps.store, workspaceId, importBatches(deps.store, workspaceId).map((item) => item.id === batchId ? { ...item, state: "ready" as const } : item));
    }).finally(() => sorting.delete(batchId));
  };
  const text = (body: Record<string, unknown> | undefined, key: string, max: number) => typeof body?.[key] === "string" ? (body[key] as string).slice(0, max) : "";
  async function handle(method: string, pathname: string, workspaceId: string, body: Record<string, unknown> | undefined): Promise<{ status: number; body: unknown } | undefined> {
    if (method === "GET" && pathname === "/v1/import") return { status: 200, body: importView(deps.store, workspaceId) };
    if (method === "POST" && pathname === "/v1/import/sources") {
      const answer = await connectSource(deps, workspaceId, { kind: text(body, "kind", 20), token: text(body, "token", 400), databaseId: text(body, "databaseId", 40), label: text(body, "label", 40) });
      if (answer.ok && "batchId" in answer) sortSoon(workspaceId, answer.batchId);
      return { status: answer.ok ? 200 : 400, body: answer.ok ? answer : { ok: false, blocker: { code: answer.code, message: answer.message } } };
    }
    if (method === "POST" && pathname === "/v1/import/file") {
      const answer = await importFile(deps, workspaceId, { file: text(body, "file", 60), kind: text(body, "kind", 10), name: text(body, "name", 80) });
      if (answer.ok) sortSoon(workspaceId, answer.batchId);
      return { status: answer.ok ? 200 : 400, body: answer.ok ? answer : { ok: false, blocker: { code: answer.code, message: answer.message } } };
    }
    const source = /^\/v1\/import\/sources\/([a-z0-9-]{1,40})(\/read|\/options)?$/.exec(pathname);
    if (source && method === "DELETE" && !source[2]) return { status: 200, body: { ok: removeSource(deps, workspaceId, source[1]!) } };
    if (source && method === "POST" && source[2] === "/options") {
      return { status: 200, body: { ok: setSourceOptions(deps.store, workspaceId, source[1]!, {
        ...(typeof body?.daily === "boolean" ? { daily: body.daily } : {}), ...(typeof body?.writeBack === "boolean" ? { writeBack: body.writeBack } : {}) }) } };
    }
    if (source && method === "POST" && source[2] === "/read") {
      const answer = await readSourceNow(deps, workspaceId, source[1]!);
      if (answer.ok) sortSoon(workspaceId, answer.batchId);
      return { status: answer.ok ? 200 : 400, body: answer.ok ? answer : { ok: false, blocker: { code: answer.code, message: answer.message } } };
    }
    const batch = /^\/v1\/import\/batches\/([a-z0-9-]{1,40})(\/confirm)?$/.exec(pathname);
    if (batch && method === "POST" && batch[2] === "/confirm") {
      const choices = Array.isArray(body?.choices) ? (body.choices as unknown[]).flatMap((entry) => {
        const choice = entry as { key?: unknown; keep?: unknown; lineId?: unknown };
        return typeof choice?.key === "string" && typeof choice.keep === "boolean"
          ? [{ key: choice.key.slice(0, 12), keep: choice.keep, ...(typeof choice.lineId === "string" ? { lineId: choice.lineId.slice(0, 80) } : {}) }] : [];
      }).slice(0, IMPORT_BATCH_MAX) : [];
      const answer = confirmBatch(deps, workspaceId, batch[1]!, choices);
      return { status: answer.ok ? 200 : 404, body: answer };
    }
    if (batch && method === "DELETE" && !batch[2]) return { status: 200, body: { ok: discardBatch(deps, workspaceId, batch[1]!, body?.remember === true) } };
    return undefined;
  }
  return { handle, pass: (workspaceId: string) => importDailyPass(deps, workspaceId) };
}
