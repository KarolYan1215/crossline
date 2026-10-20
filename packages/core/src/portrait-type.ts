import { SCHWARTZ_VALUES, redactPortrait, type PortraitReport } from "./portrait";
export { CHARACTER_EXPRESSIONS, CHARACTER_POSES } from "./portrait-character";

/**
 * Crossline's own typing (redesigned 2026-10-17 with the owner, docs/assess-redesign.md): four dimensions of how a person runs several
 * lines of life, each taken from a body of research and scored 0–100 (0 = left pole, 100 = right pole) — by the quick test from
 * independently measured poles, by the portrait writer from evidence — read as a four-letter code into one of sixteen fixed types in four
 * groups. The names live here, not in the model's answer, so the same profile always lands on the same, comparable, shareable type.
 *
 * The sixteen names and the thirty-two figures were kept from the first version (2026-10-08); only the codes moved, letter for letter in
 * the same positions: S→C, G→D, E→L, I→X, M→W, R→B, P→U, A→V. No letter is one of MBTI's (E I S N T F J P) or the first version's.
 */

export type TypeAxisId = "concentration" | "orientation" | "boundary" | "pacing";
/** Each letter is the initial of an English word (`en`), so the code reads as words: DLWU = Diversified, Leverage, Walled, Uniform. */
export type TypeAxis = {
  id: TypeAxisId;
  /** The dimension's name, and what it measures in one sentence. */
  name: string;
  question: string;
  left: { letter: string; label: string; en: string; definition: string };
  right: { letter: string; label: string; en: string; definition: string };
  /** The research it rests on, as short citations. */
  sources: string;
};
export const TYPE_AXES: TypeAxis[] = [
  { id: "concentration", name: "主线集中度", question: "时间与身份认同集中在一条主线上，还是分布在几条主线上",
    left: { letter: "C", label: "单线主导", en: "Concentrated", definition: "一条主线占主导地位，其他领域服务于它或为它让路" },
    right: { letter: "D", label: "多线并行", en: "Diversified", definition: "两条及以上主线获得相近的时间与认同投入" },
    sources: "Sieber 1974 角色累积；Handy 1989 组合型职业；Unsworth, Yeo & Beck 2014 多目标追求" },
  { id: "orientation", name: "探索–利用取向", question: "深化已掌握的能力与领域，还是进入陌生的领域与方法",
    left: { letter: "L", label: "利用", en: "Leverage", definition: "在已掌握的能力与领域内持续改进，追求效率与确定的回报" },
    right: { letter: "X", label: "探索", en: "eXplore", definition: "主动进入陌生领域、尝试新方法，接受更高的不确定性" },
    sources: "March 1991；Gupta, Smith & Shalley 2006；Mom, van den Bosch & Volberda 2009" },
  { id: "boundary", name: "角色边界管理", question: "各条主线之间划清时间与情境的边界，还是让边界可渗透、相互交织",
    left: { letter: "W", label: "分隔", en: "Walled", definition: "为每条主线划定明确的时间与情境边界，减少相互干扰" },
    right: { letter: "B", label: "整合", en: "Blended", definition: "各条主线在时间、情境与思维上相互渗透，允许随时切换与借用" },
    sources: "Nippert-Eng 1996；Ashforth, Kreiner & Fugate 2000；Kreiner 2006" },
  { id: "pacing", name: "投入节律", question: "投入在时间上均匀分布，还是集中在若干高强度阶段",
    left: { letter: "U", label: "均匀", en: "Uniform", definition: "投入在时间上分布较为平均，按固定节奏持续推进" },
    right: { letter: "V", label: "波动", en: "Variable", definition: "投入集中在截止期前或状态好的阶段，其余时间投入较低" },
    sources: "Gersick 1988 间断平衡；Gevers, Rutte & van Eerde 2006 工作节奏风格" }
];

/**
 * The four groups (first two letters: concentration × orientation), each one muted Morandi hue (decided 2026-10-14): `tone` is the
 * figure's outfit colour, `tint` the card's and the figure's backdrop, `colour` the same hue deep enough for text (at least 7:1 on the
 * poster's paper, checked in portrait-type.test.ts) — sage for 工匠组, dusty rose for 求索组, haze blue for 架构组, clay for 开拓组.
 */
export const TYPE_GROUPS: Record<string, { name: string; colour: string; tone: string; tint: string; blurb: string }> = {
  CL: { name: "工匠组", colour: "#3D4A35", tone: "#8C9A7E", tint: "#E2E6DA", blurb: "集中一条主线，深化已有优势" },
  CX: { name: "求索组", colour: "#66404A", tone: "#A88C93", tint: "#EBDEE0", blurb: "集中一条主线，开辟新问题" },
  DL: { name: "架构组", colour: "#34495A", tone: "#8497A6", tint: "#DCE3E9", blurb: "多线并行，深化已有优势" },
  DX: { name: "开拓组", colour: "#623E29", tone: "#B48C72", tint: "#EFE2D7", blurb: "多线并行，进入新领域" }
};

/**
 * Sixteen types (names kept from 2026-10-14, codes moved 2026-10-17). `blurb` describes the four positions in plain words; it is also the
 * fallback one-liner for a report written before the writer gave a personal `summary`.
 */
export const TYPE_TABLE: Record<string, { name: string; blurb: string }> = {
  CLWU: { name: "钟表匠", blurb: "专注一条主线，深化既有能力；给主线划出固定时段，按稳定节奏推进" },
  CLWV: { name: "试验家", blurb: "专注一条主线，深化既有能力；给主线留出完整时段，集中高强度投入" },
  CLBU: { name: "讲师", blurb: "专注一条主线，深化既有能力；把相邻领域融入主线，按稳定节奏推进" },
  CLBV: { name: "顾问", blurb: "专注一条主线，深化既有能力；随需求在各场景间切换，投入时多时少" },
  CXWU: { name: "雕刻家", blurb: "专注一条主线，持续探索新问题；在独立时段里长期、稳定地打磨" },
  CXWV: { name: "即兴艺人", blurb: "专注一条主线，持续探索新问题；在独立时段里，状态到时集中投入" },
  CXBU: { name: "布道者", blurb: "专注一条主线，持续探索新问题；把生活其他部分融入主线，稳定推进" },
  CXBV: { name: "吟游诗人", blurb: "专注一条主线，持续探索新问题；各场景间自由切换，投入随状态起伏" },
  DLWU: { name: "架构师", blurb: "多线并行，深化各线既有能力；每条线边界清楚，按固定节奏轮转" },
  DLWV: { name: "改装师", blurb: "多线并行，深化各线既有能力；每条线分开处理，轮流集中突击" },
  DLBU: { name: "参谋长", blurb: "多线并行，深化各线既有能力；各线互相借力，按稳定节奏统筹推进" },
  DLBV: { name: "联络官", blurb: "多线并行，深化各线既有能力；各线互相渗透，随时机灵活调配投入" },
  DXWU: { name: "创始人", blurb: "多线并行，持续进入新领域；每条线边界清楚，长期稳定投入" },
  DXWV: { name: "发明家", blurb: "多线并行，持续进入新领域；每条线分开推进，阶段性高强度攻关" },
  DXBU: { name: "旗手", blurb: "多线并行，持续进入新领域；各线汇入一个整体，稳定持续推进" },
  DXBV: { name: "探险家", blurb: "多线并行，持续进入新领域；各线自由交织，投入随机会起伏" }
};

/** The first version's code for each type (2026-10-08 to 2026-10-17), for files and texts written under it. */
export const LEGACY_TYPE_CODE: Record<string, string> = Object.fromEntries(Object.keys(TYPE_TABLE).map((code) => {
  const back: Record<string, string> = { C: "S", D: "G", L: "E", X: "I", W: "M", B: "R", U: "P", V: "A" };
  return [code, [...code].map((letter) => back[letter]!).join("")];
}));

/**
 * What stops the writer's personal type summary from being shown: it must speak to the person (「你…」), and it must not name a type or a
 * code — the page ends it with 「你是 DLWV 改装师。」 itself, from the scores, so the two can never disagree.
 */
export function typeSummaryProblem(summary: string): string | null {
  const text = summary.trim();
  if (!text) return null;
  if (!text.startsWith("你")) return "type.summary 须以「你」开头，直接对本人说";
  const named = Object.entries(TYPE_TABLE).flatMap(([code, type]) => [code, type.name]).find((word) => text.includes(word))
    ?? (/人格|MBTI|[EI][NS][TF][JP]/.test(text) ? "外部人格类型" : undefined);
  return named ? `type.summary 不要写类型名或代码（含「${named}」）；结尾的「你是 …」由页面补上` : null;
}

export type PortraitType = {
  code: string; name: string; blurb: string;
  group: { key: string; name: string; colour: string; tint: string; blurb: string };
  /** The writer's paragraph about this person as this type, without the type's name; none on older reports. */
  summary: string;
  /** Per axis: the side the person leans to and how far (50–100%), for the bars; `leftEn`/`rightEn` the English words the letters stand for. */
  axes: Array<{ id: TypeAxisId; left: string; right: string; leftEn: string; rightEn: string; score: number; letter: string; label: string; percent: number; evidence: string }>;
};

/**
 * A type from four axis scores (0 = left pole, 100 = right pole; exactly 50 reads as the right pole), with each axis's reason when there
 * is one. Shared by the portrait (scores from the writer) and the public quick test (scores from `quizScores`), so both land on the same
 * sixteen names.
 */
export function typeFromScores(scores: Record<TypeAxisId, number>, evidence: Partial<Record<TypeAxisId, string>> = {}): PortraitType {
  const axes = TYPE_AXES.map((axis) => {
    const score = Math.max(0, Math.min(100, Math.round(scores[axis.id])));
    const right = score >= 50;
    const side = right ? axis.right : axis.left;
    return { id: axis.id, left: axis.left.label, right: axis.right.label, leftEn: axis.left.en, rightEn: axis.right.en, score, letter: side.letter, label: side.label,
      percent: right ? score : 100 - score, evidence: evidence[axis.id] ?? "" };
  });
  const code = axes.map((axis) => axis.letter).join("");
  const groupKey = code.slice(0, 2);
  return { code, ...TYPE_TABLE[code]!, summary: "", group: { key: groupKey, ...TYPE_GROUPS[groupKey]! }, axes };
}

/** The person's type from the writer's axis scores, with the writer's summary; none for a report written before the axes existed. */
export function portraitType(report: PortraitReport): PortraitType | null {
  // A report written on the first version's axes (scope/basis/output/rhythm) has no type until it is rewritten (schema 4).
  if (!report.type || !TYPE_AXES.every((axis) => typeof report.type![axis.id] === "number")) return null;
  return { ...typeFromScores(report.type, report.type.evidence), summary: (report.type.summary ?? "").trim() };
}

export type PortraitLabelCell = { title: string; value: string; detail?: string };
export type PortraitIdentity = { lineId: string; label: string; target: number; now: number | null };

/**
 * The poster's labels (decided 2026-10-12), each computed or taken from a fixed field so two people's posters compare: the core word
 * the writer gave, the top-scoring Schwartz value (ties go to the earlier one in the circle), the line with the largest suggested share
 * as the base, and every other line as an identity row — suggested share as a bar, current share as a marker. A cell whose source is
 * missing (an older report) is left out.
 */
export function portraitLabels(report: PortraitReport, options: { lineLabel: (id: string) => string }): { cells: PortraitLabelCell[]; identities: PortraitIdentity[] } {
  const cells: PortraitLabelCell[] = [];
  const coreWord = report.cover.coreWord?.trim();
  if (coreWord) cells.push({ title: "核心词", value: coreWord });
  const values = report.compass.values ?? [];
  const names = SCHWARTZ_VALUES.map((value) => value.name as string);
  if (values.length === names.length && names.every((name) => values.some((value) => value.name === name))) {
    const top = names.map((name) => values.find((value) => value.name === name)!).reduce((best, value) => (value.score > best.score ? value : best));
    cells.push({ title: "价值核心", value: top.name });
  }
  const ranked = [...report.lines.items].sort((a, b) => (b.targetShare ?? 0) - (a.targetShare ?? 0));
  const base = ranked[0];
  if (base?.targetShare) cells.push({ title: "建议底座", value: options.lineLabel(base.lineId), detail: `建议投入约 ${base.targetShare}%` });
  const identities = ranked.slice(base?.targetShare ? 1 : 0).map((item) => ({ lineId: item.lineId, label: options.lineLabel(item.lineId), target: item.targetShare ?? 0, now: item.share ?? null }));
  return { cells, identities };
}

/**
 * The character standard (decided 2026-10-08): every person's figure is drawn in one fixed style — like the sixteen figures of a
 * personality test, recognisably a family — and only what the portrait says about this person varies: the outfit (in their base line's
 * colour), up to three props, the pose and the expression, on their type group's backdrop. The figure is gender-neutral and never a
 * likeness of anyone; no text, numbers or logos anywhere, so the picture can be shared.
 */
export const CHARACTER_STANDARD = [
  "Full-body stylized cartoon character in the style of modern personality-test avatars: flat vector shapes with soft faceted (low-poly inspired) shading, clean geometric silhouette.",
  "Proportions about five heads tall, three-quarter view, standing on a soft ground shadow, centered, the figure filling about 75% of the height.",
  "Simplified face: small dot eyes, a small mouth, no nose detail; simple neat hairstyle; gender-neutral, not a likeness of any real person.",
  "Exactly one main outfit colour and one accent colour; props drawn simply and clearly readable at small size.",
  "Plain backdrop: flat warm off-white (#F3EFE6) with one large soft circle behind the figure in the group tint.",
  "Absolutely no text, letters, numbers, logos or brand marks anywhere. Square 1:1 frame."
].join(" ");

const LINE_COLOUR_NAME: Record<string, string> = { research: "deep blue (#0A5198)", startup: "burnt orange (#8C3709)", media: "plum (#792E9C)", investment: "forest green (#085E3A)", health: "ochre (#664E00)",
  "line-wellness": "olive (#4A5200)", "line-wealth": "deep teal (#005B66)" };

/** The one image prompt for the person's figure: the standard, their group's backdrop, and the writer's redacted choices. */
export function characterPrompt(report: PortraitReport): string | null {
  const type = portraitType(report);
  const character = redactPortrait(report).character;
  if (!type || !character) return null;
  const base = [...report.lines.items].sort((a, b) => (b.targetShare ?? b.share ?? 0) - (a.targetShare ?? a.share ?? 0))[0]?.lineId ?? "";
  const outfitColour = LINE_COLOUR_NAME[base] ?? "near-black";
  const accent = Object.entries(LINE_COLOUR_NAME).find(([id]) => id !== base && report.lines.items.some((item) => item.lineId === id))?.[1] ?? "white";
  // How the person says they look comes first (decided 2026-10-14): it replaces the standard's neutral face-and-hair defaults and the
  // clothing colours; the base line's colour moves to accessories and small details, and the circle keeps the type group's tint.
  const appearance = character.appearance?.trim();
  if (appearance) return [CHARACTER_STANDARD.replace(/Simplified face:[^.]*\.\s*/, "Simplified face: small dot eyes, a small mouth, no nose detail; not a portrait of a real face. ")
      .replace("Exactly one main outfit colour and one accent colour; ", ""),
    `Group tint for the circle: ${type.group.tint}.`,
    `Appearance, as the person describes themselves: ${appearance}. Clothing colours follow this description.`,
    `Outfit: ${character.outfit.trim()}. Accessories and small details (a strap, a badge, a pen, a prop's trim) in ${outfitColour}, with ${accent} as a second detail colour.`,
    character.props.length ? `Holding or carrying: ${character.props.map((prop) => prop.trim()).join(", ")}.` : "",
    `Pose: ${character.pose}. Expression: ${character.expression}.`
  ].filter(Boolean).join(" ");
  return [CHARACTER_STANDARD,
    `Group tint for the circle: ${type.group.tint}.`,
    `Outfit: ${character.outfit.trim()}, main colour ${outfitColour}, accent ${accent}.`,
    character.props.length ? `Holding or carrying: ${character.props.map((prop) => prop.trim()).join(", ")}.` : "",
    `Pose: ${character.pose}. Expression: ${character.expression}.`
  ].filter(Boolean).join(" ");
}
