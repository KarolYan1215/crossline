import type { DashboardData } from "./dashboard-view";

type Identity = DashboardData["identities"][number];
type Node = DashboardData["flywheelStrip"]["nodes"][number];
type Edge = DashboardData["flywheelStrip"]["edges"][number];

const CHIP_W = 200;
const CHIP_H = 52;
const GAP = 36;
const ARC_BAND = 60;
const TOP_PAD = 8;

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * A horizontally-scrolling strip, not a tall diagram: nodes are milestones (not identity percentages),
 * already ordered by recency from `loadDashboard` so newly active ones sit at the right edge. Flow arrows
 * stay ink-outlined chips with a thin identity-coloured accent — the same restrained language `.line-symbol`
 * and `work-order-list article`'s left border already use elsewhere — and the connecting arcs are the
 * identity accent heavily diluted with `--mist` rather than the earlier saturated gradient fill, so this
 * is the one place colour stays secondary instead of becoming the whole drawing.
 */
export function FlywheelStrip({ identities, nodes, edges }: { identities: Identity[]; nodes: Node[]; edges: Edge[] }) {
  if (nodes.length === 0) {
    return <p className="identity-flywheel-empty">尚无跨主线的已批准或候选里程碑关系 · 周复盘或 onboarding 对话产出候选后会显示在这里</p>;
  }
  const accentOf = (identityId: string) => identities.find((item) => item.id === identityId)?.accent ?? "#5A5B54";
  const indexOf = new Map(nodes.map((node, index) => [node.id, index]));
  const xOf = (index: number) => TOP_PAD + index * (CHIP_W + GAP);
  const chipTop = TOP_PAD + ARC_BAND;
  const width = TOP_PAD * 2 + nodes.length * CHIP_W + (nodes.length - 1) * GAP;
  const height = chipTop + CHIP_H + TOP_PAD;

  const arcs = edges.flatMap((edge) => {
    const from = indexOf.get(edge.from);
    const to = indexOf.get(edge.to);
    if (from === undefined || to === undefined || from === to) return [];
    const x1 = xOf(from) + CHIP_W / 2;
    const x2 = xOf(to) + CHIP_W / 2;
    const distance = Math.abs(to - from);
    const depth = Math.min(ARC_BAND - 10, 18 + distance * 10);
    const midY = chipTop - depth;
    return [{
      ...edge, toIndex: to,
      d: `M${x1},${chipTop} Q${(x1 + x2) / 2},${midY} ${x2},${chipTop}`,
      strokeWidth: Math.min(1.4 + edge.count * 1.1, 6)
    }];
  });

  return <div className="flywheel-strip-scroll">
    <svg width={width} height={height} role="img" aria-label="跨主线飞轮长条，按最新动态从左到右排列">
      <defs>
        {nodes.map((node) => <marker key={node.id} id={`fw-arrow-${node.id}`} viewBox="0 0 10 10" refX="7" refY="5"
          markerWidth="5" markerHeight="5" orient="auto">
          <path d="M0,0L10,5L0,10z" style={{ fill: `color-mix(in srgb, ${accentOf(node.identityId)} 55%, var(--graphite) 45%)` }} />
        </marker>)}
      </defs>
      {arcs.map((arc) => <path key={`${arc.from}->${arc.to}`} d={arc.d} fill="none"
        style={{ stroke: `color-mix(in srgb, ${accentOf(nodes[arc.toIndex]!.identityId)} 38%, var(--mist) 62%)` }}
        strokeWidth={arc.strokeWidth} strokeDasharray={arc.pending ? "2 5" : undefined}
        markerEnd={`url(#fw-arrow-${arc.to})`}>
        <title>{`${arc.kindLabel}（${arc.count} 条关系${arc.pending ? " · 待周复盘确认" : ""}）`}</title>
      </path>)}
      {nodes.map((node, index) => {
        const x = xOf(index);
        return <g key={node.id}>
          <rect x={x} y={chipTop} width={CHIP_W} height={CHIP_H} fill="var(--paper)" stroke="var(--mist)" />
          <rect x={x} y={chipTop} width={4} height={CHIP_H} fill={accentOf(node.identityId)} />
          <text x={x + 14} y={chipTop + 20} className="flywheel-chip-title">{truncate(node.title, 15)}</text>
          <text x={x + 14} y={chipTop + 38} className="flywheel-chip-signal">{node.latestSignal}</text>
        </g>;
      })}
    </svg>
  </div>;
}
