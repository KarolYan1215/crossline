import fs from "node:fs";
import path from "node:path";
import { AVATARS_PER_EMAIL, type AvatarStatus } from "../../lib/contract";
import { dataDir } from "../config";
import { avatarsDrawnFor, forgetFailedDraw, setAvatarState, type StoredResult } from "../store";
import { dailyLimit, takeSlot } from "./budget";
import { writeFileAtomic } from "./files";
import { avatarPrompt, seedFor } from "./prompt";
import { announceAvatarProvider } from "./announce";
import { ProviderError, imageType, providerFromEnv, type CallTiming, type ImageProvider } from "./provider";
import { createQueue, type Queue } from "./queue";
import { templatesDir, templateVariant, type TemplateVariant } from "./templates";

/**
 * The figure pipeline (workstream W5, docs/beta-launch.md §4): the type's template plus the person's appearance, drawn by an image
 * model, with a queue, a per-address limit, a daily budget and a fallback. Signatures fixed by the contract.
 *
 * States: `template` at once when there is no provider, the address has had its figures, today's budget is spent or the queue is full;
 * otherwise `queued` → `drawing` → `ready` (file written) or `template` (the call failed). Every way to `template` is logged
 * (`avatar.skipped` with its reason, `avatar.failed` with the provider's answer), so a fallback is never silent. The fallback is always a
 * correct answer, so nothing here ever makes a result page wait or fail.
 */

/**
 * Figures drawn at once. A Seedream call holds only the request and the downloaded image (about 10 MB). Three at once all ran past
 * two minutes on the first try (2026-10-16), so more at once does not move a burst faster until the logged `answeredSeconds` /
 * `downloadSeconds` say which part is slow. `ASSESS_IMAGE_CONCURRENCY` overrides it (two suits SiliconFlow's lowest image tier).
 */
export const CONCURRENCY = Math.max(1, Number(process.env.ASSESS_IMAGE_CONCURRENCY) || 3);
/**
 * Waiting past this, a figure settles on the template rather than wait longer than anyone keeps the page open.
 */
export const MAX_PENDING = 60;
/**
 * One call to the model, download included. Seedream answers a 1024×1536 edit in 25–40 s and the download takes a second or two, but
 * now and then a call hangs: three at once on 2026-10-16 answered after 27 s, after 293 s, and not within 300 s — whose retry then
 * answered in 24 s. So a call is cut off at 100 s and tried again (`ATTEMPTS`), rather than waited on.
 */
export const CALL_TIMEOUT_MS = 100_000;
/** Calls within one run, the first included, for what a wait can fix (a hung call, a rate limit, an overload); each takes a budget slot. */
export const ATTEMPTS = 3;
/** A figure still `queued`/`drawing` this long after it was last queued was lost to a restart: show the fallback. */
export const STALE_AFTER_MS = 30 * 60_000;
/** After a failure a wait can fix (a timeout, an overload, the network), the person's next visit this long after it draws again. */
export const RETRY_AFTER_MS = 3 * 60_000;
/** Calls per result at most, the first included; each still needs a slot of the day's budget and the address's limit. */
export const MAX_RUNS = 3;

type Runtime = { provider: ImageProvider | null; sleep: (ms: number) => Promise<void>; random: () => number; now: () => Date };

/**
 * Per-process memory of figures in flight and of failures worth another try. Kept on `globalThis` so that every route bundle of the one
 * server process reads the same maps; lost on restart, which only means a stuck figure reads as the fallback and a failed one is not
 * retried — both safe.
 */
type Memory = { queuedAt: Map<string, number>; retries: Map<string, { at: number; runs: number }> };
const memory = ((globalThis as { __assessAvatarMemory?: Memory }).__assessAvatarMemory ??= { queuedAt: new Map(), retries: new Map() });

const defaults = (): Runtime => {
  announceAvatarProvider();
  return {
    provider: providerFromEnv(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random: Math.random,
    now: () => new Date()
  };
};

let runtime: Runtime | undefined;
let queue: Queue | undefined;
const current = (): Runtime => (runtime ??= defaults());
const jobs = (): Queue => (queue ??= createQueue({ concurrency: CONCURRENCY, maxPending: MAX_PENDING }));

/** Replaces the provider, clock or sleep (tests), and starts a fresh queue; `null` provider means none. */
export function configureAvatarPipeline(overrides: Partial<Runtime>): void {
  runtime = { ...defaults(), ...overrides };
  queue = undefined;
  memory.queuedAt.clear();
  memory.retries.clear();
}

/** Resolves once every queued figure has settled (tests, graceful shutdown). */
export function avatarQueueIdle(): Promise<void> {
  return jobs().idle();
}

/** Where a result's drawn figure is kept, relative to `dataDir()` (stored that way so the data directory can move). */
const drawnFile = (resultId: string): string => path.join("avatars", `${resultId}.png`);
const absolute = (file: string): string => (path.isAbsolute(file) ? file : path.join(dataDir(), file));

/** Why a figure was not drawn at all: logged as `avatar.skipped`, so a fallback is never silent. */
export type SkipReason = "no_provider" | "email_limit" | "queue_full" | "daily_budget" | "queue_refused";

function skip(result: StoredResult, reason: SkipReason): void {
  console.warn(JSON.stringify({ event: "avatar.skipped", resultId: result.id, reason }));
  setAvatarState(result.id, "template");
}

/**
 * Starts drawing this result's figure, or settles it on the fallback at once (over budget, over the address's limit, no provider).
 * True when it was queued.
 */
export function enqueueAvatar(result: StoredResult): boolean {
  const { provider } = current();
  const refused: SkipReason | undefined = !provider ? "no_provider"
    : avatarsDrawnFor(result.email) >= AVATARS_PER_EMAIL ? "email_limit"
    : jobs().size() >= MAX_PENDING + CONCURRENCY ? "queue_full"
    : !takeSlot(dailyLimit(), current().now()) ? "daily_budget"
    : undefined;
  if (refused || !provider) {
    skip(result, refused ?? "no_provider");
    return false;
  }
  setAvatarState(result.id, "queued");
  memory.queuedAt.set(result.id, current().now().getTime());
  const taken = jobs().push(() => draw(provider, result));
  if (!taken) {
    memory.queuedAt.delete(result.id);
    skip(result, "queue_refused");
  }
  return taken;
}

/**
 * A figure that fell back after a failure a wait can fix is drawn again when the person opens their result `RETRY_AFTER_MS` or more
 * later (at most `MAX_RUNS` calls in all, each through the same limits as the first). True when it was queued again, so the caller
 * re-reads the result. Refusals (a wrong key or model, the content check) are not retried: they would fail the same way.
 */
export function retryAvatarIfDue(result: StoredResult): boolean {
  if (result.avatar.state !== "template") return false;
  const entry = memory.retries.get(result.id);
  if (!entry || current().now().getTime() - entry.at < RETRY_AFTER_MS) return false;
  memory.retries.delete(result.id);
  if (entry.runs >= MAX_RUNS) return false;
  console.info(JSON.stringify({ event: "avatar.retry", resultId: result.id, run: entry.runs + 1 }));
  const queued = enqueueAvatar(result);
  if (queued) memory.retries.set(result.id, { at: Number.POSITIVE_INFINITY, runs: entry.runs });
  return queued;
}

/** Whether a failed call is worth another try later: no answer at all, a timeout, an overload or a broken download — not a refusal. */
function transient(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return true;
  if (/^IMAGE_(API_NO_URL|FORMAT_UNSUPPORTED|NOT_AN_IMAGE|TOO_LARGE|URL_)/.test(error.message)) return false;
  return error.status === 429 || error.status >= 500;
}

/** The error's own words plus, for a network failure (`fetch failed`), the system's code underneath (ECONNRESET, ENOTFOUND, UND_ERR_…). */
function failureReason(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause;
  const under = cause && typeof cause.code === "string" ? cause.code : cause && typeof cause.message === "string" ? cause.message : "";
  return `${error.name === "AbortError" ? "ABORTED " : ""}${error.message}${under ? ` (${under})` : ""}`.slice(0, 300);
}

async function draw(provider: ImageProvider, result: StoredResult): Promise<void> {
  const started = Date.now();
  let attempts = 1;
  // The last call's own clock: how long until the service answered (upload and drawing) and how long the download took.
  let timing: CallTiming = {};
  let callStarted = Date.now();
  try {
    setAvatarState(result.id, "drawing");
    const reference = fs.readFileSync(templateImagePath(result.code, templateVariant(result.appearance.presentation, result.id)));
    const input = { reference, prompt: avatarPrompt(result.appearance), seed: seedFor(result.id) };
    let image: Buffer | undefined;
    for (;;) {
      timing = {};
      callStarted = Date.now();
      try {
        image = await withTimeout((signal) => provider.edit({ ...input, signal, timing }));
        break;
      } catch (error) {
        // Again only for what a wait can fix, and only if today's budget still has a slot for it.
        if (attempts >= ATTEMPTS || !(error instanceof ProviderError) || !error.retryable || !takeSlot(dailyLimit(), current().now())) throw error;
        console.warn(JSON.stringify({ event: "avatar.retrying", resultId: result.id, attempt: attempts, reason: failureReason(error), ...phaseLog(callStarted, timing) }));
        await current().sleep(backoffMs(error));
        attempts += 1;
      }
    }
    // The poster renderer reads PNG and JPEG only: a WebP figure would show on the page and never on the poster.
    const type = imageType(image);
    if (type !== "image/png" && type !== "image/jpeg") throw new ProviderError(`IMAGE_FORMAT_UNSUPPORTED: ${type ?? "unknown"}`, 502);
    const file = drawnFile(result.id);
    writeFileAtomic(absolute(file), image);
    setAvatarState(result.id, "ready", file);
    memory.retries.delete(result.id);
    console.info(JSON.stringify({ event: "avatar.ready", resultId: result.id, provider: provider.label ?? "unknown", attempts,
      seconds: Math.round((Date.now() - started) / 1000), ...phaseLog(callStarted, timing) }));
  } catch (error) {
    const runs = (memory.retries.get(result.id)?.runs ?? 0) + 1;
    const retry = transient(error) && runs < MAX_RUNS;
    console.warn(JSON.stringify({ event: "avatar.failed", resultId: result.id, provider: provider.label ?? "unknown", attempts,
      ...(error instanceof ProviderError ? { status: error.status } : {}), seconds: Math.round((Date.now() - started) / 1000),
      reason: failureReason(error), retryLater: retry, ...phaseLog(callStarted, timing) }));
    if (retry) memory.retries.set(result.id, { at: current().now().getTime(), runs });
    else memory.retries.delete(result.id);
    // Nothing was drawn, so the address keeps its figure; then the page shows the fallback.
    forgetFailedDraw(result.id);
    setAvatarState(result.id, "template");
  } finally {
    memory.queuedAt.delete(result.id);
  }
}

/** The last call's phases for the log; a call cut off while the service was still drawing has no `downloadSeconds`. */
function phaseLog(callStarted: number, timing: CallTiming): Record<string, number> {
  if (timing.answeredAt === undefined) return { waitedForAnswerSeconds: Math.round((Date.now() - callStarted) / 1000) };
  return { answeredSeconds: Math.round((timing.answeredAt - callStarted) / 1000), downloadSeconds: Math.round((Date.now() - timing.answeredAt) / 1000),
    ...(timing.bytes !== undefined ? { bytes: timing.bytes } : {}) };
}

/** The wait before the one retry: the server's `Retry-After` (capped), else 20–40 s after a rate limit and 2–5 s after an overload. */
function backoffMs(error: ProviderError): number {
  const jitter = current().random();
  if (error.retryAfterMs !== undefined) return Math.min(60_000, error.retryAfterMs) + jitter * 1_000;
  return error.status === 429 ? 20_000 + jitter * 20_000 : 2_000 + jitter * 3_000;
}

async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ProviderError("IMAGE_TIMEOUT", 504));
    }, CALL_TIMEOUT_MS);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Queued or drawing for longer than any call takes, counted from the latest time this process queued it (else from the result's making). */
const isStale = (result: StoredResult, now: Date): boolean =>
  (result.avatar.state === "queued" || result.avatar.state === "drawing")
  && now.getTime() - (memory.queuedAt.get(result.id) ?? Date.parse(result.createdAt)) > STALE_AFTER_MS;

/** The drawn file on disk when the figure is ready and the file is there. */
function drawnPath(result: StoredResult): string | undefined {
  if (result.avatar.state !== "ready" || !result.avatar.file) return undefined;
  const file = absolute(result.avatar.file);
  return fs.existsSync(file) ? file : undefined;
}

/** What the pages show: the drawn figure's URL when ready, else the template's. */
export function avatarStatus(result: StoredResult): AvatarStatus {
  const base = `/api/avatar/${result.inviteToken}.png`;
  const drawn = drawnPath(result);
  if (drawn) return { state: "ready", url: `${base}?v=${Math.floor(fs.statSync(drawn).mtimeMs)}` };
  if (result.avatar.state === "ready" || isStale(result, current().now())) return { state: "template", url: base };
  return { state: result.avatar.state, url: base };
}

/** The person's own drawn figure on disk, for the posters; undefined while it is drawn, or when it never was (posters then show the code). */
export function drawnImagePath(result: StoredResult): string | undefined {
  return drawnPath(result);
}

/**
 * The figure the avatar route serves: the drawn one when ready, else the template. Only the App's link (`figureUrl`) still shows the
 * template; the pages and posters show the drawn figure or the code tile (`FigureTile`, `figure.ts`).
 */
export function avatarImagePath(result: StoredResult): string {
  return drawnPath(result) ?? templateImagePath(result.code, templateVariant(result.appearance.presentation, result.id));
}

/** The type's template PNG on disk, the woman's or the man's. */
export function templateImagePath(code: string, variant: TemplateVariant = "female"): string {
  if (!/^[CD][LX][WB][UV]$/.test(code)) throw new Error(`AVATAR_TYPE_UNKNOWN: ${code}`);
  return path.join(templatesDir(), `${code}-${variant}.png`);
}
