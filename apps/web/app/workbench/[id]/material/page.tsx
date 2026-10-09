import { readFileSync } from "node:fs";
import path from "node:path";
import { notFound } from "next/navigation";
import { pathToFileURL } from "node:url";
import { SubpageShell } from "../../../subpage-shell";
import { requireSessionContext } from "../../../../lib/access-guard";
import { dataDirectory, getStore } from "../../../../lib/crossline";

export const dynamic = "force-dynamic";

type Listed = { title: string; publisher: string; url: string; docId?: string; kept: string; verdict: string; summary: string; file?: string;
  notes: Array<{ node: string; step: string; note: string }> };

/**
 * One material of a task on its own page: the material itself on the left (the person's file, or the copy the tutorial kept, or its link
 * and summary), and on the right what each step of the tutorial says about it for this task. `?doc=<id>` is an uploaded file, `?m=<n>`
 * a material the tutorial found.
 */
export default async function MaterialPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ doc?: string; m?: string }> }) {
  const ctx = await requireSessionContext();
  const { id } = await params;
  const { doc, m } = await searchParams;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) notFound();
  const store = getStore();
  const order = store.getWorkOrder(ctx.workspaceId, id);
  if (!order) notFound();
  let listed: Listed[] = [];
  try { listed = JSON.parse(readFileSync(path.resolve(dataDirectory(), "materials", id, "materials.json"), "utf8")) as Listed[]; } catch { /* no tutorial yet */ }
  const document = doc ? store.listSourceDocuments(ctx.workspaceId).find((item) => item.id === doc) : undefined;
  const entry = document ? listed.find((item) => item.docId === document.id) : m !== undefined && /^\d{1,3}$/.test(m) ? listed[Number(m)] : undefined;
  if (!document && !entry) notFound();
  const title = document?.fileName ?? entry!.title;
  // A copy the tutorial kept is opened through the materials route, by the address the ledger recorded for it.
  const kept = entry?.file ? store.listMaterials(ctx.workspaceId, id).find((item) => item.uri === pathToFileURL(path.resolve(dataDirectory(), "materials", id, entry.file!)).href) : undefined;
  const isPdf = document ? document.mediaType === "application/pdf" : Boolean(entry?.file?.endsWith(".pdf"));
  const frame = document ? `/api/source-documents/${encodeURIComponent(document.id)}/file` : kept ? `/api/work-orders/${encodeURIComponent(id)}/materials?uri=${encodeURIComponent(kept.uri)}` : undefined;
  const notes = entry?.notes ?? [];
  return <SubpageShell active="任务" title={title}>
    <p className="material-back"><a href={`/workbench/${encodeURIComponent(id)}`}>← {order.intent}</a></p>
    <div className="material-view">
      <section className="material-source" aria-label="材料">
        <header><h2>材料</h2>
          <small className="muted">{document ? "本人上传" : `${entry!.publisher || "网络"} · ${({ full_text: "已存全文", summary_only: "链接与摘要", unverified: "未能自动核实" } as Record<string, string>)[entry!.kept] ?? "链接与摘要"}`}</small>
          {frame && <a href={frame} target="_blank" rel="noreferrer">新窗口打开</a>}
          {entry && !document && entry.url && <a href={entry.url} target="_blank" rel="noreferrer noopener">原网页</a>}</header>
        {frame && isPdf ? <iframe className="material-frame" src={frame} title={title} />
          : document ? <pre className="material-text">{document.extractedText.slice(0, 60_000) || "（该文件没有可显示的文字）"}</pre>
          : frame ? <iframe className="material-frame" src={frame} title={title} />
          : <p className="gen">{entry!.summary}</p>}
      </section>
      <section className="material-analysis" aria-label="解析">
        <header><h2>针对本任务的解析</h2></header>
        {notes.length ? <ol className="material-notes">{notes.map((item, index) => <li key={index}><h3>{item.step}</h3><p className="gen">{item.note}</p></li>)}</ol>
          : <p className="muted">尚无解析。任务的教程生成时，会逐份材料写出与本任务相关的要点、用法和注意事项。</p>}
      </section>
    </div>
  </SubpageShell>;
}
