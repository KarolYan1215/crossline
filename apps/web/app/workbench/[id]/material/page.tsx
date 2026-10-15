import { readFileSync } from "node:fs";
import path from "node:path";
import { notFound } from "next/navigation";
import { pathToFileURL } from "node:url";
import { SubpageShell } from "../../../subpage-shell";
import { requireSessionContext } from "../../../../lib/access-guard";
import { gateUntilReady } from "../../../../lib/start-gate";
import { dataDirectory, getStore } from "../../../../lib/crossline";
import { MaterialViewer } from "../../../materials/material-viewer";
import { fileDigest } from "../../../materials/material-digest";
import { stepAnchor } from "../../../materials/tutorial-model";

export const dynamic = "force-dynamic";

type Listed = { title: string; publisher: string; url: string; docId?: string; kept: string; verdict: string; summary: string; file?: string;
  notes: Array<{ node: string; step: string; note: string }> };
const KEPT: Record<string, string> = { full_text: "已存全文", summary_only: "链接与摘要", unverified: "未能自动核实" };

/**
 * One material of a task on its own page: the material itself drawn in place (the person's file, or the copy the tutorial kept, or its
 * link and summary), and beside it what it is and which steps of the task it serves, with what the tutorial says about it for each.
 * `?doc=<id>` is an uploaded file, `?m=<n>` a material the tutorial found.
 */
export default async function MaterialPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ doc?: string; m?: string }> }) {
  const ctx = await requireSessionContext();
  gateUntilReady(ctx);
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
  const src = document ? `/api/source-documents/${encodeURIComponent(document.id)}/file` : kept ? `/api/work-orders/${encodeURIComponent(id)}/materials?uri=${encodeURIComponent(kept.uri)}` : undefined;
  const plan = store.getStepPlan(ctx.workspaceId, id);
  const digest = fileDigest({ fileName: document?.fileName ?? entry?.file ?? title, extractedText: document?.extractedText ?? "", notes: entry?.notes ?? [],
    steps: (plan?.steps ?? []).map((step) => ({ id: step.id, title: step.title, ...(step.covers ? { covers: step.covers } : {}) })),
    units: (plan?.units ?? []).map((unit) => ({ id: unit.id, title: unit.title, quote: unit.quote })) });
  const taskHref = `/workbench/${encodeURIComponent(id)}`;

  const aside = <div className="mt-digest">
    <h2>这份材料</h2>
    <p className="mt-digest-kind">
      <span className="tag">{document ? "本人上传" : entry!.publisher || "网络"}</span>
      {document ? <small>{digest.kindLabel}{digest.characters ? ` · 约 ${digest.characters.toLocaleString("zh-CN")} 字` : ""}</small>
        : <small>{KEPT[entry!.kept] ?? "链接与摘要"}</small>}
    </p>
    {!document && entry!.summary && <p className="gen">{entry!.summary}</p>}
    {digest.sections.length > 0 && <><h3>包含</h3><ul className="mt-digest-sections">{digest.sections.map((section) => <li key={section}>{section}</li>)}</ul></>}
    <h3>与步骤的关系</h3>
    {digest.steps.length ? <ol className="mt-digest-steps">{digest.steps.map((step) => <li key={step.title}>
      {step.stepId ? <a href={`${taskHref}#${stepAnchor(step.stepId)}`}>{step.title}</a> : <b>{step.title}</b>}
      {step.notes.map((note, index) => <p key={index} className="gen">{note}</p>)}
      {!step.notes.length && <small className="muted">该步骤的内容取自这份文件。</small>}
    </li>)}</ol> : <p className="muted">尚无解析。任务的教程生成时，会逐份材料写出与各步骤相关的要点。</p>}
  </div>;

  return <SubpageShell active="任务" title={title}>
    <p className="material-back"><a href={taskHref}>← {order.intent}</a></p>
    {src ? <MaterialViewer src={src} name={document?.fileName ?? entry!.file!.split("/").pop()!} aside={aside} size="page" generated={!document} />
      : <div className="material-viewer" data-aside="">
        <section className="mv-main" aria-label={title}>
          <header className="mv-toolbar"><span className="tag">链接与摘要</span>
            {entry!.url && <span className="mv-actions"><a href={entry!.url} target="_blank" rel="noreferrer noopener">原网页</a></span>}</header>
          <div className="mv-body"><p className="gen long-form">{entry!.summary}</p></div>
        </section>
        <aside className="mv-aside" aria-label="解析">{aside}</aside>
      </div>}
  </SubpageShell>;
}
