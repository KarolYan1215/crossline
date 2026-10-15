/**
 * The type templates of the public quick test: one woman and one man per type, full length, 2:3 — 32 figures, numbered 1–32 in type
 * order, woman before man (docs/beta-launch.md §4, apps/assess/templates/README.md).
 *
 *   pnpm exec tsx scripts/assess-templates.ts placeholders                     redraw the 32 placeholder PNGs (no model, no key)
 *   pnpm exec tsx scripts/assess-templates.ts candidates [CODE|N ...] [--via=codex [--port=N]] [--variant=female|male] [--force]
 *                                                                              draw the missing candidates (all 32, some types, or numbers)
 *   pnpm exec tsx scripts/assess-templates.ts redo N ... [--via=codex [--port=N]]  draw those numbers again
 *   pnpm exec tsx scripts/assess-templates.ts sheet                            one numbered overview of every candidate
 *   pnpm exec tsx scripts/assess-templates.ts pick all | pick N ...            make candidates the templates
 *   pnpm exec tsx scripts/assess-templates.ts prompt CODE [female|male]        print the prompt a candidate is drawn from
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TYPE_GROUPS, TYPE_TABLE } from "../packages/core/src/portrait-type";
import { placeholderSvg, renderPlaceholder, renderSvg } from "../apps/assess/server/avatar/placeholder";
import { providerFromEnv, imageType } from "../apps/assess/server/avatar/provider";
import { TEMPLATE_VARIANTS, type TemplateVariant } from "../apps/assess/server/avatar/templates";

const TEMPLATES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "apps", "assess", "templates");
const CANDIDATES = path.join(TEMPLATES, "candidates");
const MANIFEST = path.join(TEMPLATES, "manifest.json");
const CODES = Object.keys(TYPE_TABLE);

/** The 32 figures in sheet order: number n is `SLOTS[n - 1]`. */
const SLOTS = CODES.flatMap((code) => TEMPLATE_VARIANTS.map((variant) => ({ code, variant })));
const slotNumber = (code: string, variant: TemplateVariant) => SLOTS.findIndex((slot) => slot.code === code && slot.variant === variant) + 1;
const candidateFile = (code: string, variant: TemplateVariant) => path.join(CANDIDATES, `${code}-${variant}.png`);

/**
 * What each type's figure shows (decided 2026-10-14; research in docs/beta-launch.md §4.2). Two references, used as principles and never
 * copied: 16Personalities gives each type a role costume and a signature prop inside one colour per group (outfit is the strongest cue to
 * a character's perceived personality — more than motion), and SBTI's viral results are self-mocking: the picture acts out the flaw
 * everyone recognises. So each figure carries the type's strength as costume and prop, its subtitle's flaw as one visible gag, the four
 * letters as body language — S compact and focused / G open and laden; E measuring and noting / I looking up, sparked; M hands on tools /
 * R mouth open, gesturing; P buttoned and symmetrical / A loose and mid-motion — and, after the owner found the first full-length set too
 * alike, its own build, hair and a pose caught mid-action, so the sixteen are sixteen different people.
 */
type Look = { trait: string; build: string; hair: Record<TemplateVariant, string>; outfit: string; prop: string; gag: string; pose: string; expression: string };
const LOOKS: Record<string, Look> = {
  SEMP: { trait: "precision, patience, everything checked twice", build: "neat, compact and upright",
    hair: { female: "a sleek low bun with not a strand out of place", male: "a short side-parted cut, perfectly combed" },
    outfit: "a crisp buttoned shirt under a fitted work apron, sleeve garters, a jeweller's loupe pushed up on the forehead",
    prop: "fine tweezers lowering a tiny gear into an open pocket-watch held close to the face",
    gag: "a small schedule card clipped to the apron with every box neatly ticked, perfectly squared",
    pose: "bent slightly forward over the watch, one foot exactly beside the other, elbows tucked in", expression: "intensely focused, tongue just visible at the corner of the mouth" },
  SEMA: { trait: "try it first, let the result speak", build: "wiry and quick",
    hair: { female: "a messy high ponytail with flyaway strands", male: "short tousled hair sticking up at the back" },
    outfit: "a lab coat with sleeves rolled up over a plain sweater, safety goggles pushed up on the head, one smudge on the cheek",
    prop: "a test tube with softly bubbling liquid held up at arm's length",
    gag: "an absurdly long paper lab log unrolling out of the coat pocket and trailing on the floor behind",
    pose: "leaning back on one leg, the other foot lifted, peering up at the test tube", expression: "delighted surprise, eyebrows high" },
  SERP: { trait: "turns any subject into a clear three-part lesson", build: "tall and slim",
    hair: { female: "a neat shoulder-length bob tucked behind one ear", male: "short neat hair with a small quiff" },
    outfit: "a cardigan over a buttoned shirt with a neat collar, smart trousers",
    prop: "a short pointer stick aimed at a small easel chart showing exactly three blank bullet marks",
    gag: "the other hand holding up exactly three fingers mid-sentence",
    pose: "mid-stride towards the easel, half turned to an imagined audience", expression: "earnest, mouth open as if lecturing" },
  SERA: { trait: "answers everyone's questions instantly", build: "relaxed and medium-built",
    hair: { female: "loose wavy hair to the collarbone", male: "a short textured crop" },
    outfit: "an unstructured blazer over a plain t-shirt and jeans, a pen tucked behind one ear",
    prop: "a phone held up with several blank speech bubbles popping out of it",
    gag: "a pile of their own unopened envelopes slipping from under the other arm",
    pose: "walking while typing with one thumb, shoulders slightly hunched", expression: "helpful and calm, eyes a little tired" },
  SIMP: { trait: "polishes one work for years, deaf to deadlines", build: "sturdy with strong forearms",
    hair: { female: "long hair tied back with a cloth band", male: "a short beard-free crop under a cloth headband" },
    outfit: "a long sculptor's smock with a light dusting of stone powder, sleeves rolled",
    prop: "a small chisel and mallet working on a half-carved stone figure on a low stand",
    gag: "torn-off blank calendar pages drifting past and piling up at the feet, ignored",
    pose: "kneeling on one knee beside the stand, head bowed over the carving", expression: "serene and absorbed, eyes half closed" },
  SIMA: { trait: "unstoppable when inspired, lost when the spark leaves", build: "light and lanky",
    hair: { female: "a big loose curly bun with a brush stuck in it", male: "shaggy chin-length hair" },
    outfit: "a loose painter's shirt with bright paint splashes, sleeves pushed up unevenly, cuffed trousers",
    prop: "a paintbrush mid-stroke leaving a swirling ribbon of colour around the body",
    gag: "a small glowing light bulb floating away above the head while the free hand stretches for it",
    pose: "on tiptoe, spinning, one leg kicked back", expression: "wide-eyed excitement" },
  SIRP: { trait: "carries one conviction and preaches it everywhere", build: "tall and upright",
    hair: { female: "long straight hair with a centre parting", male: "short swept-back hair" },
    outfit: "a long buttoned coat with a scarf flowing behind",
    prop: "a lit lantern held high above the head",
    gag: "the whole audience is one sleepy little bird perched on the shoulder",
    pose: "standing on a low step, free hand on the chest, coat blown by the wind", expression: "fervent, eyes shining" },
  SIRA: { trait: "thinks while wandering, shares half-finished thoughts", build: "slight and loose-limbed",
    hair: { female: "a long side braid", male: "wavy hair under a soft beret" },
    outfit: "a hooded travelling cloak over simple clothes, a small lute slung across the back, worn boots",
    prop: "an open notebook with loose pages slipping out",
    gag: "crumpled paper drafts spilling out of every cloak pocket and trailing behind",
    pose: "strolling forward while writing, one foot in the air", expression: "dreamy, gazing upward" },
  GEMP: { trait: "designs a system for everything, then redesigns it", build: "solid and square-shouldered",
    hair: { female: "a sharp chin-length bob", male: "a short buzz cut" },
    outfit: "a utility vest with many neat pockets over a collared shirt, a pencil behind each ear",
    prop: "a small model made of modular blocks balanced on one palm while the other hand lifts one block to move it",
    gag: "an eraser on a cord worn down to a tiny nub",
    pose: "crouching slightly to look at the model at eye level", expression: "analytical, one eyebrow raised" },
  GEMA: { trait: "builds whatever works from whatever is at hand", build: "stocky and energetic",
    hair: { female: "two short space buns", male: "a backwards cap over short hair" },
    outfit: "work overalls with one strap undone and the sleeves rolled up, a roll of duct tape worn on the wrist like a bracelet",
    prop: "a hand-built gadget held together with duct tape, one spring popping out, and a wrench",
    gag: "the gadget is visibly wobbly and smoking slightly, still proudly presented",
    pose: "one foot up on a toolbox, presenting the gadget forward with both hands", expression: "proud lopsided grin" },
  GERP: { trait: "writes the best plan in the room, hands the doing to others", build: "tall and poised",
    hair: { female: "a high sleek ponytail", male: "short slicked-back hair" },
    outfit: "a structured jacket with a high collar, pressed trousers, polished shoes",
    prop: "a thick, neatly tabbed binder",
    gag: "holding the binder out towards someone off-frame with one finger pointing at them, delegating the work",
    pose: "turning on one heel mid-step, chin slightly lifted", expression: "confident and assured" },
  GERA: { trait: "knows everyone, connects every circle", build: "medium and springy",
    hair: { female: "a curly half-up ponytail", male: "short curly hair" },
    outfit: "a light jacket with a messenger bag across the body and a lanyard crowded with many different badges, sneakers",
    prop: "a phone at the ear and a small stack of envelopes in the other hand",
    gag: "the lanyard is so crowded with badges it tangles around the arm",
    pose: "walking fast while waving to someone behind, body twisting", expression: "friendly busy smile" },
  GIMP: { trait: "sees the venture years ahead and plans towards it", build: "broad and steady",
    hair: { female: "a low ponytail with a side-swept fringe", male: "short neat hair with a side part" },
    outfit: "a waistcoat over a shirt with rolled sleeves, sturdy boots",
    prop: "a young sapling in a small pot held carefully in the crook of one arm",
    gag: "a presentation clicker in the other hand and three nearly identical blank slide cards fanned behind",
    pose: "one foot on a step, leaning forward, looking into the distance", expression: "determined visionary gaze" },
  GIMA: { trait: "keeps inventing new things before finishing the last", build: "small and restless",
    hair: { female: "frizzy hair held back by the goggles", male: "wild spiky hair under the goggles" },
    outfit: "a workshop jacket with goggles pushed up on the head, utility belt, cargo shorts over leggings",
    prop: "a small propeller contraption just starting to spin, lifting the arm",
    gag: "several unfinished gadgets clipped to the jacket and belt, one giving off a small spark",
    pose: "jumping slightly off the ground as the contraption lifts", expression: "manic delight" },
  GIRP: { trait: "rallies people around a grand vision", build: "athletic and tall",
    hair: { female: "a short pixie cut", male: "short hair with a bold quiff" },
    outfit: "a windbreaker jacket zipped to the collar, track trousers",
    prop: "a plain flag on a short pole held high, the flag in the backdrop colour with no marks",
    gag: "a completely blank planner tucked under the other arm",
    pose: "one foot up on a rock, flag raised, heroic", expression: "rousing, mouth open mid-cheer" },
  GIRA: { trait: "opens new paths everywhere at once", build: "lean and long-legged",
    hair: { female: "wind-blown shoulder-length hair", male: "messy wind-blown short hair" },
    outfit: "an explorer's jacket, cargo trousers and hiking boots, a small backpack stuffed with rolled maps",
    prop: "an open compass held in one hand",
    gag: "different maps and tickets sticking out of every single pocket",
    pose: "mid-stride, looking back over the shoulder towards something new", expression: "thrilled, eyes wide" }
};

/**
 * The templates' style (the owner's direction, 2026-10-14): the look of the popular MBTI personality-test avatars — full length, smooth
 * low-poly facets with soft flat shading, slender stylised bodies, small heads with minimal faces — so the figure reads at a glance as
 * "my type's character". Only the shape language is borrowed: the colours are our own muted Morandi tone per group (`TYPE_GROUPS`, not
 * their purple/green/blue/yellow), and every outfit, prop and gag is ours (`LOOKS`). Skin stays medium and there are no glasses, so a
 * person's own appearance can be edited in later.
 */
function stylePrompt(tone: string, tint: string): string {
  return [
    "Exactly one full-body stylized 3D-look cartoon character with the shape language of popular MBTI personality-test avatars: smooth low-poly faceted shapes with soft flat shading on each facet, a clean geometric silhouette, stylised proportions about six heads tall.",
    "Small head with a minimal face: small dark dot eyes, simple brows, a tiny mouth, almost no nose; not a likeness of any real person.",
    `Colour: a soft muted Morandi palette, dusty and slightly greyed, low saturation; the outfit's main colour is ${tone}, with off-white and one quiet neutral as accents; no saturated or neon colours.`,
    "The whole figure from head to shoes is visible, with a soft oval ground shadow, centered, filling about 85% of the frame height with a little margin above the head and below the feet.",
    "Props drawn simply and clearly readable at small size. An original character design, not a copy of any existing character.",
    `Backdrop: one flat plain fill of ${tint} from edge to edge; no frame, no scenery.`,
    "Absolutely no text, letters, numbers, logos or brand marks anywhere. Tall portrait frame, 2:3."
  ].join(" ");
}

export function templatePrompt(code: string, variant: TemplateVariant = "female"): string {
  const type = TYPE_TABLE[code];
  const group = TYPE_GROUPS[code.slice(0, 2)];
  const look = LOOKS[code];
  if (!type || !group || !look) throw new Error(`unknown type ${code}`);
  return [
    stylePrompt(group.tone, group.tint),
    `The character is a young ${variant === "female" ? "woman" : "man"}, ${look.build}; hair: ${look.hair[variant]}, dark brown; medium skin tone; no glasses.`,
    `The character's core: ${look.trait}.`,
    `Outfit: ${look.outfit}.`,
    `Holding: ${look.prop}.`,
    `One small self-mocking visual gag: ${look.gag}.`,
    `Pose, caught mid-action and full of character: ${look.pose}. Expression: ${look.expression}.`,
    "Any paper, card, screen or chart in the picture is blank or has only abstract lines, never writing."
  ].join(" ");
}

type Manifest = Record<string, { source: string; at: string }>;
const readManifest = (): Manifest => (fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, "utf8")) as Manifest : {});
const writeManifest = (manifest: Manifest) =>
  fs.writeFileSync(MANIFEST, `${JSON.stringify(Object.fromEntries(Object.entries(manifest).sort()), null, 2)}\n`);

function placeholders(): void {
  const manifest = readManifest();
  fs.mkdirSync(TEMPLATES, { recursive: true });
  for (const { code, variant } of SLOTS) {
    fs.writeFileSync(path.join(TEMPLATES, `${code}-${variant}.png`), renderPlaceholder(code, variant));
    manifest[`${code}-${variant}`] = { source: "placeholder", at: new Date().toISOString() };
  }
  writeManifest(manifest);
  console.log(`wrote ${SLOTS.length} placeholders to ${TEMPLATES}`);
}

type Drawer = { draw(prompt: string, seed: number): Promise<Buffer>; stop(): Promise<void> };

/**
 * Draws through the machine owner's own Codex sign-in (ChatGPT's image tool), the same path the portrait figure takes
 * (`crossline-portrait-illustrator`). For the templates only, drawn once on this machine for the owner's own project — never for the
 * public test's per-person figures, which would put the owner's ChatGPT login on a public server and serve other people from a personal
 * subscription.
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

/** Positional arguments as slots: a type code (both variants, or `--variant`) or a sheet number. */
function slotsFrom(args: string[], only?: string): Array<{ code: string; variant: TemplateVariant }> {
  const positional = args.filter((arg) => !arg.startsWith("--"));
  if (!positional.length) return SLOTS.filter((slot) => !only || slot.variant === only);
  return positional.flatMap((arg) => {
    if (/^\d+$/.test(arg)) {
      const slot = SLOTS[Number(arg) - 1];
      if (!slot) throw new Error(`no figure number ${arg} (1–${SLOTS.length})`);
      return [slot];
    }
    if (!TYPE_TABLE[arg]) throw new Error(`unknown type ${arg}`);
    return SLOTS.filter((slot) => slot.code === arg && (!only || slot.variant === only));
  });
}

async function candidates(args: string[], redo = false): Promise<void> {
  const flag = (name: string) => args.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
  const chosen = slotsFrom(args, flag("variant"));
  if (redo && !args.some((arg) => /^\d+$/.test(arg))) throw new Error("redo takes figure numbers from the sheet, e.g. redo 3 7 12");
  const force = redo || args.includes("--force");
  const todo = chosen.filter(({ code, variant }) => force || !fs.existsSync(candidateFile(code, variant)));
  if (!todo.length) return void console.log("nothing to draw");
  let drawer: Drawer;
  if ((flag("via") ?? "api") === "codex") drawer = await codexDrawer(Number(flag("port") ?? 3397));
  else {
    const provider = providerFromEnv();
    if (!provider) throw new Error("ASSESS_IMAGE_API_KEY is not set: candidates are drawn by the image model, or pass --via=codex (see templates/README.md)");
    drawer = { draw: (prompt, seed) => provider.generate({ prompt, seed }), stop: async () => {} };
  }
  fs.mkdirSync(CANDIDATES, { recursive: true });
  let failed = 0;
  try {
    for (const { code, variant } of todo) {
      const file = candidateFile(code, variant), label = `${slotNumber(code, variant)} ${path.basename(file)}`, started = Date.now();
      try {
        const image = await drawer.draw(templatePrompt(code, variant), Date.now() % 1_000_000);
        if (imageType(image) !== "image/png") console.warn(`${label}: the model returned ${imageType(image)}, saved as is`);
        fs.writeFileSync(file, image);
        console.log(`wrote ${label} in ${Math.round((Date.now() - started) / 1000)} s`);
      } catch (error) {
        failed += 1;
        console.error(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await drawer.stop();
  }
  if (failed) process.exitCode = 1;
}

function pick(args: string[]): void {
  const manifest = readManifest();
  const chosen = args[0] === "all" ? SLOTS.filter(({ code, variant }) => fs.existsSync(candidateFile(code, variant))) : slotsFrom(args);
  if (!chosen.length) throw new Error("expected pick all, or figure numbers from the sheet");
  for (const { code, variant } of chosen) {
    const source = candidateFile(code, variant);
    if (!fs.existsSync(source)) throw new Error(`no candidate ${path.basename(source)}`);
    const bytes = fs.readFileSync(source);
    if (imageType(bytes) !== "image/png") throw new Error(`${path.basename(source)} is not a PNG`);
    fs.writeFileSync(path.join(TEMPLATES, `${code}-${variant}.png`), flatten(bytes, TYPE_GROUPS[code.slice(0, 2)]!.tint));
    manifest[`${code}-${variant}`] = { source: "candidate", at: new Date().toISOString() };
    console.log(`${slotNumber(code, variant)} ${code}-${variant}.png`);
  }
  writeManifest(manifest);
}

/**
 * A candidate as the template the pipeline expects: 1024×1536 on the group's tint. ChatGPT's image tool sometimes answers with a
 * transparent or half-transparent background and its own size, whatever the prompt asks; a transparent reference would come back from
 * the editing model on black.
 */
function flatten(png: Buffer, tint: string): Buffer {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1536"><rect width="1024" height="1536" fill="${tint}"/>`
    + `<image href="data:image/png;base64,${png.toString("base64")}" width="1024" height="1536" preserveAspectRatio="xMidYMid meet"/></svg>`;
  return renderSvg(svg, 1024);
}

/** Every candidate on one sheet (`candidates/sheet.png`), eight to a row, each with its number, code, name and 女/男 to answer by. */
function sheet(): void {
  const cols = 8, cellW = 220, cellH = 330, gap = 18, caption = 64;
  const rows = Math.ceil(SLOTS.length / cols);
  const width = cols * (cellW + gap) + gap, height = rows * (cellH + caption + gap) + gap;
  const cells = SLOTS.map(({ code, variant }, index) => {
    const x = gap + (index % cols) * (cellW + gap), y = gap + Math.floor(index / cols) * (cellH + caption + gap);
    const group = TYPE_GROUPS[code.slice(0, 2)]!, file = candidateFile(code, variant);
    const image = fs.existsSync(file)
      ? `<image x="${x}" y="${y}" width="${cellW}" height="${cellH}" preserveAspectRatio="xMidYMid meet" href="data:image/png;base64,${fs.readFileSync(file).toString("base64")}"/>`
      : `<text x="${x + cellW / 2}" y="${y + cellH / 2}" font-size="24" fill="#4F4A42" text-anchor="middle" font-family="Microsoft YaHei, sans-serif">未生成</text>`;
    return `<rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" rx="14" fill="${group.tint}"/>${image}`
      + `<circle cx="${x + 30}" cy="${y + 30}" r="24" fill="#1E1B16"/>`
      + `<text x="${x + 30}" y="${y + 39}" font-size="26" font-weight="700" fill="#F6F2EA" text-anchor="middle" font-family="Arial">${index + 1}</text>`
      + `<text x="${x + cellW / 2}" y="${y + cellH + 30}" font-size="24" font-weight="700" fill="${group.colour}" text-anchor="middle" font-family="Microsoft YaHei, Arial, sans-serif">${code} ${TYPE_TABLE[code]!.name}</text>`
      + `<text x="${x + cellW / 2}" y="${y + cellH + 56}" font-size="20" fill="#4F4A42" text-anchor="middle" font-family="Microsoft YaHei, sans-serif">${variant === "female" ? "女" : "男"}</text>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#F6F2EA"/>${cells}</svg>`;
  const out = path.join(CANDIDATES, "sheet.png");
  fs.mkdirSync(CANDIDATES, { recursive: true });
  fs.writeFileSync(out, renderSvg(svg, width));
  console.log(`wrote ${out} (${SLOTS.filter(({ code, variant }) => fs.existsSync(candidateFile(code, variant))).length} of ${SLOTS.length} drawn)`);
}

async function main(): Promise<void> {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "placeholders") return placeholders();
  if (mode === "candidates") return candidates(args);
  if (mode === "redo") return candidates(args, true);
  if (mode === "pick") return pick(args);
  if (mode === "sheet") return sheet();
  if (mode === "prompt") return void console.log(templatePrompt(args[0] ?? "", args[1] === "male" ? "male" : "female"));
  if (mode === "svg") return void console.log(placeholderSvg(args[0] ?? "", args[1] === "male" ? "male" : "female"));
  console.error("usage: assess-templates.ts placeholders | candidates [CODE|N ...] [--via=codex [--port=N]] [--variant=female|male] [--force] | redo N ... | sheet | pick all | pick N ... | prompt CODE [female|male]");
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
