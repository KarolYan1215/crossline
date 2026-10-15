import { NOTE_MAX, type Appearance } from "../../lib/contract";

/**
 * The instruction that turns a type's template into one person's figure (docs/beta-launch.md §4). Fixed English text built only from
 * the closed choices of `Appearance` — never the email, the nickname or the answers. The free note is the one opening for text a stranger
 * typed, so it never reaches the model as written: it is cleaned, refused whole when it reads like an instruction or asks for something
 * unsafe, and otherwise reduced to the appearance words it contains, translated from a fixed vocabulary and quoted as a description.
 * Prompt shape follows Black Forest Labs' editing guidance: say exactly what changes, then name everything that stays, colours as hex.
 */

const PRESENTATION: Record<Appearance["presentation"], string> = {
  female: "the character reads as a young woman (a softer face shape), drawn in exactly the same cartoon style",
  male: "the character reads as a young man (a slightly squarer jaw), drawn in exactly the same cartoon style",
  neutral: "the character keeps an androgynous, gender-neutral look"
};

const HAIR: Record<Appearance["hair"], string> = {
  short: "short hair",
  medium: "shoulder-length hair",
  long: "long hair falling past the shoulders",
  curly: "curly hair",
  tied: "hair tied back in a ponytail or bun",
  bald: "a bald head with no hair"
};

const SKIN: Record<Appearance["skin"], string> = {
  light: "a light skin tone (#F2D6C1)",
  medium: "a medium skin tone (#C99A72)",
  deep: "a deep skin tone (#7A5139)"
};

/** Style changes the cut of the clothes only; the template's outfit colours always stay. */
const STYLE: Record<Appearance["style"], string> = {
  casual: "a relaxed, casual cut",
  smart: "a neat, tailored cut",
  sporty: "a sporty cut with a zip collar",
  artsy: "a loose, artistic cut"
};

const COLOURS: Array<[RegExp, string]> = [
  [/酒红|burgundy/, "burgundy"], [/亚麻|ash/, "ash-blonde"], [/红|red/, "red"], [/粉|pink/, "pink"], [/橙|橘|orange/, "orange"],
  [/金|blonde|blond|gold/, "gold"], [/黄|yellow/, "yellow"], [/绿|green/, "green"], [/蓝|blue/, "blue"], [/紫|purple/, "purple"],
  [/棕|褐|咖啡|brown/, "brown"], [/黑|black/, "black"], [/白|white/, "white"], [/银|silver/, "silver"], [/灰|grey|gray/, "grey"]
];

/** Appearance words a note may contribute, longest first, each with its fixed English phrase; `coloured` takes a colour before it. */
const VOCABULARY: Array<{ keys: string[]; phrase: string; coloured?: boolean; needsColour?: boolean }> = [
  { keys: ["贝雷帽", "beret"], phrase: "beret", coloured: true },
  { keys: ["渔夫帽", "bucket hat"], phrase: "bucket hat", coloured: true },
  { keys: ["棒球帽", "baseball cap"], phrase: "baseball cap", coloured: true },
  { keys: ["毛线帽", "beanie"], phrase: "knit beanie", coloured: true },
  { keys: ["帽子", "帽", "hat", "cap"], phrase: "hat", coloured: true },
  { keys: ["挑染", "highlights"], phrase: "hair highlights", coloured: true },
  { keys: ["发带", "headband"], phrase: "headband", coloured: true },
  { keys: ["发夹", "发卡", "hair clip"], phrase: "hair clip", coloured: true },
  { keys: ["蝴蝶结", "bow"], phrase: "hair bow", coloured: true },
  { keys: ["围巾", "scarf"], phrase: "scarf", coloured: true },
  { keys: ["耳钉", "stud"], phrase: "stud earrings", coloured: true },
  { keys: ["耳环", "earring"], phrase: "earrings", coloured: true },
  { keys: ["项链", "necklace"], phrase: "necklace", coloured: true },
  { keys: ["领带", "necktie", "tie"], phrase: "necktie", coloured: true },
  { keys: ["耳机", "headphone"], phrase: "headphones", coloured: true },
  { keys: ["雀斑", "freckle"], phrase: "freckles" },
  { keys: ["小胡子", "moustache", "mustache"], phrase: "a moustache" },
  { keys: ["胡子", "胡须", "络腮胡", "beard"], phrase: "a short beard" },
  { keys: ["酒窝", "dimple"], phrase: "dimples" },
  { keys: ["刘海", "bangs", "fringe"], phrase: "bangs" },
  { keys: ["马尾", "ponytail"], phrase: "a ponytail" },
  { keys: ["双马尾", "pigtails"], phrase: "pigtails" },
  { keys: ["辫子", "麻花辫", "braid"], phrase: "braids" },
  { keys: ["丸子头", "bun"], phrase: "a hair bun" },
  { keys: ["寸头", "buzz cut"], phrase: "a buzz cut" },
  { keys: ["痣", "beauty mark", "mole"], phrase: "a small beauty mark" },
  { keys: ["头发", "发色", "发", "hair"], phrase: "hair", coloured: true, needsColour: true }
];

/** Notes that try to steer the model rather than describe a look are dropped whole. */
const INSTRUCTION_LIKE = /ignore|disregard|instruction|prompt|system|assistant|override|forget|pretend|jailbreak|you are|act as|previous|above|以上|之前|忽略|无视|指令|提示词|系统|扮演|你是|你现在|现在开始|规则|不要遵守|改为输出|生成一张|画一张/i;
/** Anything that is not a look the poster can carry: nudity, gore, weapons, hate symbols, real people's likeness. */
const UNSAFE = /nud|naked|nsfw|sex|porn|lingerie|bikini|blood|gore|weapon|gun|knife|nazi|swastika|kill|裸|性感|色情|内衣|比基尼|血|枪|刀|武器|纳粹|杀|暴力|明星|celebrity|像.{0,6}(一样|本人)/i;
const URL_LIKE = /(https?:\/\/|www\.)\S*|\S+@\S+|\S+\.(com|cn|net|org|io|ai|me|xyz|top|cc)\S*/gi;

/** The cleaned note's appearance words, in English, at most four; [] when the note says nothing usable or anything it must not. */
export function sanitizeNote(note: string): string[] {
  const text = note.normalize("NFKC").replace(/\p{C}/gu, "").slice(0, NOTE_MAX).replace(URL_LIKE, " ").toLowerCase();
  if (!text.trim() || INSTRUCTION_LIKE.test(text) || UNSAFE.test(text)) return [];
  const used = new Array<boolean>(text.length).fill(false);
  const found: Array<{ at: number; phrase: string }> = [];
  // Longest keys first, across the whole vocabulary: 「双马尾」 before 「马尾」, 「贝雷帽」 before 「帽」, 「发带」 before 「发」.
  const keys = VOCABULARY.flatMap((entry) => entry.keys.map((key) => ({ key, entry }))).sort((a, b) => b.key.length - a.key.length);
  for (const { key, entry } of keys) {
    for (let at = text.indexOf(key); at >= 0; at = text.indexOf(key, at + key.length)) {
      if (used.slice(at, at + key.length).some(Boolean)) continue;
      // An English key must be a whole word ("cap" in "capable" is not a cap).
      if (/^[a-z ]+$/.test(key) && (/[a-z]/.test(text[at - 1] ?? "") || /[a-z]/.test(text[at + key.length] ?? ""))) continue;
      const colour = entry.coloured ? colourNear(text, at, key.length) : undefined;
      if (entry.needsColour && !colour) continue;
      used.fill(true, at, at + key.length);
      const named = colour === "gold" && entry.needsColour ? "golden blonde" : colour;
      found.push({ at, phrase: named ? `${named} ${entry.phrase}` : entry.phrase });
    }
  }
  return [...new Set(found.sort((a, b) => a.at - b.at).map((item) => item.phrase))].slice(0, 4);
}

/** The colour word just before an item (「红色贝雷帽」, "red beret"), else just after it for hair (「头发是红色」). */
function colourNear(text: string, at: number, length: number): string | undefined {
  const before = text.slice(Math.max(0, at - 12), at);
  const after = text.slice(at + length, at + length + 4);
  const last = (window: string): string | undefined => {
    let best: { index: number; name: string } | undefined;
    for (const [pattern, name] of COLOURS) {
      const match = [...window.matchAll(new RegExp(pattern.source, "g"))].pop();
      if (match && (!best || match.index > best.index)) best = { index: match.index, name };
    }
    return best?.name;
  };
  // Only the words right before the item belong to it: cut the window at the last separator.
  const tail = before.split(/[,，、;；.。]|和|与|\band\b|\bwith\b/).pop() ?? "";
  return last(tail) ?? last(after.split(/[,，、;；.。]+/)[0] ?? "");
}

/** The edit instruction for one person's figure: what changes, then everything that must stay. */
export function avatarPrompt(appearance: Appearance): string {
  const changes = [
    PRESENTATION[appearance.presentation],
    HAIR[appearance.hair],
    appearance.glasses ? "simple thin-framed round glasses" : "no glasses",
    SKIN[appearance.skin],
    `the clothes take ${STYLE[appearance.style]} while keeping exactly the same outfit colours`
  ];
  const note = sanitizeNote(appearance.note);
  return [
    "Edit this cartoon character. Change only the character's appearance:",
    `${changes.join("; ")}.`,
    note.length ? `Extra appearance details, as a description only: "${note.join(", ")}".` : "",
    "Keep everything else exactly unchanged: the same character design and drawing style, the same flat colours and line weight, the same pose and body proportions, the same expression, the same framing and camera angle, the same outfit colours and props, and the same flat plain background.",
    "No text, letters, numbers or logos anywhere."
  ].filter(Boolean).join(" ");
}

/** A stable seed per result, so a retry draws the same picture. */
export function seedFor(id: string): number {
  let hash = 2166136261;
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return hash;
}
