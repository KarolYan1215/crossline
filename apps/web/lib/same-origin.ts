import "server-only";

/**
 * Whether a state-changing request came from another site.
 *
 * Compared against the `Host` header — the address the browser actually used — rather than
 * `new URL(request.url).origin`. Behind `next start` the reconstructed URL does not carry the host the
 * browser addressed, so the old check refused every same-origin POST: Analyze, every execution action
 * and the consent toggle all returned 403 from the browser while the same routes worked from curl,
 * which sends no `Origin` at all. The whole write path was unreachable from the UI.
 *
 * A request with no `Origin` is not a browser form post — it is a local tool or a script, which this
 * app is expected to support. The guard exists to stop another *site* writing here, not to stop the
 * owner's own terminal.
 */
export function isCrossSiteWrite(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const host = request.headers.get("host");
  if (!host) return true;
  try {
    return new URL(origin).host !== host;
  } catch {
    // An Origin that is not a URL is not something to trust.
    return true;
  }
}
