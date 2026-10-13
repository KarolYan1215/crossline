/**
 * Builds the poster's serif subset (decided 2026-10-12, style A): Noto Serif SC Bold (SIL OFL 1.1) cut down to the characters the
 * poster sets in it (`posterSerifText`), self-hosted so it works offline and `html-to-image` can embed it in the shared images.
 *
 *   pnpm exec tsx scripts/poster-font-subset.ts <path to NotoSerifSC-Bold.otf>
 *
 * The source font comes from github.com/notofonts/noto-cjk (Serif/SubsetOTF/SC). Rerun after changing a type name or a title: a
 * character missing from the subset silently falls back to another face, which `poster-geometry.test.ts` catches.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import subsetFont from "subset-font";
// Relative: the repo root is not a workspace package.
import { posterSerifText } from "../apps/web/app/portrait/poster-geometry.js";

const source = process.argv[2];
if (!source) throw new Error("usage: poster-font-subset.ts <NotoSerifSC-Bold.otf>");
const text = posterSerifText();
const out = path.resolve(import.meta.dirname, "../apps/web/public/fonts");
const woff2 = await subsetFont(readFileSync(source), text, { targetFormat: "woff2" });
writeFileSync(path.join(out, "poster-serif.woff2"), woff2);
writeFileSync(path.join(out, "poster-serif.glyphs.txt"), text);
console.log(`poster-serif.woff2: ${woff2.length} bytes, ${[...text].length} characters`);
