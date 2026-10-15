import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the sixteen type templates live (`apps/assess/templates/<CODE>.png`), found without trusting the working directory:
 *
 * 1. `ASSESS_TEMPLATES_DIR`, when set (a deployment may keep them anywhere);
 * 2. beside this module's source (`../../templates`) — dev, vitest, tsx scripts;
 * 3. `<cwd>/templates` — the Next standalone server `chdir`s into `.next/standalone/apps/assess` before it starts, and the templates are
 *    copied there (see templates/README.md: `outputFileTracingIncludes` or the Dockerfile's `COPY`); a bundled module's `import.meta.url`
 *    names the build machine's source path, which is why step 2 alone is not enough;
 * 4. `<cwd>/apps/assess/templates` — a script run from the repository root.
 *
 * The first directory that holds `GEMA.png` wins and is remembered.
 */

let resolved: string | undefined;

function candidates(): string[] {
  const list: string[] = [];
  if (process.env.ASSESS_TEMPLATES_DIR) list.push(path.resolve(process.env.ASSESS_TEMPLATES_DIR));
  // Not `new URL("../../templates/", import.meta.url)`: webpack reads that form as an asset import and cannot resolve a directory.
  try { list.push(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "templates")); } catch { /* not a file URL once bundled */ }
  list.push(path.join(process.cwd(), "templates"), path.join(process.cwd(), "apps", "assess", "templates"));
  return list;
}

export function templatesDir(): string {
  if (resolved) return resolved;
  const all = candidates();
  const found = all.find((dir) => fs.existsSync(path.join(dir, "GEMA.png")));
  if (found) resolved = found;
  return found ?? all[0]!;
}

/** Forget the remembered directory (tests that point `ASSESS_TEMPLATES_DIR` elsewhere). */
export function resetTemplatesDir(): void {
  resolved = undefined;
}
