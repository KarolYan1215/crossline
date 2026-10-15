/**
 * The sixteen type templates of the public quick test (docs/beta-launch.md §4, apps/assess/templates/README.md).
 *
 *   pnpm exec tsx scripts/assess-templates.ts placeholders           redraw the 16 placeholder PNGs (no model, no key)
 *   pnpm exec tsx scripts/assess-templates.ts candidates [CODE ...]  draft 3 candidates per type with the image model (needs
 *                                                                    ASSESS_IMAGE_API_KEY; 48 paid images for all 16; existing files
 *                                                                    are kept unless --force)
 *   pnpm exec tsx scripts/assess-templates.ts pick GEMA=2 SEMP=1 ... copy the owner's chosen candidates over the templates
 *   pnpm exec tsx scripts/assess-templates.ts prompt CODE            print the prompt a type's candidates are drawn from
 *
 * The candidates share one style prompt in our own editorial comic style (`stylePrompt`), never 16Personalities' figures.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHARACTER_POSES, TYPE_GROUPS, TYPE_TABLE } from "../packages/core/src/portrait-type";
import { placeholderSvg, renderPlaceholder } from "../apps/assess/server/avatar/placeholder";
import { providerFromEnv, imageType } from "../apps/assess/server/avatar/provider";

const TEMPLATES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "apps", "assess", "templates");
const CANDIDATES = path.join(TEMPLATES, "candidates");
const MANIFEST = path.join(TEMPLATES, "manifest.json");
const CODES = Object.keys(TYPE_TABLE);
const PER_TYPE = 3;

/** One outfit and one prop per type, chosen for the role its name describes. */
const ROLES: Record<string, { outfit: string; prop: string; pose: (typeof CHARACTER_POSES)[number] }> = {
  SEMP: { outfit: "a fitted work apron over a collared shirt, a jeweller's loupe pushed up on the forehead", prop: "an open pocket-watch movement held up in one hand", pose: "holding an object up to look at it" },
  SEMA: { outfit: "a lab coat with rolled-up sleeves over a plain sweater", prop: "a test tube with a softly bubbling liquid", pose: "holding an object up to look at it" },
  SERP: { outfit: "a cardigan over a buttoned shirt", prop: "a closed book under one arm and a short pointer stick", pose: "gesturing as if explaining" },
  SERA: { outfit: "an unstructured blazer over a t-shirt, a pen tucked behind one ear", prop: "a clipboard held against the chest", pose: "standing confidently" },
  SIMP: { outfit: "a sculptor's smock with a few dust marks", prop: "a small chisel and a half-carved stone figure", pose: "holding an object up to look at it" },
  SIMA: { outfit: "a loose painter's shirt with a few paint splashes", prop: "a paintbrush raised mid-stroke", pose: "gesturing as if explaining" },
  SIRP: { outfit: "a long buttoned coat with a scarf", prop: "a lit lantern held up", pose: "standing confidently" },
  SIRA: { outfit: "a hooded travelling cloak over simple clothes", prop: "a small lute slung across the back and a notebook in hand", pose: "mid-stride, walking forward" },
  GEMP: { outfit: "a utility vest with many pockets over a shirt", prop: "rolled-up blueprints under one arm", pose: "arms crossed, relaxed" },
  GEMA: { outfit: "work overalls with the sleeves rolled up", prop: "a wrench and a small hand-built gadget", pose: "holding an object up to look at it" },
  GERP: { outfit: "a structured jacket with a high collar", prop: "a folded map and a slim folder", pose: "gesturing as if explaining" },
  GERA: { outfit: "a light jacket with a messenger bag across the body", prop: "a small stack of envelopes held out", pose: "mid-stride, walking forward" },
  GIMP: { outfit: "a waistcoat over a shirt with rolled sleeves", prop: "a young sapling in a small pot", pose: "standing confidently" },
  GIMA: { outfit: "a workshop jacket with goggles pushed up on the head", prop: "a small propeller contraption", pose: "holding an object up to look at it" },
  GIRP: { outfit: "a windbreaker jacket", prop: "a plain flag on a short pole, the flag in the backdrop tint with no marks", pose: "standing confidently" },
  GIRA: { outfit: "an explorer's jacket with a small backpack", prop: "an open compass held in one hand", pose: "mid-stride, walking forward" }
};

/**
 * The templates' own style, written out rather than derived from the portrait's CHARACTER_STANDARD: the public poster shows the figure
 * cropped to a disc of about 340 px, so a waist-up figure on a flat full-bleed backdrop reads there, where a full-body figure on its
 * own inner circle came out small and as a ring inside the disc.
 */
function stylePrompt(tint: string): string {
  return [
    "Waist-up stylized cartoon character in an original editorial comic style: flat colour shapes with clean dark ink outlines of even weight, one soft cel-shade tone per colour, a clean readable silhouette; not low-poly, not faceted, and not resembling any existing personality-test characters.",
    "Three-quarter view, centered, the head in the upper half and the hands with the prop in the lower half; everything important inside the central circle of the frame, because the image is shown cropped to a circle.",
    "Simplified face: small dot eyes, a small mouth, no nose detail; gender-neutral, not a likeness of any real person.",
    "Exactly one main outfit colour and one accent colour; props drawn simply and clearly readable at small size.",
    `Backdrop: one flat plain fill of ${tint} from edge to edge; no circle, no frame, no shadow, no scenery.`,
    "Absolutely no text, letters, numbers, logos or brand marks anywhere. Square 1:1 frame."
  ].join(" ");
}

export function templatePrompt(code: string): string {
  const type = TYPE_TABLE[code];
  const group = TYPE_GROUPS[code.slice(0, 2)];
  const role = ROLES[code];
  if (!type || !group || !role) throw new Error(`unknown type ${code}`);
  return [
    stylePrompt(group.tint),
    "A neutral face and simple short neutral hair, no glasses, so a later edit can change presentation, hair, glasses and skin tone.",
    `Outfit: ${role.outfit}, main colour ${group.colour}, accent off-white.`,
    `Holding or carrying: ${role.prop}.`,
    `Pose: ${role.pose}. Expression: calm and confident.`
  ].join(" ");
}

type Manifest = Record<string, { source: string; at: string }>;
const readManifest = (): Manifest => (fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, "utf8")) as Manifest : {});
const writeManifest = (manifest: Manifest) =>
  fs.writeFileSync(MANIFEST, `${JSON.stringify(Object.fromEntries(Object.entries(manifest).sort()), null, 2)}\n`);

function placeholders(): void {
  const manifest = readManifest();
  fs.mkdirSync(TEMPLATES, { recursive: true });
  for (const code of CODES) {
    fs.writeFileSync(path.join(TEMPLATES, `${code}.png`), renderPlaceholder(code));
    manifest[code] = { source: "placeholder", at: new Date().toISOString() };
  }
  writeManifest(manifest);
  console.log(`wrote ${CODES.length} placeholders to ${TEMPLATES}`);
}

async function candidates(args: string[]): Promise<void> {
  const provider = providerFromEnv();
  if (!provider) throw new Error("ASSESS_IMAGE_API_KEY is not set: candidates are drawn by the image model (see templates/README.md)");
  const force = args.includes("--force");
  const codes = args.filter((arg) => !arg.startsWith("--"));
  const chosen = codes.length ? codes : CODES;
  for (const code of chosen) if (!TYPE_TABLE[code]) throw new Error(`unknown type ${code}`);
  fs.mkdirSync(CANDIDATES, { recursive: true });
  for (const code of chosen) {
    const prompt = templatePrompt(code);
    for (let n = 1; n <= PER_TYPE; n += 1) {
      const file = path.join(CANDIDATES, `${code}-${n}.png`);
      if (fs.existsSync(file) && !force) { console.log(`keep ${path.basename(file)}`); continue; }
      const image = await provider.generate({ prompt, seed: 1000 * CODES.indexOf(code) + n });
      if (imageType(image) !== "image/png") console.warn(`${path.basename(file)}: the model returned ${imageType(image)}, saved as is`);
      fs.writeFileSync(file, image);
      console.log(`wrote ${path.basename(file)}`);
    }
  }
}

function pick(args: string[]): void {
  const manifest = readManifest();
  for (const arg of args) {
    const match = /^([SG][EI][MR][PA])=(\d+)$/.exec(arg);
    if (!match || !TYPE_TABLE[match[1]!]) throw new Error(`expected CODE=n, got ${arg}`);
    const [, code, n] = match as unknown as [string, string, string];
    const source = path.join(CANDIDATES, `${code}-${n}.png`);
    if (!fs.existsSync(source)) throw new Error(`no candidate ${path.basename(source)}`);
    if (imageType(fs.readFileSync(source)) !== "image/png") throw new Error(`${path.basename(source)} is not a PNG`);
    fs.copyFileSync(source, path.join(TEMPLATES, `${code}.png`));
    manifest[code] = { source: `candidate-${n}`, at: new Date().toISOString() };
    console.log(`${code}.png ← ${path.basename(source)}`);
  }
  writeManifest(manifest);
}

async function main(): Promise<void> {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "placeholders") return placeholders();
  if (mode === "candidates") return candidates(args);
  if (mode === "pick") return pick(args);
  if (mode === "prompt") return void console.log(templatePrompt(args[0] ?? ""));
  if (mode === "svg") return void console.log(placeholderSvg(args[0] ?? ""));
  console.error("usage: assess-templates.ts placeholders | candidates [CODE ...] [--force] | pick CODE=n ... | prompt CODE");
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
