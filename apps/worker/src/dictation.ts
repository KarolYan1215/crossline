// i18n-exempt: dictated text, the corrector's input and log lines
import { randomUUID, createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  DICTATION_CORRECTION_SCHEMA, DICTATION_MAX_BYTES, DICTATION_SAMPLE_RATE, correctionCount, lexiconFromText, lexiconText, taskTitleOf,
  validateDictationCorrection, type DictationCorrection, type LexiconEdit
} from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";
import { identityLines } from "./lines";
import { SENSEVOICE_MODEL, checkSenseVoice, createSenseVoice, type WindowRecogniser } from "./sensevoice";
import { aliveFile, dictateSamples, inboxDir, outboxDir, pcmToSamples, uploadDir, dictationDir } from "./dictate";

export { aliveFile, dictateSamples, dictationDir, inboxDir, outboxDir, pcmToSamples, uploadDir } from "./dictate";

/**
 * Voice input's server side (docs/voice-input.md). The browser's recogniser does most of the work; this is what stands in where it does
 * not (Firefox, the home-screen app on an iPhone, a desktop shell without one) and what corrects either's text.
 *
 * - **Recognition** is SenseVoiceSmall, the model the recordings already use. On an installed copy it runs in this process once the person
 *   has agreed to its download (`<data>/models/sensevoice`, about 240 MB, checked against its hashes); on the hosted server it is the
 *   transcriber container's (`--network none`, its own memory ceiling), handed a clip through `<data>/dictation/inbox` and answering in
 *   `outbox`. The clip is 16 kHz mono PCM the page decoded, and it is deleted the moment it is read: no audio is ever kept.
 * - **Correction** is Skill `crossline-dictation-corrector` (low tier, the person's own priority) against the names on the person's board
 *   and the wordings they taught; an answer that rewrites rather than fixes is refused and the person keeps what was heard.
 * - **Wordings** are preference entries of source `dictation`, scope `dictation`: what the person changed in dictated text, deletable in
 *   Settings → 个性化, never given to any other model run.
 */
export const DICTATION_SKILL = "crossline:crossline-dictation-corrector";
const RATE = DICTATION_SAMPLE_RATE;
/** How long a dictation may wait for the server transcriber before the person is told it is not answering. */
const SERVER_WAIT_MS = 90_000;
/** The transcriber writes this every 30 s while it is up; older than this, the server engine counts as down. */
const ALIVE_MS = 90_000;
const UPLOAD_FILE = /^[a-z0-9-]{8,40}\.pcm$/;
const TERMS_MAX = 120;
const WORDINGS_MAX = 40;

export type VoiceEngine = "ready" | "model_missing" | "downloading" | "unavailable";
export type DictationDeps = {
  store: CrosslineStore; dataDir: string; cwd: string;
  client: (workspaceId: string) => CodexRpcBoundary | undefined;
  /** `server`: the hosted beta, where the transcriber container recognises; `local`: this process, after the model is downloaded. */
  mode: "server" | "local";
  /** Overrides for tests: the recogniser and the model folder. */
  recogniser?: WindowRecogniser; modelDir?: string;
  fetch?: typeof fetch; now?: () => number;
  log?: (event: Record<string, unknown>) => void;
};

/** The names a recogniser gets wrong most: the person's lines, projects, open tasks and milestones, and the object on the page. */
export function dictationTerms(store: CrosslineStore, workspaceId: string, page?: { kind?: string; entityId?: string }): string[] {
  const terms: string[] = [];
  const add = (value: string | undefined) => { const text = value?.trim(); if (text && text.length <= 60 && !terms.includes(text)) terms.push(text); };
  const orders = store.listWorkOrders(workspaceId);
  if (page?.entityId) {
    const order = orders.find((item) => item.id === page.entityId);
    if (order) add(taskTitleOf(order));
    add(store.listMilestones(workspaceId).find((item) => item.id === page.entityId)?.title);
  }
  for (const line of identityLines(store, workspaceId)) add(line.label);
  for (const project of store.listProjects(workspaceId)) add(project.name);
  for (const milestone of store.listMilestones(workspaceId).filter((item) => item.status !== "archived").slice(-40)) add(milestone.title);
  for (const order of orders.filter((item) => item.state !== "accepted" && item.state !== "archived").slice(-50)) add(taskTitleOf(order));
  return terms.slice(0, TERMS_MAX);
}

export const dictationWordings = (store: CrosslineStore, workspaceId: string): string[] =>
  store.listPreferences(workspaceId).filter((entry) => entry.source === "dictation").map((entry) => entry.text).slice(0, WORDINGS_MAX);

/** Keeps what the person taught: each edit a preference entry, the same heard form replacing its earlier meaning. */
export function rememberWordings(store: CrosslineStore, workspaceId: string, edits: LexiconEdit[]): number {
  let kept = 0;
  for (const edit of edits.slice(0, 3)) {
    const heard = edit.heard.trim(), meant = edit.meant.trim();
    if (!heard || !meant || heard === meant || [...heard].length > 16 || [...meant].length > 16 || !lexiconFromText(lexiconText({ heard, meant }))) continue;
    store.addPreference({ workspaceId, source: "dictation", scope: "dictation", text: lexiconText({ heard, meant }), weight: 1, refId: `dictation:${heard}` });
    kept += 1;
  }
  return kept;
}

/** Whether the server transcriber is up: its heartbeat is fresh. */
const transcriberAlive = (deps: DictationDeps) => {
  try { return (deps.now?.() ?? Date.now()) - statSync(aliveFile(deps.dataDir)).mtimeMs < ALIVE_MS; } catch { return false; }
};

export function createDictationService(deps: DictationDeps) {
  const modelDir = deps.modelDir ?? process.env.CROSSLINE_SENSEVOICE_DIR ?? path.join(deps.dataDir, "models", "sensevoice");
  let checked: Promise<string | undefined> | undefined;
  let downloading = false;
  let recogniser: WindowRecogniser | undefined = deps.recogniser;
  // One clip at a time on this machine: SenseVoice already uses the threads it is given.
  let line: Promise<unknown> = Promise.resolve();

  const localState = async (): Promise<VoiceEngine> => {
    if (deps.recogniser) return "ready";
    if (downloading) return "downloading";
    const problem = await (checked ??= checkSenseVoice(modelDir));
    if (problem) checked = undefined;
    return problem ? "model_missing" : "ready";
  };
  const engine = async (): Promise<VoiceEngine> => deps.mode === "server" ? (transcriberAlive(deps) ? "ready" : "unavailable") : localState();

  async function download(): Promise<{ ok: boolean; blocker?: { code: string; message: string } }> {
    if (deps.mode === "server") return { ok: false, blocker: { code: "VOICE_MODEL_SERVER", message: "VOICE_MODEL_SERVER" } };
    if (downloading) return { ok: true };
    if (await localState() === "ready") return { ok: true };
    downloading = true;
    void (async () => {
      mkdirSync(modelDir, { recursive: true });
      for (const [name, expected] of Object.entries(SENSEVOICE_MODEL.files)) {
        const target = path.join(modelDir, name), part = `${target}.part`;
        const response = await (deps.fetch ?? fetch)(`${SENSEVOICE_MODEL.source}${name}`, { redirect: "follow" });
        if (!response.ok || !response.body) throw new Error(`VOICE_MODEL_DOWNLOAD_FAILED: ${name} ${response.status}`);
        const hash = createHash("sha256");
        await pipeline(Readable.fromWeb(response.body as never), async function* (source) { for await (const chunk of source) { hash.update(chunk as Buffer); yield chunk; } }, createWriteStream(part));
        if (hash.digest("hex") !== expected) { rmSync(part, { force: true }); throw new Error(`VOICE_MODEL_HASH_MISMATCH: ${name}`); }
        renameSync(part, target);
      }
      checked = undefined;
      deps.log?.({ type: "voice.model_downloaded", dir: modelDir });
    })().catch((error: unknown) => deps.log?.({ type: "voice.model_download_failed", message: error instanceof Error ? error.message.slice(0, 200) : "" }))
      .finally(() => { downloading = false; });
    return { ok: true };
  }

  /** The server engine: the clip goes to the transcriber's inbox and its answer is waited for. */
  async function viaTranscriber(bytes: Buffer): Promise<{ text: string; language?: string }> {
    const id = randomUUID();
    mkdirSync(inboxDir(deps.dataDir), { recursive: true });
    mkdirSync(outboxDir(deps.dataDir), { recursive: true });
    const inbox = path.join(inboxDir(deps.dataDir), `${id}.pcm`), answer = path.join(outboxDir(deps.dataDir), `${id}.json`);
    writeFileSync(`${inbox}.part`, bytes);
    renameSync(`${inbox}.part`, inbox);
    const until = Date.now() + SERVER_WAIT_MS;
    try {
      while (Date.now() < until) {
        if (existsSync(answer)) {
          const result = JSON.parse(readFileSync(answer, "utf8")) as { text?: string; language?: string; error?: string };
          if (result.error) throw new Error(`VOICE_TRANSCRIBE_FAILED: ${result.error.slice(0, 120)}`);
          return { text: result.text ?? "", ...(result.language ? { language: result.language } : {}) };
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error("VOICE_TRANSCRIBER_TIMEOUT");
    } finally { rmSync(inbox, { force: true }); rmSync(answer, { force: true }); }
  }

  async function transcribe(workspaceId: string, file: string): Promise<{ status: number; body: unknown }> {
    if (!UPLOAD_FILE.test(file)) return { status: 400, body: { ok: false, blocker: { code: "VOICE_FILE_INVALID", message: "VOICE_FILE_INVALID" } } };
    const source = path.join(uploadDir(deps.dataDir, workspaceId), file);
    let bytes: Buffer;
    try { bytes = readFileSync(source); } catch { return { status: 404, body: { ok: false, blocker: { code: "VOICE_FILE_MISSING", message: "VOICE_FILE_MISSING" } } }; }
    finally { rmSync(source, { force: true }); }
    if (bytes.length > DICTATION_MAX_BYTES || bytes.length < RATE / 5) return { status: 400, body: { ok: false, blocker: { code: "VOICE_CLIP_LENGTH", message: "VOICE_CLIP_LENGTH" } } };
    const started = Date.now();
    try {
      let result: { text: string; language?: string };
      if (deps.mode === "server") {
        if (!transcriberAlive(deps)) return { status: 503, body: { ok: false, blocker: { code: "VOICE_ENGINE_UNAVAILABLE", message: "VOICE_ENGINE_UNAVAILABLE" } } };
        result = await viaTranscriber(bytes);
      } else {
        if (await localState() !== "ready") return { status: 409, body: { ok: false, blocker: { code: "VOICE_MODEL_MISSING", message: "VOICE_MODEL_MISSING" } } };
        recogniser ??= createSenseVoice(modelDir, 2);
        const run = line.then(() => dictateSamples(pcmToSamples(bytes), recogniser!));
        line = run.catch(() => undefined);
        result = await run;
      }
      deps.log?.({ type: "voice.transcribed", workspaceId, mode: deps.mode, seconds: Math.round(bytes.length / 2 / RATE), workMs: Date.now() - started, empty: !result.text });
      return { status: 200, body: { ok: true, text: result.text, ...(result.language ? { language: result.language } : {}) } };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      deps.log?.({ type: "voice.transcribe_failed", workspaceId, message: message.slice(0, 200) });
      const code = message.startsWith("VOICE_TRANSCRIBER_TIMEOUT") ? "VOICE_TRANSCRIBER_TIMEOUT" : "VOICE_TRANSCRIBE_FAILED";
      return { status: 502, body: { ok: false, blocker: { code, message: code } } };
    }
  }

  async function correct(workspaceId: string, body: Record<string, unknown> | undefined): Promise<{ status: number; body: unknown }> {
    const raw = typeof body?.raw === "string" ? body.raw.trim().slice(0, 4000) : "";
    if (!raw) return { status: 400, body: { ok: false, blocker: { code: "VOICE_TEXT_EMPTY", message: "VOICE_TEXT_EMPTY" } } };
    const client = deps.client(workspaceId);
    if (!client) return { status: 200, body: { ok: true, text: raw, count: 0, kept: "raw" } };
    const field = body?.field as { kind?: unknown; label?: unknown } | undefined;
    const kind = ["conversation", "interview", "note", "form"].includes(String(field?.kind)) ? String(field?.kind) : "form";
    const page = body?.page as { kind?: string; entityId?: string } | undefined;
    const input = { version: "crossline.dictation-correct.v1", raw, language: ["zh", "en", "yue"].includes(String(body?.language)) ? String(body?.language) : "zh",
      field: { kind, label: typeof field?.label === "string" ? field.label.slice(0, 40) : "" },
      terms: dictationTerms(deps.store, workspaceId, page && typeof page === "object" ? page : undefined),
      wordings: dictationWordings(deps.store, workspaceId), today: new Date().toISOString().slice(0, 10) };
    const result = await runCodexSkill<DictationCorrection>(client, input, { skillName: DICTATION_SKILL, cwd: deps.cwd,
      developerInstructions: "Correct what the speech recogniser got wrong in `raw` against `terms` and `wordings`, as the crossline-dictation-corrector "
        + "Skill describes: misheard words, names, numbers, punctuation and fillers only, every other word kept as spoken. Return only {text}.",
      outputSchema: DICTATION_CORRECTION_SCHEMA, prepareInput: () => input, validateOutput: (output) => validateDictationCorrection(raw, output),
      onAudit: () => {}, timeoutMs: 60_000 }).catch((error: unknown) => ({ ok: false as const, blocker: { code: error instanceof Error ? error.message.slice(0, 60) : "" } }));
    if (!result.ok) {
      deps.log?.({ type: "voice.correct_kept_raw", workspaceId, code: result.blocker.code });
      return { status: 200, body: { ok: true, text: raw, count: 0, kept: "raw" } };
    }
    const text = result.output.text.trim();
    return { status: 200, body: { ok: true, text, count: correctionCount(raw, text) } };
  }

  async function handle(method: string, pathname: string, workspaceId: string, body: Record<string, unknown> | undefined): Promise<{ status: number; body: unknown } | undefined> {
    if (method === "GET" && pathname === "/v1/voice/status") return { status: 200, body: { mode: deps.mode, server: await engine(), modelBytes: 240_000_000 } };
    if (method === "POST" && pathname === "/v1/voice/model") {
      if (body?.consent !== true) return { status: 400, body: { ok: false, blocker: { code: "VOICE_CONSENT_REQUIRED", message: "VOICE_CONSENT_REQUIRED" } } };
      const answer = await download();
      return { status: answer.ok ? 202 : 400, body: answer };
    }
    if (method === "POST" && pathname === "/v1/voice/transcribe") return transcribe(workspaceId, typeof body?.file === "string" ? body.file : "");
    if (method === "POST" && pathname === "/v1/voice/correct") return correct(workspaceId, body);
    if (method === "POST" && pathname === "/v1/voice/lexicon") {
      const edits = Array.isArray(body?.edits) ? (body.edits as unknown[]).flatMap((entry) => {
        const edit = entry as Partial<LexiconEdit>;
        return typeof edit?.heard === "string" && typeof edit.meant === "string" ? [{ heard: edit.heard, meant: edit.meant }] : [];
      }) : [];
      return { status: 200, body: { ok: true, kept: rememberWordings(deps.store, workspaceId, edits) } };
    }
    return undefined;
  }

  /** Clips left behind by a page that went away (older than two minutes) are deleted: no audio outlives its request. */
  function sweep(): void {
    const cutoff = Date.now() - 2 * 60_000;
    for (const dir of [path.join(dictationDir(deps.dataDir), "upload"), inboxDir(deps.dataDir), outboxDir(deps.dataDir)]) {
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true } as never) as unknown as Array<{ name: string; parentPath?: string; path?: string; isFile(): boolean }>) {
        if (!entry.isFile()) continue;
        const file = path.join(entry.parentPath ?? entry.path ?? dir, entry.name);
        try { if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true }); } catch { /* gone already */ }
      }
    }
  }

  return { handle, sweep, engine };
}
