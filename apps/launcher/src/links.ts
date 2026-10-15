import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";

/**
 * The workspace packages (`@crossline/core`, …) resolve through `node_modules\@crossline\<name>`, which a checkout's package
 * manager makes as links to `packages\<name>`. An installer copies files, not links, and copying the package instead would give the
 * same module two identities (one under node_modules, one under packages). So the installed tree ships without those entries and
 * the launcher makes them as directory junctions — no administrator rights needed — before anything is started. Idempotent; a
 * link pointing anywhere else is replaced.
 */
export function ensureWorkspaceLinks(appDir: string): string[] {
  const packagesDir = path.join(appDir, "packages");
  if (!existsSync(packagesDir)) return [];
  const made: string[] = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const target = path.join(packagesDir, entry.name);
    let name: string | undefined;
    try { name = (JSON.parse(readFileSync(path.join(target, "package.json"), "utf8")) as { name?: string }).name; } catch { continue; }
    if (!name?.startsWith("@crossline/")) continue;
    const link = path.join(appDir, "node_modules", ...name.split("/"));
    if (pointsAt(link, target)) continue;
    rmSync(link, { recursive: true, force: true });
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(target, link, "junction");
    made.push(name);
  }
  return made;
}

function pointsAt(link: string, target: string): boolean {
  try { return lstatSync(link).isSymbolicLink() && realpathSync(link).toLowerCase() === realpathSync(target).toLowerCase(); }
  catch { return false; }
}
