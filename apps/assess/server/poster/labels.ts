import { TYPE_AXES, TYPE_GROUPS, TYPE_TABLE } from "@crossline/core/assess";
import { RELATIONS, TYPE_LINES, TYPE_SUBTITLE } from "@crossline/core/assess-content";

/**
 * Every fixed string the posters print, and the text the font subsets must cover (`posterFixedText`). Pure, so the font script
 * (`scripts/assess-poster-fonts.ts`) and the coverage test read the same list the renderer prints from.
 */
export const LABELS = {
  kicker: "思维模式类型",
  pairKicker: "双人关系卡",
  rankTail: "（理论估算）",
  linesHeading: "你也许想做",
  moreHeading: "也可以这样组合",
  loopHeading: "它们如何互相供养",
  loopCaption: "在 Crossline 里把这几条线真的跑起来",
  loopExplain: "每一步的产出是下一步的输入，最后一步又回到第一步。",
  best: "最佳搭子",
  hardest: "一起做事容易吵",
  axesHeading: "四条轴",
  partnersHeading: "和谁一起做事",
  scan: "扫码测测我们是什么关系",
  scanSub: "朋友做完，你们的双人卡当场生成",
  disclaimer: "基于自评的趣味测评，非心理诊断",
  brand: "Crossline",
  also: "也是",
  shared: "共同的主线",
  noShared: "没有共同主线，正好互补",
  friendA: "你的朋友",
  friendB: "新朋友",
  ambiguous: "浅色字母表示两可",
  replacement: "·"
} as const;

/** 「跨界倾向约超过 93% 的人（理论估算）」 */
export const rankLine = (rank: { pole: string; percent: number; estimated: boolean }): string =>
  `${rank.pole}倾向约超过 ${rank.percent}% 的人${rank.estimated ? LABELS.rankTail : ""}`;

/** Each pole explained, read off the axis's own question (「A，还是 B」), so the long image adds no copy of its own. */
export function poleExplanations(question: string): [string, string] {
  const [left, right] = question.split("，还是");
  return [left!.trim(), (right ?? "").trim()];
}

const ASCII = Array.from({ length: 95 }, (_, index) => String.fromCharCode(32 + index)).join("");

/** Every character a poster can print outside a nickname: fixed copy, the type tables, relations, digits and ASCII. */
export function posterFixedText(): string {
  const parts: string[] = [ASCII, ...Object.values(LABELS), "%", "→"];
  for (const [code, type] of Object.entries(TYPE_TABLE)) parts.push(code, type.name);
  for (const group of Object.values(TYPE_GROUPS)) parts.push(group.name, group.blurb);
  for (const axis of TYPE_AXES) parts.push(axis.left.letter, axis.left.label, axis.left.en, axis.right.letter, axis.right.label, axis.right.en, axis.question, `${axis.left.label}倾向约超过 ${axis.right.label}倾向约超过`);
  parts.push(...Object.values(TYPE_SUBTITLE));
  for (const lines of Object.values(TYPE_LINES)) {
    for (const line of [...lines.lines, ...lines.more.flat()]) parts.push(line.identity, `${line.domain}的`);
    parts.push(...lines.loop);
  }
  for (const relation of Object.values(RELATIONS)) parts.push(relation.name, relation.when, ...relation.tips);
  return [...new Set(parts.join(""))].sort().join("");
}
