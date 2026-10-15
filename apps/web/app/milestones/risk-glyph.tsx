import { MILESTONE_RISK_KIND_LABEL, MILESTONE_RISK_LEVEL_LABEL, type MilestoneRisk, type MilestoneRiskLevel } from "@crossline/core";

const BARS: Record<MilestoneRiskLevel, number> = { low: 1, medium: 2, high: 3 };

/**
 * A risk level as a glyph: three bars of rising height, as many filled as the level is high (low one, medium two, high three). Drawn in
 * ink, so it reads the same on every line's colour; the level is in its label.
 */
export function RiskGlyph({ level, size = 12 }: { level: MilestoneRiskLevel | null; size?: number }) {
  const filled = level ? BARS[level] : 0;
  return <svg className="risk-glyph" width={size} height={size} viewBox="0 0 12 12" role="img" aria-label={level ? `${MILESTONE_RISK_LEVEL_LABEL[level]}风险` : "无风险"}>
    {[0, 1, 2].map((index) => <rect key={index} x={index * 4 + 0.5} y={12 - (index + 1) * 4 + 0.5} width={3} height={(index + 1) * 4 - 1} rx={0.5}
      data-on={index < filled || undefined} />)}
  </svg>;
}

/** Each risk as glyph · kind tag · note; nothing at all for a milestone without one. `gen` when the note was written by the reviewer. */
export function RiskList({ risks, gen }: { risks: MilestoneRisk[]; gen: boolean }) {
  if (!risks.length) return null;
  return <ul className="risk-list">{risks.map((risk) => <li key={risk.kind} data-level={risk.level}>
    <RiskGlyph level={risk.level} /><span className="risk-kind">{MILESTONE_RISK_KIND_LABEL[risk.kind]}</span>
    <span className={gen ? "gen" : undefined}>{risk.note}</span></li>)}</ul>;
}

