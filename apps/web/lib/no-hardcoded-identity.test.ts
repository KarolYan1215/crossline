import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";

/**
 * Stage three's whole point was deleting `OWNER_ID = "local-owner"` / `WORKSPACE_ID = "personal-crossline"`
 * from every business read/write path in favour of a real `AccessContext`. "Did I actually get every
 * occurrence" is not something to trust to memory or a one-off grep — this is the discovery-test sibling
 * of `csrf-protection.test.ts`: it walks every source file under the covered roots and fails the moment
 * either literal reappears, so a reintroduced hardcode is caught on the commit that added it.
 *
 * `apps/worker` is covered too. It was left out while its background jobs each closed over the old
 * owner constant; those now resolve the workspace's real owner through `apps/worker/src/owner.ts`, and the
 * one place that still *filtered* on the constant (the goal backplanner) is exactly the bug that made
 * 「从此目标反推步骤」 fail on every real account.
 *
 * Test files and fixtures are exempt on purpose: a test's own `TEST_CTX`/`seed()` helper needs some
 * concrete workspace id to write rows under, and that id is not a production identity leak.
 */
const ROOTS = ["apps/web", "apps/worker"];
const SKIP_DIRS = new Set(["node_modules", ".next", ".next-e2e", "dist", "testing"]);
const FORBIDDEN = ["local-owner", "personal-crossline"];

function collectFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...collectFiles(full));
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) {
      files.push(full);
    }
  }
  return files;
}

test("no source file outside tests hardcodes the old single-user identity", () => {
  const repoRoot = path.resolve(import.meta.dirname, "../../..");
  const offenders: Array<{ file: string; literal: string }> = [];
  for (const root of ROOTS) {
    for (const file of collectFiles(path.join(repoRoot, root))) {
      const text = readFileSync(file, "utf8");
      for (const literal of FORBIDDEN) {
        if (text.includes(`"${literal}"`)) offenders.push({ file: path.relative(repoRoot, file), literal });
      }
    }
  }
  expect(offenders).toEqual([]);
});

// A glob that matched nothing would make the assertion above pass for the wrong reason — silence that
// looks identical to success.
test("the scan actually walked a non-trivial number of files", () => {
  const repoRoot = path.resolve(import.meta.dirname, "../../..");
  const total = ROOTS.reduce((sum, root) => sum + collectFiles(path.join(repoRoot, root)).length, 0);
  expect(total).toBeGreaterThan(50);
});
