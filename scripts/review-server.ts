import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A throwaway copy of the app for walking the interface: the resident production build (`apps/web/.next-prod`) served on port 3320
 * against a fresh data directory with the example board seeded, so a review never reads or writes the real ledger and needs no real
 * account. Sign up with any test address; `scripts/review-seed.ts` then adds step plans to the example tasks.
 *
 *   pnpm exec tsx scripts/review-server.ts
 *
 * `dev` runs `next dev` on the same port against its own build directory (`.next-review`) instead of the resident build, for looking at
 * a change before `pnpm build:prod` — rebuilding `.next-prod` under the running resident server breaks its styles (CLAUDE.md).
 *
 *   pnpm exec tsx scripts/review-server.ts dev
 *
 * `--port N` (or `REVIEW_PORT`) serves on another port, with a data directory of its own (`crossline-review-<N>`), when 3320 is taken by
 * another review copy.
 */
const repoRoot = path.resolve(import.meta.dirname, "..");
const webRoot = path.join(repoRoot, "apps", "web");
const portArg = process.argv.indexOf("--port");
const port = Number(portArg >= 0 ? process.argv[portArg + 1] : process.env.REVIEW_PORT ?? 3320) || 3320;
export const REVIEW_DATA_DIR = path.join(tmpdir(), port === 3320 ? "crossline-review" : `crossline-review-${port}`);
const dev = process.argv.includes("dev");
// Kept between restarts (a rebuild restarts the server); `REVIEW_RESET=1` starts from an empty board.
if (process.env.REVIEW_RESET === "1") rmSync(REVIEW_DATA_DIR, { recursive: true, force: true });
mkdirSync(REVIEW_DATA_DIR, { recursive: true });
const child = spawn(process.execPath, [path.join(webRoot, "node_modules", "next", "dist", "bin", "next"), dev ? "dev" : "start", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: webRoot, stdio: "inherit",
  env: { ...process.env, CROSSLINE_DATA_DIR: REVIEW_DATA_DIR, CROSSLINE_NEXT_DIR: dev ? ".next-review" : ".next-prod", CROSSLINE_SEED_EXAMPLES: "1",
    BETTER_AUTH_SECRET: "review-secret-not-for-production-use",
    // `localhost`, not 127.0.0.1: cookies do not keep ports apart, so signing in to the review copy at 127.0.0.1 replaced the resident
    // app's (127.0.0.1:3210) session in the same browser and signed the person out of their real account.
    CROSSLINE_WEB_BASE_URL: `http://localhost:${port}`,
    CROSSLINE_AUTH_TEST_MAILBOX_DIR: path.join(REVIEW_DATA_DIR, "mailbox"), CROSSLINE_DEPLOYMENT_MODE: "local", CROSSLINE_TAILSCALE_HOSTNAME: "",
    CROSSLINE_AUTO_PUBLISH: "off",
    // Never the resident worker: its supervisor serves the real ledger. Nothing listens here, so model features report the worker as down.
    CROSSLINE_CODEX_SUPERVISOR_URL: "http://127.0.0.1:3399", CROSSLINE_SUPERVISOR_CAPABILITY_SECRET: "review-capability-secret" }
});
child.on("exit", (code) => process.exit(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
