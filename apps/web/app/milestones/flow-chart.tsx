import { NODE, layoutFlow, type FlowMilestone, type FlowRelation } from "./flow-model";

/**
 * The lines and what each is working towards, left to right in the order it has to happen. A column is a stage,
 * a row is a line, and what sits in the same stage of one line stacks. Solid links are "this comes after that"
 * inside a line; dashed ones are connections between lines (dotted-dashed while still only a candidate).
 */
export function FlowChart({ milestones, relations, labels, lineOrder }: {
  milestones: FlowMilestone[]; relations: FlowRelation[]; labels: Record<string, string>; lineOrder: string[];
}) {
  const layout = layoutFlow(milestones, relations, lineOrder);
  if (!layout.nodes.length) return <p className="flow-empty">还没有里程碑。完成「先了解你」后，在那里设计里程碑草稿。</p>;
  return <div className="flow" role="group" aria-label="里程碑流程图">
    <div className="flow-scroll">
      <div className="flow-canvas" style={{ width: layout.width, height: layout.height }}>
        <svg width={layout.width} height={layout.height} aria-hidden="true">
          <defs>
            <marker id="flow-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" fill="currentColor" /></marker>
          </defs>
          {layout.stages.map((stage, index) => <text key={stage} x={NODE.labelW + index * (NODE.w + NODE.gapX)} y={17} className="flow-stage">阶段 {stage}</text>)}
          {layout.rows.map((row) => <line key={row.identityId} x1={0} x2={layout.width} y1={row.y} y2={row.y} className="flow-rule" />)}
          {layout.edges.map((edge) => <path key={edge.id} d={edge.path} data-kind={edge.kind} data-pending={edge.pending || undefined} className="flow-edge" markerEnd="url(#flow-arrow)">{edge.label && <title>{edge.label}</title>}</path>)}
        </svg>
        {layout.rows.map((row) => <div key={row.identityId} className="flow-line" data-line={row.identityId} style={{ top: row.y, height: row.height, width: NODE.labelW - 8 }}>
          <b>{labels[row.identityId] ?? row.identityId}</b>
        </div>)}
        {layout.nodes.map((node) => <a key={node.id} className="flow-node" data-line={node.identityId} data-status={node.status}
          href={`/milestones/${encodeURIComponent(node.id)}`} style={{ left: node.x, top: node.y, width: NODE.w, height: NODE.h }}>
          <b>{node.title}</b>
          <small>{node.deadline ? `最晚 ${node.deadline}` : "未定日期"}{node.status === "draft" ? " · 草稿" : ""}</small>
          {node.total ? <span className="flow-progress" title={`${node.met ?? 0}/${node.total} 条标准已达成`}><i style={{ width: `${((node.met ?? 0) / node.total) * 100}%` }} /></span> : null}
        </a>)}
      </div>
    </div>
    <p className="flow-legend"><span className="flow-key chain" />同一主线内的先后　<span className="flow-key relation" />主线之间的联系　<span className="flow-key candidate" />待确认的联系　草稿为虚线框</p>
  </div>;
}
