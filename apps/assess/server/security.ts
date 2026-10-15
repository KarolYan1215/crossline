import { quizScores, type TypeAxisId } from "@crossline/core/assess";
import { APPEARANCE_LABELS, NICKNAME_MAX, NOTE_MAX, type ApiErrorCode, type Appearance, type SubmitRequest } from "../lib/contract";

/**
 * What stands between the public internet and the store (docs/assess-deploy.md, 「安全」): the client address as the reverse proxy
 * saw it, rate limits, the cross-site write check, input validation and the JSON answers every route gives.
 */

/** Statements answered faster than this are not a person reading 32 of them (docs/beta-launch.md §1.1). */
export const MIN_ANSWER_MS = 40_000;

/** JSON with `Cache-Control: no-store`: every answer here is either private or a capability's view, and neither belongs in a cache. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

const STATUS: Record<ApiErrorCode, number> = {
  QUIZ_INCOMPLETE: 400, APPEARANCE_INVALID: 400, EMAIL_INVALID: 400, NICKNAME_INVALID: 400, TOO_FAST: 400, REJECTED: 400,
  RATE_LIMITED: 429, INVITE_NOT_FOUND: 404, ALREADY_PAIRED: 409, NOT_FOUND: 404, UNAUTHORIZED: 401, EMAIL_LIMIT_REACHED: 409
};

export function fail(code: ApiErrorCode, retryAfterSeconds?: number): Response {
  return json({ ok: false, code }, STATUS[code], retryAfterSeconds ? { "Retry-After": String(retryAfterSeconds) } : {});
}

/**
 * The client's address. In production the app listens only to Caddy on the loopback interface; Caddy ignores any incoming
 * `X-Forwarded-For` from an untrusted client and sends the address it actually saw, and Next fills the header from the socket only when
 * it is absent. So the right-most entry is always the address of whoever connected to the proxy (or to the app directly in development).
 * Exposing the app's port without the proxy would let a client choose that entry — the deployment guide binds it to 127.0.0.1.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const last = forwarded?.split(",").map((part) => part.trim()).filter(Boolean).pop();
  return (last ?? "unknown").replace(/^::ffff:/, "");
}

/** A sliding-window counter per key, in memory: one container runs one process, and a restart forgetting the counts is acceptable. */
export class RateLimiter {
  #hits = new Map<string, number[]>();
  constructor(readonly limit: number, readonly windowMs: number) {}

  /** Records one attempt; refuses (with seconds to wait) once the key has used its window. */
  hit(key: string, now = Date.now()): { ok: true } | { ok: false; retryAfter: number } {
    const recent = (this.#hits.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (recent.length >= this.limit) {
      this.#hits.set(key, recent);
      return { ok: false, retryAfter: Math.max(1, Math.ceil((recent[0]! + this.windowMs - now) / 1000)) };
    }
    recent.push(now);
    this.#hits.set(key, recent);
    if (this.#hits.size > 50_000) this.#prune(now);
    return { ok: true };
  }

  /** Seconds to wait when the key has used its window, without recording an attempt; undefined when it may go on. */
  blocked(key: string, now = Date.now()): number | undefined {
    const recent = (this.#hits.get(key) ?? []).filter((at) => now - at < this.windowMs);
    return recent.length >= this.limit ? Math.max(1, Math.ceil((recent[0]! + this.windowMs - now) / 1000)) : undefined;
  }

  reset(): void { this.#hits.clear(); }

  #prune(now: number): void {
    for (const [key, times] of this.#hits) if (times.every((at) => now - at >= this.windowMs)) this.#hits.delete(key);
  }
}

/** Submissions per address per hour: generous, since a classroom, a dormitory or a mobile carrier's shared (CGNAT) address can stand
 * for many people at once; the per-email limit and the 40-second floor are what stop a script. */
export const submitsPerIp = new RateLimiter(120, 60 * 60_000);
/** Submissions per email per day. */
export const submitsPerEmail = new RateLimiter(5, 24 * 60 * 60_000);
/** Token lookups that found nothing, per address per ten minutes: slows anyone walking the token space. */
export const lookupMisses = new RateLimiter(30, 10 * 60_000);

/** Link lookups from the Crossline app (`/api/link`), per address per minute; wrong secrets count too. */
export const linkLookups = new RateLimiter(60, 60_000);

export function resetRateLimits(): void {
  linkLookups.reset();
  submitsPerIp.reset();
  submitsPerEmail.reset();
  lookupMisses.reset();
}

/** A token lookup refused before it runs, once this address has missed too often. */
export function lookupBlocked(request: Request): Response | undefined {
  const wait = lookupMisses.blocked(clientIp(request));
  return wait ? fail("RATE_LIMITED", wait) : undefined;
}

/** A token lookup that found nothing: counted against the address, then answered 404. */
export function lookupMissed(request: Request): Response {
  lookupMisses.hit(clientIp(request));
  return fail("NOT_FOUND");
}

/**
 * Whether a state-changing request came from another site: an `Origin` that names a different host than the one addressed (the same
 * rule as the private app's `isCrossSiteWrite`). No `Origin` at all is a script or a test, not a cross-site browser post.
 */
export function crossSiteWrite(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!host) return true;
  try { return new URL(origin).host !== host; } catch { return true; }
}

/** Control, format (zero-width, bidi), separator and filler characters: nothing a person means to type into a name. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}ᅟᅠㅤﾠ⠀]/gu;
export const stripInvisible = (text: string): string => text.replace(INVISIBLE, "");
const characters = (text: string): number => [...text].length;

const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[^\s@<>()[\]\\,;:"_]+(\.[^\s@<>()[\]\\,;:"_]+)*\.[^\s@<>()[\]\\,;:"_.\d]{2,}$/u;

/** A trimmed, lowercased address of a sane shape and at most 254 characters, or undefined. */
export function normaliseEmail(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const email = raw.trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) && !email.includes("..") ? email : undefined;
}

const oneOf = <T extends string>(value: unknown, options: Record<T, string>): value is T =>
  typeof value === "string" && Object.prototype.hasOwnProperty.call(options, value);

/** The appearance as the contract allows it, with the free note cleaned; undefined when anything is off. */
export function parseAppearance(raw: unknown): Appearance | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const keys = ["presentation", "hair", "glasses", "skin", "style", "note"];
  if (Object.keys(value).some((key) => !keys.includes(key))) return undefined;
  if (!oneOf(value.presentation, APPEARANCE_LABELS.presentation) || !oneOf(value.hair, APPEARANCE_LABELS.hair)
    || typeof value.glasses !== "boolean" || !oneOf(value.skin, APPEARANCE_LABELS.skin) || !oneOf(value.style, APPEARANCE_LABELS.style)) return undefined;
  const note = typeof value.note === "string" ? stripInvisible(value.note).trim() : value.note === undefined ? "" : undefined;
  if (note === undefined || characters(note) > NOTE_MAX) return undefined;
  return { presentation: value.presentation, hair: value.hair, glasses: value.glasses, skin: value.skin, style: value.style, note };
}

export type ParsedSubmission = {
  scores: Record<TypeAxisId, number>;
  appearance: Appearance;
  email: string;
  nickname: string;
  sendEmail: boolean;
  inviteToken?: string;
};

/**
 * Checks a submission in the order a person would want to hear about it, recomputing the scores on the server (a client's own scores
 * are never trusted). `now` is when it arrived.
 */
export function parseSubmission(raw: unknown, now = Date.now()): { ok: true; value: ParsedSubmission } | { ok: false; code: ApiErrorCode } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, code: "REJECTED" };
  const body = raw as Partial<Record<keyof SubmitRequest, unknown>>;
  if (typeof body.website === "string" ? body.website.trim() !== "" : body.website !== undefined) return { ok: false, code: "REJECTED" };
  if (typeof body.startedAt !== "number" || !Number.isFinite(body.startedAt)) return { ok: false, code: "REJECTED" };
  let scores: Record<TypeAxisId, number>;
  try {
    if (!body.answers || typeof body.answers !== "object" || Array.isArray(body.answers)) throw new Error("QUIZ_INCOMPLETE");
    scores = quizScores(body.answers as Record<string, number>);
  } catch {
    return { ok: false, code: "QUIZ_INCOMPLETE" };
  }
  const appearance = parseAppearance(body.appearance);
  if (!appearance) return { ok: false, code: "APPEARANCE_INVALID" };
  const email = normaliseEmail(body.email);
  if (!email) return { ok: false, code: "EMAIL_INVALID" };
  if (typeof body.nickname !== "string") return { ok: false, code: "NICKNAME_INVALID" };
  const nickname = stripInvisible(body.nickname).trim();
  if (characters(nickname) > NICKNAME_MAX) return { ok: false, code: "NICKNAME_INVALID" };
  if (typeof body.sendEmail !== "boolean") return { ok: false, code: "REJECTED" };
  if (body.inviteToken !== undefined && typeof body.inviteToken !== "string") return { ok: false, code: "INVITE_NOT_FOUND" };
  const elapsed = now - body.startedAt;
  if (elapsed < MIN_ANSWER_MS) return { ok: false, code: "TOO_FAST" };
  return { ok: true, value: { scores, appearance, email, nickname, sendEmail: body.sendEmail,
    ...(body.inviteToken ? { inviteToken: body.inviteToken } : {}) } };
}
