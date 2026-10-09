import type { ReactNode } from "react";

/** `**bold**` and `` `code` `` inside a line; everything else stays text (nothing is parsed as HTML). */
function inline(text: string, key: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map((part, index) =>
    part.startsWith("**") && part.endsWith("**") ? <b key={`${key}-${index}`}>{part.slice(2, -2)}</b>
      : part.startsWith("`") && part.endsWith("`") ? <code key={`${key}-${index}`}>{part.slice(1, -1)}</code>
        : part);
}

/**
 * The small part of Markdown model-written text actually uses — headings, bulleted and numbered lists, bold, inline code, paragraphs —
 * drawn as such instead of showing 「## 假设」 and 「- 」 to the person. No HTML is ever interpreted.
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length) blocks.push(<p key={`p${blocks.length}`}>{inline(paragraph.join(" "), `p${blocks.length}`)}</p>);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((item, index) => <li key={index}>{inline(item, `l${blocks.length}-${index}`)}</li>);
    blocks.push(list.ordered ? <ol key={`l${blocks.length}`}>{items}</ol> : <ul key={`l${blocks.length}`}>{items}</ul>);
    list = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)、]\s+(.*)$/.exec(line);
    if (!line.trim()) { flushParagraph(); flushList(); continue; }
    if (heading) { flushParagraph(); flushList(); blocks.push(<h5 key={`h${blocks.length}`}>{inline(heading[2]!, `h${blocks.length}`)}</h5>); continue; }
    if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1]!);
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  flushParagraph(); flushList();
  return <div className={["md-text", className].filter(Boolean).join(" ")}>{blocks}</div>;
}
