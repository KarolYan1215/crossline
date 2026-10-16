import fs from "node:fs";
import path from "node:path";
import { AVATARS_PER_EMAIL, type AvatarStatus } from "../../lib/contract";
import { dataDir } from "../config";
import { avatarsDrawnFor, setAvatarState, type StoredResult } from "../store";
import { dailyLimit, takeSlot } from "./budget";
import { writeFileAtomic } from "./files";
import { avatarPrompt, seedFor } from "./prompt";
import { ProviderError, imageType, providerFromEnv, providerSummary, type ImageProvider } from "./provider";
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

export const CONCURRENCY = 2;
export const MAX_PENDING = 40;
/** One call to the model, download included. Seedream's larger models take 30–60 s for a 1024×1536 edit (measured 2026-10-16: 39 s). */
export const CALL_TIMEOUT_MS = 120_000;
/** A figure still `queued`/`drawing` this long after its result was made was lost to a restart: show the fallback. */
export const STALE_AFTER_MS = 15 * 60_000;

type Runtime = { provider: ImageProvider | null; sleep: (ms: number) => Promise<void>; random: () => number; now: () => Date };

let announced = false;

/** The image settings, said once per process in the server log, so a missing or wrong provider is visible without a test draw. */
function announce(): void {
  if (announced) return;
  announced = true;
  console.info(JSON.stringify({ event: "avatar.provider", ...providerSummary() }));
}

const defaults = (): Runtime => {
  announce();
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

/** Starts drawing this result's figure, or settles it on the fallback at once (over budget, over the address's limit, no provider). */
export function enqueueAvatar(result: StoredResult): void {
  const { provider } = current();
  if (!provider) return skip(result, "no_provider");
  if (avatarsDrawnFor(result.email) >= AVATARS_PER_EMAIL) return skip(result, "email_limit");
  if (jobs().size() >= MAX_PENDING + CONCURRENCY) return skip(result, "queue_full");
  if (!takeSlot(dailyLimit(), current().now())) return skip(result, "daily_budget");
  setAvatarState(result.id, "queued");
  const taken = jobs().push(() => draw(provider, result));
  if (!taken) skip(result, "queue_refused");
}

async function draw(provider: ImageProvider, result: StoredResult): Promise<void> {
  const started = Date.now();
  let attempts = 1;
  try {
    setAvatarState(result.id, "drawing");
    const reference = fs.readFileSync(templateImagePath(result.code, templateVariant(result.appearance.presentation, result.id)));
    const input = { reference, prompt: avatarPrompt(result.appearance), seed: seedFor(result.id) };
    let image: Buffer;
    try {
      image = await withTimeout((signal) => provider.edit({ ...input, signal }));
    } catch (error) {
      // One retry, only for what a wait can fix (rate limit, overload), and only if today's budget still has a slot for it.
      if (!(error instanceof ProviderError) || !error.retryable || !takeSlot(dailyLimit(), current().now())) throw error;
      await current().sleep(backoffMs(error));
      attempts = 2;
      image = await withTimeout((signal) => provider.edit({ ...input, signal }));
    }
    // The poster renderer reads PNG and JPEG only: a WebP figure would show on the page and never on the poster.
    const type = imageType(image);
    if (type !== "image/png" && type !== "image/jpeg") throw new ProviderError(`IMAGE_FORMAT_UNSUPPORTED: ${type ?? "unknown"}`, 502);
    const file = drawnFile(result.id);
    writeFileAtomic(absolute(file), image);
    setAvatarState(result.id, "ready", file);
    console.info(JSON.stringify({ event: "avatar.ready", resultId: result.id, provider: provider.label ?? "unknown", attempts,
      seconds: Math.round((Date.now() - started) / 1000) }));
  } catch (error) {
    console.warn(JSON.stringify({ event: "avatar.failed", resultId: result.id, provider: provider.label ?? "unknown", attempts,
      ...(error instanceof ProviderError ? { status: error.status } : {}),
      reason: error instanceof Error ? error.message.slice(0, 200) : "unknown" }));
    setAvatarState(result.id, "template");
  }
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

const isStale = (result: StoredResult, now: Date): boolean =>
  (result.avatar.state === "queued" || result.avatar.state === "drawing") && now.getTime() - Date.parse(result.createdAt) > STALE_AFTER_MS;

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

/** A PNG file on disk for the poster renderer: the drawn figure when ready, else the template. */
export function avatarImagePath(result: StoredResult): string {
  return drawnPath(result) ?? templateImagePath(result.code, templateVariant(result.appearance.presentation, result.id));
}

/** The type's template PNG on disk, the woman's or the man's. */
export function templateImagePath(code: string, variant: TemplateVariant = "female"): string {
  if (!/^[SG][EI][MR][PA]$/.test(code)) throw new Error(`AVATAR_TYPE_UNKNOWN: ${code}`);
  return path.join(templatesDir(), `${code}-${variant}.png`);
}
