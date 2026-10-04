/**
 * Where every milestone sits on the flow chart.
 *
 * Columns are stages, left to right, in the order the work has to happen. Rows are lines. Two milestones in the
 * same line and the same stage stack vertically in that cell. A link inside a line runs from one stage's right
 * edge to the next one's left edge; a link between lines (or one that runs backwards) leaves by the side and is
 * drawn dashed. All of it is arithmetic, so it is tested without a browser.
 */
export type FlowMilestone = {
  id: string; identityId: string; title: string; status: "draft" | "approved" | "archived";
  stage?: number | undefined; deadline?: string | undefined; dependsOn?: string[] | undefined;
  /** Criteria the gate has judged met, and how many there are. */
  met?: number | undefined; total?: number | undefined;
};
export type FlowRelation = { id: string; source: string; target: string; kind: string; status: string };

export const NODE = { w: 214, h: 78, gapX: 56, gapY: 10, labelW: 96, headH: 26, rowPad: 10 } as const;

export type PlacedNode = FlowMilestone & { stage: number; x: number; y: number };
export type PlacedEdge = { id: string; from: string; to: string; kind: "chain" | "relation"; pending: boolean; label: string; path: string };
export type FlowLayout = {
  width: number; height: number; stages: number[]; nodes: PlacedNode[]; edges: PlacedEdge[];
  rows: Array<{ identityId: string; y: number; height: number }>;
};

const RELATION_LABEL: Record<string, string> = { enables: "使能", reuses: "复用", informs: "启发", constrains: "约束", recurring_feedback: "回流" };

/** A milestone with no stage of its own takes the next free one in its line, in the order it was made. */
export function assignStages(milestones: FlowMilestone[]): Array<FlowMilestone & { stage: number }> {
  const taken = new Map<string, number>();
  return milestones.map((milestone) => {
    if (milestone.stage) return { ...milestone, stage: milestone.stage };
    const next = (taken.get(milestone.identityId) ?? 0) + 1;
    taken.set(milestone.identityId, next);
    return { ...milestone, stage: next };
  });
}

export function layoutFlow(milestones: FlowMilestone[], relations: FlowRelation[], lineOrder: string[]): FlowLayout {
  const live = assignStages(milestones.filter((milestone) => milestone.status !== "archived"));
  const stages = [...new Set(live.map((node) => node.stage))].sort((a, b) => a - b);
  const column = new Map(stages.map((stage, index) => [stage, index]));
  const lines = [...new Set([...lineOrder.filter((id) => live.some((node) => node.identityId === id)), ...live.map((node) => node.identityId)])];

  const nodes: PlacedNode[] = [];
  const rows: FlowLayout["rows"] = [];
  let y = NODE.headH;
  for (const identityId of lines) {
    const own = live.filter((node) => node.identityId === identityId);
    const depth = Math.max(1, ...stages.map((stage) => own.filter((node) => node.stage === stage).length));
    const height = depth * NODE.h + (depth - 1) * NODE.gapY + NODE.rowPad * 2;
    for (const stage of stages) {
      own.filter((node) => node.stage === stage).forEach((node, index) => nodes.push({
        ...node, x: NODE.labelW + column.get(stage)! * (NODE.w + NODE.gapX), y: y + NODE.rowPad + index * (NODE.h + NODE.gapY)
      }));
    }
    rows.push({ identityId, y, height });
    y += height;
  }

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges: PlacedEdge[] = [];
  const route = (a: PlacedNode, b: PlacedNode, forceSide: boolean): string => {
    const x1 = a.x + NODE.w, y1 = a.y + NODE.h / 2, x2 = b.x, y2 = b.y + NODE.h / 2;
    if (!forceSide && x2 >= x1 + 10) {
      const mid = (x1 + x2) / 2;
      return `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`;
    }
    // Backwards or sideways: out of the right edge, round the nodes by the gutter, into the left edge.
    const out = x1 + NODE.gapX / 2 - 6, back = x2 - NODE.gapX / 2 + 6;
    const lane = Math.max(a.y, b.y) + NODE.h + 4;
    return `M${x1},${y1} H${out} V${lane} H${back} V${y2} H${x2}`;
  };
  for (const node of nodes) {
    for (const parent of node.dependsOn ?? []) {
      const from = byId.get(parent);
      if (from) edges.push({ id: `chain:${parent}>${node.id}`, from: parent, to: node.id, kind: "chain", pending: false, label: "", path: route(from, node, false) });
    }
  }
  for (const relation of relations) {
    const from = byId.get(relation.source), to = byId.get(relation.target);
    if (from && to && relation.status !== "archived") {
      edges.push({ id: `relation:${relation.id}`, from: from.id, to: to.id, kind: "relation", pending: relation.status === "candidate",
        label: RELATION_LABEL[relation.kind] ?? relation.kind, path: route(from, to, from.identityId === to.identityId && to.x <= from.x) });
    }
  }
  return { width: NODE.labelW + stages.length * (NODE.w + NODE.gapX) - NODE.gapX + 8, height: y + 8, stages, nodes, edges, rows };
}
