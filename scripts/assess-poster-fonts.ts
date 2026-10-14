/**
 * Builds the public quick test's poster fonts (docs/beta-launch.md §1, W3): Noto Sans SC and Noto Serif SC (SIL OFL 1.1) cut down to
 * what the server-rendered posters print, as plain sfnt (OpenType/CFF) — satori 0.33 reads TTF/OTF/WOFF but not WOFF2.
 *
 *   pnpm exec tsx scripts/assess-poster-fonts.ts <folder holding NotoSansSC-{Regular,Bold}.otf and NotoSerifSC-{Regular,Bold}.otf>
 *
 * The sources are github.com/notofonts/noto-cjk `Sans/SubsetOTF/SC` and `Serif/SubsetOTF/SC`. The sans faces carry every fixed string
 * (`posterFixedText`) plus GB2312 level 1 (3,755 characters, decoded from the byte range with TextDecoder("gbk")) and ASCII, so a
 * nickname of up to twelve characters renders; the serif faces only print fixed strings and carry just those. The glyph lists written
 * beside the fonts are what the renderer checks text against: anything outside them is printed as 「·」, never silently dropped.
 * Rerun after changing a type name, subtitle, line, relation or poster label; `poster.test.ts` fails until you do.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import subsetFont from "subset-font";
// Relative: the repo root is not a workspace package.
import { posterFixedText } from "../apps/assess/server/poster/labels.js";

const source = process.argv[2];
if (!source) throw new Error("usage: assess-poster-fonts.ts <folder with the Noto SC .otf files>");

/** GB2312 level 1: rows 0xB0–0xD7, cells 0xA1–0xFE (row 0xD7 stops at 0xF9). */
function gb2312Level1(): string {
  const decoder = new TextDecoder("gbk", { fatal: true });
  let text = "";
  for (let row = 0xb0; row <= 0xd7; row += 1) {
    for (let cell = 0xa1; cell <= 0xfe; cell += 1) {
      if (row === 0xd7 && cell > 0xf9) break;
      text += decoder.decode(new Uint8Array([row, cell]));
    }
  }
  return text;
}

const fixed = posterFixedText();
const level1 = gb2312Level1();
if ([...level1].length !== 3755) throw new Error(`GB2312 level 1 should be 3755 characters, got ${[...level1].length}`);
const sans = [...new Set(fixed + level1)].sort().join("");
const serif = fixed;

const out = path.resolve(import.meta.dirname, "../apps/assess/fonts");
const faces: Array<[string, string, string]> = [
  ["NotoSansSC-Regular.otf", "poster-sans-regular.otf", sans],
  ["NotoSansSC-Bold.otf", "poster-sans-bold.otf", sans],
  ["NotoSerifSC-Regular.otf", "poster-serif-regular.otf", serif],
  ["NotoSerifSC-Bold.otf", "poster-serif-bold.otf", serif]
];
for (const [from, to, text] of faces) {
  const font = await subsetFont(readFileSync(path.join(source, from)), text, { targetFormat: "sfnt" });
  writeFileSync(path.join(out, to), font);
  console.log(`${to}: ${(font.length / 1024).toFixed(0)} KB, ${[...text].length} characters`);
}
writeFileSync(path.join(out, "poster-sans.glyphs.txt"), sans);
writeFileSync(path.join(out, "poster-serif.glyphs.txt"), serif);
