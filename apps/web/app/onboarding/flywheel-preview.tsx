import type { Fact, Identity } from "./onboarding-types";

const KIND_LABEL: Record<string, string> = {
  enables: "使能", reuses: "复用", informs: "启发", constrains: "约束", recurring_feedback: "反哺"
};
const COLORS: Record<string, string> = { research: "#1d4ed8", startup: "#c2410c", media: "#be185d", investment: "#047857" };

/** `flywheel_<to>_<kind>` facts, keyed on the line they come from. */
export type Link = { from: string; to: string; kind: string; explanation: string; status: Fact["status"]; slot: string };

export function linksFrom(facts: Fact[]): Link[] {
  return facts.filter((fact) => fact.slot.startsWith("flywheel_")).flatMap((fact) => {
    const [, to, ...kind] = fact.slot.split("_");
    return to && kind.length ? [{ from: fact.identityId, to, kind: kind.join("_"), explanation: fact.value, status: fact.status, slot: fact.slot }] : [];
  });
}

/**
 * The connections between the four lines, drawn left to right. Solid = the person confirmed it, dashed = the
 * interview only guessed it. A guess is drawn so it cannot be mistaken for a fact.
 */
export function FlywheelPreview({ identities, facts, onConfirm, onRemove }: {
  identities: Identity[]; facts: Fact[];
  onConfirm: (link: Link) => void; onRemove: (link: Link) => void;
}) {
  const links = linksFrom(facts);
  const width = 300, height = 40 + identities.length * 44;
  const y = (index: number) => 30 + index * 44;
  const indexOf = (id: string) => identities.findIndex((identity) => identity.id === id);
  return <section className="ob-block" aria-label="飞轮预览">
    <h3>主线之间的关系</h3>
    {links.length === 0 && <p className="ob-muted">还没有。访谈中选定的关系显示在此。</p>}
    {links.length > 0 && <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="主线之间的关系图" className="ob-flywheel">
      <defs><marker id="ob-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#111" /></marker></defs>
      {identities.map((identity, index) => <g key={identity.id}>
        <circle cx={26} cy={y(index)} r={7} fill={COLORS[identity.id] ?? "#111"} />
        <text x={38} y={y(index) + 4} fontSize="12" fontWeight="700" fill="#111">{identity.label}</text>
        <circle cx={width - 26} cy={y(index)} r={7} fill={COLORS[identity.id] ?? "#111"} />
        <text x={width - 38} y={y(index) + 4} fontSize="12" fontWeight="700" textAnchor="end" fill="#111">{identity.label}</text>
      </g>)}
      {links.map((link) => {
        const from = indexOf(link.from), to = indexOf(link.to);
        if (from < 0 || to < 0) return null;
        const x1 = 76, x2 = width - 76;
        return <path key={`${link.from}-${link.slot}`} d={`M${x1},${y(from)} C${x1 + 70},${y(from)} ${x2 - 70},${y(to)} ${x2},${y(to)}`}
          fill="none" stroke={COLORS[link.from] ?? "#111"} strokeWidth="2" strokeDasharray={link.status === "inferred" ? "5 4" : undefined}
          markerEnd="url(#ob-arrow)" opacity={link.status === "inferred" ? 0.75 : 1} />;
      })}
    </svg>}
    <ul className="ob-links">
      {links.map((link) => {
        const name = (id: string) => identities.find((identity) => identity.id === id)?.label ?? id;
        return <li key={`${link.from}-${link.slot}`} data-status={link.status}>
          <b>{name(link.from)} → {name(link.to)}</b> <span className="ob-tag">{KIND_LABEL[link.kind] ?? link.kind}</span>
          <span className="ob-tag" data-kind={link.status}>{link.status === "confirmed" ? "已确认" : "推断"}</span>
          <p>{link.explanation}</p>
          {link.status === "inferred" && <span className="ob-actions">
            <button type="button" className="ob-btn" onClick={() => onConfirm(link)}>确认</button>
            <button type="button" className="ob-btn ob-quiet" onClick={() => onRemove(link)}>不成立</button>
          </span>}
        </li>;
      })}
    </ul>
  </section>;
}
