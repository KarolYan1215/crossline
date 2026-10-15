import { blockText, markdownToBlocks, spansText, type DocBlock } from "./doc-blocks";
import { Namer, cleanText, firstSentence, gapRows, statusOf, type Status } from "./humanize";
import type { MaterialPreview } from "./preview";

/**
 * What the assistant made, drawn by what it is for (the person's direction, 2026-10-15): a catalogue as a tree, a ledger as a table, a
 * list of gaps or to-dos as a checklist, a procedure as a row of steps, anything else as the document's outline. The groups themselves
 * come from `groupOutputs` (approvals/assistant-outputs.ts); this decides the drawing and reads the shape out of the file. Pure.
 */
export type Visual = "tree" | "ledger" | "checklist" | "flow" | "document";

export function visualFor(group: string, name: string, purpose: string): Visual {
  if (group === "材料目录") return "tree";
  if (group === "文件台账") return "ledger";
  if (group === "缺口清单") return "checklist";
  if (/流程|步骤|工作流|操作顺序|pipeline|workflow|procedure/i.test(`${name} ${purpose}`)) return "flow";
  if (/清单|checklist|待办|核对/i.test(`${name} ${purpose}`)) return "checklist";
  return "document";
}

/** A preview as blocks, whatever it came as: Markdown is read into blocks, a CSV becomes one table. */
export function previewBlocks(preview: MaterialPreview): DocBlock[] {
  if (preview.kind === "markdown") return markdownToBlocks(preview.text);
  if (preview.kind === "doc") return preview.blocks;
  if (preview.kind === "table") return [{ t: "table", header: true, rows: [preview.header, ...preview.rows].map((row) => row.map((cell) => [{ text: cell }])) }];
  return [];
}

export type TreeNode = { label: string; note?: string; children: TreeNode[] };

/**
 * A catalogue's tree: headings are branches by level, list items hang under the heading above them at their own depth, and a table's
 * rows become leaves named by their first cell with the rest as a note.
 */
export function treeOf(blocks: DocBlock[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const headings: Array<{ level: number; node: TreeNode }> = [];
  const parent = () => headings.at(-1)?.node.children ?? roots;
  for (const block of blocks) {
    if (block.t === "h") {
      const node: TreeNode = { label: spansText(block.spans), children: [] };
      while (headings.length && headings.at(-1)!.level >= block.level) headings.pop();
      parent().push(node);
      headings.push({ level: block.level, node });
    } else if (block.t === "list") {
      const stack: Array<{ depth: number; node: TreeNode }> = [];
      for (const item of block.items) {
        const node: TreeNode = { label: spansText(item.spans), children: [] };
        while (stack.length && stack.at(-1)!.depth >= item.depth) stack.pop();
        (stack.at(-1)?.node.children ?? parent()).push(node);
        stack.push({ depth: item.depth, node });
      }
    } else if (block.t === "table") {
      const rows = block.header ? block.rows.slice(1) : block.rows;
      for (const row of rows) {
        const [first, ...rest] = row.map(spansText);
        // A leaf's note is its next two cells: a catalogue row's date and topic, not every remark the ledger keeps about it.
        const note = rest.filter((cell) => cell.trim()).slice(0, 2).join(" · ");
        if (first?.trim()) parent().push({ label: first.trim(), ...(note ? { note } : {}), children: [] });
      }
    }
  }
  // A document whose only heading is its title: the title is not a level of the tree.
  return roots.length === 1 && roots[0]!.children.length ? roots[0]!.children : roots;
}

/** A ledger's table: the first table in the file (a CSV is one), with its header. */
export function ledgerOf(blocks: DocBlock[]): { header: string[]; rows: string[][] } | undefined {
  const table = blocks.find((block): block is Extract<DocBlock, { t: "table" }> => block.t === "table");
  if (!table) return undefined;
  const rows = table.rows.map((row) => row.map(spansText));
  return table.header ? { header: rows[0] ?? [], rows: rows.slice(1) } : { header: [], rows };
}

export type CheckRow = { label: string; status?: Status; note?: string; done?: boolean };

/**
 * A checklist's rows: list items (with their own [x]) or table rows. A table with a header is read by its columns (`gapRows`): a short
 * title, a status (可访问 / 缺 / 待核验) and one sentence, never the row's whole run of fields; one without a header takes its first
 * cell as the title and a cell that reads as a status as the status. Every string is cleaned of paths, hashes and codes.
 */
export function checklistOf(blocks: DocBlock[], namer: Namer = new Namer()): CheckRow[] {
  const out: CheckRow[] = [];
  for (const block of blocks) {
    if (block.t === "list") for (const item of block.items) {
      const label = cleanText(spansText(item.spans), namer);
      if (label) out.push({ label, ...(item.checked !== undefined ? { done: item.checked } : {}) });
    }
    if (block.t !== "table") continue;
    const cells = block.rows.map((row) => row.map(spansText));
    if (block.header) {
      for (const row of gapRows(cells[0] ?? [], cells.slice(1), namer)) out.push({ ...row, ...(row.status ? { done: row.status === "可访问" } : {}) });
      continue;
    }
    for (const [first = "", ...rest] of cells) {
      const label = cleanText(first, namer);
      if (!label) continue;
      const state = rest.find((cell) => statusOf(cell));
      const status = state === undefined ? undefined : statusOf(state);
      const note = firstSentence(rest.filter((cell) => cell !== state).map((cell) => cleanText(cell, namer)).filter(Boolean).join("；"));
      out.push({ label, ...(status ? { status, done: status === "可访问" } : {}), ...(note ? { note } : {}) });
    }
  }
  return out;
}

/** A procedure's steps: the first numbered list, else the headings under the title. */
export function flowOf(blocks: DocBlock[]): string[] {
  const ordered = blocks.find((block): block is Extract<DocBlock, { t: "list" }> => block.t === "list" && block.ordered);
  if (ordered) return ordered.items.filter((item) => item.depth === 0).map((item) => spansText(item.spans));
  const headings = blocks.filter((block): block is Extract<DocBlock, { t: "h" }> => block.t === "h");
  const top = Math.min(...headings.map((block) => block.level));
  const below = headings.filter((block) => block.level > top);
  return (below.length >= 2 ? below.filter((block) => block.level === Math.min(...below.map((item) => item.level))) : headings).map((block) => spansText(block.spans));
}

/** A document's outline: its headings, else the opening of its first paragraphs. */
export function outlineOf(blocks: DocBlock[]): { headings: string[]; opening: string } {
  return { headings: blocks.filter((block) => block.t === "h").map(blockText).slice(0, 12),
    opening: blocks.filter((block) => block.t === "p").map(blockText).join(" ").slice(0, 240) };
}
