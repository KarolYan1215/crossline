import type { ReactNode } from "react";
import { latinGap } from "@crossline/core/assess-content";
import type { LineView, PublicAxis, PublicType } from "../lib/contract";
import { useLocale, useT } from "./locale-context";

/** The pole an axis leans to and by how much, e.g. 「跨界 78%」. */
export function axisLean(axis: PublicAxis): { label: string; percent: number } {
  const right = axis.letter === axis.rightLetter;
  return { label: right ? axis.rightLabel : axis.leftLabel, percent: right ? axis.score : 100 - axis.score };
}

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

/** The four axes as text: the pole leaned to, the percentage, 「两可」 near the middle, and the estimated rank. */
export function AxesList({ type, ranks = true }: { type: PublicType; ranks?: boolean }) {
  const t = useT();
  return <ul className="as-axes" style={groupStyle(type)}>{type.axes.map((axis) => {
    const lean = axisLean(axis);
    return <li key={axis.id} data-ambiguous={axis.ambiguous || undefined}>
      <span className="as-axis-poles"><span data-on={axis.letter === axis.leftLetter || undefined}>{axis.leftLetter} {axis.leftLabel}</span>
        <span data-on={axis.letter === axis.rightLetter || undefined}>{axis.rightLabel} {axis.rightLetter}</span></span>
      <span className="as-axis-track" aria-hidden="true"><i style={{ left: `${Math.min(axis.score, 50)}%`, width: `${Math.abs(axis.score - 50)}%` }} /></span>
      <span className="as-axis-text">{lean.label} {lean.percent}%{axis.ambiguous ? t("（两可）") : ""}
        {ranks ? t("，约超过 {{percent}}% 的人", { percent: axis.rank.percent }) : ""}{ranks && axis.rank.estimated ? t("（理论估算）") : ""}</span>
    </li>;
  })}</ul>;
}

/** 「人工智能的研究者 · 软件工具的创业者 · …」: each field small, each identity bold. */
function Combo({ lines, className }: { lines: LineView[]; className?: string }) {
  const t = useT();
  // Chinese: 「人工智能的 研究者」; English: the field as a modifier, "AI Researcher".
  const gap = useLocale() === "en" ? () => "" : latinGap;
  return <p className={className}>{lines.map((line, index) => <span key={line.identity}>{index ? " · " : ""}
    {line.domain && <span className="as-form">{t("{{domain}}的", { domain: line.domain })}{gap(line.identity)}</span>}<b>{line.identity}</b></span>)}</p>;
}

/**
 * Everything else the poster says: the lines and their loop (with how each feeds the next once they come from what the person said,
 * else three more combinations), the best partner and the hardest. `wants` is the person's own control to choose or change the lines.
 */
export function TypeDetails({ type, wants }: { type: PublicType; wants?: ReactNode }) {
  const t = useT();
  return <div className="as-details">
    <section>
      <h3>{t("你也许想做")}</h3>
      <Combo lines={type.lines} className="as-lines" />
      <p className="as-note">{t("飞轮：{{loop}}", { loop: `${type.loop.join(" → ")} → ${type.loop[0]}` })}</p>
      {type.links.length > 0 && <ul className="as-links">{type.links.map((link) => <li key={`${link.from}-${link.to}`}>
        <b>{type.lines[link.from]?.identity} → {type.lines[link.to]?.identity}</b>
        <span className="as-tag">{link.kind}</span>{link.how}
      </li>)}</ul>}
      {wants}
      {type.more.length > 0 && <>
        <p className="as-note">{t("也可以这样组合：")}</p>
        {type.more.map((combo, index) => <Combo key={index} lines={combo} className={`as-more as-more-${index + 1}`} />)}
      </>}
    </section>
    <section>
      <h3>{t("最佳搭子：{{name}} {{code}}", { name: type.best.name, code: type.best.code })}</h3>
      <p className="as-note">{t("{{relation}}。{{tip}}", { relation: type.best.relation, tip: type.best.tip })}</p>
    </section>
    <section>
      <h3>{t("一起做事容易吵：{{name}} {{code}}", { name: type.hardest.name, code: type.hardest.code })}</h3>
      <p className="as-note">{t("{{relation}}。{{tip}}", { relation: type.hardest.relation, tip: type.hardest.tip })}</p>
    </section>
  </div>;
}
