/**
 * 「No large areas of text, and everything clearly readable」 (the owner, 2026-10-15) as a measurement, run in the page by
 * `copy-audit.spec.ts`.
 *
 * A text block is what reads as one paragraph: the text nodes whose nearest box that is not plain inline (a block, a flex or grid item,
 * an inline-block chip) is the same element. Its lines are counted from the rendered line boxes (`Range.getClientRects`), keeping only
 * what is not clipped away — a line-clamped summary with 「全文」 counts the lines it shows, not the lines it holds. Text inside a closed
 * fold is not rendered (`checkVisibility`), so it is not counted either.
 *
 * Outside reading content:
 * - `BLOCK_CHARS` (120) characters or `BLOCK_LINES` (3) lines is the most one block may show. 120 is three lines at the readable
 *   measure of about 40 characters (docs/copy-style.md), so the two limits say the same thing at any width: a block in a wide row may
 *   not dodge the line count by running 90 characters a line. Model-written text (`.gen`) and the person's own words are held to it
 *   too — a summary on a card shows its first lines and opens in place. Characters are counted by the width they take: a Chinese
 *   character as one, a Latin letter, digit, space or mark as half (two of them fill about one Chinese character's width).
 * - A list of more than `LIST_ITEMS` (10) plain text entries is a wall of its own; the first few stay in view and the rest fold.
 *
 * Reading content (`.long-form`: material and tutorial bodies, file previews, a book's reference list; `[data-private]`: the portrait's
 * private half; `[data-reading]`: the portrait type's own paragraph, the one sentence-length result a poster exists to show) has text
 * to read, so it is held to how it reads instead: a paragraph of at most `READING_CHARS` (400, about nine lines — the renderer cuts
 * longer ones at sentence ends, `splitParagraph`) and a line of at most `READING_EM` (48em, the ~46-character measure plus slack).
 *
 * Exempt: an opened `details.advanced` (the sanctioned fold for detail), table cells (a table scrolls in its own box and its cells are
 * data), preformatted layout, chart text (`svg`), screen-reader-only text and the interview's conversation (`.ob-voice`).
 */
export type TextBlockFinding = { text: string; chars: number; lines: number; em: number; where: string };
export type TextBlockFindings = { blocks: TextBlockFinding[]; reading: TextBlockFinding[]; lists: string[] };

export const TEXT_LIMITS = { BLOCK_CHARS: 120, BLOCK_LINES: 3, LIST_ITEMS: 10, READING_CHARS: 400, READING_EM: 48 };

/** Runs in the page (`page.evaluate(textBlockAudit, TEXT_LIMITS)`), so it is self-contained. */
export function textBlockAudit(limits: typeof TEXT_LIMITS): TextBlockFindings {
  const EXEMPT = "details.advanced[open], td, th, pre, svg, script, style, noscript, .sr-only, .ob-voice, [aria-hidden='true']";
  const READING = ".long-form, [data-private], [data-reading]";
  const describe = (element: Element) => `${element.tagName.toLowerCase()}${typeof element.className === "string" && element.className.trim() ? `.${element.className.trim().split(/\s+/).slice(0, 2).join(".")}` : ""}`;
  const shown = (element: Element) => element.checkVisibility({ visibilityProperty: true, opacityProperty: true } as CheckVisibilityOptions)
    && element.getBoundingClientRect().width > 0;
  const blockOf = (element: Element): Element => {
    for (let node: Element | null = element; node && node !== document.body; node = node.parentElement) {
      const display = getComputedStyle(node).display;
      if (display !== "inline" && display !== "contents") return node;
    }
    return document.body;
  };
  // The area a line must fall in to be seen: the intersection of every ancestor that clips its overflow (a line clamp, a held block).
  const clipOf = (element: Element) => {
    let top = -Infinity, bottom = Infinity;
    for (let node: Element | null = element; node && node !== document.documentElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (/hidden|clip/.test(style.overflowY)) {
        const box = node.getBoundingClientRect();
        top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom);
      }
    }
    return { top, bottom };
  };
  const groups = new Map<Element, Text[]>();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const element = node.parentElement;
    if (!element || !node.textContent?.trim() || element.closest(EXEMPT) || !shown(element)) continue;
    const block = blockOf(element);
    groups.set(block, [...(groups.get(block) ?? []), node]);
  }
  const found: TextBlockFindings = { blocks: [], reading: [], lists: [] };
  for (const [block, nodes] of groups) {
    const size = parseFloat(getComputedStyle(block).fontSize) || 14;
    const clip = clipOf(block);
    const all: DOMRect[] = [];
    for (const node of nodes) {
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) if (rect.width > 0) all.push(rect);
    }
    const rects = all.filter((rect) => (rect.top + rect.bottom) / 2 > clip.top && (rect.top + rect.bottom) / 2 < clip.bottom);
    if (!rects.length) continue;
    // Line boxes of one line share a vertical middle (inline chips of another height shift it a little).
    const countLines = (boxes: DOMRect[]) => {
      let count = 0, last = -Infinity;
      for (const middle of boxes.map((rect) => (rect.top + rect.bottom) / 2).sort((a, b) => a - b)) if (middle > last + size * 0.6) { count += 1; last = middle; }
      return count;
    };
    const lines = countLines(rects);
    const shownText = nodes.map((node) => node.textContent ?? "").join("").replace(/\s+/g, " ").trim();
    // Characters actually on screen: a clamped block shows about its visible lines' share of its text.
    const wide = (shownText.match(/[⺀-鿿豈-﫿＀-￯　-〿]/g) ?? []).length;
    const chars = Math.round((wide + (shownText.length - wide) / 2) * Math.min(1, lines / countLines(all)));
    const em = Math.round(Math.max(...rects.map((rect) => rect.width)) / size);
    const finding = { text: shownText.slice(0, 40), chars, lines, em, where: describe(block) };
    if (block.closest(READING)) {
      if (chars > limits.READING_CHARS || (lines > 1 && em > limits.READING_EM)) found.reading.push(finding);
    } else if (chars > limits.BLOCK_CHARS || lines > limits.BLOCK_LINES) found.blocks.push(finding);
  }
  // A list of plain entries (no heading, form or picture in them: those are cards, not entries) longer than the limit.
  for (const list of document.querySelectorAll("ul, ol")) {
    if (list.closest(`nav, ${EXEMPT}, ${READING}`) || !shown(list)) continue;
    const entries = [...list.children].filter((item) => item.tagName === "LI" && shown(item) && item.textContent?.trim()
      && !item.querySelector("h1, h2, h3, h4, h5, img, svg, canvas, input, textarea, select, table, article, section, fieldset"));
    if (entries.length > limits.LIST_ITEMS) found.lists.push(`${describe(list)} · ${entries.length} 项 · ${(entries[0]!.textContent ?? "").trim().slice(0, 24)}`);
  }
  return found;
}
