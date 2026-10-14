import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Font } from "satori";
import { LABELS } from "./labels";

/**
 * The poster fonts: subsets of Noto Sans SC and Noto Serif SC built by `scripts/assess-poster-fonts.ts` (SIL OFL 1.1, `fonts/OFL.txt`).
 * satori renders only what the fonts it is handed contain — a missing glyph is left out, not substituted — so every string goes
 * through `safe` first, which prints 「·」 for a character the face's glyph list does not hold.
 */

export type Family = "Sans" | "Serif";

/**
 * Where the fonts live: `ASSESS_FONTS_DIR`, else `fonts/` under the app (the working directory of `next start` and of the standalone
 * server), else under `apps/assess` (vitest and scripts run from the repo root).
 */
export function fontsDir(): string {
  const candidates = [process.env.ASSESS_FONTS_DIR, path.join(process.cwd(), "fonts"), path.join(process.cwd(), "apps", "assess", "fonts")];
  const found = candidates.find((dir): dir is string => Boolean(dir) && existsSync(path.join(dir!, "poster-sans-regular.otf")));
  if (!found) throw new Error("POSTER_FONTS_MISSING: run scripts/assess-poster-fonts.ts or set ASSESS_FONTS_DIR");
  return found;
}

let loaded: { fonts: Font[]; glyphs: Record<Family, Set<string>> } | undefined;

/** The four faces, read once; the same array every time, so satori keeps its parsed fonts between renders. */
export function posterFonts(): { fonts: Font[]; glyphs: Record<Family, Set<string>> } {
  if (loaded) return loaded;
  const dir = fontsDir();
  const read = (file: string) => readFileSync(path.join(dir, file));
  const glyphs = (file: string) => new Set([...readFileSync(path.join(dir, file), "utf8")]);
  loaded = {
    fonts: [
      { name: "Sans", data: read("poster-sans-regular.otf"), weight: 400, style: "normal" },
      { name: "Sans", data: read("poster-sans-bold.otf"), weight: 700, style: "normal" },
      { name: "Serif", data: read("poster-serif-regular.otf"), weight: 400, style: "normal" },
      { name: "Serif", data: read("poster-serif-bold.otf"), weight: 700, style: "normal" }
    ],
    glyphs: { Sans: glyphs("poster-sans.glyphs.txt"), Serif: glyphs("poster-serif.glyphs.txt") }
  };
  return loaded;
}

/** The text with every character the face cannot print replaced by 「·」 (whitespace kept as a plain space). */
export function safe(text: string, family: Family): string {
  const glyphs = posterFonts().glyphs[family];
  return [...text].map((char) => /\s/.test(char) ? " " : glyphs.has(char) ? char : LABELS.replacement).join("");
}
