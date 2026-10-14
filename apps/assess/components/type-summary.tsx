import type { PublicAxis, PublicType } from "../lib/contract";

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
  return <ul className="as-axes" style={groupStyle(type)}>{type.axes.map((axis) => {
    const lean = axisLean(axis);
    return <li key={axis.id} data-ambiguous={axis.ambiguous || undefined}>
      <span className="as-axis-poles"><span data-on={axis.letter === axis.leftLetter || undefined}>{axis.leftLetter} {axis.leftLabel}</span>
        <span data-on={axis.letter === axis.rightLetter || undefined}>{axis.rightLabel} {axis.rightLetter}</span></span>
      <span className="as-axis-track" aria-hidden="true"><i style={{ left: `${Math.min(axis.score, 50)}%`, width: `${Math.abs(axis.score - 50)}%` }} /></span>
      <span className="as-axis-text">{lean.label} {lean.percent}%{axis.ambiguous ? "（两可）" : ""}
        {ranks ? `，约超过 ${axis.rank.percent}% 的人${axis.rank.estimated ? "（理论估算）" : ""}` : ""}</span>
    </li>;
  })}</ul>;
}

/** Everything else the poster says: the three lines and their loop, the best partner and the hardest. */
export function TypeDetails({ type }: { type: PublicType }) {
  return <div className="as-details">
    <section>
      <h3>推荐主线</h3>
      <p>{type.lines.join(" · ")}</p>
      <p className="as-note">飞轮：{type.loop.join(" → ")}</p>
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
