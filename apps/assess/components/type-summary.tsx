import type { ReactNode } from "react";
import { TYPE_AXES } from "@crossline/core/assess";
import { latinGap } from "@crossline/core/assess-content";
import type { LineView, PublicAxis, PublicType } from "../lib/contract";

/** The pole a dimension leans to and by how much, e.g. 「多线并行 78%」. */
export function axisLean(axis: PublicAxis): { label: string; percent: number } {
  const right = axis.letter === axis.rightLetter;
  return { label: right ? axis.rightLabel : axis.leftLabel, percent: right ? axis.score : 100 - axis.score };
}

/** Both poles measured strong or weak on their own: said beside the lean, since the lean alone would hide it. */
export const BALANCE_TEXT = { both_high: "两端都强", both_low: "两端都弱" } as const;

/** 「（两可，两端都强）」: what qualifies a lean, in one bracket. */
const notes = (axis: PublicAxis): string => {
  const parts = [axis.ambiguous ? "两可" : "", axis.balance ? BALANCE_TEXT[axis.balance] : ""].filter(Boolean);
  return parts.length ? `（${parts.join("，")}）` : "";
};

/** The type's group colour as CSS variables, for accents only (text stays ink or grey). */
export const groupStyle = (type: PublicType) => ({ ["--group" as string]: type.group.colour, ["--group-tint" as string]: type.group.tint });

/** Name, code and subtitle: the poster's headline as text, for anyone who cannot see the image. */
export function TypeHeading({ type, as: Tag = "h1" }: { type: PublicType; as?: "h1" | "h2" | "h3" }) {
  return <header className="as-type-head" style={groupStyle(type)}>
    <p className="as-kicker">{type.group.name}</p>
    <Tag className="as-type-name">{type.name} <span className="as-code">{type.code}</span></Tag>
    <p className="as-subtitle">{type.subtitle}</p>
  </header>;
}

/** The four dimensions as text: the pole leaned to, the percentage, 「两可」 near the middle, both poles strong or weak, and the estimated rank. */
export function AxesList({ type, ranks = true }: { type: PublicType; ranks?: boolean }) {
  return <ul className="as-axes" style={groupStyle(type)}>{type.axes.map((axis) => {
    const lean = axisLean(axis);
    return <li key={axis.id} data-ambiguous={axis.ambiguous || undefined}>
      <span className="as-axis-poles"><span data-on={axis.letter === axis.leftLetter || undefined}>{axis.leftLetter} {axis.leftLabel}</span>
        <span data-on={axis.letter === axis.rightLetter || undefined}>{axis.rightLabel} {axis.rightLetter}</span></span>
      <span className="as-axis-track" aria-hidden="true"><i style={{ left: `${Math.min(axis.score, 50)}%`, width: `${Math.abs(axis.score - 50)}%` }} /></span>
      <span className="as-axis-text">{lean.label} {lean.percent}%{notes(axis)}
        {ranks ? `，约超过 ${axis.rank.percent}% 的人${axis.rank.estimated ? "（理论估算）" : ""}` : ""}</span>
    </li>;
  })}</ul>;
}

/**
 * Where the four dimensions come from (asked by a tester on 2026-10-17: 「怎么划分出这四个维度的」): each one's name, both poles' definitions
 * and the research it rests on, folded under the scores.
 */
export function DimensionNotes() {
  return <details className="as-dimensions">
    <summary>这四个维度从哪来</summary>
    <p className="as-note">四个维度描述一个人如何同时经营几条人生主线，各自取自一类已有研究。每个维度的两端分别用独立的题目测量，两端可以都强，也可以都弱；字母取得分较高的一端。这是趣味测评，没有做过信度与效度检验。</p>
    <dl>{TYPE_AXES.map((axis) => <div key={axis.id}>
      <dt>{axis.name}</dt>
      <dd><b>{axis.left.letter} {axis.left.label}</b>：{axis.left.definition}。</dd>
      <dd><b>{axis.right.letter} {axis.right.label}</b>：{axis.right.definition}。</dd>
      <dd className="as-note">依据：{axis.sources}</dd>
    </div>)}</dl>
  </details>;
}

/** 「人工智能的研究者 · 软件工具的创业者 · …」: each field small, each identity bold. */
function Combo({ lines, className }: { lines: LineView[]; className?: string }) {
  return <p className={className}>{lines.map((line, index) => <span key={line.identity}>{index ? " · " : ""}
    {line.domain && <span className="as-form">{line.domain}的{latinGap(line.identity)}</span>}<b>{line.identity}</b></span>)}</p>;
}

/**
 * Everything else the poster says: the lines and their loop (with how each feeds the next once they come from what the person said,
 * else three more combinations), the best partner and the hardest. `wants` is the person's own control to choose or change the lines.
 */
export function TypeDetails({ type, wants }: { type: PublicType; wants?: ReactNode }) {
  return <div className="as-details">
    <section>
      <h3>你也许想做</h3>
      <Combo lines={type.lines} className="as-lines" />
      <p className="as-note">飞轮：{type.loop.join(" → ")} → {type.loop[0]}</p>
      {type.links.length > 0 && <ul className="as-links">{type.links.map((link) => <li key={`${link.from}-${link.to}`}>
        <b>{type.lines[link.from]?.identity} → {type.lines[link.to]?.identity}</b>
        <span className="as-tag">{link.kind}</span>{link.how}
      </li>)}</ul>}
      {wants}
      {type.more.length > 0 && <>
        <p className="as-note">也可以这样组合：</p>
        {type.more.map((combo, index) => <Combo key={index} lines={combo} className={`as-more as-more-${index + 1}`} />)}
      </>}
    </section>
    <section>
      <h3>最佳搭子：{type.best.name} {type.best.code}</h3>
      <p className="as-note">{type.best.relation}。{type.best.tip}</p>
    </section>
    <section>
      <h3>一起做事容易吵：{type.hardest.name} {type.hardest.code}</h3>
      <p className="as-note">{type.hardest.relation}。{type.hardest.tip}</p>
    </section>
  </div>;
}
