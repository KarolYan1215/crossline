import katex from "katex";
import "katex/dist/katex.min.css";
import "./math.css";
import type { ReactNode } from "react";

/** Draws a footnote mark `[^n]` (the tutorial numbers its sources that way); without one the mark stays text. */
export type CiteRenderer = (n: number, key: string) => ReactNode;

/**
 * A formula as KaTeX's own HTML, the only HTML this component ever puts on the page. `trust: false` refuses every command that could
 * reach outside the formula (links, images, classes, ids, styles); `strict: "error"` refuses anything that is not LaTeX, so a stray pair
 * of dollar signs in a shell line is not typeset; `throwOnError` turns any of that into `undefined`, and the caller shows the source text.
 * KaTeX escapes the text it is given, so a `<script>` inside a formula is drawn as characters, never run.
 */
export function renderMath(tex: string, display: boolean): string | undefined {
  if (!tex.trim()) return undefined;
  try {
    const html = katex.renderToString(tex, { displayMode: display, throwOnError: true, trust: false, strict: "error", maxSize: 10, maxExpand: 200, errorColor: REFUSED });
    // An untrusted command (`\href`, `\htmlClass`, …) is not an error to KaTeX: it is drawn in the error colour. That is a failure here.
    return html.includes(REFUSED) ? undefined : html;
  } catch {
    return undefined;
  }
}
const REFUSED = "#cc0001";

/** One formula: KaTeX's rendering, or — when KaTeX cannot read it — the source exactly as written. */
function Formula({ tex, display, source }: { tex: string; display: boolean; source: string }) {
  const html = renderMath(tex, display);
  if (!html) return <>{source}</>;
  return <span className={display ? "md-math md-math-display" : "md-math"} dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * Inline marks: `**bold**`, `` `code` ``, `$$display$$`, `$inline$` (a `$` not followed by a space, closed by one not preceded by a space
 * or a backslash and not followed by a digit — so 「$5 和 $10」 stays text), and `[^n]` footnotes when `cite` is given.
 */
const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\$\$[^$]+?\$\$|\$(?![\s$])[^$\n]+?(?<![\s\\])\$(?!\d))/;
const INLINE_CITE = /(\*\*[^*]+\*\*|`[^`]+`|\$\$[^$]+?\$\$|\$(?![\s$])[^$\n]+?(?<![\s\\])\$(?!\d)|\[\^\d{1,3}\])/;

/** One line's marks; everything that is not a mark stays text (nothing is parsed as HTML). */
function inline(text: string, key: string, cite?: CiteRenderer): ReactNode[] {
  // With one capturing group, `split` puts the marks at the odd places and the text between them at the even ones.
  return text.split(new RegExp((cite ? INLINE_CITE : INLINE).source, "g")).flatMap((part, index): ReactNode[] => {
    const at = `${key}-${index}`;
    if (!part) return [];
    if (index % 2 === 0) return [part];
    if (part.startsWith("**")) return [<b key={at}>{inline(part.slice(2, -2), at, cite)}</b>];
    if (part.startsWith("`")) return [<code key={at}>{part.slice(1, -1)}</code>];
    if (part.startsWith("$$")) return [<Formula key={at} tex={part.slice(2, -2)} display source={part} />];
    if (part.startsWith("$")) return [<Formula key={at} tex={part.slice(1, -1)} display={false} source={part} />];
    return cite ? [cite(Number(part.slice(2, -1)), at)] : [part];
  });
}

const tableCells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
const isTableRule = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

/**
 * The small part of Markdown model-written text actually uses — headings, bulleted and numbered lists, bold, inline code, paragraphs —
 * drawn as such instead of showing 「## 假设」 and 「- 」 to the person. Pipe tables and `>` quotes too (what the assistant writes in a
 * ledger or a checklist). No HTML is ever interpreted. `cite` draws the tutorial's `[^n]` footnote marks.
 */
/**
 * A long paragraph cut into paragraphs of whole sentences, each at most about `max` characters (one sentence longer than that stays
 * whole). Reading pages show documents and tutorials in full, but a 2,000-character block of a syllabus is easier read in pieces.
 */
export function splitParagraph(text: string, max = 300): string[] {
  if (text.length <= max) return [text];
  // Cut after a sentence's closing mark (and its closing quote), or after an English full stop followed by a space; nothing is dropped.
  const sentences = text.split(/(?<=[。！？!?])(?![”’」』）)"。！？!?])|(?<=[。！？!?][”’」』）)"])|(?<=\.)(?=\s)/);
  const parts: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && (current + sentence).length > max) { parts.push(current.trim()); current = ""; }
    current += sentence;
  }
  if (current.trim()) parts.push(current.trim());
  return parts.length ? parts : [text];
}

const SENTENCE_END = /[。！？!?；;.]["”’」』）)]?$/;

export function Markdown({ text, className, cite }: { text: string; className?: string; cite?: CiteRenderer }) {
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; start: number; items: string[] } | null = null;
  let paragraph: string[] = [];
  const flushParagraph = () => {
    for (const part of paragraph.length ? splitParagraph(paragraph.join(" ")) : []) blocks.push(<p key={`p${blocks.length}`}>{inline(part, `p${blocks.length}`, cite)}</p>);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((item, index) => <li key={index}>{inline(item, `l${blocks.length}-${index}`, cite)}</li>);
    // A numbered list keeps its own numbers: a loose list (items apart by blank lines) is drawn as several, each starting where it left off.
    blocks.push(list.ordered ? <ol key={`l${blocks.length}`} start={list.start === 1 ? undefined : list.start}>{items}</ol> : <ul key={`l${blocks.length}`}>{items}</ul>);
    list = null;
  };
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trimEnd();
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*(\d+)[.)、]\s+(.*)$/.exec(line);
    if (!line.trim()) { flushParagraph(); flushList(); continue; }
    if (heading) { flushParagraph(); flushList(); blocks.push(<h5 key={`h${blocks.length}`}>{inline(heading[2]!, `h${blocks.length}`, cite)}</h5>); continue; }
    // A display formula: `$$ … $$` on one line, or opened by a line starting `$$` and closed by one ending `$$`. Unclosed, it is text.
    if (line.trimStart().startsWith("$$")) {
      let end = index;
      while (end < lines.length && !(end === index ? /\$\$\s*$/.test(line.trimStart().slice(2)) : /\$\$\s*$/.test(lines[end]!))) end += 1;
      if (end < lines.length) {
        flushParagraph(); flushList();
        const source = lines.slice(index, end + 1).join("\n").trim();
        const key = `m${blocks.length}`;
        const html = renderMath(source.slice(2, -2), true);
        blocks.push(html ? <div key={key} className="md-math md-math-display" dangerouslySetInnerHTML={{ __html: html }} /> : <p key={key}>{source}</p>);
        index = end;
        continue;
      }
    }
    if (line.includes("|") && isTableRule(lines[index + 1] ?? "")) {
      flushParagraph(); flushList();
      const head = tableCells(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index]!.includes("|") && lines[index]!.trim()) rows.push(tableCells(lines[index++]!));
      index -= 1;
      const key = `t${blocks.length}`;
      blocks.push(<div key={key} className="md-table-wrap"><table className="md-table">
        <thead><tr>{head.map((cell, column) => <th key={column} scope="col">{inline(cell, `${key}-h${column}`, cite)}</th>)}</tr></thead>
        <tbody>{rows.map((row, at) => <tr key={at}>{head.map((_, column) => <td key={column}>{inline(row[column] ?? "", `${key}-${at}-${column}`, cite)}</td>)}</tr>)}</tbody>
      </table></div>);
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) { flushParagraph(); flushList(); blocks.push(<blockquote key={`q${blocks.length}`}>{inline(quote[1]!, `q${blocks.length}`, cite)}</blockquote>); continue; }
    if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, start: numbered ? Number(numbered[1]) : 1, items: [] };
      list.items.push(bullet ? bullet[1]! : numbered![2]!);
      continue;
    }
    flushList();
    // A line that ends a sentence ends its paragraph: a file written one entry per line (「[2026-08-27] - …。」) stays one entry per
    // paragraph instead of running together into a single block, while a line wrapped mid-sentence still joins the next.
    if (paragraph.length && SENTENCE_END.test(paragraph[paragraph.length - 1]!)) flushParagraph();
    paragraph.push(line.trim());
  }
  flushParagraph(); flushList();
  return <div className={["md-text", className].filter(Boolean).join(" ")}>{blocks}</div>;
}
