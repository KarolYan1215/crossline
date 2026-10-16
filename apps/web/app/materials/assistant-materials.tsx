"use client";

import "./materials.css";
import { useEffect, useMemo, useState } from "react";
import type { GroupedOutputs, OutputItem } from "../approvals/assistant-outputs";
import { Tag, type TagTone } from "../ui/tag";
import { Clamp } from "../ui/clamp";
import { checklistOf, flowOf, ledgerOf, outlineOf, previewBlocks, treeOf, visualFor, type TreeNode, type Visual } from "./assistant-visual";
import { spansText, type DocBlock } from "./doc-blocks";
import { Namer, cleanText, humanTable, humanizeBlocks, type Names, type Status } from "./humanize";
import { isTooling, materialKind, viewerHref, withQuery } from "./kinds";
import type { MaterialPreview } from "./preview";
import { stepAnchor } from "./tutorial-model";
import { useLocale, useT } from "../locale-context";

export type AssistantOutput = { taskId: string; title: string; status: string; stepId: string; files: Array<{ path: string; name: string }> };
export type AssistantMaterialsProps = {
  /** What the assistant produced for the task (`TaskDetail.agentOutputs`). */
  outputs: AssistantOutput[];
  /** The task's steps, so each run is shown under the step it was for and links to it. */
  steps?: Array<{ id: string; title: string }>;
  /** Where a step link goes; default `#step-<stepId>`. */
  stepHref?: (stepId: string) => string;
};

const fileHref = (taskId: string, path: string) => `/api/agent/tasks/${encodeURIComponent(taskId)}/file?path=${encodeURIComponent(path)}`;
const VIEWABLE = new Set(["markdown", "text", "docx", "csv", "pdf", "image"]);

function Tree({ nodes }: { nodes: TreeNode[] }) {
  return <ul className="av-tree">{nodes.map((node, index) => <li key={index}>
    {/* A leaf can be a whole sentence of the catalogue; two lines in the tree, the rest with 「全文」. */}
    <span className="gen"><Clamp text={node.label} /></span>{node.note && <small className="gen muted"> {node.note}</small>}
    {node.children.length > 0 && <Tree nodes={node.children} />}
  </li>)}</ul>;
}

type Loaded = { blocks: DocBlock[]; title: string } | null;

/** A file's preview as blocks, read once it is on the page; its title is its first heading, cleaned like the rest. */
function usePreview(src: string | undefined, namer: Namer): Loaded | undefined {
  const [preview, setPreview] = useState<MaterialPreview | null | undefined>(src ? undefined : null);
  useEffect(() => {
    if (!src) return;
    let live = true;
    const load = async () => {
      const response = await fetch(withQuery(src, "view", "preview"), { cache: "no-store" }).catch(() => undefined);
      return response?.ok ? await (response.json() as Promise<MaterialPreview>).catch(() => null) : null;
    };
    void load().then((value) => { if (live) setPreview(value); });
    return () => { live = false; };
  }, [src]);
  if (preview === undefined) return undefined;
  if (!preview) return null;
  const blocks = previewBlocks(preview);
  const heading = humanizeBlocks(blocks.filter((block) => block.t === "h").slice(0, 1), namer)[0];
  return { blocks, title: heading && heading.t === "h" ? spansText(heading.spans) : "" };
}

/** One file drawn by its use, from its raw blocks; every string on the way out is cleaned of paths, hashes and internal codes. */
function Drawing({ blocks, visual, namer }: { blocks: DocBlock[]; visual: Visual; namer: Namer }) {
  // A ledger or a checklist shows its first rows; the rest are one click away, so the task detail stays short.
  const t = useT();
  const [all, setAll] = useState(false);
  const more = (total: number) => total > SHORT && <button type="button" className="text-button av-more" aria-expanded={all} onClick={() => setAll(!all)}>
    {all ? t("收起") : t("显示全部 {{count}} 项", { count: total })}</button>;
  if (!blocks.length) return null;
  if (visual === "ledger") {
    const raw = ledgerOf(blocks);
    const table = raw && humanTable(raw.header, raw.rows, namer);
    if (table?.kind === "summary") return <p className="gen av-summary">{table.text}</p>;
    if (table) return <div className="doc-table-wrap"><table className="doc-table gen">
      {table.header.length > 0 && <thead><tr>{table.header.map((cell, index) => <th key={index} scope="col">{cell}</th>)}</tr></thead>}
      <tbody>{table.rows.slice(0, all ? 60 : SHORT).map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}>{cell}</td>)}</tr>)}</tbody>
    </table>{more(table.total)}{all && table.total > 60 && <small className="muted">{t("共 {{count}} 行，显示前 60 行", { count: table.total })}</small>}</div>;
  }
  if (visual === "checklist") {
    const rows = checklistOf(blocks, namer);
    if (rows.length) {
      const done = rows.filter((row) => row.done).length;
      return <div className="av-check">
        <p className="av-check-count"><span className="av-check-bar" aria-hidden="true"><span style={{ width: `${(done / rows.length) * 100}%` }} /></span>
          <small>{t("{{done}} / {{total}} 项已有", { done, total: rows.length })}</small></p>
        <ul>{rows.slice(0, all ? 60 : SHORT).map((row, index) => <li key={index} data-done={row.done === undefined ? undefined : String(row.done)}>
          {row.status ? <Tag tone={STATUS_TONE[row.status]}>{t(row.status)}</Tag>
            : <span className="doc-check" aria-label={row.done ? t("已有") : t("未有")}>{row.done ? "☑" : "☐"}</span>}
          <span className="gen">{row.label}</span>{row.note && <small className="gen muted">{row.note}</small>}</li>)}</ul>
        {more(rows.length)}
      </div>;
    }
  }
  const human = humanizeBlocks(blocks, namer);
  if (visual === "tree") {
    const tree = treeOf(human);
    if (tree.length) return <Tree nodes={tree.slice(0, 40)} />;
  }
  if (visual === "flow") {
    const steps = flowOf(human);
    if (steps.length >= 2) return <ol className="av-flow">{steps.slice(0, 12).map((step, index) => <li key={index}><span className="mono">{index + 1}</span><span className="gen">{step}</span></li>)}</ol>;
  }
  const outline = outlineOf(human);
  return outline.headings.length >= 2
    ? <ol className="av-outline gen">{outline.headings.map((heading, index) => <li key={index}>{heading}</li>)}</ol>
    : outline.opening ? <p className="gen av-opening">{outline.opening}{outline.opening.length >= 240 ? "…" : ""}</p> : null;
}

const SHORT = 4;
const STATUS_TONE: Record<Status, TagTone> = { 可访问: "ok", 缺: "risk", 待核验: "warn" };
const DRAWN = new Set(["markdown", "text", "docx", "csv"]);
/** A file stem the assistant made up for itself (`material-gaps`) is not a title. */
const TECHNICAL_NAME = /^[\x20-\x7e]*[-_][\x20-\x7e]*$/;

function OutputCard({ taskId, item, group, namer }: { taskId: string; item: OutputItem; group: string; namer: Namer }) {
  const src = fileHref(taskId, item.path);
  const kind = materialKind(item.path);
  const read = VIEWABLE.has(kind) ? viewerHref(src, item.path.split("/").pop() ?? item.name) : src;
  const visual = visualFor(group, item.name, item.purpose);
  const loaded = usePreview(DRAWN.has(kind) ? (item.previewPath ? fileHref(taskId, item.previewPath) : src) : undefined, namer);
  const named = cleanText(item.name, namer);
  const title = loaded?.title || (named && !TECHNICAL_NAME.test(named) ? named : namer.t(group));
  const purpose = cleanText(item.purpose, namer);
  const t = namer.t;
  return <li className="av-item" data-visual={visual}>
    <p className="av-item-head"><a href={read}><b className="gen">{title}</b></a>
      <a className="av-download" href={withQuery(src, "download", "1")} download>{t("下载")}</a></p>
    {purpose && visual !== "ledger" && <p className="gen av-purpose">{purpose}</p>}
    {loaded === undefined && DRAWN.has(kind) && <p className="muted"><small>{t("读取中…")}</small></p>}
    {loaded && <Drawing blocks={loaded.blocks} visual={visual} namer={namer} />}
    {kind === "image" && <img className="mv-image" src={src} alt={title} loading="lazy" />}
  </li>;
}

/** One run's results, grouped by use; when its grouping cannot be read, its files by name (scaffolding left out). */
function Run({ output }: { output: AssistantOutput }) {
  const t = useT();
  const locale = useLocale();
  const [grouped, setGrouped] = useState<(GroupedOutputs & { names?: Names }) | null | undefined>();
  // The readable names of the files this run read, keyed by the hash its copy was stored under and the code it gave each one.
  const namer = useMemo(() => new Namer(grouped?.names ?? {}, locale), [grouped, locale]);
  useEffect(() => {
    let live = true;
    void fetch(`/api/agent/tasks/${encodeURIComponent(output.taskId)}/file?view=outputs`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<GroupedOutputs & { names?: Names }> : null).catch(() => null)
      .then((value) => { if (live) setGrouped(value); });
    return () => { live = false; };
  }, [output.taskId]);
  if (grouped === undefined) return <p className="muted"><small>{t("读取中…")}</small></p>;
  const groups = grouped?.groups.length ? grouped.groups : [{ group: "成品", items: output.files.filter((file) => !isTooling(file.path)).map((file): OutputItem => ({
    path: file.path.replace(/\\/g, "/"), name: file.name.replace(/\.[^.]+$/, ""), purpose: "", group: "成品", preview: "none" })) }].filter((entry) => entry.items.length);
  if (!groups.length) return <p className="muted"><small>{t("这次没有可读的成品。")}</small></p>;
  return <>{groups.map((entry) => <section key={entry.group} className="av-group" aria-label={t(entry.group)}>
    <h5>{t(entry.group)} · {entry.items.length}</h5>
    <ul>{entry.items.map((item) => <OutputCard key={item.path} taskId={output.taskId} item={item} group={entry.group} namer={namer} />)}</ul>
  </section>)}</>;
}

/**
 * What the assistant made for a task, by what it is for and drawn as such (a catalogue as a tree, a ledger as a table, a list of gaps as
 * a checklist, a procedure as steps), under the step it was made for. Scripts and other scaffolding are never listed. Only results that
 * are ready (accepted, or waiting for review) are shown.
 */
export function AssistantMaterials({ outputs, steps = [], stepHref = (id) => `#${stepAnchor(id)}` }: AssistantMaterialsProps) {
  const t = useT();
  const ready = outputs.filter((output) => (output.status === "accepted" || output.status === "needs_review") && output.files.length);
  if (!ready.length) return null;
  return <div className="assistant-materials">{ready.map((output) => {
    const step = steps.find((item) => item.id === output.stepId);
    return <article key={output.taskId} className="av-run">
      <header><b className="gen">{output.title}</b>
        {output.status === "needs_review" && <span className="tag">{t("待审阅")}</span>}
        {step && <a href={stepHref(step.id)}>{t("步骤：{{step}}", { step: step.title })}</a>}</header>
      <Run output={output} />
    </article>;
  })}</div>;
}
