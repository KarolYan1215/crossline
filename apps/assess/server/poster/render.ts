import type { ReactNode } from "react";
import satori, { type SatoriNode } from "satori";
import { Resvg } from "@resvg/resvg-js";
import { TYPE_AXES, TYPE_GROUPS } from "@crossline/core/assess";
import { RELATIONS, latinGap } from "@crossline/core/assess-content";
import type { PartnerView, PublicAxis, PublicType, RelationView } from "../../lib/contract";
import { faceFor, posterFonts, safe, type Family } from "./fonts";
import { LABELS, rankLine } from "./labels";
import { withName } from "../../lib/names";
import { qrDataUri } from "./qr";
import { groupQr } from "./group-qr";

/**
 * The three posters as satori trees, style A 「编辑杂志」 (CLAUDE.md, the portrait paragraph): paper #F6F2EA, ink #1E1B16, grey #4F4A42
 * (7.9:1 on the paper), ink rules between sections, the type group's colour for the type itself and its tint behind the figure. Every
 * size is set for a 1080-wide canvas and no text is under 24 px. Plain `{ type, props }` objects rather than JSX: satori reads them
 * the same, and the module then needs no JSX runtime under tsx, vitest or Next.
 */

export const WIDTH = 1080;
export const HEIGHT = 1440;
const PAPER = "#F6F2EA";
const INK = "#1E1B16";
const GREY = "#4F4A42";
const TRACK = "#DDD5C7";
const PAD = 64;
const INNER = WIDTH - PAD * 2;

type Style = Record<string, string | number>;
type Child = El | string | null | undefined | false;
type El = { type: string; props: Record<string, unknown> };

function h(type: string, props: Record<string, unknown> | null, ...children: Child[]): El {
  const kept = children.filter((child): child is El | string => child !== null && child !== undefined && child !== false);
  return { type, props: { ...props, children: kept.length === 1 ? kept[0] : kept } };
}
const box = (style: Style, ...children: Child[]) => h("div", { style: { display: "flex", ...style } }, ...children);
/** Text in one family; `safe` swaps anything the face cannot print for 「·」. */
const text = (value: string, family: Family, style: Style) => h("div", { style: { display: "flex", fontFamily: family, ...style } }, safe(value, family));
const rule = (margin = 26) => box({ height: 2, backgroundColor: INK, marginTop: margin, marginBottom: margin, width: "100%" });

/** The figure as a data URI (`figure.ts`), or none: the panel then shows the type code. */
export type Figure = { dataUri: string | null };

/**
 * The person's drawn figure in a 2:3 panel of the group's tint; with no drawn figure (never the type's shared template, decided
 * 2026-10-16), the four letters as a 2×2 monogram in the group's colour, an ambiguous letter faint — an emblem rather than a stand-in
 * person.
 */
function panel(figure: Figure, type: PublicType, width: number): El {
  const height = Math.round(width * 1.5);
  const size = Math.round(width * 0.3);
  const letter = (axis: PublicAxis) => box({ width: size * 1.1, justifyContent: "center" },
    text(axis.letter, "Serif", { fontSize: size, fontWeight: 700, color: type.group.colour, opacity: axis.ambiguous ? 0.38 : 1, lineHeight: 1.1 }));
  return box({ width, height, borderRadius: 24, backgroundColor: type.group.tint, overflow: "hidden", alignItems: "center", justifyContent: "center", flexShrink: 0 },
    figure.dataUri
      ? h("img", { src: figure.dataUri, width, height, style: { width, height, objectFit: "contain" } })
      : box({ flexDirection: "column", alignItems: "center" },
        box({}, letter(type.axes[0]!), letter(type.axes[1]!)),
        box({}, letter(type.axes[2]!), letter(type.axes[3]!))));
}

/** The axis leaned to furthest (a clear lean before an ambiguous one): the poster's one 「约超过 X% 的人」. */
export function strongestAxis(type: PublicType): PublicAxis {
  return [...type.axes].sort((a, b) => Number(a.ambiguous) - Number(b.ambiguous) || Math.abs(b.score - 50) - Math.abs(a.score - 50))[0]!;
}

function hero(type: PublicType, nickname: string, figure: Figure, compact: boolean): El {
  const owner = nickname.trim() ? `${withName(nickname.trim(), "的")}${LABELS.kicker}` : LABELS.kicker;
  const group = TYPE_GROUPS[type.group.key];
  return box({ width: "100%", alignItems: "center" },
    panel(figure, type, compact ? 250 : 280),
    box({ flexDirection: "column", marginLeft: 44, flexGrow: 1, flexShrink: 1, minWidth: 0 },
      text(owner, "Sans", { fontSize: 26, color: GREY, marginBottom: 10 }),
      text(type.name, "Serif", { fontSize: type.name.length > 4 ? (compact ? 72 : 84) : (compact ? 92 : 108), fontWeight: 700, color: INK, lineHeight: 1.15, marginTop: 4 }),
      text(group ? `${type.group.name} · ${group.blurb}` : type.group.name, "Sans", { fontSize: 24, color: type.group.colour, fontWeight: 700, marginTop: 6 }),
      text(`「${type.subtitle}」`, "Serif", { fontSize: compact ? 32 : 34, color: INK, lineHeight: 1.4, marginTop: 12, textWrap: "balance" }),
      compact ? box({ marginTop: 18, paddingTop: 12, borderTop: `2px solid ${type.group.colour}` },
        text(rankLine(strongestAxis(type).rank), "Sans", { fontSize: 26, fontWeight: 700, color: INK })) : null));
}

/** A bar that grows from the middle towards the pole leaned to, as on the portrait (`axisBar`). */
function axisBar(axis: PublicAxis, colour: string, height: number): El {
  const right = axis.score >= 50;
  const width = Math.abs(axis.score - 50);
  return box({ flexGrow: 1, height, backgroundColor: TRACK, borderRadius: height / 2, position: "relative", marginLeft: 16, marginRight: 16 },
    box({ position: "absolute", top: 0, height, left: `${right ? 50 : 50 - width}%`, width: `${Math.max(width, 0.8)}%`, backgroundColor: colour, opacity: axis.ambiguous ? 0.45 : 1,
      borderRadius: height / 2 }),
    box({ position: "absolute", top: -6, left: "50%", width: 2, height: height + 12, backgroundColor: INK }));
}

// Two-character pole names and the letter as a small coordinate (「接力 R 78%」), 2026-10-24.
const POLE_WIDTH = 196;

/** One pole: its letter and name, and — on the side leaned to — the percentage, next to the bar. */
function pole(label: string, letter: string, percent: number | null, align: "left" | "right"): El {
  const on = percent !== null;
  const style = { fontSize: 28, color: on ? INK : GREY, fontWeight: on ? 700 : 400 };
  const coordinate = text(letter, "Sans", { fontSize: 24, color: GREY, [align === "left" ? "marginLeft" : "marginRight"]: 6 });
  const name = box({ alignItems: "baseline" }, ...(align === "left" ? [text(label, "Serif", style), coordinate] : [coordinate, text(label, "Serif", style)]));
  const value = on ? text(`${percent}%`, "Sans", { fontSize: 28, fontWeight: 700, color: INK, [align === "left" ? "marginLeft" : "marginRight"]: 12 }) : null;
  return box({ width: POLE_WIDTH, flexShrink: 0, justifyContent: align === "left" ? "flex-start" : "flex-end", alignItems: "baseline" },
    ...(align === "left" ? [name, value] : [value, name]));
}

/** One axis; the long image adds the rank under each bar, the poster prints only the strongest one, in the hero. */
function axisRow(axis: PublicAxis, colour: string, withRank = true): El {
  const right = axis.score >= 50;
  const percent = right ? axis.score : 100 - axis.score;
  return box({ flexDirection: "column", width: "100%" },
    box({ alignItems: "center", width: "100%" },
      pole(axis.leftLabel, axis.leftLetter, right ? null : percent, "left"),
      axisBar(axis, colour, 16),
      pole(axis.rightLabel, axis.rightLetter, right ? percent : null, "right")),
    withRank ? text(rankLine(axis.rank), "Sans",
      { fontSize: 24, color: GREY, lineHeight: 1.25, marginTop: 2, marginLeft: POLE_WIDTH + 16 }) : null);
}

/** The four steps as a cycle: across the top, down, back along the bottom, up — the last step feeding the first. */
function loopCycle(loop: PublicType["loop"], colour: string, tint: string): El {
  // 256 wide holds a ten-character step at 24 px on one line (the content test caps steps at ten).
  const boxW = 256, boxH = 58, gapX = 44, gapY = 40, width = boxW * 2 + gapX, height = boxH * 2 + gapY;
  const at = [[0, 0], [boxW + gapX, 0], [boxW + gapX, boxH + gapY], [0, boxH + gapY]] as const;
  const step = (label: string, index: number) => box({ position: "absolute", left: at[index]![0], top: at[index]![1], width: boxW, height: boxH, alignItems: "center", justifyContent: "center",
    border: `2px solid ${colour}`, borderRadius: 10, backgroundColor: index === 0 ? tint : PAPER },
  text(label, "Sans", { fontSize: 24, color: INK }));
  const midY = boxH / 2, midX = boxW / 2, rightX = boxW + gapX + boxW / 2;
  const arrow = (x1: number, y1: number, x2: number, y2: number) => {
    const angle = Math.atan2(y2 - y1, x2 - x1), head = 12;
    const p1 = [x2 - head * Math.cos(angle - 0.5), y2 - head * Math.sin(angle - 0.5)];
    const p2 = [x2 - head * Math.cos(angle + 0.5), y2 - head * Math.sin(angle + 0.5)];
    return `M${x1} ${y1}L${x2} ${y2}M${p1[0]} ${p1[1]}L${x2} ${y2}L${p2[0]} ${p2[1]}`;
  };
  const d = [arrow(boxW + 8, midY, boxW + gapX - 8, midY), arrow(rightX, boxH + 6, rightX, boxH + gapY - 6),
    arrow(boxW + gapX - 8, boxH + gapY + midY, boxW + 8, boxH + gapY + midY), arrow(midX, boxH + gapY - 6, midX, boxH + 6)].join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><path d="${d}" fill="none" stroke="${colour}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return box({ position: "relative", width, height, flexShrink: 0 },
    h("img", { src: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`, width, height, style: { position: "absolute", left: 0, top: 0 } }),
    ...loop.map(step));
}

/** The three lines and the cycle they feed; the poster prints its heading above the lines and the call to run them on a row of its own. */
function linesBlock(type: PublicType, withLabels: boolean): El {
  const row = box({ width: "100%", alignItems: "center", justifyContent: "space-between" },
    box({ flexDirection: "column", flexShrink: 1, minWidth: 0 },
      withLabels ? text(LABELS.linesHeading, "Sans", { fontSize: 24, color: GREY, marginBottom: 8 }) : null,
      // The field small, the identity large: 「人工智能的 研究者」.
      ...type.lines.map((line, index) => box({ alignItems: "baseline", marginTop: index ? 4 : 0 },
        text(String(index + 1), "Serif", { fontSize: 26, fontWeight: 700, color: type.group.colour, width: 30 }),
        line.domain ? text(`${line.domain}的`, "Sans", { fontSize: 24, color: GREY, lineHeight: 1.3 }) : null,
        text(line.identity, faceFor(line.identity, "Serif"), { fontSize: 32, fontWeight: 700, color: INK, lineHeight: 1.3, marginLeft: line.domain && latinGap(line.identity) ? 8 : 0 })))),
    loopCycle(type.loop, type.group.colour, type.group.tint));
  return withLabels ? box({ flexDirection: "column", width: "100%" }, row, text(LABELS.loopCaption, "Sans", { fontSize: 24, color: GREY, marginTop: 12 })) : row;
}

/** One more combination on a row: fields small and grey, identities bold at `size`, joined by 「·」. */
function comboLine(combo: PublicType["lines"], size: number, marginTop: number): El {
  return box({ alignItems: "baseline", flexWrap: "wrap", marginTop },
    ...combo.flatMap((line, index) => [
      index ? text(" · ", "Sans", { fontSize: 24, color: GREY, marginLeft: 6, marginRight: 6 }) : null,
      line.domain ? text(`${line.domain}的`, "Sans", { fontSize: 24, color: GREY }) : null,
      text(line.identity, faceFor(line.identity, "Serif"), { fontSize: size, fontWeight: 700, color: INK, marginLeft: line.domain && latinGap(line.identity) ? 8 : 0 })
    ]));
}

function partner(label: string, view: PartnerView, colour: string, tips: string[], when?: string): El {
  return box({ flexDirection: "column", width: (INNER - 48) / 2 },
    text(label, "Sans", { fontSize: 24, color: GREY }),
    text(view.name, "Serif", { fontSize: 38, fontWeight: 700, color: INK, marginTop: 8 }),
    text(view.relation, "Sans", { fontSize: 28, fontWeight: 700, color: colour, marginTop: 6 }),
    when ? text(when, "Sans", { fontSize: 24, color: GREY, marginTop: 4 }) : null,
    ...tips.map((tip) => text(tip, "Sans", { fontSize: 24, color: INK, lineHeight: 1.45, marginTop: 6 })));
}

/** 「AI 替你干的」 from the person's answers and 「你不让 AI 碰的」, the type's own line. */
function aiBlock(type: PublicType): El {
  const row = (label: string, value: string, marginTop: number) => box({ alignItems: "baseline", marginTop, width: "100%" },
    text(label, "Sans", { fontSize: 26, fontWeight: 700, color: type.group.colour, width: 210, flexShrink: 0 }),
    text(value, "Serif", { fontSize: 32, fontWeight: 700, color: INK, lineHeight: 1.35, flexShrink: 1 }));
  return box({ flexDirection: "column", width: "100%" },
    row(LABELS.aiDoes, type.aiDoes.length ? type.aiDoes.join(" · ") : LABELS.aiDoesNone, 0),
    row(LABELS.aiKeeps, type.aiKeeps, 10));
}

/** The person whose way of working is close to the type: name, years and field, then the line in the original (slanted) and ours. */
function kindredBlock(type: PublicType, withWhy: boolean): El {
  const { kindred } = type;
  const latin = !/[\u4e00-\u9fff]/.test(kindred.quote.original);
  return box({ flexDirection: "column", width: "100%" },
    box({ alignItems: "baseline", flexWrap: "wrap" },
      text(LABELS.kindred, "Sans", { fontSize: 24, color: GREY, marginRight: 16 }),
      text(kindred.name, "Serif", { fontSize: 34, fontWeight: 700, color: INK, marginRight: 14 }),
      text(`${kindred.years} · ${kindred.field}`, "Sans", { fontSize: 24, color: GREY })),
    withWhy ? text(kindred.why, "Sans", { fontSize: 24, color: INK, marginTop: 6 }) : null,
    text(kindred.quote.original, latin ? "Sans" : "Serif", { fontSize: latin ? 24 : 28, color: INK, lineHeight: 1.35, marginTop: 8,
      borderLeft: `4px solid ${type.group.colour}`, paddingLeft: 16, ...(latin ? { transform: "skewX(-8deg)" } : { fontWeight: 700 }) }),
    kindred.quote.translation ? text(kindred.quote.translation, "Serif", { fontSize: 26, color: INK, lineHeight: 1.35, marginTop: 2, paddingLeft: 20 }) : null,
    text(`—— ${kindred.quote.source}`, "Sans", { fontSize: 24, color: GREY, marginTop: 2, paddingLeft: 20 }));
}

/** The WeChat group's code (`group-qr.ts`), modules only on the paper, its caption on the left; nothing when no file is set. */
function groupQrBlock(size: number): El | null {
  const qr = groupQr();
  if (!qr) return null;
  return box({ alignItems: "center", justifyContent: "flex-end", width: (INNER - 32) / 2 },
    box({ flexDirection: "column", alignItems: "flex-end", marginRight: 18, flexShrink: 1 },
      text(LABELS.groupScan, "Serif", { fontSize: 28, fontWeight: 700, color: INK }),
      text(qr.caption, "Sans", { fontSize: 24, color: GREY, marginTop: 6, textAlign: "right" })),
    h("img", { src: qr.dataUri, width: size, height: size, style: { flexShrink: 0 } }));
}

function qrBlock(inviteUrl: string, size: number, half = false): El {
  const qr = qrDataUri(inviteUrl, INK);
  return box({ alignItems: "center", ...(half ? { width: (INNER - 32) / 2 } : {}) },
    box({ width: size + 16, height: size + 16, backgroundColor: "#FFFFFF", alignItems: "center", justifyContent: "center", flexShrink: 0 },
      h("img", { src: qr.uri, width: size, height: size })),
    box({ flexDirection: "column", marginLeft: half ? 18 : 26, flexShrink: 1 },
      text(half ? LABELS.scanShort : LABELS.scan, "Serif", { fontSize: half ? 28 : 32, fontWeight: 700, color: INK }),
      text(half ? LABELS.scanSubShort : LABELS.scanSub, "Sans", { fontSize: 24, color: GREY, marginTop: half ? 6 : 8 })));
}

/** The Crossline mark: two lines crossing, then the name. */
function brand(): El {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 30 30"><path d="M3 5C12 5 18 25 27 25M3 25C12 25 18 5 27 5" fill="none" stroke="${INK}" stroke-width="3.2" stroke-linecap="round"/></svg>`;
  return box({ alignItems: "center" },
    h("img", { src: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`, width: 30, height: 30 }),
    text(LABELS.brand, "Sans", { fontSize: 26, fontWeight: 700, color: INK, marginLeft: 10 }));
}

function footer(): El {
  return box({ width: "100%", justifyContent: "space-between", alignItems: "center" },
    text(LABELS.disclaimer, "Sans", { fontSize: 24, color: GREY }),
    brand());
}

/** The page; its sections never shrink, so a poster that runs long overflows (and the layout test fails) instead of overlapping. */
const page = (height: number | undefined, ...children: Child[]) =>
  box({ flexDirection: "column", width: WIDTH, ...(height ? { height } : {}), backgroundColor: PAPER, padding: `${PAD - 16}px ${PAD}px 40px`, fontFamily: "Sans" },
    ...children.map((child) => child && typeof child === "object"
      ? { ...child, props: { ...child.props, style: { flexShrink: 0, ...(child.props.style as Style) } } } : child));

export function typePosterTree(type: PublicType, nickname: string, figure: Figure, inviteUrl: string): El {
  const group = groupQrBlock(104);
  return page(HEIGHT,
    hero(type, nickname, figure, true),
    rule(12),
    box({ flexDirection: "column", width: "100%" }, ...type.axes.map((axis, index) => box({ marginTop: index ? 8 : 0, width: "100%" }, axisRow(axis, type.group.colour, false)))),
    rule(12),
    aiBlock(type),
    rule(12),
    kindredBlock(type, false),
    rule(12),
    box({ width: "100%", justifyContent: "space-between" },
      partner(LABELS.best, type.best, type.group.colour, [type.best.tip]),
      partner(LABELS.hardest, type.hardest, type.group.colour, [type.hardest.tip])),
    box({ flexGrow: 1 }),
    rule(12),
    box({ width: "100%", justifyContent: "space-between", alignItems: "center" },
      qrBlock(inviteUrl, 96, Boolean(group)),
      group),
    box({ width: "100%", justifyContent: "space-between", alignItems: "center", marginTop: 12 },
      text(LABELS.disclaimer, "Sans", { fontSize: 24, color: GREY }),
      brand()));
}

const relationByName = (name: string) => Object.values(RELATIONS).find((relation) => relation.name === name);

function section(title: string, ...children: Child[]): El {
  return box({ flexDirection: "column", width: "100%" }, text(title, "Serif", { fontSize: 36, fontWeight: 700, color: INK, marginBottom: 18 }), ...children);
}

export function longImageTree(type: PublicType, nickname: string, figure: Figure, inviteUrl: string): El {
  const axisDetail = (axis: PublicAxis, index: number) => {
    const definition = TYPE_AXES.find((item) => item.id === axis.id)!;
    const leftText = definition.left.definition, rightText = definition.right.definition;
    const pole = (letter: string, label: string, en: string, explanation: string, on: boolean) => box({ flexDirection: "column", width: (INNER - 40) / 2 },
      box({ alignItems: "baseline" },
        text(`${letter} ${label}`, "Serif", { fontSize: 30, fontWeight: 700, color: on ? type.group.colour : INK }),
        text(en, "Sans", { fontSize: 24, color: GREY, marginLeft: 10 })),
      text(explanation, "Sans", { fontSize: 24, color: INK, lineHeight: 1.45, marginTop: 4 }));
    return box({ flexDirection: "column", width: "100%", marginTop: index ? 34 : 0 },
      text(definition.name, "Serif", { fontSize: 28, fontWeight: 700, color: INK, marginBottom: 10 }),
      axisRow(axis, type.group.colour),
      box({ width: "100%", justifyContent: "space-between", marginTop: 14 },
        pole(axis.leftLetter, axis.leftLabel, axis.leftEn, leftText, axis.score < 50),
        pole(axis.rightLetter, axis.rightLabel, axis.rightEn, rightText, axis.score >= 50)),
      text(`${LABELS.sources}${definition.sources}`, "Sans", { fontSize: 24, color: GREY, lineHeight: 1.45, marginTop: 10 }));
  };
  const detail = (label: string, view: PartnerView) => {
    const relation = relationByName(view.relation);
    return partner(label, view, type.group.colour, relation ? relation.tips.map((tip, index) => `${index + 1}. ${tip}`) : [view.tip], relation?.when);
  };
  return page(undefined,
    hero(type, nickname, figure, false),
    rule(34),
    section(LABELS.axesHeading,
      type.axes.some((axis) => axis.ambiguous) ? text(LABELS.ambiguous, "Sans", { fontSize: 24, color: GREY, marginBottom: 20 }) : null,
      ...type.axes.map(axisDetail)),
    rule(34),
    section(LABELS.aiHeading, aiBlock(type)),
    rule(34),
    section(LABELS.kindredHeading, kindredBlock(type, true)),
    rule(34),
    section(LABELS.linesHeading, linesBlock(type, false),
      text(LABELS.loopHeading, "Serif", { fontSize: 28, fontWeight: 700, color: INK, marginTop: 24 }),
      text(`${type.loop.join(" → ")} → ${type.loop[0]}`, "Sans", { fontSize: 26, color: INK, lineHeight: 1.5, marginTop: 8 }),
      text(LABELS.loopExplain, "Sans", { fontSize: 24, color: GREY, lineHeight: 1.5, marginTop: 6 }),
      // Lines from what the person said they want: how each feeds the next, with the relation kind.
      ...type.links.map((link, index) => box({ alignItems: "baseline", marginTop: index ? 6 : 14, flexWrap: "wrap" },
        text(`${type.lines[link.from]?.identity ?? ""} → ${type.lines[link.to]?.identity ?? ""}`, "Sans", { fontSize: 24, fontWeight: 700, color: INK }),
        text(link.kind, "Sans", { fontSize: 24, fontWeight: 700, color: INK, backgroundColor: type.group.tint, paddingLeft: 8, paddingRight: 8, marginLeft: 10, marginRight: 10 }),
        text(link.how, "Sans", { fontSize: 24, color: INK }))),
      text(LABELS.loopCaption, "Sans", { fontSize: 24, color: GREY, marginTop: 4 }),
      type.more.length ? text(LABELS.moreHeading, "Serif", { fontSize: 28, fontWeight: 700, color: INK, marginTop: 28 }) : null,
      // Three more combinations, each a step smaller (30 / 27 / 24 px for the identities), never under 24 px.
      ...type.more.map((combo, index) => comboLine(combo, [30, 27, 24][index]!, index ? 10 : 12))),
    rule(34),
    section(LABELS.partnersHeading,
      box({ width: "100%", justifyContent: "space-between" },
        detail(LABELS.best, type.best),
        detail(LABELS.hardest, type.hardest))),
    rule(34),
    box({ width: "100%", justifyContent: "space-between", alignItems: "center" }, qrBlock(inviteUrl, 140, Boolean(groupQr())), groupQrBlock(140)),
    box({ height: 40 }),
    footer());
}

type Side = { type: PublicType; nickname: string; figure: Figure };

export function pairCardTree(a: Side, b: Side, primary: RelationView, secondary: RelationView | undefined, sharedLines: string[], inviteUrl: string): El {
  const person = (side: Side, fallback: string) => box({ flexDirection: "column", alignItems: "center", width: (INNER - 60) / 2 },
    panel(side.figure, side.type, 300),
    text(side.nickname.trim() || fallback, "Sans", { fontSize: 32, fontWeight: 700, color: INK, marginTop: 20 }),
    text(side.type.name, "Serif", { fontSize: 46, fontWeight: 700, color: INK, marginTop: 6 }));
  return page(HEIGHT,
    text(LABELS.pairKicker, "Sans", { fontSize: 26, color: GREY, marginBottom: 22 }),
    box({ width: "100%", justifyContent: "space-between", alignItems: "flex-start" }, person(a, LABELS.friendA), person(b, LABELS.friendB)),
    rule(30),
    text(primary.name, "Serif", { fontSize: 92, fontWeight: 700, color: INK, lineHeight: 1.1 }),
    text(primary.when, "Sans", { fontSize: 26, color: GREY, marginTop: 10 }),
    ...primary.tips.map((tip, index) => box({ marginTop: index ? 10 : 22, alignItems: "flex-start" },
      text(String(index + 1), "Serif", { fontSize: 30, fontWeight: 700, color: a.type.group.colour, width: 36, lineHeight: 1.4 }),
      text(tip, "Sans", { fontSize: 30, color: INK, lineHeight: 1.4, flexShrink: 1 }))),
    secondary ? box({ marginTop: 22, alignItems: "baseline" },
      text(`${LABELS.also}：`, "Sans", { fontSize: 26, color: GREY }),
      text(secondary.name, "Serif", { fontSize: 30, fontWeight: 700, color: INK }),
      text(`（${secondary.when}）`, "Sans", { fontSize: 24, color: GREY, flexShrink: 1 })) : null,
    rule(30),
    box({ alignItems: "baseline", flexWrap: "wrap" },
      text(LABELS.shared, "Sans", { fontSize: 24, color: GREY, marginRight: 20 }),
      sharedLines.length
        ? box({ alignItems: "baseline" }, ...sharedLines.map((line) => text(line, "Serif", { fontSize: 34, fontWeight: 700, color: INK, marginRight: 22 })))
        : text(LABELS.noShared, "Serif", { fontSize: 34, fontWeight: 700, color: INK })),
    box({ flexGrow: 1 }),
    rule(22),
    box({ width: "100%", justifyContent: "space-between", alignItems: "flex-end" },
      qrBlock(inviteUrl, 128),
      box({ flexDirection: "column", alignItems: "flex-end" },
        text(LABELS.disclaimer, "Sans", { fontSize: 24, color: GREY, marginBottom: 10 }),
        brand())));
}

export type Rendered = { png: Buffer; height: number; nodes: SatoriNode[] };

/** satori lays the tree out and writes SVG with text as paths; resvg rasterises it at exactly 1080 wide. */
export async function toPng(tree: El, height?: number, options: { collect?: boolean; onMissing?: (segment: string) => void } = {}): Promise<Rendered> {
  const nodes: SatoriNode[] = [];
  const { onMissing } = options;
  const svg = await satori(tree as unknown as ReactNode, {
    width: WIDTH, ...(height ? { height } : {}), fonts: posterFonts().fonts,
    ...(options.collect ? { onNodeDetected: (node: SatoriNode) => { nodes.push(node); } } : {}),
    // Called only for a segment no passed font can draw: `safe` should have made that impossible, the tests make sure of it.
    ...(onMissing ? { loadAdditionalAsset: async (_language: string, segment: string) => { onMissing(segment); return []; } } : {})
  });
  const image = new Resvg(svg, { fitTo: { mode: "width", value: WIDTH }, font: { loadSystemFonts: false }, background: PAPER }).render();
  return { png: Buffer.from(image.asPng()), height: image.height, nodes };
}
