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
import { TYPE_GROUPS, TYPE_TABLE } from "../packages/core/src/portrait-type";
import { placeholderSvg, renderPlaceholder, renderSvg } from "../apps/assess/server/avatar/placeholder";
import { providerFromEnv, imageType } from "../apps/assess/server/avatar/provider";

const TEMPLATES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "apps", "assess", "templates");
const CANDIDATES = path.join(TEMPLATES, "candidates");
const MANIFEST = path.join(TEMPLATES, "manifest.json");
const CODES = Object.keys(TYPE_TABLE);
const PER_TYPE = 3;

/**
 * What each type's figure shows (decided 2026-10-14; research in docs/beta-launch.md §4.2). Two references, used as principles and never
 * copied: 16Personalities gives each type a role costume and a signature prop inside one colour system per group (outfit is the
 * strongest cue to a character's perceived personality — more than motion), and SBTI's viral results are self-mocking: the picture acts
 * out the flaw everyone recognises. So each figure carries the type's strength as costume and prop, and its subtitle's flaw as one visible
 * gag, with the four letters as body language — S compact and focused / G open and laden; E measuring and noting / I looking up, sparked;
 * M hands on tools / R mouth open, gesturing; P buttoned and symmetrical / A loose and mid-motion. Hair stays plain and there are no
 * glasses: a person's own appearance is edited in later.
 */
type Look = { trait: string; outfit: string; prop: string; gag: string; pose: string; expression: string };
const LOOKS: Record<string, Look> = {
  SEMP: { trait: "precision, patience, everything checked twice",
    outfit: "a crisp buttoned shirt under a fitted work apron, sleeve garters, a jeweller's loupe pushed up on the forehead",
    prop: "fine tweezers lowering a tiny gear into an open pocket-watch held in the other hand",
    gag: "a small schedule card clipped to the apron with every box neatly ticked, perfectly squared", pose: "upright and symmetrical, elbows tucked in",
    expression: "intensely focused with a tiny satisfied smile" },
  SEMA: { trait: "try it first, let the result speak",
    outfit: "a lab coat with sleeves rolled up over a plain sweater, safety goggles pushed up on the head, one smudge on the cheek",
    prop: "a test tube with softly bubbling liquid held up to the eye",
    gag: "an absurdly long paper lab log unrolling out of the coat pocket and spilling down out of frame", pose: "leaning in towards the test tube",
    expression: "delighted curiosity, eyebrows raised" },
  SERP: { trait: "turns any subject into a clear three-part lesson",
    outfit: "a cardigan over a buttoned shirt with a neat collar",
    prop: "a short pointer stick tapping a small flip chart that shows exactly three blank bullet marks",
    gag: "the other hand holding up exactly three fingers mid-sentence", pose: "half turned to the chart, explaining",
    expression: "earnest, mouth open as if lecturing" },
  SERA: { trait: "answers everyone's questions instantly",
    outfit: "an unstructured blazer over a plain t-shirt, a pen tucked behind one ear",
    prop: "a phone in one hand with several blank speech bubbles popping out of it",
    gag: "a small pile of their own unopened envelopes tucked forgotten under the other arm", pose: "relaxed, attentive, slightly leaning forward",
    expression: "helpful and calm, eyes a little tired" },
  SIMP: { trait: "polishes one work for years, deaf to deadlines",
    outfit: "a sculptor's smock with a light dusting of stone powder",
    prop: "a small chisel and a half-carved stone figure held close",
    gag: "a few torn-off blank calendar pages drifting past the shoulder, ignored", pose: "head bowed over the carving",
    expression: "serene and absorbed, eyes half closed" },
  SIMA: { trait: "unstoppable when inspired, lost when the spark leaves",
    outfit: "a loose painter's shirt with bright paint splashes, sleeves pushed up unevenly",
    prop: "a paintbrush mid-stroke leaving a swirling ribbon of colour in the air",
    gag: "a small glowing light bulb floating away above the head while the free hand reaches for it", pose: "off-balance, one shoulder raised",
    expression: "wide-eyed excitement" },
  SIRP: { trait: "carries one conviction and preaches it everywhere",
    outfit: "a long buttoned coat with a scarf wrapped neatly",
    prop: "a lit lantern held high",
    gag: "the whole audience is one sleepy little bird perched on the shoulder", pose: "standing tall, free hand on the chest",
    expression: "fervent, eyes shining" },
  SIRA: { trait: "thinks while wandering, shares half-finished thoughts",
    outfit: "a hooded travelling cloak over simple clothes, a small lute slung across the back",
    prop: "an open notebook with loose pages slipping out",
    gag: "crumpled paper drafts spilling out of every cloak pocket", pose: "mid-stride, walking forward",
    expression: "dreamy, gazing upward" },
  GEMP: { trait: "designs a system for everything, then redesigns it",
    outfit: "a utility vest with many neat pockets over a collared shirt, a pencil behind each ear",
    prop: "a small model made of modular blocks held in one hand while the other lifts one block to move it",
    gag: "an eraser on a cord worn down to a tiny nub", pose: "upright, studying the model",
    expression: "analytical, one eyebrow raised" },
  GEMA: { trait: "builds whatever works from whatever is at hand",
    outfit: "work overalls with the sleeves rolled up, a roll of duct tape worn on the wrist like a bracelet",
    prop: "a hand-built gadget held together with duct tape, one spring popping out, and a wrench",
    gag: "the gadget is visibly wobbly and still proudly presented", pose: "presenting the gadget forward with both hands",
    expression: "proud lopsided grin" },
  GERP: { trait: "writes the best plan in the room, hands the doing to others",
    outfit: "a structured jacket with a high collar, everything pressed",
    prop: "a thick, neatly tabbed binder",
    gag: "holding the binder out towards someone off-frame with one finger pointing at them, as if delegating the work", pose: "composed, chin slightly lifted",
    expression: "confident and assured" },
  GERA: { trait: "knows everyone, connects every circle",
    outfit: "a light jacket with a messenger bag across the body and a lanyard crowded with many different badges",
    prop: "a small stack of envelopes in one hand and a phone in the other",
    gag: "the lanyard is so crowded with badges it tangles", pose: "turned slightly sideways as if greeting someone",
    expression: "friendly busy smile" },
  GIMP: { trait: "sees the venture years ahead and plans towards it",
    outfit: "a waistcoat over a shirt with rolled sleeves",
    prop: "a young sapling in a small pot held carefully",
    gag: "a presentation clicker in the other hand and three nearly identical blank slide cards fanned behind it", pose: "standing confidently, looking ahead",
    expression: "determined visionary gaze" },
  GIMA: { trait: "keeps inventing new things before finishing the last",
    outfit: "a workshop jacket with goggles pushed up on the head",
    prop: "a small propeller contraption just starting to spin",
    gag: "several unfinished gadgets clipped to the jacket and pockets, one giving off a small spark", pose: "holding the contraption up high",
    expression: "manic delight" },
  GIRP: { trait: "rallies people around a grand vision",
    outfit: "a windbreaker jacket zipped to the collar",
    prop: "a plain flag on a short pole held high, the flag in the backdrop tint with no marks",
    gag: "a completely blank planner tucked under the other arm", pose: "chin up, flag raised, heroic",
    expression: "rousing, mouth open mid-cheer" },
  GIRA: { trait: "opens new paths everywhere at once",
    outfit: "an explorer's jacket and a small backpack stuffed with rolled maps",
    prop: "an open compass held in one hand",
    gag: "different maps and tickets sticking out of every single pocket", pose: "mid-stride, looking sideways towards something new",
    expression: "thrilled, eyes wide" }
};

/** The three candidates of a type differ in framing of the same look, so the owner chooses between real alternatives. */
const VARIANTS = [
  "Show the look exactly as described.",
  "Same look, with a different, more dynamic pose and camera angle.",
  "Same look, with the gag exaggerated a little more for comic effect, still clean and readable."
];

/**
 * The templates' own style, written out rather than derived from the portrait's CHARACTER_STANDARD: the public poster shows the figure
 * cropped to a disc of about 340 px, so a waist-up figure on a flat full-bleed backdrop reads there, where a full-body figure on its
 * own inner circle came out small and as a ring inside the disc.
 */
function stylePrompt(tint: string): string {
  return [
    "Waist-up stylized cartoon character in an original editorial comic style: flat colour shapes with clean dark ink outlines of even weight, one soft cel-shade tone per colour, a clean readable silhouette; not low-poly, not faceted, and not resembling any existing personality-test characters.",
    "Three-quarter view, centered, the head in the upper half and the hands with the prop in the lower half; everything important inside the central circle of the frame, because the image is shown cropped to a circle.",
    "Simplified face: small dot eyes with simple brows, a small expressive mouth, no nose detail; gender-neutral, not a likeness of any real person.",
    "Exactly one main outfit colour and one accent colour; props drawn simply and clearly readable at small size.",
    `Backdrop: one flat plain fill of ${tint} from edge to edge; no circle, no frame, no shadow, no scenery.`,
    "Absolutely no text, letters, numbers, logos or brand marks anywhere. Square 1:1 frame."
  ].join(" ");
}

export function templatePrompt(code: string, variant = 0): string {
  const type = TYPE_TABLE[code];
  const group = TYPE_GROUPS[code.slice(0, 2)];
  const look = LOOKS[code];
  if (!type || !group || !look) throw new Error(`unknown type ${code}`);
  return [
    stylePrompt(group.tint),
    `The character's core: ${look.trait}.`,
    "Plain simple short hair and no glasses, so a later edit can change presentation, hair, glasses and skin tone; the personality shows in the outfit, prop, pose and expression.",
    `Outfit: ${look.outfit}; main colour ${group.colour}, accent off-white.`,
    `Holding: ${look.prop}.`,
    `One small self-mocking visual gag: ${look.gag}.`,
    `Pose: ${look.pose}. Expression: ${look.expression}.`,
    "Any paper, card, screen or chart in the picture is blank or has only abstract lines, never writing.",
    VARIANTS[variant] ?? VARIANTS[0]!
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

type Drawer = { draw(prompt: string, seed: number): Promise<Buffer>; stop(): Promise<void> };

/**
 * Draws through the machine owner's own Codex sign-in (ChatGPT's image tool), the same path the portrait figure takes
 * (`crossline-portrait-illustrator`). For the sixteen templates only, drawn once on this machine for the owner's own project — never for
 * the public test's per-person figures, which would put the owner's ChatGPT login on a public server and serve other people from a
 * personal subscription.
 */
async function codexDrawer(port: number): Promise<Drawer> {
  const { startCodexSupervisor, runCodexSkill } = await import("../packages/codex/src/index");
  const repoRoot = path.resolve(TEMPLATES, "..", "..", "..");
  const skill = "crossline:crossline-portrait-illustrator";
  const supervisor = await startCodexSupervisor({ port, plugin: { name: "crossline", cwd: repoRoot, requiredSkills: [skill],
    marketplacePath: path.join(repoRoot, "skills", "marketplace", ".agents", "plugins", "marketplace.json") } });
  const schema = { type: "object", properties: { generated: { type: "boolean" }, note: { type: "string", minLength: 0, maxLength: 200 } },
    required: ["generated", "note"], additionalProperties: false };
  return {
    async draw(prompt) {
      let image: Buffer | undefined;
      const context = { version: "crossline.portrait-image.v1", slot: "character", prompt };
      const result = await runCodexSkill<{ generated: boolean; note: string }>(supervisor.client, context, {
        skillName: skill, cwd: repoRoot, developerInstructions: "Generate exactly one image from the given prompt, then return raw JSON only.",
        outputSchema: schema, prepareInput: () => context, allowImageGeneration: true,
        onImage: (drawn) => { image ??= Buffer.from(drawn.base64, "base64"); },
        validateOutput: (output) => output as { generated: boolean; note: string }, onAudit: () => {}, timeoutMs: 15 * 60_000 });
      if (!image) throw new Error(result.ok ? `no image: ${result.output.note}` : `${result.blocker.code}: ${result.blocker.message}`);
      return image;
    },
    stop: () => supervisor.stop()
  };
}

async function candidates(args: string[]): Promise<void> {
  const flag = (name: string) => args.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
  const via = flag("via") ?? "api";
  let drawer: Drawer;
  if (via === "codex") drawer = await codexDrawer(Number(flag("port") ?? 3397));
  else {
    const provider = providerFromEnv();
    if (!provider) throw new Error("ASSESS_IMAGE_API_KEY is not set: candidates are drawn by the image model, or pass --via=codex (see templates/README.md)");
    drawer = { draw: (prompt, seed) => provider.generate({ prompt, seed }), stop: async () => {} };
  }
  const force = args.includes("--force");
  const codes = args.filter((arg) => !arg.startsWith("--"));
  const chosen = codes.length ? codes : CODES;
  for (const code of chosen) if (!TYPE_TABLE[code]) throw new Error(`unknown type ${code}`);
  fs.mkdirSync(CANDIDATES, { recursive: true });
  let failed = 0;
  try {
    for (const code of chosen) {
      for (let n = 1; n <= PER_TYPE; n += 1) {
        const file = path.join(CANDIDATES, `${code}-${n}.png`);
        if (fs.existsSync(file) && !force) { console.log(`keep ${path.basename(file)}`); continue; }
        const started = Date.now();
        try {
          const image = await drawer.draw(templatePrompt(code, n - 1), 1000 * CODES.indexOf(code) + n);
          if (imageType(image) !== "image/png") console.warn(`${path.basename(file)}: the model returned ${imageType(image)}, saved as is`);
          fs.writeFileSync(file, image);
          console.log(`wrote ${path.basename(file)} in ${Math.round((Date.now() - started) / 1000)} s`);
        } catch (error) {
          failed += 1;
          console.error(`${path.basename(file)} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  } finally {
    await drawer.stop();
  }
  if (failed) process.exitCode = 1;
}

function pick(args: string[]): void {
  const manifest = readManifest();
  for (const arg of args) {
    const match = /^([SG][EI][MR][PA])=(\d+)$/.exec(arg);
    if (!match || !TYPE_TABLE[match[1]!]) throw new Error(`expected CODE=n, got ${arg}`);
    const [, code, n] = match as unknown as [string, string, string];
    const source = path.join(CANDIDATES, `${code}-${n}.png`);
    if (!fs.existsSync(source)) throw new Error(`no candidate ${path.basename(source)}`);
    const bytes = fs.readFileSync(source);
    if (imageType(bytes) !== "image/png") throw new Error(`${path.basename(source)} is not a PNG`);
    fs.writeFileSync(path.join(TEMPLATES, `${code}.png`), flatten(bytes, TYPE_GROUPS[code.slice(0, 2)]!.tint));
    manifest[code] = { source: `candidate-${n}`, at: new Date().toISOString() };
    console.log(`${code}.png ← ${path.basename(source)}`);
  }
  writeManifest(manifest);
}

/**
 * A candidate as the template the pipeline expects: 1024×1024 on the group's tint. ChatGPT's image tool answers with a transparent
 * background and its own size, whatever the prompt asks; a transparent reference would come back from the editing model on black.
 */
function flatten(png: Buffer, tint: string): Buffer {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="${tint}"/>`
    + `<image href="data:image/png;base64,${png.toString("base64")}" width="1024" height="1024" preserveAspectRatio="xMidYMid meet"/></svg>`;
  return renderSvg(svg, 1024);
}

/** Every candidate on one sheet (`candidates/sheet.png`): a row per type, as the poster's disc shows it, for the owner to choose from. */
function sheet(): void {
  const cell = 300, label = 240, gap = 20, rows = CODES.filter((code) => fs.existsSync(path.join(CANDIDATES, `${code}-1.png`)));
  const width = label + PER_TYPE * (cell + gap), height = rows.length * (cell + gap) + gap;
  const parts = rows.map((code, row) => {
    const y = gap + row * (cell + gap), group = TYPE_GROUPS[code.slice(0, 2)]!;
    const discs = Array.from({ length: PER_TYPE }, (_, i) => {
      const file = path.join(CANDIDATES, `${code}-${i + 1}.png`);
      if (!fs.existsSync(file)) return "";
      const x = label + i * (cell + gap), id = `c${row}-${i}`;
      return `<clipPath id="${id}"><circle cx="${x + cell / 2}" cy="${y + cell / 2}" r="${cell / 2}"/></clipPath>`
        + `<circle cx="${x + cell / 2}" cy="${y + cell / 2}" r="${cell / 2}" fill="${group.tint}"/>`
        + `<image clip-path="url(#${id})" x="${x}" y="${y}" width="${cell}" height="${cell}" href="data:image/png;base64,${fs.readFileSync(file).toString("base64")}"/>`
        + `<text x="${x + cell - 8}" y="${y + cell - 8}" font-size="28" font-weight="700" fill="#1E1B16" text-anchor="end" font-family="Arial">${i + 1}</text>`;
    }).join("");
    return `<text x="16" y="${y + cell / 2 - 10}" font-size="40" font-weight="700" fill="${group.colour}" font-family="Arial">${code}</text>`
      + `<text x="16" y="${y + cell / 2 + 40}" font-size="34" fill="#1E1B16" font-family="Microsoft YaHei, PingFang SC, Noto Sans CJK SC, sans-serif">${TYPE_TABLE[code]!.name}</text>${discs}`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#F6F2EA"/>${parts}</svg>`;
  const out = path.join(CANDIDATES, "sheet.png");
  fs.writeFileSync(out, renderSvg(svg, width));
  console.log(`wrote ${out} (${rows.length} types)`);
}

async function main(): Promise<void> {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "placeholders") return placeholders();
  if (mode === "candidates") return candidates(args);
  if (mode === "pick") return pick(args);
  if (mode === "sheet") return sheet();
  if (mode === "prompt") return void console.log(templatePrompt(args[0] ?? ""));
  if (mode === "svg") return void console.log(placeholderSvg(args[0] ?? ""));
  console.error("usage: assess-templates.ts placeholders | candidates [CODE ...] [--force] [--via=codex [--port=N]] | pick CODE=n ... | sheet | prompt CODE");
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
