"use client";

import { useEffect, useState } from "react";
import { Markdown } from "./ui/markdown";

type Source = { id: string; url: string; title: string; publisher: string; kept: "full_text" | "summary_only"; verdict: string; summary: string; file?: string; uri?: string };
type FlowNode = { id: string; title: string; kind: string; goal: string; stage: number; order?: number };
type Status = { building: boolean; progress: { stage: string; done: number; total: number } | null; blocker: string | null };
type Book = Status & {
  built: true; flow: { nodes: FlowNode[]; edges: Array<{ from: string; to: string }> }; manual: string;
  nodes: Record<string, { task: string; analysis: string; tutorial: string; sources: Source[] }>;
};
type Pending = Status & { built: false };

const STAGE: Record<string, string> = { designing: "设计步骤", researching: "查找资料", writing: "撰写教程与解析", assembling: "整理" };
const KIND: Record<string, string> = { read: "阅读", do: "动手", decide: "决定", verify: "核对", write: "撰写" };
/** A write-up as stored (markdown): its own heading dropped, the rest shown as written. */
const body = (text: string) => text.replace(/^# .*\n+/, "").trim();

/**
 * The task's tutorial, read top to bottom: the overview, then each step in order with its step-by-step guide; the analysis of the material
 * and the sources sit one click away on the same step. 生成教程 asks for one when there is none (work coming up this week gets one on its
 * own); while one is being built its progress shows, and a stopped build says why with a way to try again.
 */
export function ManualbookView({ workOrderId, building: preparing, canBuild = true }: { workOrderId: string; building: boolean; canBuild?: boolean }) {
  const [state, setState] = useState<Book | Pending | undefined>();
  const [views, setViews] = useState<Record<string, "tutorial" | "analysis" | "sources">>({});
  const [asked, setAsked] = useState(false);

  const look = async () => {
    const response = await fetch(`/api/work-orders/${encodeURIComponent(workOrderId)}/manualbook`, { cache: "no-store" }).catch(() => undefined);
    const next = await response?.json().catch(() => undefined) as Book | Pending | undefined;
    if (next) setState(next);
  };
  useEffect(() => { void look(); }, [workOrderId]); // eslint-disable-line react-hooks/exhaustive-deps
  const running = Boolean(state?.building || preparing || asked);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void look(), 5000);
    return () => clearInterval(timer);
  }, [running]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (state && !state.building && asked && (state.built || state.blocker)) setAsked(false); }, [state, asked]);

  const generate = async () => {
    setAsked(true);
    const response = await fetch(`/api/work-orders/${encodeURIComponent(workOrderId)}/tutorial`, { method: "POST" }).catch(() => null);
    if (!response?.ok) setAsked(false);
    void look();
  };
  if (!state) return <p className="muted">读取中…</p>;
  const status = running
    ? <p role="status" className="muted">正在生成教程：{state.progress ? `${STAGE[state.progress.stage] ?? state.progress.stage}（${state.progress.done}/${state.progress.total}）` : "排队中"}…</p>
    : state.blocker ? <p role="status">上次未能生成：{state.blocker}</p> : null;

  if (!state.built) return <section className="manualbook" aria-label="教程">
    {status}
    {!running && <p className="muted">教程按该任务的步骤逐步写出：先读本人上传的课程文件，再联网查找资料，每份材料附针对本任务的解析。7 天内排有时间的任务会自动生成。</p>}
    {!running && canBuild && <button type="button" className="primary-button" onClick={() => void generate()}>{state.blocker ? "重新生成" : "生成教程"}</button>}
  </section>;

  const nodes = [...state.flow.nodes].sort((a, b) => (a.order ?? a.stage) - (b.order ?? b.stage));
  const overview = state.manual.split("\n## 流程")[0]?.replace(/^# .*\n+/, "").trim();
  return <section className="manualbook" aria-label="教程">
    <header className="mb-head">{status ?? <span />}
      {canBuild && !running && <button type="button" className="secondary-button" onClick={() => void generate()}>重新生成</button>}</header>
    {overview && <Markdown className="gen mb-overview" text={overview} />}
    <ol className="mb-steps">{nodes.map((node, index) => {
      const content = state.nodes[node.id];
      const view = views[node.id] ?? "tutorial";
      const sources = content?.sources ?? [];
      return <li key={node.id} className="mb-step">
        <header><h4>{index + 1}. {node.title}</h4><small className="muted">{KIND[node.kind] ?? node.kind}{node.goal ? ` · ${node.goal}` : ""}</small></header>
        <div className="cal-tabs" role="tablist" aria-label={`${node.title} 的内容`}>
          {([["tutorial", "教程"], ["analysis", "资料解析"], ["sources", `来源（${sources.length}）`]] as const).map(([id, label]) =>
            <button key={id} type="button" role="tab" aria-selected={view === id} onClick={() => setViews((current) => ({ ...current, [node.id]: id }))}>{label}</button>)}
        </div>
        {view === "sources"
          ? <ul className="mb-sources">{sources.map((source) => <li key={source.id}>
              <a href={source.url} target="_blank" rel="noreferrer noopener">{source.title}</a> <small>{source.publisher}</small>
              <span className="tag">{source.kept === "full_text" ? "已存全文" : "链接与摘要"}</span>
              <p className="gen">{source.summary}</p>
              {source.uri && <small><a href={`/api/work-orders/${encodeURIComponent(workOrderId)}/materials?uri=${encodeURIComponent(source.uri)}`} target="_blank" rel="noreferrer">打开本地副本</a></small>}
            </li>)}{sources.length === 0 && <li className="muted">该步骤只用到本人上传的文件。</li>}</ul>
          : <Markdown className="mb-text gen" text={body(view === "tutorial" ? content?.tutorial || content?.task || "" : content?.analysis || "") || "该步骤没有这部分内容。"} />}
      </li>;
    })}</ol>
  </section>;
}
