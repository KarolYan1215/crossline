import { spawnSync } from "node:child_process";
import path from "node:path";

/**
 * Builds the resident app into its own directory (`apps/web/.next-prod`), which `start-crossline.ps1` serves from.
 *
 * The resident server used to run from `.next`, the same directory `pnpm build` (and so `pnpm verify`) writes. A verify run while the
 * server was up replaced the hashed CSS and chunks under it: the server kept handing out pages that named the old files, which no
 * longer existed, and every page lost its styles (found on 2026-10-07 opening the app from the phone address, where nothing was
 * cached). A separate directory means building for tests never touches what is being served; this replaces it only when asked.
 */
const repoRoot = path.resolve(import.meta.dirname, "..");
const result = spawnSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["--filter", "@crossline/web", "build"], {
  cwd: repoRoot, stdio: "inherit", shell: process.platform === "win32", env: { ...process.env, CROSSLINE_NEXT_DIR: ".next-prod" }
});
process.exit(result.status ?? 1);
