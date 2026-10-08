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
 */
const repoRoot = path.resolve(import.meta.dirname, "..");
const webRoot = path.join(repoRoot, "apps", "web");
export const REVIEW_DATA_DIR = path.join(tmpdir(), "crossline-review");
// Kept between restarts (a rebuild restarts the server); `REVIEW_RESET=1` starts from an empty board.
if (process.env.REVIEW_RESET === "1") rmSync(REVIEW_DATA_DIR, { recursive: true, force: true });
mkdirSync(REVIEW_DATA_DIR, { recursive: true });
const child = spawn(process.execPath, [path.join(webRoot, "node_modules", "next", "dist", "bin", "next"), "start", "--hostname", "127.0.0.1", "--port", "3320"], {
  cwd: webRoot, stdio: "inherit",
  env: { ...process.env, CROSSLINE_DATA_DIR: REVIEW_DATA_DIR, CROSSLINE_NEXT_DIR: ".next-prod", CROSSLINE_SEED_EXAMPLES: "1",
    BETTER_AUTH_SECRET: "review-secret-not-for-production-use", CROSSLINE_WEB_BASE_URL: "http://127.0.0.1:3320",
    CROSSLINE_AUTH_TEST_MAILBOX_DIR: path.join(REVIEW_DATA_DIR, "mailbox"), CROSSLINE_DEPLOYMENT_MODE: "local", CROSSLINE_TAILSCALE_HOSTNAME: "",
    CROSSLINE_AUTO_PUBLISH: "off" }
});
child.on("exit", (code) => process.exit(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
