import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";

/**
 * A window title can name a person, a page, a document or an account, and the promise made to the person is that it never
 * leaves this machine and never reaches a model. That is a property of what code can *reach* the titles, so it is checked
 * the way the CSRF and identity rules are: by walking the source, not by trusting each call site.
 *
 * Titles are readable through exactly one store method, `recentActivityEntries`, and written through one,
 * `recordActivityReading`. Anything else asking for them is a new path that has to be argued for here.
 */
const ROOTS = ["apps/web", "apps/worker/src", "packages"];
const SKIP = new Set(["node_modules", ".next", ".next-e2e", "dist"]);
const root = path.resolve(import.meta.dirname, "../../..");

function collect(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(full));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full);
  }
  return out;
}
const files = ROOTS.flatMap((dir) => collect(path.join(root, dir)));
const rel = (file: string) => path.relative(root, file).replaceAll("\\", "/");
const using = (needle: string) => files.filter((file) => readFileSync(file, "utf8").includes(needle)).map(rel).sort();

test("window titles are readable from one place only: the settings route that shows the person what is kept", () => {
  expect(using("recentActivityEntries")).toEqual(["apps/web/app/api/settings/local-activity/route.ts", "packages/db/src/index.ts"]);
});

test("only the tracker writes readings, and nothing that builds a model context touches segments at all", () => {
  expect(using("recordActivityReading")).toEqual(["apps/worker/src/activity-recorder.ts", "packages/db/src/index.ts"]);
  const codexFacing = files.filter((file) => /packages\/codex|apps\/worker\/src\/(analysis|assistant|diligence|flywheel|manualbook|materials|milestone|onboarding|plan-explainer)/.test(rel(file)));
  expect(codexFacing.length).toBeGreaterThan(5);
  const offenders = codexFacing.filter((file) => /listActivitySegments|recentActivityEntries|activity_segments/.test(readFileSync(file, "utf8"))).map(rel);
  expect(offenders).toEqual([]);
});
