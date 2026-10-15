/**
 * The landing page's example figures: four type templates (one per group) shrunk to 240×360 PNGs in `public/samples/`, so a stranger
 * sees what the test ends in before answering anything. The full templates are 1024×1536 and about 1.8 MB each — far too heavy for the
 * first screen on a phone. Rerun after a template is redrawn:
 *
 *   pnpm --filter @crossline/assess exec tsx scripts/sample-thumbs.ts
 */
import fs from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { LANDING_SAMPLES } from "../lib/samples";

const root = path.join(import.meta.dirname, "..");
const out = path.join(root, "public", "samples");
fs.mkdirSync(out, { recursive: true });

for (const sample of LANDING_SAMPLES) {
  const source = fs.readFileSync(path.join(root, "templates", `${sample.code}-${sample.variant}.png`));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1536"><image href="data:image/png;base64,${source.toString("base64")}" width="1024" height="1536"/></svg>`;
  const png = new Resvg(svg, { fitTo: { mode: "width", value: 240 }, font: { loadSystemFonts: false } }).render().asPng();
  const file = path.join(out, `${sample.code}.png`);
  fs.writeFileSync(file, png);
  console.log(`${path.relative(root, file)} ${Math.round(png.length / 1024)} KB`);
}
