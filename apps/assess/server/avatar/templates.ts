import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the type templates live (`apps/assess/templates/<CODE>-female.png` and `<CODE>-male.png`: a woman and a man per type, full
 * length, 2:3), found without trusting the working directory:
 *
 * 1. `ASSESS_TEMPLATES_DIR`, when set (a deployment may keep them anywhere);
 * 2. beside this module's source (`../../templates`) — dev, vitest, tsx scripts;
 * 3. `<cwd>/templates` — the Next standalone server `chdir`s into `.next/standalone/apps/assess` before it starts, and the templates are
 *    copied there (see templates/README.md: `outputFileTracingIncludes` or the Dockerfile's `COPY`); a bundled module's `import.meta.url`
 *    names the build machine's source path, which is why step 2 alone is not enough;
 * 4. `<cwd>/apps/assess/templates` — a script run from the repository root.
 *
 * The first directory that holds `ROBA-female.png` wins and is remembered.
 */

export type TemplateVariant = "female" | "male";
export const TEMPLATE_VARIANTS: TemplateVariant[] = ["female", "male"];

/**
 * Which template a person's figure starts from: the one matching how they present; someone who chose 「中性」 gets one of the two by a
 * stable hash of their result id (the editing model then draws them androgynous), so the same result always shows the same figure.
 */
export function templateVariant(presentation: "female" | "male" | "neutral", id: string): TemplateVariant {
  if (presentation !== "neutral") return presentation;
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 2 ? "male" : "female";
}

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
  const found = all.find((dir) => fs.existsSync(path.join(dir, "ROBA-female.png")));
  if (found) resolved = found;
  return found ?? all[0]!;
}

/** Forget the remembered directory (tests that point `ASSESS_TEMPLATES_DIR` elsewhere). */
export function resetTemplatesDir(): void {
  resolved = undefined;
}
