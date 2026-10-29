/**
 * Builds the poster's serif subset (decided 2026-10-12, style A): Noto Serif SC Bold (SIL OFL 1.1) cut down to the characters the
 * poster sets in it (`posterSerifText`), self-hosted so it works offline and `html-to-image` can embed it in the shared images.
 *
 *   pnpm exec tsx scripts/poster-font-subset.ts <path to NotoSerifSC-Bold.otf>
 *
 * The source font comes from github.com/notofonts/noto-cjk (Serif/SubsetOTF/SC). Rerun after changing a type name or a title: a
 * character missing from the subset silently falls back to another face, which `poster-geometry.test.ts` catches.
 *
 * `--display <NotoSerifSC-VF.ttf>` builds the frame's display serif instead (`display-serif.woff2`, the Chinese characters of
 * `DISPLAY_SERIF` in `ui/serif-strings.ts`), from the variable Noto Serif SC that Windows installs, pinned at weight 600. It is a file of
 * its own so the poster's subset, and the portrait drawn with it, do not change when a card title is added.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import subsetFont from "subset-font";
// Relative: the repo root is not a workspace package.
import { posterSerifText } from "../apps/web/app/portrait/poster-geometry.js";
import { displaySerifText } from "../apps/web/app/ui/serif-strings.js";

const display = process.argv[2] === "--display";
const source = process.argv[display ? 3 : 2];
if (!source) throw new Error("usage: poster-font-subset.ts <NotoSerifSC-Bold.otf> | --display <NotoSerifSC-VF.ttf>");
const out = path.resolve(import.meta.dirname, "../apps/web/public/fonts");
const name = display ? "display-serif" : "poster-serif";
const text = display ? displaySerifText() : posterSerifText();
const woff2 = await subsetFont(readFileSync(source), text, { targetFormat: "woff2", ...(display ? { variationAxes: { wght: 600 } } : {}) });
writeFileSync(path.join(out, `${name}.woff2`), woff2);
writeFileSync(path.join(out, `${name}.glyphs.txt`), text);
console.log(`${name}.woff2: ${woff2.length} bytes, ${[...text].length} characters`);
