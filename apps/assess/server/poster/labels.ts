import { QUIZ_ITEMS, TYPE_AXES, TYPE_GROUPS, TYPE_TABLE } from "@crossline/core/assess";
import { AI_KEEPS, RELATIONS, TYPE_KINDRED, TYPE_LINES, TYPE_SUBTITLE } from "@crossline/core/assess-content";
import { tFor, type Locale } from "../../lib/i18n";
import { kindredView } from "../../lib/public-type";
import { GROUP_QR_CAPTION } from "./group-qr";

/**
 * Every fixed string the posters print, and the text the font subsets must cover (`posterFixedText`). Pure, so the font script
 * (`scripts/assess-poster-fonts.ts`) and the coverage test read the same list the renderer prints from.
 */
export const LABELS = {
  kicker: "超级个体类型",
  pairKicker: "双人关系卡",
  rankTail: "（理论估算）",
  linesHeading: "你也许想做",
  moreHeading: "也可以这样组合",
  loopHeading: "它们如何互相供养",
  loopCaption: "在 Crossline 里把这几条线真的跑起来",
  loopExplain: "每一步的产出是下一步的输入，最后一步又回到第一步。",
  best: "最佳搭子",
  hardest: "最难搭子",
  aiHeading: "你和 AI 的分工",
  aiDoes: "AI 替你干的",
  aiDoesNone: "还没有，你什么都想自己来",
  aiKeeps: "你不让 AI 碰的",
  kindred: "思想相近的名人",
  kindredHeading: "思想相近的名人",
  groupScan: "进 Crossline 群",
  axesHeading: "四个维度",
  partnersHeading: "和谁一起做事",
  scan: "扫码测测我们是什么关系",
  scanSub: "朋友做完，你们的双人卡当场生成",
  scanShort: "测测我们的关系",
  scanSubShort: "朋友扫码答完，生成双人卡",
  disclaimer: "基于自评的趣味测评，非心理诊断",
  brand: "Crossline",
  also: "也是",
  shared: "共同的主线",
  noShared: "没有共同主线，正好互补",
  friendA: "你的朋友",
  friendB: "新朋友",
  ambiguous: "浅色字母表示两可",
  sources: "依据：",
  replacement: "·"
} as const;

export type PosterLabels = { -readonly [K in keyof typeof LABELS]: string };

/**
 * The labels in the reader's language. Chinese is `LABELS` itself; the English is plain ASCII (straight quotes, no dashes or ellipses),
 * which both poster faces carry, so nothing English prints as 「·」.
 */
export function posterLabels(locale?: Locale): PosterLabels {
  if (locale !== "en") return LABELS;
  const t = tFor(locale);
  return Object.fromEntries(Object.entries(LABELS).map(([key, value]) => [key, key === "replacement" || key === "brand" ? value : t(value)])) as PosterLabels;
}

/** 「多星倾向约超过 93% 的人（理论估算）」, "Leans Galaxy more than about 93% of people (estimate)". `rank.pole` is already translated. */
export const rankLine = (rank: { pole: string; percent: number; estimated: boolean }, locale?: Locale): string =>
  tFor(locale)("{{pole}}倾向约超过 {{percent}}% 的人", { pole: rank.pole, percent: rank.percent }) + (rank.estimated ? posterLabels(locale).rankTail : "");

/** Every English string a poster can print outside a nickname and a model's words, for the glyph test. */
export function posterEnglishText(): string[] {
  const t = tFor("en");
  return [
    ...Object.values(posterLabels("en")),
    ...Object.values(TYPE_TABLE).flatMap((type) => [t(type.name), t("「{{quote}}」", { quote: t(type.quote) })]),
    ...Object.values(TYPE_GROUPS).flatMap((group) => [t(group.name), t(group.blurb)]),
    ...TYPE_AXES.flatMap((axis) => [t(axis.name), t(axis.sources), ...[axis.left, axis.right].flatMap((pole) => [t(pole.label), pole.en, t(pole.definition)]),
      t("{{pole}}倾向约超过 {{percent}}% 的人", { pole: t(axis.left.label), percent: 95 })]),
    ...Object.values(AI_KEEPS).map((text) => t(text)), ...QUIZ_ITEMS.flatMap((item) => (item.ai ? [t(item.ai.does)] : [])),
    ...Object.values(TYPE_KINDRED).flatMap((kindred) => {
      const view = kindredView(kindred, "en");
      return [view.name, view.years, view.field, view.why, view.quote.original, view.quote.translation ?? "", `- ${view.quote.source}`];
    }),
    ...Object.values(TYPE_LINES).flatMap((lines) => [...lines.lines, ...lines.more.flat()].flatMap((line) => [t(line.identity), t(line.domain)]).concat(lines.loop.map((step) => t(step)))),
    ...Object.values(RELATIONS).flatMap((relation) => [t(relation.name), t(relation.when), ...relation.tips.map((tip) => t(tip))]),
    t("{{name}}的超级个体类型", { name: "A" }), t("{{also}}：", { also: t(LABELS.also) }), t("（{{when}}）", { when: "A" }), t(GROUP_QR_CAPTION)
  ];
}

const ASCII = Array.from({ length: 95 }, (_, index) => String.fromCharCode(32 + index)).join("");

/** Every character a poster can print outside a nickname: fixed copy, the type tables, relations, digits and ASCII. */
export function posterFixedText(): string {
  const parts: string[] = [ASCII, ...Object.values(LABELS), "%", "→", "；", "「」", "——", "àéèêç", GROUP_QR_CAPTION];
  parts.push(...Object.values(AI_KEEPS), ...QUIZ_ITEMS.flatMap((item) => (item.ai ? [item.ai.does] : [])));
  for (const kindred of Object.values(TYPE_KINDRED)) parts.push(kindred.name, kindred.years, kindred.field, kindred.why, kindred.quote.original, kindred.quote.translation ?? "", kindred.quote.source);
  for (const [code, type] of Object.entries(TYPE_TABLE)) parts.push(code, type.name);
  for (const group of Object.values(TYPE_GROUPS)) parts.push(group.name, group.blurb);
  // i18n-ignore-start: characters for the font subset, not interface text
  for (const axis of TYPE_AXES) parts.push(axis.name, axis.left.letter, axis.left.label, axis.left.en, axis.left.definition, axis.right.letter, axis.right.label, axis.right.en,
    axis.right.definition, axis.question, axis.sources, `${axis.left.label}倾向约超过 ${axis.right.label}倾向约超过`);
  parts.push(...Object.values(TYPE_SUBTITLE));
  for (const lines of Object.values(TYPE_LINES)) {
    for (const line of [...lines.lines, ...lines.more.flat()]) parts.push(line.identity, `${line.domain}的`);
    parts.push(...lines.loop);
  }
  // i18n-ignore-end
  for (const relation of Object.values(RELATIONS)) parts.push(relation.name, relation.when, ...relation.tips);
  return [...new Set(parts.join(""))].sort().join("");
}
