import { SCHWARTZ_VALUES, redactPortrait, type PortraitReport } from "./portrait";
export { CHARACTER_EXPRESSIONS, CHARACTER_POSES } from "./portrait-character";
import { tFor, type Locale } from "./i18n";

/**
 * Crossline's own typing (redesigned 2026-10-24 with the owner): what kind of super individual a person is in the AI era — four
 * dimensions of how they work with AI and how many lines they run, each taken from a body of research and scored 0–100 (0 = left pole,
 * 100 = right pole) — by the quick test from situational answers, by the portrait writer from evidence — read as a four-letter code into
 * one of sixteen fixed types in four groups. The names live here, not in the model's answer, so the same profile always lands on the same,
 * comparable, shareable type. The letters are coordinates only: no page or poster shows them beside a type's name.
 *
 * It replaced the 2026-10-17 typing (主线集中度 / 探索–利用 / 角色边界 / 投入节律, codes like DXBV), which was almost all about running
 * several lines and said nothing about AI (the owner, 2026-10-24: 「过重地谈论跨人生主线并行，忽略了 AI 时代和超级个体」).
 */

export type TypeAxisId = "collab" | "purpose" | "build" | "lines";
/** Each letter is the initial of an English word (`en`); the eight letters are all different and none is one of MBTI's. */
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
  { id: "collab", name: "协作形态", question: "把活切开分段交给 AI，还是从头到尾和 AI 交织着做",
    left: { letter: "R", label: "接力", en: "Relay", definition: "先自己拆好任务，把其中几段交给 AI，再把结果接回来" },
    right: { letter: "W", label: "共生", en: "Weave", definition: "从第一步起就和 AI 一来一回，边做边改，人和 AI 的部分分不开" },
    sources: "Dell'Acqua, Mollick 等 2023（HBS 24-013，半人马与赛博格）" },
  { id: "purpose", name: "用 AI 图什么", question: "用 AI 是为了拿到结果，还是为了让自己变强",
    left: { letter: "O", label: "交付", en: "Output", definition: "要的是能交出去的结果，过程交给 AI 越多越好" },
    right: { letter: "U", label: "精进", en: "Upskill", definition: "借 AI 学会、看懂、练熟，下次自己也能做" },
    sources: "Anthropic Economic Index 2025（自动化与增强）；Lee 等 2025（CHI，知识工作者的批判性思考）" },
  { id: "build", name: "构建方式", question: "先把蓝图想清楚再动手，还是先上手拼出来再改",
    left: { letter: "B", label: "蓝图", en: "Blueprint", definition: "先定目标、结构和步骤，再按计划推进" },
    right: { letter: "H", label: "拼装", en: "Hack", definition: "先用手边的东西拼出一版，边试边改，在改的过程里想清楚" },
    sources: "Turkle & Papert 1990（规划者与拼装者）" },
  { id: "lines", name: "人生主线", question: "时间和身份集中在一条主线，还是分给几条线",
    left: { letter: "A", label: "单核", en: "Anchor", definition: "一条主线占主导，AI 省下的时间也投回它" },
    right: { letter: "G", label: "多星", en: "Galaxy", definition: "同时经营几条分量相近的线，AI 让每条线都能转起来" },
    sources: "Sieber 1974 角色累积；Ramarajan 2014 多重身份；Teodoridis, Bikard & Vakili 2019 通才与专才" }
];

/**
 * The four groups (first two letters: collab × purpose), each one muted Morandi hue (kept from 2026-10-14): `tone` is the figure's outfit
 * colour, `tint` the card's and the figure's backdrop, `colour` the same hue deep enough for text (at least 7:1 on the poster's paper,
 * checked in portrait-type.test.ts) — haze blue for 甲方派, sage for 蒸馏派, clay for 机甲派, dusty rose for 共修派.
 */
export const TYPE_GROUPS: Record<string, { name: string; colour: string; tone: string; tint: string; blurb: string }> = {
  RO: { name: "甲方派", colour: "#34495A", tone: "#8497A6", tint: "#DCE3E9", blurb: "把活拆开派给 AI，自己验收结果" },
  RU: { name: "蒸馏派", colour: "#3D4A35", tone: "#8C9A7E", tint: "#E2E6DA", blurb: "让 AI 当师傅，学会了自己上" },
  WO: { name: "机甲派", colour: "#623E29", tone: "#B48C72", tint: "#EFE2D7", blurb: "和 AI 合体干活，只看产出" },
  WU: { name: "共修派", colour: "#66404A", tone: "#A88C93", tint: "#EBDEE0", blurb: "和 AI 一起变强" }
};

/**
 * Sixteen types (named by the owner, 2026-10-24). `quote` is the type's line on the poster and the result page, the owner's own; `blurb`
 * describes the four positions in plain words and is the fallback one-liner for a report written before the writer gave a `summary`.
 */
export const TYPE_TABLE: Record<string, { name: string; quote: string; blurb: string }> = {
  ROBA: { name: "甲方", quote: "我还是觉得第 1 版比较好看", blurb: "先想清楚要什么，把一件事拆好交给 AI，自己把关验收" },
  ROBG: { name: "塔台", quote: "MU11451，你怎么四百多节降落", blurb: "几条线排好次序，同时派活给 AI，自己盯全局" },
  ROHA: { name: "甩手掌柜", quote: "你应该是这方面的专家，反正比我专家", blurb: "先把事丢给 AI 跑出一版，能用就交，专心一条主线" },
  ROHG: { name: "时间管理大师", quote: "做完你的做你的，做完你的做你的", blurb: "好几件事一起丢给 AI，边跑边看，哪条线都不落下" },
  RUBA: { name: "大学生", quote: "豆包再胡说我给你豆馅掏出来。", blurb: "按计划跟着 AI 学一门，学透为止" },
  RUBG: { name: "六边形战士", quote: "快用你那无敌的 Claude 想想办法啊！", blurb: "每条线都有学习计划，借 AI 样样补齐" },
  RUHA: { name: "拆弹专家", quote: "我不敢剪大肥鱼说的那条线", blurb: "AI 给的东西先拆开弄懂，再自己上手" },
  RUHG: { name: "野生学者", quote: "没有学位，但有 200 个收藏夹", blurb: "什么都想学，跟着 AI 到处试" },
  WOBA: { name: "铁驭", quote: "铁驭，准备战斗", blurb: "定好目标后和 AI 合体推进一条主线，人机配合只为产出" },
  WOBG: { name: "舰长", quote: "右满舵，主炮预备！", blurb: "按航线指挥一整船 AI，几条线同时开火" },
  WOHA: { name: "某神秘光头", quote: "我不明白。机枪手向右 20cm。", blurb: "边打边调，和 AI 一起把一条主线磨出结果" },
  WOHG: { name: "数字游民", quote: "Wi-Fi 在哪，工位就在哪", blurb: "带着 AI 四处开工，几条线随走随做" },
  WUBA: { name: "修行者", quote: "闭关七七四十九天，出关即满级", blurb: "定好修炼计划，和 AI 对练，在一条主线上越练越强" },
  WUBG: { name: "军师", quote: "主公莫慌，AI 已推演三遍", blurb: "和 AI 一起推演每条线的打法，样样心里有数" },
  WUHA: { name: "炼金术士", quote: "炸炉是必要的等价交换", blurb: "和 AI 一炉一炉试，炸了再来，在一条主线上越试越懂" },
  WUHG: { name: "百晓生", quote: "江湖上的事，问我就对了", blurb: "和 AI 聊遍各个领域，什么都懂一点，什么都想试" }
};

/**
 * What stops the writer's personal type summary from being shown: it must speak to the person (「你…」), and it must not name a type or a
 * code — the page ends it with 「你是某神秘光头。」 itself, from the scores, so the two can never disagree.
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
  code: string; name: string; quote: string; blurb: string;
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
  return { code, name: t(type.name), quote: t(type.quote), blurb: t(type.blurb), summary: "",
    group: { key: groupKey, ...group, name: t(group.name), blurb: t(group.blurb) }, axes };
}

/** The person's type from the writer's axis scores, with the writer's summary; none for a report written before the axes existed. */
export function portraitType(report: PortraitReport, locale?: Locale): PortraitType | null {
  // A report written on the first version's axes (scope/basis/output/rhythm) has no type until it is rewritten (schema 4).
  if (!report.type || !TYPE_AXES.every((axis) => typeof report.type![axis.id] === "number")) return null;
  return { ...typeFromScores(report.type, report.type.evidence, locale), summary: (report.type.summary ?? "").trim() };
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
