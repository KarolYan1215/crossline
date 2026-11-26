// Split out of index.ts (move only). The worker's singletons (store, supervisor, services) stay in index.ts, which runs the
// side effects in order; this module reads them from `../index` only inside functions, after index.ts has set them up.
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { enterUsageWorkspace } from "@crossline/codex";
import { tFor, spendAllows } from "@crossline/core";
import { createCalendarClassifier, unfiledCalendarEvents } from "../calendar-classifier";
import { createTimeDraftPass } from "../time-drafts";
import { sayToPerson } from "../workflow-smith";
import { localeOf, tOfWorkspace } from "../locale";
import { createFileProjectReader } from "../source-filing";
import { maskForModel, readSourceText, screenUploadedText } from "../source-intake";
import { createVersionJudge } from "../source-versions";
import { createChatDigester } from "../chat-digest";
import { WHISPER_MODEL } from "../transcribe";
import { recordingPass, recordingsOn, transcribeConcurrency } from "../recordings";
import { createRecordingDigester, transcriptsAwaitingDigest } from "../recording-digest";
import { importScreenedFiles, syncFolders } from "../source-folders";
import { createFolderClassifier, createFolderScreener, screenListedWith } from "../folder-classifier";
import { ownerOf } from "../owner";
import { accountClient, analysisStore, calendarZone, codexSupervisor, dataDir, folderDepsFor, lastIdle, machineOwner, paused, repoRoot, spendFor, transcriber } from "../index";

/**
 * Reads a stored document's text: the worker's one extraction path (the web's upload and the supervisor route; authorized folders call `readSourceText` before keeping a file).
 * Only files this app wrote itself, by the path it recorded: the model and the browser never supply one.
 */
export async function extractDocument(documentId: string, workspaceId: string) {
  const doc = analysisStore.listSourceDocuments(workspaceId).find((item) => item.id === documentId);
  const t = tOfWorkspace(analysisStore, workspaceId);
  if (!doc) return { state: "blocked" as const, code: "SOURCE_NOT_FOUND", message: t("找不到这个文件。") };
  if (doc.kind === "audio") return transcribeDocument(workspaceId, doc.id);
  const locale = localeOf(analysisStore, workspaceId);
  let result;
  try { result = await readSourceText(new Uint8Array(readFileSync(fileURLToPath(doc.uri))), doc.kind, doc.fileName, locale); }
  catch { result = { status: "failed" as const, text: "", note: t("读不到已保存的文件。") }; }
  // A direct upload passes the same code checks as a folder's file before anything keeps its text (§四.3: keys first, then personal numbers).
  const verdict = screenUploadedText(doc.fileName, result.text, locale);
  if (verdict.refused) {
    const gone = analysisStore.deleteSourceDocument(workspaceId, doc.id);
    if (gone && !gone.uriInUse) {
      try { const file = path.resolve(fileURLToPath(gone.uri)); if (file.startsWith(path.resolve(dataDir, "sources") + path.sep)) rmSync(file, { force: true }); } catch { /* not a local copy */ }
    }
    analysisStore.appendEvent({ ownerId: ownerOf(analysisStore, workspaceId), workspaceId, idempotencyKey: `source.refused:${doc.id}`, type: "source.refused", entityId: doc.id,
      payload: { fileName: doc.fileName, code: verdict.code } });
    return { state: "refused" as const, documentId: doc.id, fileName: doc.fileName, code: verdict.code, message: verdict.message };
  }
  const note = [result.note, verdict.note].filter(Boolean).join(t("；"));
  analysisStore.setSourceDocumentExtraction(workspaceId, doc.id, { status: result.status, text: verdict.text, ...(note ? { note } : {}) });
  void versionPass(workspaceId).catch(() => undefined);
  return { state: "extracted" as const, documentId: doc.id, status: result.status, characters: verdict.text.length };
}
/** Authorized folders (source-folders.ts): read what is new or changed, then have the model propose lines for newly read folders. */
const readingFolders = new Set<string>();
// A folder added while a pass runs would wait for the next tick (up to fifteen minutes) while its card says 「正在读取」 — four folders
// authorized at once read only the first (2026-10-15) — so a call during a pass runs one more pass after it.
const rereadFolders = new Set<string>();
export async function folderPass(workspaceId: string, checkedAt: string): Promise<void> {
  if (readingFolders.has(workspaceId)) { rereadFolders.add(workspaceId); return; }
  if (paused(workspaceId, "intake") || !machineOwner(workspaceId)) return;
  readingFolders.add(workspaceId);
  try {
    const outcomes = await syncFolders(analysisStore, workspaceId, folderDepsFor(workspaceId)).catch(() => []);
    const read = outcomes.reduce((sum, item) => sum + item.read, 0);
    if (read) console.info(JSON.stringify({ type: "sources.folders_read", checkedAt, workspaceId, outcomes }));
    // Recordings the pass just queued start now, in the background: a long one takes far longer than a tick.
    startRecordings(workspaceId);
    void digestPass(workspaceId).catch(() => undefined);
    if (!codexSupervisor || !spendAllows(await spendFor(workspaceId), "intake")) return;
    enterUsageWorkspace(workspaceId);
    const screen = screenListedWith(createFolderScreener(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId)));
    const screened = await importScreenedFiles(analysisStore, workspaceId, folderDepsFor(workspaceId), screen).catch(() => 0);
    if (screened) console.info(JSON.stringify({ type: "sources.folders_screened", checkedAt, workspaceId, read: screened }));
    const filed = await createFolderClassifier(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId))().catch(() => undefined);
    if (filed && "filed" in filed && filed.filed) console.info(JSON.stringify({ type: "sources.folder_lines_filed", checkedAt, workspaceId, ...filed }));
  } finally {
    readingFolders.delete(workspaceId);
    if (rereadFolders.delete(workspaceId)) void folderPass(workspaceId, new Date().toISOString()).catch(() => undefined);
  }
}

/** Files new calendar events under the person's lines after a sync, a batch a tick; a small model, so it still runs when quota is tight. */
const filingCalendar = new Set<string>();
export async function calendarLinePass(workspaceId: string, checkedAt: string): Promise<void> {
  if (paused(workspaceId, "intake")) return;
  if (filingCalendar.has(workspaceId) || !codexSupervisor || !unfiledCalendarEvents(analysisStore, workspaceId).length) return;
  if (!spendAllows(await spendFor(workspaceId), "intake")) return;
  filingCalendar.add(workspaceId);
  try {
    enterUsageWorkspace(workspaceId);
    const outcome = await createCalendarClassifier(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId))().catch(() => undefined);
    if (outcome) console.info(JSON.stringify({ type: "calendar.lines_filed", checkedAt, workspaceId, ...outcome }));
  } finally { filingCalendar.delete(workspaceId); }
}

/**
 * 拟计时 (`time-drafts.ts`): untimed work drafted from the screen record every ten minutes per account, under the 「应用与窗口」 consent;
 * the attribution model is asked about what nothing placed only while intake work is allowed.
 */
const draftingTime = new Set<string>();
const timeDraftedAt = new Map<string, number>();
export async function timeDraftPass(workspaceId: string, checkedAt: string): Promise<void> {
  if (draftingTime.has(workspaceId) || Date.now() - (timeDraftedAt.get(workspaceId) ?? 0) < 10 * 60_000) return;
  draftingTime.add(workspaceId);
  timeDraftedAt.set(workspaceId, Date.now());
  try {
    const modelAllowed = Boolean(codexSupervisor) && !paused(workspaceId, "intake") && spendAllows(await spendFor(workspaceId), "intake");
    if (modelAllowed) enterUsageWorkspace(workspaceId);
    const outcome = await createTimeDraftPass(analysisStore, workspaceId, repoRoot, () => modelAllowed ? accountClient(workspaceId) : undefined)().catch(() => undefined);
    if (outcome && (outcome.drafted || outcome.attributed || outcome.blocked)) console.info(JSON.stringify({ type: "activity.time_drafted", checkedAt, workspaceId, ...outcome }));
  } finally { draftingTime.delete(workspaceId); }
}
// One recording at a time: transcription is CPU-bound and a second would only slow the first.
let transcribeQueue: Promise<void> = Promise.resolve();
async function transcribeDocument(workspaceId: string, documentId: string): Promise<{ state: string; documentId: string }> {
  const doc = analysisStore.listSourceDocuments(workspaceId).find((item) => item.id === documentId);
  if (!doc) return { state: "blocked", documentId };
  const locale = localeOf(analysisStore, workspaceId);
  const t = tFor(locale);
  const status = await transcriber.status(locale);
  if (status.state !== "ready") {
    const note = status.state === "unavailable" ? status.message
      : status.state === "downloading" ? t("正在下载语音识别模型，下载完会自动开始转写。")
      : t("转写录音需要先下载语音识别模型（约 {{mb}} MB，一次性，之后完全离线）。", { mb: status.approxMegabytes });
    analysisStore.setSourceDocumentExtraction(workspaceId, doc.id, { status: "pending", text: "", note });
    return { state: "waiting_for_model", documentId };
  }
  analysisStore.setSourceDocumentExtraction(workspaceId, doc.id, { status: "pending", text: "", note: t("正在转写…") });
  transcribeQueue = transcribeQueue.then(async () => {
    try {
      const bytes = new Uint8Array(readFileSync(fileURLToPath(doc.uri)));
      const result = await transcriber.transcribe(bytes, doc.fileName, process.env.CROSSLINE_TRANSCRIBE_LANGUAGE?.trim() || undefined, locale);
      if (result.state === "transcribed") {
        // A recording uploaded on purpose is read like any other upload: numbers that identify the person are masked before it is kept.
        const masked = maskForModel(result.text, locale);
        analysisStore.setSourceDocumentExtraction(workspaceId, doc.id, { status: "done", text: masked.text,
          note: [t("本机转写，约 {{minutes}} 分钟的录音。", { minutes: Math.round(result.seconds / 60) }), masked.note].filter(Boolean).join(" ") });
      } else {
        analysisStore.setSourceDocumentExtraction(workspaceId, doc.id, { status: "failed", text: "",
          note: result.state === "failed" ? result.message : t("语音识别模型还没有准备好。") });
      }
    } catch {
      analysisStore.setSourceDocumentExtraction(workspaceId, doc.id, { status: "failed", text: "", note: t("读不到已保存的录音。") });
    }
  }).catch(() => undefined);
  return { state: "transcribing", documentId };
}
/**
 * 录音自动转写 (recordings.ts, docs/phone-recording.md): recordings queued from the authorized folders, a few at once
 * (`transcribeConcurrency`), beside uploaded recordings, slowed down while the person uses the computer in the day. The idle time is the screen-activity reader's latest,
 * kept in memory only — it is read whether or not screen activity is recorded, and nothing of it is stored here.
 */
const recordingWorkspaces = new Set<string>();
let recordingRunning = false;
function startRecordings(workspaceId: string): void {
  if (!machineOwner(workspaceId) || !recordingsOn(analysisStore, workspaceId) || paused(workspaceId, "intake")) return;
  recordingWorkspaces.add(workspaceId);
  if (recordingRunning) return;
  recordingRunning = true;
  void (async () => {
    while (recordingWorkspaces.size) {
      const next = [...recordingWorkspaces][0]!;
      recordingWorkspaces.delete(next);
      const outcomes = await recordingPass(analysisStore, next, {
        transcriber, dataDir, timeZone: calendarZone(next) ?? "America/Chicago",
        ...(process.env.CROSSLINE_TRANSCRIBE_LANGUAGE?.trim() ? { language: process.env.CROSSLINE_TRANSCRIBE_LANGUAGE.trim() } : {}),
        idleMs: () => lastIdle && Date.now() - lastIdle.at < 5 * 60_000 ? lastIdle.idleMs + (Date.now() - lastIdle.at) : undefined,
        modelNeeded: (waiting) => sayToPerson(analysisStore, next, tOfWorkspace(analysisStore, next)("有 {{count}} 个手机录音等着转写，需要先在设置里同意下载语音识别模型（约 {{megabytes}} MB，一次性）。",
          { count: waiting, megabytes: WHISPER_MODEL.approxMegabytes }), "recording_model", "recording_model", [{ label: tOfWorkspace(analysisStore, next)("去设置"), href: "/settings#privacy" }])
      }, transcribeConcurrency()).catch(() => []);
      if (outcomes.length) console.info(JSON.stringify({ type: "recordings.transcribed", workspaceId: next, outcomes }));
      // What was just transcribed is sorted and summarised at once, not at the next tick.
      if (outcomes.some((item) => item.state === "transcribed")) void digestPass(next).catch(() => undefined);
    }
  })().catch(() => undefined).finally(() => { recordingRunning = false; });
}

/**
 * Recording digests (recording-digest.ts): transcripts sorted into kept and not, summarised, and their commitments, facts and days taken
 * into the ledger. Intake work: it runs while the quota allows intake, one pass per workspace at a time.
 */
const digesting = new Set<string>();
export async function digestPass(workspaceId: string): Promise<void> {
  if (digesting.has(workspaceId) || paused(workspaceId, "intake") || !transcriptsAwaitingDigest(analysisStore, workspaceId).length) return;
  if (!codexSupervisor || !spendAllows(await spendFor(workspaceId), "intake")) return;
  digesting.add(workspaceId);
  try {
    enterUsageWorkspace(workspaceId);
    // The start-on-use handle, like every other pass: the running runtime only left a guest whose runtime had gone idle undigested.
    const outcome = await createRecordingDigester(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId),
      { dataDir, timeZone: calendarZone(workspaceId) ?? "America/Chicago" })();
    console.info(JSON.stringify({ type: "recordings.digested", workspaceId, ...outcome }));
  } finally { digesting.delete(workspaceId); }
}

/**
 * Older versions of one document (source-versions.ts): fingerprints circle close pairs after a file is read, the model confirms them and
 * picks the latest. Intake work, so it runs while the quota allows intake; a pass already running takes the next file on its next call.
 */
const versioning = new Set<string>();
const filingProjects = new Set<string>();
export async function fileProjectPass(workspaceId: string): Promise<void> {
  if (filingProjects.has(workspaceId) || paused(workspaceId, "intake") || !codexSupervisor) return;
  if (!spendAllows(await spendFor(workspaceId), "intake")) return;
  filingProjects.add(workspaceId);
  try {
    enterUsageWorkspace(workspaceId);
    const outcome = await createFileProjectReader(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId))().catch(() => undefined);
    if (outcome && "filed" in outcome && outcome.filed) console.info(JSON.stringify({ type: "source.project_inferred", workspaceId, by: "model", filed: outcome.filed }));
  } finally { filingProjects.delete(workspaceId); }
}

export async function versionPass(workspaceId: string): Promise<void> {
  if (versioning.has(workspaceId) || paused(workspaceId, "intake") || !codexSupervisor) return;
  if (!spendAllows(await spendFor(workspaceId), "intake")) return;
  versioning.add(workspaceId);
  try {
    enterUsageWorkspace(workspaceId);
    const outcome = await createVersionJudge(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId), { dataDir })().catch(() => undefined);
    if (outcome && "superseded" in outcome && outcome.asked) console.info(JSON.stringify({ type: "sources.versions_judged", workspaceId, ...outcome }));
    // AI conversation exports, one summary per conversation (chat-digest.ts, D14): the same Skill, the same intake budget.
    const chats = await createChatDigester(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId), { dataDir })().catch(() => undefined);
    if (chats && "notes" in chats && (chats.summarized || chats.notes)) console.info(JSON.stringify({ type: "sources.chats_digested", workspaceId, ...chats }));
  } finally { versioning.delete(workspaceId); }
}

export async function resumeWaitingRecordings(): Promise<void> {
  for (const workspace of analysisStore.listWorkspaces()) {
    startRecordings(workspace.id);
    for (const doc of analysisStore.listSourceDocuments(workspace.id)) {
      if (doc.kind === "audio" && doc.extractionStatus === "pending") await transcribeDocument(workspace.id, doc.id);
    }
  }
}
