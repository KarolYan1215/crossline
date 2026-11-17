import { DIMENSION_IDS, DIMENSION_LABEL, type DimensionId, type DimensionNote, type Hypothesis, type HypothesisBasis } from "./interview-contract";

/**
 * The right column's map (decision 25, 2026-11-12): the ten dimensions round the person, each dimension's hypotheses fanned out beyond it,
 * and each hypothesis's evidence beyond that. An edge from evidence to its hypothesis is coloured by the hypothesis's verdict — the
 * evidence of a supported one supports it, of a refuted one refutes it, of an open or undecided one is still pending — since the contract
 * gives a hypothesis one verdict over all of its basis, not one per item.
 *
 * Pure: it only places what the profile holds, so it is tested without a screen.
 */
export type EdgeKind = "member" | "supports" | "refutes" | "pending";
export type DimensionNode = { kind: "dimension"; id: DimensionId; label: string; summary: string; evidenced: boolean; hypotheses: number; x: number; y: number };
export type HypothesisNode = { kind: "hypothesis"; id: string; number: number; hypothesis: Hypothesis; fits: boolean; x: number; y: number };
export type EvidenceNode = { kind: "evidence"; id: string; hypothesisId: string; basis: HypothesisBasis; x: number; y: number };
export type GraphNode = DimensionNode | HypothesisNode | EvidenceNode;
export type GraphEdge = { id: string; from: string; to: string; kind: EdgeKind; x1: number; y1: number; x2: number; y2: number };
export type DivergenceGraph = { size: number; centre: number; nodes: GraphNode[]; edges: GraphEdge[] };

const RING = { dimension: 0.27, hypothesis: 0.4, evidence: 0.48 } as const;
const SECTOR = (Math.PI * 2) / DIMENSION_IDS.length;

/** The verdict an evidence edge carries, from its hypothesis's status. */
export function evidenceEdgeKind(status: Hypothesis["status"]): EdgeKind {
  return status === "supported" ? "supports" : status === "refuted" ? "refutes" : "pending";
}

const isDimension = (id: string): id is DimensionId => (DIMENSION_IDS as readonly string[]).includes(id);
const round = (value: number) => Math.round(value * 10) / 10;

export function buildDivergenceGraph(profile: { hypotheses?: Hypothesis[] | undefined; dimensions?: DimensionNote[] | undefined } | null | undefined,
  size = 320): DivergenceGraph {
  const centre = size / 2;
  const at = (radius: number, angle: number) => ({ x: round(centre + Math.cos(angle) * radius * size), y: round(centre + Math.sin(angle) * radius * size) });
  const notes = new Map((profile?.dimensions ?? []).filter((note) => isDimension(note.id)).map((note) => [note.id, note]));
  const hypotheses = (profile?.hypotheses ?? []).filter((item) => isDimension(item.dimension));
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const numbers = new Map(hypotheses.map((item, index) => [item.id, index + 1]));
  DIMENSION_IDS.forEach((id, index) => {
    const angle = -Math.PI / 2 + index * SECTOR;
    const own = hypotheses.filter((item) => item.dimension === id);
    const note = notes.get(id);
    const place = at(RING.dimension, angle);
    nodes.push({ kind: "dimension", id, label: DIMENSION_LABEL[id], summary: note?.summary ?? "", evidenced: note?.evidenced ?? false, hypotheses: own.length, ...place });
    // A dimension's hypotheses share its sector, never spilling into the next one's.
    const step = own.length > 1 ? Math.min(0.22, (SECTOR * 0.84) / own.length) : 0;
    own.forEach((hypothesis, slot) => {
      const hAngle = angle + (slot - (own.length - 1) / 2) * step;
      const hPlace = at(RING.hypothesis, hAngle);
      nodes.push({ kind: "hypothesis", id: hypothesis.id, number: numbers.get(hypothesis.id)!, hypothesis, fits: hypothesis.rated === "fits", ...hPlace });
      edges.push({ id: `${id}>${hypothesis.id}`, from: id, to: hypothesis.id, kind: "member", x1: place.x, y1: place.y, x2: hPlace.x, y2: hPlace.y });
      const width = own.length > 1 ? step : SECTOR * 0.5;
      const eStep = hypothesis.basis.length > 1 ? Math.min(0.07, (width * 0.9) / hypothesis.basis.length) : 0;
      hypothesis.basis.forEach((basis, index) => {
        const ePlace = at(RING.evidence, hAngle + (index - (hypothesis.basis.length - 1) / 2) * eStep);
        const evidenceId = `${hypothesis.id}:e${index}`;
        nodes.push({ kind: "evidence", id: evidenceId, hypothesisId: hypothesis.id, basis, ...ePlace });
        edges.push({ id: `${evidenceId}>${hypothesis.id}`, from: evidenceId, to: hypothesis.id, kind: evidenceEdgeKind(hypothesis.status),
          x1: ePlace.x, y1: ePlace.y, x2: hPlace.x, y2: hPlace.y });
      });
    });
  });
  return { size, centre, nodes, edges };
}

/** One entry of 「本人标为准」: a hypothesis the person's rating reached, or an observation card they rated 准. */
export type FitsEntry = { key: string; text: string; source: "hypothesis" | "insight"; hypothesisId?: string; dimension?: DimensionId };

/**
 * What the person marked 准, kept on top (decision 23): rated hypotheses first, then the observation cards rated 准 whose text no hypothesis
 * already says.
 */
export function fitsEntries(hypotheses: Hypothesis[] | undefined, insights: Array<{ seq: number | string; text: string }>,
  ratings: Record<string, "fits" | "off" | "partial"> | undefined): FitsEntry[] {
  const entries: FitsEntry[] = (hypotheses ?? []).filter((item) => item.rated === "fits")
    .map((item) => ({ key: `h:${item.id}`, text: item.statement, source: "hypothesis", hypothesisId: item.id, dimension: item.dimension }));
  const said = new Set(entries.map((entry) => entry.text.trim()));
  for (const insight of insights) {
    const text = insight.text.trim();
    if (ratings?.[String(insight.seq)] !== "fits" || !text || said.has(text)) continue;
    said.add(text);
    entries.push({ key: `i:${insight.seq}`, text, source: "insight" });
  }
  return entries;
}

/** Hypotheses in reading order for a list: the ones rated 准 first, then by id as the model numbered them. */
export function fitsFirst<T extends { rated?: "fits" | "off" | "partial" | undefined }>(items: T[]): T[] {
  return items.map((item, index) => ({ item, index }))
    .sort((a, b) => Number(b.item.rated === "fits") - Number(a.item.rated === "fits") || a.index - b.index)
    .map(({ item }) => item);
}

/** Whether a basis reference is a link to open (an external source), rather than a reply id or a file id. */
export const isUrl = (ref: string) => /^https?:\/\//i.test(ref);
