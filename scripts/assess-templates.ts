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
  ROBA: { trait: "a demanding client who briefs the AI precisely and judges every version", build: "poised and upright",
    hair: { female: "a sleek straight bob", male: "short neat hair with a sharp side part" },
    outfit: "a tailored blazer over a crisp shirt, smart trousers, a lanyard with a blank visitor badge",
    prop: "a tall stack of nearly identical blank design drafts on one arm, the very first sheet pulled out from the bottom and held up",
    gag: "a row of sticky tabs on the stack, every one crossed out except the first",
    pose: "standing with weight on one hip, holding the first draft up at arm's length and tapping it with one finger", expression: "satisfied, slightly smug, eyebrows raised" },
  ROBG: { trait: "an air traffic controller lining up many tasks to land in order", build: "steady and square-shouldered",
    hair: { female: "a low practical ponytail under the headset", male: "a short crew cut under the headset" },
    outfit: "a short-sleeved shirt with plain epaulettes under a high-visibility vest, a headset with a boom microphone",
    prop: "a clipboard of blank flight strips held in one hand",
    gag: "several small paper planes circling the head in a queue, one diving far too steeply",
    pose: "one hand pressed to the headset mic, the other arm pointing sternly up at the diving plane", expression: "exasperated, mouth open mid-call" },
  ROHA: { trait: "a hands-off shopkeeper who lets the AI do the work and trusts the result", build: "relaxed and round-shouldered",
    hair: { female: "a loose low bun with a pencil stuck through it", male: "slightly long hair tucked behind the ears" },
    outfit: "a loose linen shirt with sleeves rolled, wide trousers, cloth slippers",
    prop: "a big cup of milk tea with a straw held lazily in one hand",
    gag: "two tiny faceted robots carrying a box past the feet while the figure does nothing",
    pose: "leaning back with the feet crossed at the ankles, free hand waving the robots on without looking", expression: "contented, eyes closed" },
  ROHG: { trait: "a time-management master running five things through AI at once", build: "quick and wiry",
    hair: { female: "a high ponytail swinging mid-motion", male: "short spiky hair" },
    outfit: "a zip-up hoodie over a t-shirt, joggers, sneakers, earbuds in",
    prop: "two phones in the hands and three small floating blank screens around the body",
    gag: "a tangle of charging cables looping around the legs",
    pose: "spinning on one foot, glancing at one screen while tapping another", expression: "confident grin, a bit frazzled" },
  RUBA: { trait: "a student who learns one subject with the AI as tutor and checks everything it says", build: "slim and youthful",
    hair: { female: "a short bob with a hair clip", male: "a short fluffy cut" },
    outfit: "an oversized hoodie, a backpack on both shoulders, a student lanyard with a blank card",
    prop: "a soft steamed bun torn open in both hands, sweet red bean paste showing inside",
    gag: "a tablet tucked under one arm with a small question mark floating above it",
    pose: "standing feet apart, pulling the bun apart and glaring at the filling", expression: "annoyed squint, determined" },
  RUBG: { trait: "an all-round fighter with a study plan for every line, aiming for full marks everywhere", build: "very tall, broad-shouldered and imposing",
    hair: { female: "long straight dark hair falling from under a peaked cap", male: "short dark hair merging into a peaked cap" },
    outfit: "a long dark high-collared coat worn open over a fitted top, a thin gold chain hanging from the collar, dark trousers (an original look in the spirit of a dramatic shonen hero, not any existing character)",
    prop: "a glowing hexagonal shield-badge held up in one hand",
    gag: "six small hexagon tokens orbiting the shoulders, one of them noticeably dimmer than the rest",
    pose: "a dramatic angular pose, torso twisted, pointing straight ahead with the free hand", expression: "stern and cool" },
  RUHA: { trait: "a careful disposal specialist who takes the AI's answer apart before trusting it", build: "compact and sturdy",
    hair: { female: "hair tucked under a helmet, a short fringe showing", male: "short hair under a helmet" },
    outfit: "generic tactical gear: a plate carrier vest with pouches, knee pads, gloves, a padded helmet with the visor pushed up, no insignia",
    prop: "wire cutters hovering between two wires, one muted red and one muted blue, coming out of a small blank toy puzzle box",
    gag: "a small plush whale clipped to the vest, watching",
    pose: "crouching on one knee over the device, cutters frozen mid-air", expression: "nervous, a bead of sweat on the brow" },
  RUHG: { trait: "a self-taught scholar who learns anything from the AI and saves everything", build: "lanky and loose-limbed",
    hair: { female: "messy shoulder-length waves with a pencil behind the ear", male: "tousled medium hair with a pencil behind the ear" },
    outfit: "a long knitted cardigan over a t-shirt, rolled trousers, a canvas messenger bag",
    prop: "an open book held up while walking, a second book under the arm",
    gag: "the messenger bag overflowing with dozens of colourful bookmark ribbons and folders",
    pose: "walking forward while reading, one foot mid-step", expression: "curious and absorbed" },
  WOBA: { trait: "a pilot who plans the mission and fights fused with the machine", build: "athletic and lean",
    hair: { female: "a short practical crop", male: "a short undercut" },
    outfit: "a sleek armoured pilot suit with a compact jump-kit pack on the back, a helmet tucked under one arm, original design, no insignia",
    prop: "a slim data-link cable running from the wrist to a giant faceted robot hand rising behind, open-palmed like a partner",
    gag: "the giant robot hand copying the pilot's raised fist exactly",
    pose: "a ready stance, one fist raised towards the robot hand", expression: "focused and calm" },
  WOBG: { trait: "a ship's captain commanding a whole crew of AI across several lines", build: "broad and steady",
    hair: { female: "a neat low bun under a peaked captain's cap", male: "short hair under a peaked captain's cap" },
    outfit: "a double-breasted naval captain's coat with plain buttons, white gloves, boots",
    prop: "a brass telescope held at the side",
    gag: "three tiny faceted robot sailors saluting at the feet, one saluting with the wrong hand",
    pose: "one arm flung forward commanding, coat flaring", expression: "bold, mouth open mid-order" },
  WOHA: { trait: "a mysterious bald generalissimo of the old school who adjusts every shot by feel", build: "slight, very upright and stiff-backed",
    hair: { female: "a smooth fully shaved head", male: "a smooth fully shaved head and a small neat moustache" },
    outfit: "a high-collared buttoned military tunic of an early twentieth-century style with a long cape over the shoulders, white gloves, riding boots; an original caricature commander, not a portrait of any real person, no insignia, medals, badges or flags",
    prop: "a slim walking cane held like a pointer, aimed a little to the right, and a small folded blank map in the other hand",
    gag: "the map is held upside down",
    pose: "standing very straight, chin up, the cane jabbing a little to the right", expression: "puzzled frown under a stern brow" },
  WOHG: { trait: "a digital nomad who works with AI wherever the Wi-Fi is", build: "easygoing",
    hair: { female: "loose sun-bleached waves", male: "a short messy cut" },
    outfit: "a loose patterned short-sleeved shirt, shorts, sandals, sunglasses pushed up on the head, a small backpack",
    prop: "an open laptop balanced on one forearm",
    gag: "a small floating Wi-Fi signal shape that the figure is following",
    pose: "strolling forward while typing one-handed", expression: "relaxed smile" },
  WUBA: { trait: "an ascetic who trains with the AI in seclusion until reaching the top level", build: "lean and calm",
    hair: { female: "long hair in a top knot with a wooden pin", male: "hair tied in a small top knot" },
    outfit: "a simple wrap-front cultivation robe with a sash, cloth shoes",
    prop: "an open scroll glowing softly, floating in front",
    gag: "a small cushion and a teacup hovering beside, both mid-air too",
    pose: "sitting cross-legged and hovering a little above the ground", expression: "serene, eyes closed" },
  WUBG: { trait: "a strategist who war-games every line with the AI before acting", build: "tall and slender",
    hair: { female: "long hair half-tied with a small hair crown", male: "hair in a scholar's top knot with a small crown" },
    outfit: "a long flowing scholar's robe with wide sleeves and a light cloak",
    prop: "a white feather fan held at the chest",
    gag: "a tiny faceted robot sitting on the shoulder, whispering into the ear",
    pose: "strolling calmly, fan raised, free hand behind the back", expression: "knowing half-smile" },
  WUHA: { trait: "an alchemist who experiments with the AI furnace after furnace", build: "small and energetic",
    hair: { female: "frizzy hair blown back and slightly singed", male: "spiky hair blown upright and slightly singed" },
    outfit: "a scorched leather apron over a shirt, rolled sleeves, thick gloves, goggles around the neck",
    prop: "a round flask with a small puff of smoke held up triumphantly",
    gag: "soot smudges on the face and a tiny cracked pot at the feet",
    pose: "standing on tiptoe, flask raised overhead", expression: "triumphant grin despite the soot" },
  WUHG: { trait: "a know-it-all wanderer who chats with the AI about every field", build: "medium and animated",
    hair: { female: "a long braid over one shoulder", male: "shoulder-length hair tied low" },
    outfit: "a traveller's long jacket with many pockets over a tunic, a bamboo hat hanging on the back",
    prop: "a closed folding fan pointed like a storyteller's baton and a small bound notebook",
    gag: "slips of paper peeking out of every pocket",
    pose: "leaning in as if sharing a secret, one finger raised", expression: "playful, one eyebrow up" }
};

/**
 * The templates' style (the owner's direction, 2026-10-14): the look of the popular MBTI personality-test avatars — full length, smooth
 * low-poly facets with soft flat shading, slender stylised bodies, small heads with minimal faces — so the figure reads at a glance as
 * "my type's character". Only the shape language is borrowed: the colours are our own muted Morandi tone per group (`TYPE_GROUPS`, not
 * their purple/green/blue/yellow), and every outfit, prop and gag is ours (`LOOKS`). Skin stays medium and there are no glasses, so a
 * person's own appearance can be edited in later.
 */
/**
 * The groups' colours in words as well as hex, keyed by the hex so a palette change in `TYPE_GROUPS` that is not named here falls back to
 * the hex alone instead of naming the wrong colour.
 */
const COLOUR_WORDS: Record<string, string> = {
  "#8C9A7E": "muted sage green", "#E2E6DA": "very pale sage green",
  "#A88C93": "muted dusty rose", "#EBDEE0": "very pale dusty pink",
  "#8497A6": "muted haze blue", "#DCE3E9": "very pale grey-blue",
  "#B48C72": "muted warm clay terracotta", "#EFE2D7": "very pale warm sand"
};
const named = (hex: string) => (COLOUR_WORDS[hex] ? `${COLOUR_WORDS[hex]} (${hex})` : hex);

function stylePrompt(tone: string, tint: string): string {
  return [
    "Exactly one full-body character in the angular low-poly 3D style of popular MBTI personality-test avatars: every form is built from a few large flat planar facets with crisp hard edges, like a faceted papercraft figure or a low-polygon game model.",
    "Chunky squared-off geometry: boxy shoulders and torso, angular jaw, hair made of a few big polygonal chunks, limbs as straight faceted segments, hands as simple geometric mitten shapes, shoes as angular blocks.",
    "Flat shading with one solid tone per facet and visible facet edges; no smooth gradients, no soft rounded curves, no glossy or realistic render, no outlines. Stylised proportions about six heads tall.",
    "Small head with a minimal face: small dark dot eyes, simple straight brows, a tiny mouth, no nose detail; not a likeness of any real person.",
    `Colour: a soft muted Morandi palette, dusty and slightly greyed, low saturation; the outfit's main colour is clearly ${named(tone)} — the most visible garment must be this colour, not grey or another hue — with off-white and one quiet neutral as accents; no saturated or neon colours.`,
    "The whole figure from head to shoes is visible, standing on the floor with only a soft oval ground shadow under the feet (no rock, step, box, stand or platform unless the pose names one), centered, filling about 85% of the frame height with a little margin above the head and below the feet.",
    "Props drawn simply and clearly readable at small size. An original character design, not a copy of any existing character.",
    `Backdrop: one flat plain fill of ${named(tint)} from edge to edge; no frame, no scenery.`,
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
    `The character is a young ${variant === "female" ? "woman, clearly feminine at a glance" : "man, clearly masculine at a glance"}, ${look.build}; hair: ${look.hair[variant]}, dark brown; medium skin tone; no glasses.`,
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
