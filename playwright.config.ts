import { defineConfig, devices } from "@playwright/test";
import os from "node:os";
import path from "node:path";

// Computed once in the main process and handed down through the environment. Test workers re-load
// this config in their own processes, where `process.pid` is a different number — without the stash a
// test could not find the ledger the server is using, and one that writes its own precondition must.
const e2eDataDir = process.env.CROSSLINE_E2E_DATA_DIR ?? path.join(os.tmpdir(), `crossline-e2e-${process.pid}`);
process.env.CROSSLINE_E2E_DATA_DIR = e2eDataDir;
// Same sharing rationale as the data dir: `global-setup.ts` (main process) and the spawned server
// (its own process) both need to agree on where captured verification/reset emails land.
const authMailboxDir = path.join(e2eDataDir, "mailbox");
process.env.CROSSLINE_AUTH_TEST_MAILBOX_DIR = authMailboxDir;
// Read back by `global-setup.ts` and by the `request` fixture (via each project's `storageState`) so
// the real sign-up → verify → sign-in flow only has to run once per e2e run, not once per test.
const authStatePath = path.join(e2eDataDir, "auth-state.json");

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  // Runs after the server below is up and healthy (Playwright starts `webServer` before `globalSetup`
  // for exactly this reason — see https://playwright.dev/docs/auth): it drives a real Better Auth
  // sign-up, reads the verification link back out of `authMailboxDir` instead of a real mailbox, then
  // signs in and saves the resulting session cookie to `authStatePath` for every project to reuse.
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: "http://127.0.0.1:3310",
    trace: "retain-on-failure",
    colorScheme: "light",
    storageState: authStatePath
  },
  // Port 3310, not 3211: the resident worker owns 3211 for the Codex supervisor. Sharing it meant e2e
  // either failed to bind or — worse — answered the web app's own supervisor calls with itself.
  //
  // A production build, not `next dev`. `next.config.mjs` disables Serwist in development, so the
  // whole offline story — the app's headline claim — had no service worker to test against and could
  // not have been verified here no matter what a test asserted. Building costs a few seconds and buys
  // an environment that matches what actually runs.
  webServer: process.env.CROSSLINE_E2E_EXTERNAL_SERVER ? undefined : {
    command: "pnpm --filter @crossline/web exec next build --webpack"
      + " && pnpm --filter @crossline/web exec next start --hostname 127.0.0.1 --port 3310",
    url: "http://127.0.0.1:3310/api/health",
    env: {
      CROSSLINE_DATA_DIR: e2eDataDir,
      CROSSLINE_NEXT_DIR: ".next-e2e",
      CROSSLINE_FIXED_NOW: "2026-09-14T16:45:00.000Z",
      BETTER_AUTH_SECRET: "e2e-test-secret-not-for-production-use",
      // Better Auth stamps the verification link with this base URL — without overriding it here, the
      // captured link points at the dev server's port (3210) instead of the one e2e is actually running.
      CROSSLINE_WEB_BASE_URL: "http://127.0.0.1:3310",
      CROSSLINE_AUTH_TEST_MAILBOX_DIR: authMailboxDir,
      // Same reasoning as `scripts/run-e2e.ts`'s identical override: Next.js loads `apps/web/.env` on its
      // own inside the spawned process, and a developer's real `private`-mode config would otherwise leak
      // into this run and turn on CSP/security headers e2e never accounts for.
      CROSSLINE_DEPLOYMENT_MODE: "local",
      // The visual baselines and flows were recorded against a board with example goals on it.
      CROSSLINE_SEED_EXAMPLES: "1",
      CROSSLINE_TAILSCALE_HOSTNAME: ""
    },
    reuseExistingServer: false,
    timeout: 240_000
  },
  // The real Windows dev machine this app targets always has a branded Chrome install, so `channel:
  // "chrome"` (below) is the default path and what actually runs there. A sandbox with only the
  // Playwright-bundled Chromium (no "chrome" channel available) sets CROSSLINE_E2E_CHROME_PATH to fall
  // back to it instead; unset, behavior is unchanged.
  //
  // The phone runs after the desktop, never beside it: both share one ledger, and the phone writes a next step of its own
  // (`ensureOwnNextStep`). With more than one worker the two projects interleaved, that step reached the desktop Today
  // before its screenshot, and the baselines matched or not depending on which worker got there first.
  projects: process.env.CROSSLINE_E2E_CHROME_PATH ? [
    { name: "desktop-chrome", use: { ...devices["Desktop Chrome"], launchOptions: { executablePath: process.env.CROSSLINE_E2E_CHROME_PATH }, viewport: { width: 1440, height: 1100 } } },
    { name: "mobile-chrome", dependencies: ["desktop-chrome"], use: { ...devices["Pixel 7"], launchOptions: { executablePath: process.env.CROSSLINE_E2E_CHROME_PATH } } }
  ] : [
    { name: "desktop-chrome", use: { ...devices["Desktop Chrome"], channel: "chrome", viewport: { width: 1440, height: 1100 } } },
    { name: "mobile-chrome", dependencies: ["desktop-chrome"], use: { ...devices["Pixel 7"], channel: "chrome" } }
  ]
});
