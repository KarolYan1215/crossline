"use client";

import { useEffect, useState } from "react";

type FlowNode = { id: string; title: string; kind: string; goal: string; stage: number };
type Source = { id: string; url: string; title: string; publisher: string; kept: "full_text" | "summary_only"; verdict: string; summary: string; file?: string; uri?: string };
type Book = {
  built: true; flow: { nodes: FlowNode[]; edges: Array<{ from: string; to: string }> }; manual: string;
  nodes: Record<string, { task: string; analysis: string; tutorial: string; sources: Source[] }>;
};
type Pending = { built: false; progress: { stage: string; done: number; total: number } | null; blocker: string | null };

const KIND: Record<string, string> = { read: "读", do: "做", decide: "决定", verify: "核对", write: "写" };
const STAGE: Record<string, string> = { designing: "设计流程", researching: "查资料", writing: "写分析和教程", assembling: "整理成手册" };
const NODE = { w: 200, h: 70, gapX: 56, gapY: 10 };

/**
 * A task's manualbook: the steps as a flow from left to right, and under it whatever the chosen step has — what to do,
 * the analysis of the material found for it, the tutorial, and the sources with what was kept of each. Reads the book
 * from the folder it was built in; while it is still being built it shows how far along that is.
 */
export function ManualbookView({ workOrderId, building }: { workOrderId: string; building: boolean }) {
  const [state, setState] = useState<Book | Pending | undefined>();
  const [selected, setSelected] = useState<string | undefined>();
  const [tab, setTab] = useState<"task" | "analysis" | "tutorial" | "sources">("task");

  useEffect(() => {
    let live = true;
    const look = async () => {
      const response = await fetch(`/api/work-orders/${encodeURIComponent(workOrderId)}/manualbook`, { cache: "no-store" }).catch(() => undefined);
      const body = await response?.json().catch(() => undefined) as Book | Pending | undefined;
      if (live && body) setState(body);
    };
    void look();
    // While it is being built, keep looking; once it is built there is nothing to wait for.
    const timer = building ? setInterval(() => void look(), 5000) : undefined;
    return () => { live = false; if (timer) clearInterval(timer); };
  }, [workOrderId, building]);

  if (!state) return null;
  if (!state.built) {
    if (state.blocker) return <section className="manualbook"><h3>手册</h3><p role="status">没有生成：{state.blocker}</p></section>;
    if (!building) return null;
    return <section className="manualbook"><h3>手册</h3><p role="status" className="muted">正在生成：{state.progress ? `${STAGE[state.progress.stage] ?? state.progress.stage}（${state.progress.done}/${state.progress.total}）` : "排队中"}…</p></section>;
  }

  const stages = [...new Set(state.flow.nodes.map((node) => node.stage))].sort((a, b) => a - b);
  const column = new Map(stages.map((stage, index) => [stage, index]));
  const placed = state.flow.nodes.map((node) => {
    const rank = state.flow.nodes.filter((other) => other.stage === node.stage).findIndex((other) => other.id === node.id);
    return { ...node, x: column.get(node.stage)! * (NODE.w + NODE.gapX), y: rank * (NODE.h + NODE.gapY) };
  });
  const at = new Map(placed.map((node) => [node.id, node]));
  const width = stages.length * (NODE.w + NODE.gapX) - NODE.gapX;
  const height = Math.max(...placed.map((node) => node.y + NODE.h));
  const current = selected ? state.nodes[selected] : undefined;
  const sources = current?.sources ?? [];

  return <section className="manualbook" aria-label="任务手册">
    <h3>手册</h3>
    <pre className="manual-overview">{state.manual.split("\n## 流程")[0]?.replace(/^# .*\n+/, "")}</pre>
    <div className="flow-scroll"><div className="flow-canvas" style={{ width, height }}>
      <svg width={width} height={height} aria-hidden="true">
        <defs><marker id="mb-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="currentColor" /></marker></defs>
        {state.flow.edges.map((edge) => {
          const a = at.get(edge.from), b = at.get(edge.to);
          if (!a || !b) return null;
          const x1 = a.x + NODE.w, y1 = a.y + NODE.h / 2, x2 = b.x, y2 = b.y + NODE.h / 2, mid = (x1 + x2) / 2;
          return <path key={`${edge.from}>${edge.to}`} d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`} className="flow-edge" markerEnd="url(#mb-arrow)" />;
        })}
      </svg>
      {placed.map((node, index) => <button type="button" key={node.id} className="flow-node mb-node" aria-pressed={selected === node.id}
        style={{ left: node.x, top: node.y, width: NODE.w, height: NODE.h }} onClick={() => { setSelected(node.id); setTab("task"); }}>
        <b>{index + 1}. {node.title}</b><small>{KIND[node.kind] ?? node.kind} · {state.nodes[node.id]?.sources.length ?? 0} 个来源</small>
      </button>)}
    </div></div>
    {current && <div className="mb-detail">
      <div className="cal-tabs" role="tablist" aria-label="步骤内容">
        {([["task", "做什么"], ["analysis", "分析"], ["tutorial", "教程"], ["sources", `来源（${sources.length}）`]] as const).map(([id, label]) =>
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>)}
      </div>
      {tab === "sources"
        ? <ul className="mb-sources">{sources.map((source) => <li key={source.id}>
            <a href={source.url} target="_blank" rel="noreferrer noopener">{source.title}</a> <small>{source.publisher}</small>
            <span className="tag">{source.kept === "full_text" ? "已下载全文" : "仅链接和摘要"}</span>
            <p>{source.summary}</p><small>{source.verdict}</small>
            {source.uri && <small> · <a href={`/api/work-orders/${encodeURIComponent(workOrderId)}/materials?uri=${encodeURIComponent(source.uri)}`} target="_blank" rel="noreferrer">打开本地副本</a></small>}
          </li>)}{sources.length === 0 && <li className="muted">这一步没有外部来源。</li>}</ul>
        : <pre className="mb-text">{current[tab] || "（这一步没有这部分内容）"}</pre>}
    </div>}
    {!current && <p className="muted">点一个步骤，看它要做什么、查到的资料、分析和教程。</p>}
  </section>;
}

