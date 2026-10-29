import { cspPolicy } from "./csp-policy.mjs";

/**
 * The Content Security Policy (2026-10-28). Pages carry a fresh nonce per response, set by `proxy.ts`: Next puts it on every script it
 * writes into the page (it reads the nonce from this header on the request) and the root layout puts it on the Speculation Rules. Inline
 * script without the nonce does not run — `'unsafe-inline'` is gone from `script-src`. Every page renders on request anyway: the root
 * layout reads the language cookie, so `/offline` too is rendered per request, and the copy the service worker keeps carries its own
 * header with its own nonce, so the two still match when it is served offline.
 *
 * Everything else that can be a document — an assistant's file opened from `/api/...`, the service worker script — gets the same policy
 * with no inline script at all (next.config.mjs). Only `local` mode (plain loopback) sends none, as before. The directives are in
 * `csp-policy.mjs`, which next.config.mjs reads too.
 */
export function contentSecurityPolicy(nonce?: string): string {
  return cspPolicy(nonce, process.env.NODE_ENV === "development");
}

/** A nonce for one response: 128 random bits, base64. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/** Whether this deployment sends the security headers at all (`private`; `local` is loopback only, see next.config.mjs). */
export const sendsSecurityHeaders = (): boolean => (process.env.CROSSLINE_DEPLOYMENT_MODE ?? "local") !== "local";
