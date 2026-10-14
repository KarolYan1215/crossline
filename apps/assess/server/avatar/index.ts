import fs from "node:fs";
import path from "node:path";
import { AVATARS_PER_EMAIL, type AvatarStatus } from "../../lib/contract";
import { dataDir } from "../config";
import { avatarsDrawnFor, setAvatarState, type StoredResult } from "../store";
import { dailyLimit, takeSlot } from "./budget";
import { writeFileAtomic } from "./files";
import { avatarPrompt, seedFor } from "./prompt";
import { ProviderError, providerFromEnv, type ImageProvider } from "./provider";
import { createQueue, type Queue } from "./queue";
import { templatesDir } from "./templates";

/**
 * The figure pipeline (workstream W5, docs/beta-launch.md §4): the type's template plus the person's appearance, drawn by an image
 * model, with a queue, a per-address limit, a daily budget and the template as the fallback. Signatures fixed by the contract.
 *
 * States: `template` at once when there is no provider, the address has had its figures, today's budget is spent or the queue is full;
 * otherwise `queued` → `drawing` → `ready` (file written) or `template` (the call failed). The template is always a correct answer, so
 * nothing here ever makes a result page wait or fail.
 */

export const CONCURRENCY = 2;
export const MAX_PENDING = 40;
export const CALL_TIMEOUT_MS = 60_000;
/** A figure still `queued`/`drawing` this long after its result was made was lost to a restart: show the template. */
export const STALE_AFTER_MS = 15 * 60_000;

type Runtime = { provider: ImageProvider | null; sleep: (ms: number) => Promise<void>; random: () => number; now: () => Date };

const defaults = (): Runtime => ({
  provider: providerFromEnv(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
  now: () => new Date()
});

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

/** Starts drawing this result's figure, or settles it on the template at once (over budget, over the address's limit, no provider). */
export function enqueueAvatar(result: StoredResult): void {
  const { provider } = current();
  if (!provider || avatarsDrawnFor(result.email) >= AVATARS_PER_EMAIL || jobs().size() >= MAX_PENDING + CONCURRENCY
      || !takeSlot(dailyLimit(), current().now())) {
    setAvatarState(result.id, "template");
    return;
  }
  setAvatarState(result.id, "queued");
  const taken = jobs().push(() => draw(provider, result));
  if (!taken) setAvatarState(result.id, "template");
}

async function draw(provider: ImageProvider, result: StoredResult): Promise<void> {
  try {
    setAvatarState(result.id, "drawing");
    const reference = fs.readFileSync(templateImagePath(result.code));
    const input = { reference, prompt: avatarPrompt(result.appearance), seed: seedFor(result.id) };
    let image: Buffer;
    try {
      image = await withTimeout((signal) => provider.edit({ ...input, signal }));
    } catch (error) {
      // One retry, only for what a wait can fix (rate limit, overload), and only if today's budget still has a slot for it.
      if (!(error instanceof ProviderError) || !error.retryable || !takeSlot(dailyLimit(), current().now())) throw error;
      await current().sleep(backoffMs(error));
      image = await withTimeout((signal) => provider.edit({ ...input, signal }));
    }
    const file = drawnFile(result.id);
    writeFileAtomic(absolute(file), image);
    setAvatarState(result.id, "ready", file);
  } catch (error) {
    console.warn(JSON.stringify({ event: "avatar.failed", resultId: result.id, reason: error instanceof Error ? error.message.slice(0, 200) : "unknown" }));
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
  return drawnPath(result) ?? templateImagePath(result.code);
}

/** The type's template PNG on disk. */
export function templateImagePath(code: string): string {
  if (!/^[SG][EI][MR][PA]$/.test(code)) throw new Error(`AVATAR_TYPE_UNKNOWN: ${code}`);
  return path.join(templatesDir(), `${code}.png`);
}
