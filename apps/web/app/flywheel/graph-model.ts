import { flywheelLoops } from "@crossline/core";

/**
 * The flywheel graph on Today, as plain data and pure functions: which dots and lines there are, how they are classed, which loops close,
 * and where everything sits. No React, no DOM, no clock and no randomness — the layout is seeded from the ids, so the same ledger draws
 * the same shape on every load.
 */
export type GraphLine = { id: string; label: string; goal: string; openTasks: number };
export type GraphMilestone = { id: string; line: string; title: string; status: "approved" | "draft"; openTasks: number; dependsOn: string[] };
export type GraphRelation = { id: string; from: string; to: string; kind: string; status: "approved" | "candidate"; explanation: string;
  /** How many days the upstream's output takes to reach the downstream, when the relation says (artifact-first planning). */
  lagDays?: number };
export type FlywheelGraphData = { lines: GraphLine[]; milestones: GraphMilestone[]; relations: GraphRelation[] };

export type GraphNode = { id: string; kind: "anchor" | "milestone"; line: string; label: string; radius: number;
  status?: "approved" | "draft"; openTasks?: number; milestoneId?: string };
/**
 * `member`: a milestone to its line's anchor (drawn faint; the pull that keeps a line together). `chain`: one milestone before the next on
 * the same line (thin). `cross`: a flywheel relation from one line's milestone to another line's (thick, arrowhead, the source line's
 * colour). A relation inside one line is drawn like a chain step. Approved is solid, candidate dashed.
 */
export type GraphEdge = { id: string; from: string; to: string; kind: "member" | "chain" | "cross"; line: string; status: "approved" | "candidate";
  relationId?: string; relationKind?: string; explanation?: string; lagDays?: number };
export type Graph = { nodes: GraphNode[]; edges: GraphEdge[] };
export type GraphLoop = { id: string; label: string; lines: string[]; edgeIds: string[]; lagDays?: number };
export type Point = { x: number; y: number };

export const anchorId = (line: string) => `line:${line}`;
/** A dot's size: grows with the square root of its unfinished tasks, so ten tasks read bigger than two without swamping the graph. */
export const milestoneRadius = (openTasks: number) => Math.min(20, 6 + 3 * Math.sqrt(Math.max(0, openTasks)));
export const ANCHOR_RADIUS = 14;

/** Edges by their ends, for the classification and the loop search. */
export function classifyEdge(from: { kind: GraphNode["kind"]; line: string }, to: { kind: GraphNode["kind"]; line: string }): GraphEdge["kind"] {
  if (from.kind === "anchor" || to.kind === "anchor") return "member";
  return from.line === to.line ? "chain" : "cross";
}

/**
 * Dots and lines from the board. Health is not a line here (capacity is a constraint, not a line); a milestone on a line that is not
 * given, or a relation with an end that is not drawn, is left out. A dependency another path along the same line already implies is not
 * drawn, as on the 主线 timeline.
 */
export function buildGraph(data: FlywheelGraphData): Graph {
  const lines = new Set(data.lines.map((line) => line.id));
  const milestones = data.milestones.filter((milestone) => lines.has(milestone.line));
  const byId = new Map(milestones.map((milestone) => [milestone.id, milestone]));
  const nodes: GraphNode[] = [
    ...data.lines.map((line) => ({ id: anchorId(line.id), kind: "anchor" as const, line: line.id, label: line.goal || line.label, radius: ANCHOR_RADIUS })),
    ...milestones.map((milestone) => ({ id: milestone.id, kind: "milestone" as const, line: milestone.line, label: milestone.title,
      radius: milestoneRadius(milestone.openTasks), status: milestone.status, openTasks: milestone.openTasks, milestoneId: milestone.id }))
  ];
  const edges: GraphEdge[] = milestones.map((milestone) => ({ id: `member:${milestone.id}`, from: anchorId(milestone.line), to: milestone.id, kind: "member" as const,
    line: milestone.line, status: milestone.status === "approved" ? "approved" as const : "candidate" as const }));

  // Same-line chain, minus what another path already implies.
  const parents = (id: string) => (byId.get(id)?.dependsOn ?? []).filter((dep) => byId.get(dep)?.line === byId.get(id)?.line && dep !== id);
  const reaches = (from: string, target: string, seen = new Set<string>()): boolean => {
    for (const dep of parents(from)) {
      if (dep === target) return true;
      if (!seen.has(dep)) { seen.add(dep); if (reaches(dep, target, seen)) return true; }
    }
    return false;
  };
  for (const milestone of milestones) {
    const direct = [...new Set(parents(milestone.id))];
    for (const dep of direct) {
      if (direct.some((other) => other !== dep && reaches(other, dep))) continue;
      const both = byId.get(dep)!.status === "approved" && milestone.status === "approved";
      edges.push({ id: `chain:${dep}>${milestone.id}`, from: dep, to: milestone.id, kind: "chain", line: milestone.line, status: both ? "approved" : "candidate" });
    }
  }
  for (const relation of data.relations) {
    const from = byId.get(relation.from), to = byId.get(relation.to);
    if (!from || !to || from.id === to.id) continue;
    edges.push({ id: `relation:${relation.id}`, from: from.id, to: to.id, kind: from.line === to.line ? "chain" : "cross", line: from.line, status: relation.status,
      relationId: relation.id, relationKind: relation.kind, explanation: relation.explanation, ...(relation.lagDays !== undefined ? { lagDays: relation.lagDays } : {}) });
  }
  return { nodes, edges };
}

/**
 * The closed loops between lines (A feeds B feeds … feeds A), made of **approved** cross-line relations only — a candidate cannot close a
 * flywheel the person has not agreed exists. Each is labelled R1, R2… (a reinforcing loop) and carries its lag when every hop states one
 * (the shortest stated lag per hop, summed).
 */
export function graphLoops(graph: Graph): GraphLoop[] {
  const lineOf = new Map(graph.nodes.map((node) => [node.id, node.line]));
  const approved = graph.edges.filter((edge) => edge.kind === "cross" && edge.status === "approved");
  const hops = approved.map((edge) => ({ edge, from: lineOf.get(edge.from)!, to: lineOf.get(edge.to)! }));
  const loops = flywheelLoops(hops.map((hop) => ({ from: hop.from, to: hop.to, kind: hop.edge.relationKind ?? "informs" })));
  return loops.map((lines, index) => {
    const pairs = lines.map((line, i) => [line, lines[(i + 1) % lines.length]!] as const);
    const used = pairs.map(([from, to]) => hops.filter((hop) => hop.from === from && hop.to === to && hop.edge.relationKind !== "constrains"));
    const lags = used.map((list) => list.flatMap((hop) => hop.edge.lagDays !== undefined ? [hop.edge.lagDays] : []));
    const lagDays = lags.every((list) => list.length) ? lags.reduce((sum, list) => sum + Math.min(...list), 0) : undefined;
    return { id: `loop:${lines.join(">")}`, label: `R${index + 1}`, lines, edgeIds: used.flat().map((hop) => hop.edge.id), ...(lagDays !== undefined ? { lagDays } : {}) };
  });
}

/** Neighbours of a node along any drawn edge, for highlighting on hover and focus. */
export function neighbours(graph: Graph, id: string): Set<string> {
  const out = new Set<string>([id]);
  for (const edge of graph.edges) {
    if (edge.from === id) out.add(edge.to);
    if (edge.to === id) out.add(edge.from);
  }
  return out;
}

/** A string's 32-bit FNV-1a hash, the seed of everything random-looking in the layout. */
export function hashOf(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193); }
  return hash >>> 0;
}
/** mulberry32: a small seeded generator, so one id always gives the same numbers. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The layout's own space: a 640 × 440 field around the origin, fitted to the drawing's real width when drawn. */
export const FIELD = { width: 640, height: 440 };
const RING = 150;
const SPRING = { member: { length: 72, strength: 0.22 }, chain: { length: 56, strength: 0.3 }, cross: { length: 170, strength: 0.04 } } as const;

export type Simulation = { positions: Map<string, Point>; tick: (alpha: number) => void; settle: (ticks?: number, alpha?: number) => void; fixed: Set<string> };

/** Where each line's anchor starts: on a ring, in the order the lines are given, the first at the top. */
export function ringSlots(lineIds: string[]): Map<string, Point> {
  return new Map(lineIds.map((line, index) => {
    const angle = -Math.PI / 2 + (index / Math.max(1, lineIds.length)) * Math.PI * 2;
    const r = lineIds.length > 1 ? RING : 0;
    return [line, { x: r * Math.cos(angle), y: r * Math.sin(angle) }];
  }));
}

/**
 * A hand-written force simulation (no chart library): every pair repels, edges pull to their rest length (a milestone close to its line's
 * anchor, chain steps closer, cross-line relations long and weak), overlapping dots are pushed apart, everything drifts weakly to the
 * centre, and each anchor is held weakly to its slot on the ring so the lines keep their places between loads. Milestones start around
 * their anchor at an angle and distance seeded from their id. A node in `fixed` (being dragged, or dropped) does not move.
 */
export function createSimulation(graph: Graph, start?: Map<string, Point>): Simulation {
  const slots = ringSlots(graph.nodes.filter((node) => node.kind === "anchor").map((node) => node.line));
  const positions = new Map<string, Point>();
  const velocity = new Map<string, Point>();
  for (const node of graph.nodes) {
    const given = start?.get(node.id);
    const slot = slots.get(node.line) ?? { x: 0, y: 0 };
    if (given) positions.set(node.id, { ...given });
    else if (node.kind === "anchor") positions.set(node.id, { ...slot });
    else {
      const random = seeded(hashOf(node.id));
      const angle = random() * Math.PI * 2, distance = 40 + random() * 40;
      positions.set(node.id, { x: slot.x + Math.cos(angle) * distance, y: slot.y + Math.sin(angle) * distance });
    }
    velocity.set(node.id, { x: 0, y: 0 });
  }
  const fixed = new Set<string>();
  const nodes = graph.nodes;
  const radius = new Map(nodes.map((node) => [node.id, node.radius]));
  const springs = graph.edges.map((edge) => ({ ...edge, ...SPRING[edge.kind] }));

  const tick = (alpha: number) => {
    // Repulsion between every pair (a few dozen nodes, so the plain double loop is cheap) and collision.
    for (let i = 0; i < nodes.length; i += 1) for (let j = i + 1; j < nodes.length; j += 1) {
      const a = positions.get(nodes[i]!.id)!, b = positions.get(nodes[j]!.id)!;
      let dx = b.x - a.x, dy = b.y - a.y;
      let d2 = dx * dx + dy * dy;
      // Two nodes on the same spot are parted along a direction seeded from their ids, never at random.
      if (d2 < 0.01) { const r = seeded(hashOf(nodes[i]!.id + nodes[j]!.id))() * Math.PI * 2; dx = Math.cos(r) * 0.1; dy = Math.sin(r) * 0.1; d2 = 0.01; }
      const d = Math.sqrt(d2);
      const anchors = (nodes[i]!.kind === "anchor" ? 1 : 0) + (nodes[j]!.kind === "anchor" ? 1 : 0);
      const push = (900 * (1 + anchors * 2) / d2) * alpha;
      const gap = radius.get(nodes[i]!.id)! + radius.get(nodes[j]!.id)! + 8;
      const overlap = d < gap ? (gap - d) * 0.5 : 0;
      const fx = (dx / d) * (push + overlap), fy = (dy / d) * (push + overlap);
      const va = velocity.get(nodes[i]!.id)!, vb = velocity.get(nodes[j]!.id)!;
      va.x -= fx; va.y -= fy; vb.x += fx; vb.y += fy;
    }
    for (const spring of springs) {
      const a = positions.get(spring.from), b = positions.get(spring.to);
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const pull = ((d - spring.length) / d) * spring.strength * alpha;
      const va = velocity.get(spring.from)!, vb = velocity.get(spring.to)!;
      va.x += dx * pull * 0.5; va.y += dy * pull * 0.5; vb.x -= dx * pull * 0.5; vb.y -= dy * pull * 0.5;
    }
    for (const node of nodes) {
      const p = positions.get(node.id)!, v = velocity.get(node.id)!;
      v.x -= p.x * 0.012 * alpha; v.y -= p.y * 0.012 * alpha;
      if (node.kind === "anchor") { const slot = slots.get(node.line)!; v.x += (slot.x - p.x) * 0.06 * alpha; v.y += (slot.y - p.y) * 0.06 * alpha; }
    }
    for (const node of nodes) {
      const p = positions.get(node.id)!, v = velocity.get(node.id)!;
      if (fixed.has(node.id)) { v.x = 0; v.y = 0; continue; }
      v.x *= 0.6; v.y *= 0.6;
      p.x += v.x; p.y += v.y;
    }
  };
  const settle = (ticks = 300, alpha = 1) => {
    // d3's schedule: alpha falls from its start towards 0.001 over the ticks.
    const decay = 1 - Math.pow(0.001 / Math.max(alpha, 0.0011), 1 / ticks);
    for (let i = 0, a = alpha; i < ticks; i += 1, a *= 1 - decay) tick(a);
  };
  return { positions, tick, settle, fixed };
}

/** The settled layout, rounded to a tenth so it serialises the same everywhere. */
export function layoutGraph(graph: Graph): Map<string, Point> {
  const simulation = createSimulation(graph);
  simulation.settle();
  return new Map([...simulation.positions].map(([id, p]) => [id, { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 }]));
}

/**
 * Fitting the layout into a drawing `width` × `height` pixels wide, with room for labels: the scale and offset that turn layout
 * coordinates into pixels (before the person's own zoom and pan). Never enlarged past 1.6×, so a graph of three dots does not balloon.
 */
export function fitTransform(points: Point[], width: number, height: number, pad = 48): { scale: number; x: number; y: number } {
  if (!points.length) return { scale: 1, x: width / 2, y: height / 2 };
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const scale = Math.min(1.6, (width - pad * 2) / Math.max(1, maxX - minX), (height - pad * 2) / Math.max(1, maxY - minY));
  return { scale, x: width / 2 - ((minX + maxX) / 2) * scale, y: height / 2 - ((minY + maxY) / 2) * scale };
}

/** The point on a straight edge where it meets the target's circle (for the arrowhead), and the edge's midpoint. */
export function edgeGeometry(a: Point, b: Point, targetRadius: number, bend = 0): { path: string; mid: Point } {
  const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
  // A gentle bend, perpendicular to the chord, keeps two relations between the same pair apart.
  const cx = (a.x + b.x) / 2 - (dy / d) * bend, cy = (a.y + b.y) / 2 + (dx / d) * bend;
  const tx = b.x - cx, ty = b.y - cy, td = Math.sqrt(tx * tx + ty * ty) || 1;
  const end = { x: b.x - (tx / td) * (targetRadius + 3), y: b.y - (ty / td) * (targetRadius + 3) };
  const mid = { x: 0.25 * a.x + 0.5 * cx + 0.25 * end.x, y: 0.25 * a.y + 0.5 * cy + 0.25 * end.y };
  const f = (n: number) => n.toFixed(1);
  return { path: bend ? `M${f(a.x)},${f(a.y)} Q${f(cx)},${f(cy)} ${f(end.x)},${f(end.y)}` : `M${f(a.x)},${f(a.y)} L${f(end.x)},${f(end.y)}`, mid };
}

/** Where a loop's R sits: the centre of the milestones its relations join. */
export function loopCentre(loop: GraphLoop, graph: Graph, at: (id: string) => Point | undefined): Point | undefined {
  const ids = new Set(graph.edges.filter((edge) => loop.edgeIds.includes(edge.id)).flatMap((edge) => [edge.from, edge.to]));
  const points = [...ids].flatMap((id) => { const p = at(id); return p ? [p] : []; });
  if (!points.length) return undefined;
  return { x: points.reduce((sum, p) => sum + p.x, 0) / points.length, y: points.reduce((sum, p) => sum + p.y, 0) / points.length };
}
