"use client";

import "./materials.css";
import { useEffect, useState, type ReactNode } from "react";
import { Markdown } from "../ui/markdown";
import { DocBlocksView } from "./doc-view";
import { KIND_LABEL, materialKind, withQuery } from "./kinds";
import type { MaterialPreview } from "./preview";

export type MaterialViewerProps = {
  /** The file route: `/api/source-documents/<id>/file`, `/api/agent/tasks/<id>/file?path=…` or `/api/work-orders/<id>/materials?uri=…`. */
  src: string;
  /** The file's own name (its extension decides how it is drawn). */
  name: string;
  /** Shown beside the material on a wide screen and under it on a phone: what the file is and which steps it serves. */
  aside?: ReactNode;
  /** The assistant's or the tutorial's text: drawn in the model-written face. The person's own files are not. */
  generated?: boolean;
  /** `page` lets the material run the page's length; `panel` (default) keeps it in a box that scrolls. */
  size?: "page" | "panel";
};

/**
 * One material, drawn as a page rather than handed to the browser: Markdown as headings, lists and tables; a Word file or a PDF as its
 * structured text (a PDF's original layout one tab away); a table as a table; an image as itself. The original is always one click away
 * (下载原文件, and 新窗口打开 for what the browser shows itself). Nothing in a file is ever run as HTML.
 */
export function MaterialViewer({ src, name, aside, generated = false, size = "panel" }: MaterialViewerProps) {
  const kind = materialKind(name);
  const [preview, setPreview] = useState<MaterialPreview | "failed" | undefined>();
  const [original, setOriginal] = useState(false);
  useEffect(() => {
    let live = true;
    setPreview(undefined);
    if (kind === "image") { setPreview({ kind: "image" }); return; }
    const load = async (): Promise<MaterialPreview | "failed"> => {
      const response = await fetch(withQuery(src, "view", "preview"), { cache: "no-store" }).catch(() => undefined);
      return response?.ok ? await (response.json() as Promise<MaterialPreview>).catch(() => "failed" as const) : "failed";
    };
    void load().then((value) => { if (live) setPreview(value); });
    return () => { live = false; };
  }, [src, kind]);

  const pdf = kind === "pdf";
  const body = (() => {
    if (!preview) return <p className="muted" role="status">读取中…</p>;
    if (preview === "failed") return <p role="status">这份材料读取失败。可下载原文件查看。</p>;
    if (pdf && (original || preview.kind === "pdf")) return <iframe className="mv-frame" src={src} title={name} />;
    switch (preview.kind) {
      case "markdown": return <>
        <Markdown className={["long-form", "mv-markdown", generated ? "gen" : ""].filter(Boolean).join(" ")} text={preview.text} />
        {preview.truncated && <p className="muted">文件较长，此处显示前一部分；全文见原文件。</p>}
      </>;
      case "doc": return <>
        {preview.note && <p className="mv-note"><small>{preview.note}</small></p>}
        <DocBlocksView className={["long-form", generated ? "gen" : ""].filter(Boolean).join(" ")} blocks={preview.blocks} />
      </>;
      case "table": return <div className="doc-table-wrap"><table className={["doc-table", generated ? "gen" : ""].filter(Boolean).join(" ")}>
        <thead><tr>{preview.header.map((cell, index) => <th key={index} scope="col">{cell}</th>)}</tr></thead>
        <tbody>{preview.rows.map((row, index) => <tr key={index}>{preview.header.map((_, column) => <td key={column}>{row[column] ?? ""}</td>)}</tr>)}</tbody>
      </table><small className="muted">共 {preview.totalRows} 行{preview.totalRows > preview.rows.length ? `，显示前 ${preview.rows.length} 行` : ""}</small></div>;
      case "image": return <img className="mv-image" src={src} alt={name} />;
      default: return <p className="mv-note">{preview.note}</p>;
    }
  })();

  return <div className="material-viewer" data-size={size} data-aside={aside ? "" : undefined}>
    <section className="mv-main" aria-label={name}>
      <header className="mv-toolbar">
        <span className="tag">{KIND_LABEL[kind]}</span>
        {pdf && preview && preview !== "failed" && preview.kind === "doc" && <span className="mv-switch" role="group" aria-label="显示方式">
          <button type="button" aria-pressed={!original} onClick={() => setOriginal(false)}>文字</button>
          <button type="button" aria-pressed={original} onClick={() => setOriginal(true)}>原版式</button>
        </span>}
        <span className="mv-actions">
          {(pdf || kind === "image") && <a href={src} target="_blank" rel="noreferrer">新窗口打开</a>}
          <a href={withQuery(src, "download", "1")} download={name}>下载原文件</a>
        </span>
      </header>
      <div className="mv-body">{body}</div>
    </section>
    {aside && <aside className="mv-aside" aria-label="解析">{aside}</aside>}
  </div>;
}
