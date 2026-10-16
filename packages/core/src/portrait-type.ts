import { SCHWARTZ_VALUES, redactPortrait, type PortraitReport } from "./portrait";
export { CHARACTER_EXPRESSIONS, CHARACTER_POSES } from "./portrait-character";
import { tFor, type Locale } from "./i18n";

/**
 * Crossline's own personality typing (decided 2026-10-08, after the popular result pages of MBTI-style tests): four axes about how a
 * person runs several lines of work, each scored 0–100 by the portrait writer from evidence, read as a four-letter code into one of
 * sixteen fixed types in four groups. The names live here, not in the model's answer, so the same profile always lands on the same,
 * comparable, shareable type — the model only says where on each axis the person stands and why.
 */

export type TypeAxisId = "scope" | "basis" | "output" | "rhythm";
/** Each letter is the initial of an English word (`en`), so the code reads as words: GEMA = Generalist, Evidence, Making, Adapting. */
export const TYPE_AXES: Array<{ id: TypeAxisId; left: { letter: string; label: string; en: string }; right: { letter: string; label: string; en: string }; question: string }> = [
  { id: "scope", left: { letter: "S", label: "深耕", en: "Specialist" }, right: { letter: "G", label: "跨界", en: "Generalist" }, question: "注意力集中在一条线做深，还是在几条线之间连起来" },
  { id: "basis", left: { letter: "E", label: "实证", en: "Evidence" }, right: { letter: "I", label: "直觉", en: "Intuition" }, question: "做判断靠数据与证据，还是靠感觉与远景" },
  { id: "output", left: { letter: "M", label: "造物", en: "Making" }, right: { letter: "R", label: "传播", en: "Reaching" }, question: "成就感来自做出东西，还是来自影响他人" },
  { id: "rhythm", left: { letter: "P", label: "规划", en: "Planning" }, right: { letter: "A", label: "应变", en: "Adapting" }, question: "按计划推进，还是边做边调整" }
];

/**
 * The four groups (first two letters), each one muted Morandi hue (decided 2026-10-14: not the purple/green/blue/yellow of the popular
 * MBTI test): `tone` is the figure's outfit colour, `tint` the card's and the figure's backdrop, `colour` the same hue deep enough for
 * text (at least 7:1 on the poster's paper, checked in portrait-type.test.ts) — sage for 工匠组, dusty rose for 求索组, haze blue for
 * 架构组, clay for 开拓组.
 */
export const TYPE_GROUPS: Record<string, { name: string; colour: string; tone: string; tint: string; blurb: string }> = {
  SE: { name: "工匠组", colour: "#3D4A35", tone: "#8C9A7E", tint: "#E2E6DA", blurb: "在一处做深，用证据说话" },
  SI: { name: "求索组", colour: "#66404A", tone: "#A88C93", tint: "#EBDEE0", blurb: "在一处做深，跟随内在的问题" },
  GE: { name: "架构组", colour: "#34495A", tone: "#8497A6", tint: "#DCE3E9", blurb: "连接多条线，用证据搭结构" },
  GI: { name: "开拓组", colour: "#623E29", tone: "#B48C72", tint: "#EFE2D7", blurb: "连接多条线，凭远景开新路" }
};

/**
 * Sixteen types (renamed 2026-10-14 so no two share a word): one role noun each, kept within the group's image, and the two of a pair that
 * differ only in rhythm read as opposites (钟表匠 ↔ 试验家). `blurb` is the fallback one-liner for a report written before the writer gave
 * a personal `summary`.
 */
export const TYPE_TABLE: Record<string, { name: string; blurb: string }> = {
  SEMP: { name: "钟表匠", blurb: "守着一个领域，按证据和计划把东西做到经得起检验" },
  SEMA: { name: "试验家", blurb: "守着一个领域边做边试，让结果替自己说话" },
  SERP: { name: "讲师", blurb: "守着一个领域，按体系把证据讲清楚、讲成课" },
  SERA: { name: "顾问", blurb: "守着一个领域随问随答，拿证据回应每个问题" },
  SIMP: { name: "雕刻家", blurb: "循着心里的问题，在一个领域长期打磨一件作品" },
  SIMA: { name: "即兴艺人", blurb: "在一个领域里凭灵感随手做出新东西" },
  SIRP: { name: "布道者", blurb: "守着一个信念，系统地把它讲给更多人" },
  SIRA: { name: "吟游诗人", blurb: "在一个领域边走边追问，随时把所得分享出去" },
  GEMP: { name: "架构师", blurb: "连起多条线，按证据和计划组成一个系统" },
  GEMA: { name: "改装师", blurb: "连起多条线，拿现成的东西快速拼成能用的产品" },
  GERP: { name: "参谋长", blurb: "连起多条线，梳理证据，提出并推行方案" },
  GERA: { name: "联络官", blurb: "连起多条线，随时用证据在不同圈子之间牵线" },
  GIMP: { name: "创始人", blurb: "连起多条线，凭远景按计划汇成一项事业" },
  GIMA: { name: "发明家", blurb: "在多个领域间跳跃，不断造出新东西" },
  GIRP: { name: "旗手", blurb: "描绘一个跨领域的愿景，按计划带动他人" },
  GIRA: { name: "探险家", blurb: "在多个领域开路，把所见随时带给别人" }
};

/**
 * What stops the writer's personal type summary from being shown: it must speak to the person (「你…」), and it must not name a type or a
 * code — the page ends it with 「你是 GEMA 改装师。」 itself, from the scores, so the two can never disagree.
 */
// The problems are repair messages to the portrait writer, not interface text. An English report speaks to "you" and is held to the
// English type names as well.
/* i18n-ignore-start */
export function typeSummaryProblem(summary: string): string | null {
  const text = summary.trim();
  if (!text) return null;
  if (!text.startsWith("你") && !/^you\b/i.test(text)) return "type.summary 须以「你」开头，直接对本人说";
  const en = tFor("en");
  const named = Object.entries(TYPE_TABLE).flatMap(([code, type]) => [code, type.name]).find((word) => text.includes(word))
    ?? Object.values(TYPE_TABLE).map((type) => en(type.name)).find((word) => word !== "" && new RegExp(`\\b${word}\\b`, "i").test(text) && /[A-Za-z]/.test(word))
    ?? (/人格|MBTI|[EI][NS][TF][JP]|personality type/i.test(text) ? "外部人格类型" : undefined);
  return named ? `type.summary 不要写类型名或代码（含「${named}」）；结尾的「你是 …」由页面补上` : null;
}
/* i18n-ignore-end */

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
export function typeFromScores(scores: Record<TypeAxisId, number>, evidence: Partial<Record<TypeAxisId, string>> = {}, locale?: Locale): PortraitType {
  const t = tFor(locale);
  const axes = TYPE_AXES.map((axis) => {
    const score = Math.max(0, Math.min(100, Math.round(scores[axis.id])));
    const right = score >= 50;
    const side = right ? axis.right : axis.left;
    return { id: axis.id, left: t(axis.left.label), right: t(axis.right.label), leftEn: axis.left.en, rightEn: axis.right.en, score, letter: side.letter, label: t(side.label),
      percent: right ? score : 100 - score, evidence: evidence[axis.id] ?? "" };
  });
  const code = axes.map((axis) => axis.letter).join("");
  const groupKey = code.slice(0, 2);
  const type = TYPE_TABLE[code]!, group = TYPE_GROUPS[groupKey]!;
  return { code, name: t(type.name), blurb: t(type.blurb), summary: "",
    group: { key: groupKey, ...group, name: t(group.name), blurb: t(group.blurb) }, axes };
}

/** The person's type from the writer's axis scores, with the writer's summary; none for a report written before the axes existed. */
export function portraitType(report: PortraitReport, locale?: Locale): PortraitType | null {
  return report.type ? { ...typeFromScores(report.type, report.type.evidence, locale), summary: (report.type.summary ?? "").trim() } : null;
}

export type PortraitLabelCell = { title: string; value: string; detail?: string };
export type PortraitIdentity = { lineId: string; label: string; target: number; now: number | null };

/**
 * The poster's labels (decided 2026-10-12), each computed or taken from a fixed field so two people's posters compare: the core word
 * the writer gave, the top-scoring Schwartz value (ties go to the earlier one in the circle), the line with the largest suggested share
 * as the base, and every other line as an identity row — suggested share as a bar, current share as a marker. A cell whose source is
 * missing (an older report) is left out.
 */
export function portraitLabels(report: PortraitReport, options: { lineLabel: (id: string) => string; locale?: Locale | undefined }): { cells: PortraitLabelCell[]; identities: PortraitIdentity[] } {
  const t = tFor(options.locale);
  const cells: PortraitLabelCell[] = [];
  const coreWord = report.cover.coreWord?.trim();
  if (coreWord) cells.push({ title: t("核心词"), value: coreWord });
  const values = report.compass.values ?? [];
  const names = SCHWARTZ_VALUES.map((value) => value.name as string);
  if (values.length === names.length && names.every((name) => values.some((value) => value.name === name))) {
    const top = names.map((name) => values.find((value) => value.name === name)!).reduce((best, value) => (value.score > best.score ? value : best));
    cells.push({ title: t("价值核心"), value: t(top.name) });
  }
  const ranked = [...report.lines.items].sort((a, b) => (b.targetShare ?? 0) - (a.targetShare ?? 0));
  const base = ranked[0];
  if (base?.targetShare) cells.push({ title: t("建议底座"), value: options.lineLabel(base.lineId), detail: t("建议投入约 {{share}}%", { share: base.targetShare }) });
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

const LINE_COLOUR_NAME: Record<string, string> = { research: "deep blue (#0A5198)", startup: "burnt orange (#8C3709)", media: "plum (#792E9C)", investment: "forest green (#085E3A)", health: "ochre (#664E00)" };

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
