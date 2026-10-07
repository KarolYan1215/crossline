/**
 * Runs once before this server instance accepts its first request. `auth.db` needs Better Auth's own
 * `user`/`session`/`account`/`verification` schema before any route can use it — see
 * `migrateCrosslineAuth`'s comment in packages/auth for why this calls Better Auth's own migration
 * function directly rather than the separately-versioned `@better-auth/cli`.
 *
 * Skips silently when `BETTER_AUTH_SECRET` is unset: identity is opt-in infrastructure layered onto an
 * app that otherwise runs fine without it (today's business routes still work off the pre-login
 * `local-owner`/`personal-crossline` constants), so a Crossline install that has not turned this on yet
 * must not be blocked at boot by it.
 */
export async function register(): Promise<void> {
  // The `if (NEXT_RUNTIME === 'nodejs') { await import(...) }` shape (nested, not an early return) is
  // the documented pattern for runtime-specific code in this file — Next's webpack config uses it to
  // decide what to exclude from the edge bundle. An early-return guard in front of the same dynamic
  // imports still pulled `better-sqlite3` (a native module, unavailable on edge) into that bundle and
  // failed the whole dev server on `Module not found: Can't resolve 'fs'`, found by actually starting it.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // The Crossline calendar follows the approved plan on its own (the person chose this). Off in tests and
    // e2e, and with CROSSLINE_AUTO_PUBLISH=off; a failing pass is logged by nobody and retried next interval.
    if (process.env.CROSSLINE_AUTO_PUBLISH !== "off" && !process.env.VITEST && !process.env.CROSSLINE_E2E_DATA_DIR) {
      const { autoPublishPass, AUTO_PUBLISH_INTERVAL_MS } = await import("./lib/auto-publish");
      const timer = setInterval(() => { void autoPublishPass().catch(() => {}); }, AUTO_PUBLISH_INTERVAL_MS);
      timer.unref?.();
    }
    const { resolveCrosslineAuthOptions } = await import("./lib/auth");
    const options = resolveCrosslineAuthOptions();
    if (!options) return;
    const { migrateCrosslineAuth } = await import("@crossline/auth");
    const { applied } = await migrateCrosslineAuth(options);
    if (applied.length) console.info(`[auth] applied Better Auth schema: ${applied.join(", ")}`);
  }
}
