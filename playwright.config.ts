import { defineConfig, devices } from "@playwright/test";
import os from "node:os";
import path from "node:path";

const e2eDataDir = path.join(os.tmpdir(), `crossline-e2e-${process.pid}`);

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
  webServer: {
    command: "pnpm --filter @crossline/web exec next dev --webpack --hostname 127.0.0.1 --port 3310",
    url: "http://127.0.0.1:3310/api/health",
    env: {
      CROSSLINE_DATA_DIR: e2eDataDir,
      CROSSLINE_NEXT_DIR: ".next-e2e",
      CROSSLINE_FIXED_NOW: "2026-09-14T16:45:00.000Z"
    },
    reuseExistingServer: false,
    timeout: 120_000
  },
  projects: [
    { name: "desktop-chrome", use: { ...devices["Desktop Chrome"], channel: "chrome", viewport: { width: 1440, height: 1100 } } },
    { name: "mobile-chrome", use: { ...devices["Pixel 7"], channel: "chrome" } }
  ]
});
