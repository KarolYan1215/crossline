import type { DashboardData } from "./dashboard-view";

type Identity = DashboardData["identities"][number];
type Flow = DashboardData["identityFlows"][number];

const ROW_H = 46;
const TOP_PAD = 10;
const LABEL_W = 150;
const BAR_W = 190;
const BAR_X = LABEL_W;
const ARC_X = BAR_X + BAR_W + 34;
const WIDTH = ARC_X + 180;

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// Cubic bezier that starts and ends at the same x (the right edge of the bar lane) and bulges further
// right the more relations share that pair — the same "feedback loop" shape a sankey uses for a cycle
// it cannot lay out left-to-right, since these four identities form a real cycle (media -> research ->
// media), not a DAG a classic sankey column order could ever represent.
function arcPath(y1: number, y2: number, depth: number): { d: string; midX: number; midY: number } {
  const cx = ARC_X + depth;
  return {
    d: `M${ARC_X},${y1} C${cx},${y1} ${cx},${y2} ${ARC_X},${y2}`,
    midX: 0.25 * ARC_X + 0.75 * cx,
    midY: (y1 + y2) / 2
  };
}

/**
 * Each identity as a progress bar (real completed/total work orders), and the real, LLM-judged
 * milestone relations crossing identities drawn as weighted arcs between them — the flywheel effect
 * the star map only ever shows as an edge and a one-word kind label, made visible next to the progress
 * it actually feeds.
 */
export function IdentityFlywheel({ identities, flows }: { identities: Identity[]; flows: Flow[] }) {
  const indexOf = new Map(identities.map((item, index) => [item.id, index]));
  const centerY = (index: number) => TOP_PAD + index * ROW_H + ROW_H / 2;
  const height = TOP_PAD * 2 + identities.length * ROW_H;

  // Multiple relations between the same unordered pair (either direction) must not draw on top of one
  // another, so each gets its own bulge depth, deepest first for the pair with the most relations.
  const pairCounts = new Map<string, number>();
  const arcs = flows.flatMap((flow) => {
    const fromIndex = indexOf.get(flow.from);
    const toIndex = indexOf.get(flow.to);
    if (fromIndex === undefined || toIndex === undefined) return [];
    const pairKey = [flow.from, flow.to].sort().join("~");
    const order = pairCounts.get(pairKey) ?? 0;
    pairCounts.set(pairKey, order + 1);
    const depth = 34 + Math.min(flow.count, 6) * 9 + order * 20;
    const { d, midX, midY } = arcPath(centerY(fromIndex), centerY(toIndex), depth);
    return [{ ...flow, d, midX, midY, strokeWidth: Math.min(1.5 + flow.count * 1.4, 9) }];
  });

  return <div className="identity-flywheel">
    <svg viewBox={`0 0 ${WIDTH} ${height}`} role="img" aria-label="各主线进度与跨主线飞轮关系">
      <defs>
        {identities.map((from) => identities.map((to) => from.id === to.id ? null : <linearGradient
          key={`${from.id}->${to.id}`} id={`flow-grad-${from.id}-${to.id}`}
          gradientUnits="userSpaceOnUse" x1={ARC_X} y1={centerY(indexOf.get(from.id)!)} x2={ARC_X} y2={centerY(indexOf.get(to.id)!)}>
          <stop offset="0%" stopColor={from.accent} />
          <stop offset="100%" stopColor={to.accent} />
        </linearGradient>))}
        {identities.map((item) => <marker key={item.id} id={`flow-arrow-${item.id}`} viewBox="0 0 10 10"
          refX="7" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0L10,5L0,10z" fill={item.accent} />
        </marker>)}
      </defs>

      {arcs.map((arc) => <g key={`${arc.from}->${arc.to}`}>
        <path d={arc.d} fill="none" stroke={`url(#flow-grad-${arc.from}-${arc.to})`}
          strokeWidth={arc.strokeWidth} strokeDasharray={arc.pending ? "2 4" : undefined}
          markerEnd={`url(#flow-arrow-${arc.to})`} opacity={0.85}>
          <title>{`${arc.kindLabel} · ${identities.find((i) => i.id === arc.from)?.label} → ${identities.find((i) => i.id === arc.to)?.label}（${arc.count} 条关系${arc.pending ? " · 待周复盘确认" : ""}）`}</title>
        </path>
        <text x={arc.midX + 5} y={arc.midY - 4} className="flow-label">{arc.kindLabel}</text>
      </g>)}

      {identities.map((item, index) => {
        const y = centerY(index);
        const barWFill = (BAR_W * item.pct) / 100;
        return <g key={item.id}>
          <rect x={0} y={y - 4} width={8} height={8} fill={item.accent} />
          <text x={14} y={y} className="identity-label">{item.label}</text>
          <text x={14} y={y + 14} className="identity-sub">
            {`累计 ${item.completedCount} · 进行中 ${item.taskCount}`}
          </text>
          <rect x={BAR_X} y={y - 6} width={BAR_W} height={12} fill="var(--mist)" />
          <rect x={BAR_X} y={y - 6} width={barWFill} height={12} fill={item.accent} />
          <text x={BAR_X + BAR_W + 8} y={y + 4} className="identity-pct">{`${item.pct}%`}</text>
          <text x={BAR_X} y={y + 20} className="identity-milestone">{truncate(item.activeMilestone, 30)}</text>
        </g>;
      })}
    </svg>
    {flows.length === 0 && <p className="identity-flywheel-empty">尚无跨主线的已批准或候选关系 · 周复盘产出候选后会显示在这里</p>}
  </div>;
}
