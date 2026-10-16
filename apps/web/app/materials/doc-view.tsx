import { Fragment, type ReactNode } from "react";
import { splitParagraph } from "../ui/markdown";
import { safeHref, type DocBlock, type ListItem, type Span } from "./doc-blocks";
import { useT } from "../locale-context";

/** One run of text with its marks; a link only to a web address or an anchor. Text, never HTML. */
export function Spans({ spans }: { spans: Span[] }) {
  return <>{spans.map((span, index) => {
    let node: ReactNode = span.text.includes("\n") ? span.text.split("\n").flatMap((line, at) => at ? [<br key={`b${at}`} />, line] : [line]) : span.text;
    if (span.code) node = <code>{node}</code>;
    if (span.sup) node = <sup>{node}</sup>;
    if (span.sub) node = <sub>{node}</sub>;
    if (span.i) node = <em>{node}</em>;
    if (span.b) node = <b>{node}</b>;
    const href = safeHref(span.href);
    if (href) node = <a href={href} target={href.startsWith("#") ? undefined : "_blank"} rel="noreferrer noopener">{node}</a>;
    return <span key={index}>{node}</span>;
  })}</>;
}

/** A flat list with depths drawn as nested lists, so a Word or Markdown outline keeps its levels. */
function List({ ordered, items }: { ordered: boolean; items: ListItem[] }) {
  const t = useT();
  type Node = { item: ListItem; children: Node[] };
  const roots: Node[] = [];
  const stack: Node[] = [];
  for (const item of items) {
    const node: Node = { item, children: [] };
    while (stack.length && stack.at(-1)!.item.depth >= item.depth) stack.pop();
    (stack.at(-1)?.children ?? roots).push(node);
    stack.push(node);
  }
  const draw = (nodes: Node[], top: boolean): ReactNode => {
    const Tag = top && ordered ? "ol" : "ul";
    return <Tag>{nodes.map((node, index) => <li key={index} data-checked={node.item.checked === undefined ? undefined : String(node.item.checked)}>
      {node.item.checked !== undefined && <span className="doc-check" aria-label={node.item.checked ? t("已完成") : t("未完成")}>{node.item.checked ? "☑" : "☐"}</span>}
      <Spans spans={node.item.spans} />{node.children.length > 0 && draw(node.children, false)}</li>)}</Tag>;
  };
  return <>{draw(roots, true)}</>;
}

/**
 * A document's structure drawn as the page's own HTML: headings by level, paragraphs, nested lists, tables that scroll inside their own
 * box on a phone, and laid-out lines kept as laid out. The text is the document's own, so it is not marked as model-written.
 */
export function DocBlocksView({ blocks, className }: { blocks: DocBlock[]; className?: string }) {
  return <div className={["doc-body", className].filter(Boolean).join(" ")}>{blocks.map((block, index) => {
    switch (block.t) {
      case "h": { const Tag = (["h2", "h3", "h4", "h5"] as const)[block.level - 1]!; return <Tag key={index}><Spans spans={block.spans} /></Tag>; }
      case "p": {
        // A long plain paragraph (a syllabus's policy section runs to 2,000 characters) is drawn as several of whole sentences.
        const only = block.spans.length === 1 ? block.spans[0]! : undefined;
        const plain = only && !only.b && !only.i && !only.code && !only.sup && !only.sub && !only.href && !only.text.includes("\n");
        if (plain) return <Fragment key={index}>{splitParagraph(only.text).map((part, at) => <p key={at}>{part}</p>)}</Fragment>;
        return <p key={index}><Spans spans={block.spans} /></p>;
      }
      case "quote": return <blockquote key={index}><Spans spans={block.spans} /></blockquote>;
      case "list": return <List key={index} ordered={block.ordered} items={block.items} />;
      case "layout": return <pre key={index} className="doc-layout">{block.lines.join("\n")}</pre>;
      case "table": {
        const [head, ...rest] = block.header ? block.rows : [undefined, ...block.rows];
        const width = Math.max(...block.rows.map((row) => row.length));
        return <div key={index} className="doc-table-wrap"><table className="doc-table">
          {head && <thead><tr>{Array.from({ length: width }, (_, column) => <th key={column} scope="col"><Spans spans={head[column] ?? []} /></th>)}</tr></thead>}
          <tbody>{rest.map((row, at) => <tr key={at}>{Array.from({ length: width }, (_, column) => <td key={column}><Spans spans={row?.[column] ?? []} /></td>)}</tr>)}</tbody>
        </table></div>;
      }
    }
  })}</div>;
}
