import { defineConfig, devices } from "@playwright/test";
import os from "node:os";
import path from "node:path";

// Computed once in the main process and handed down through the environment. Test workers re-load
// this config in their own processes, where `process.pid` is a different number — without the stash a
// test could not find the ledger the server is using, and one that writes its own precondition must.
const e2eDataDir = process.env.CROSSLINE_E2E_DATA_DIR ?? path.join(os.tmpdir(), `crossline-e2e-${process.pid}`);
process.env.CROSSLINE_E2E_DATA_DIR = e2eDataDir;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3310",
    trace: "retain-on-failure",
    colorScheme: "light"
  },
  // Port 3310, not 3211: the resident worker owns 3211 for the Codex supervisor. Sharing it meant e2e
  // either failed to bind or — worse — answered the web app's own supervisor calls with itself.
  //
  // A production build, not `next dev`. `next.config.mjs` disables Serwist in development, so the
  // whole offline story — the app's headline claim — had no service worker to test against and could
  // not have been verified here no matter what a test asserted. Building costs a few seconds and buys
  // an environment that matches what actually runs.
  webServer: {
    command: "pnpm --filter @crossline/web exec next build --webpack"
      + " && pnpm --filter @crossline/web exec next start --hostname 127.0.0.1 --port 3310",
    url: "http://127.0.0.1:3310/api/health",
    env: {
      CROSSLINE_DATA_DIR: e2eDataDir,
      CROSSLINE_NEXT_DIR: ".next-e2e",
      CROSSLINE_FIXED_NOW: "2026-09-14T16:45:00.000Z"
    },
    reuseExistingServer: false,
    timeout: 240_000
  },
  projects: [
    { name: "desktop-chrome", use: { ...devices["Desktop Chrome"], channel: "chrome", viewport: { width: 1440, height: 1100 } } },
    { name: "mobile-chrome", use: { ...devices["Pixel 7"], channel: "chrome" } }
  ]
});
