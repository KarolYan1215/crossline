"use client";

import { Background, Controls, MarkerType, ReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

type MilestoneDatum = { id: string; identityId: string; title: string };
type RelationDatum = { id: string; source: string; target: string; kind: string; status: "candidate" | "approved" | "archived" | "refuted" };
const positions = [{ x: 60, y: 80 }, { x: 400, y: 20 }, { x: 720, y: 160 }, { x: 370, y: 300 }];

export function MilestoneMap({ milestones, relations }: { milestones: MilestoneDatum[]; relations: RelationDatum[] }) {
  const nodes: Node[] = milestones.map((milestone, index) => ({
    id: milestone.id, position: positions[index % positions.length]!,
    data: { label: `${milestone.identityId.toUpperCase()} · ${milestone.title}` }, draggable: false,
    style: { background: "var(--paper)", color: "var(--ink)", border: "1px solid var(--ink)", borderRadius: 0, fontSize: 11 }
  }));
  const edges: Edge[] = relations.map((relation) => ({
    id: relation.id, source: relation.source, target: relation.target, label: relation.kind.replaceAll("_", " "),
    animated: false, markerEnd: { type: MarkerType.ArrowClosed },
    // Hardcoded ink left the graph as white boxes on a dark ground. The tokens follow the theme, so the
    // map is readable in both without a second palette to keep in sync.
    style: { stroke: "var(--ink)", strokeDasharray: relation.status === "candidate" ? "7 5" : undefined }
  }));
  return <div className="milestone-map" aria-label="跨身份里程碑关系图">
    {/* The wheel pans the page, not the canvas. The map fills the viewport, so zooming on scroll trapped
        anyone trying to reach the milestone list below it — the zoom controls are still there for that. */}
    <ReactFlow nodes={nodes} edges={edges} nodesDraggable={false} nodesConnectable={false}
      zoomOnScroll={false} preventScrolling={false} elementsSelectable fitView>
      <Background gap={28} color="var(--mist)" /><Controls showInteractive={false} />
    </ReactFlow>
  </div>;
}
