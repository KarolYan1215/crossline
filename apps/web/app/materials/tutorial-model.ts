/**
 * A task's tutorial (the worker's manualbook) turned into a reading page: one section per step of the task, in the step plan's order, each
 * with its key points (goal, how it counts as done, what is still missing), its guide, its materials, and footnotes. Pure, so what the
 * page shows is tested without a book on disk.
 *
 * Concise and complete (the person's direction, 2026-10-15): a source is listed once however many sections cite it, a paragraph that
 * repeats the one before it is dropped, the analysis does not repeat what the guide already says, and its own source list (web addresses
 * in Markdown) gives way to the shared footnotes.
 */

export type BookSource = { id: string; url: string; title: string; publisher: string; kept: string; summary?: string; uri?: string };
export type BookNode = { id: string; title: string; kind: string; goal: string; stage: number; order?: number; stepId?: string };
export type BookMaterial = { index: number; id?: string; title: string; publisher: string; kept: string; docId?: string; url?: string; notes: number; nodes?: string[] };
export type Book = {
  flow: { nodes: BookNode[] }; manual: string;
  nodes: Record<string, { task: string; analysis: string; tutorial: string; sources: BookSource[] }>;
  materials: BookMaterial[];
  steps?: Array<{ id: string; title: string; status?: string }>;
};

export type Footnote = { n: number; key: string; title: string; publisher: string; kept: string; href?: string; material?: number; usedIn: number[] };
export type TutorialSection = {
  nodeId: string; stepId?: string; number: number; title: string; kind: string; goal: string;
  acceptance: string; missing: string[]; guide: string; analysis: string; cites: number[]; materials: number[];
};
export type Tutorial = { overview: string; assumptions: string[]; sections: TutorialSection[]; footnotes: Footnote[] };

export const KIND_LABEL: Record<string, string> = { read: "阅读", do: "动手", decide: "决定", verify: "核对", write: "撰写" };

/** Where an anchor in the tutorial and in the task's step list point to each other. F2's step rows carry `stepAnchor`. */
export const tutorialAnchor = (stepOrNodeId: string) => `tutorial-${stepOrNodeId}`;
export const stepAnchor = (stepId: string) => `step-${stepId}`;

/** Where a source opens inside the app: the person's file, the assistant's file, the kept copy, else the web page. */
export function sourceHref(workOrderId: string, source: { url: string; uri?: string; docId?: string }): string | undefined {
  if (source.docId) return `/api/source-documents/${encodeURIComponent(source.docId)}/file`;
  if (source.url.startsWith("local:")) return `/api/source-documents/${encodeURIComponent(source.url.slice(6))}/file`;
  const prepared = /^agent:([^/]+)\/(.+)$/.exec(source.url);
  if (prepared) return `/api/agent/tasks/${encodeURIComponent(prepared[1]!)}/file?path=${encodeURIComponent(prepared[2]!)}`;
  if (source.uri) return `/api/work-orders/${encodeURIComponent(workOrderId)}/materials?uri=${encodeURIComponent(source.uri)}`;
  return /^https:\/\//.test(source.url) ? source.url : undefined;
}

const squash = (text: string) => text.replace(/\[[^\]]{1,60}\]/g, "").replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
const sameTitle = (a: string, b: string) => squash(a) === squash(b);

/** Each section's step: the id the flow recorded, else the step of the same title, else none (never a guess by position). */
export function matchSteps(nodes: BookNode[], steps: Array<{ id: string; title: string }>): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<string>();
  for (const node of nodes) {
    const step = (node.stepId ? steps.find((item) => item.id === node.stepId) : undefined)
      ?? steps.find((item) => !taken.has(item.id) && item.title.trim() === node.title.trim())
      ?? steps.find((item) => !taken.has(item.id) && sameTitle(item.title, node.title));
    if (step) { out.set(node.id, step.id); taken.add(step.id); }
  }
  return out;
}

/** A Markdown section (`## 怎样算做到`) of a step's task file, as text. */
function sectionOf(markdown: string, heading: string): string {
  const match = new RegExp(`^##\\s*${heading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, "m").exec(markdown);
  return match?.[1]?.trim() ?? "";
}

/** Paragraphs (blank-line separated) with one that repeats the one before it, or another already kept, dropped. Exported for its test. */
export function dropRepeats(text: string, already: string[] = []): string {
  const seen = already.map(squash).filter((item) => item.length >= 12);
  const kept: string[] = [];
  for (const paragraph of text.split(/\n{2,}/)) {
    const key = squash(paragraph);
    if (key.length >= 12 && seen.some((other) => other === key || (other.length > 40 && key.length > 40 && (other.includes(key) || key.includes(other))))) continue;
    if (key) seen.push(key);
    kept.push(paragraph);
  }
  return kept.join("\n\n").trim();
}

/** 「需要补充：A、B」 lines, lifted out of the text into the section's notice. */
function liftMissing(text: string): { text: string; missing: string[] } {
  const missing: string[] = [];
  const rest = text.replace(/^[ \t>*-]*需要补充[:：]\s*(.+?)(?:(?<=[。；;])|\n|$)/gm, (_whole, items: string) => {
    missing.push(...items.replace(/[。；;]$/, "").split(/[、；;]/).map((item) => item.trim()).filter(Boolean));
    return "";
  });
  return { text: rest.trim(), missing: [...new Set(missing)] };
}

/** Citation marks `[s1]`, `[upload-2]`, `[s1][s2]`, `[s1, s2]`, full-width brackets too. */
const CITATION = /[[［]((?:[a-z][\w-]{0,40})(?:\s*[,，、]\s*[a-z][\w-]{0,40})*)[\]］]/gi;

export function buildTutorial(workOrderId: string, book: Book): Tutorial {
  const nodes = [...book.flow.nodes].sort((a, b) => (a.order ?? a.stage) - (b.order ?? b.stage));
  const stepOf = matchSteps(nodes, book.steps ?? []);
  // Steps come in the task's own order when they are matched; a section the plan does not know keeps its place in the flow.
  const position = new Map((book.steps ?? []).map((step, index) => [step.id, index]));
  nodes.sort((a, b) => {
    const pa = stepOf.has(a.id) ? position.get(stepOf.get(a.id)!) ?? 0 : Number.MAX_SAFE_INTEGER;
    const pb = stepOf.has(b.id) ? position.get(stepOf.get(b.id)!) ?? 0 : Number.MAX_SAFE_INTEGER;
    return pa === pb ? 0 : pa - pb;
  });
  const footnotes: Footnote[] = [];
  const materialByKey = new Map<string, BookMaterial>();
  for (const material of book.materials) {
    if (material.docId) materialByKey.set(`doc:${material.docId}`, material);
    if (material.url) materialByKey.set(material.url, material);
    if (material.id && /^(upload|prep)-\d+$/.test(material.id)) materialByKey.set(`id:${material.id}`, material);
  }
  const footnoteFor = (key: string, make: () => Omit<Footnote, "n" | "usedIn">): Footnote => {
    let note = footnotes.find((item) => item.key === key);
    if (!note) { note = { ...make(), n: footnotes.length + 1, usedIn: [] }; footnotes.push(note); }
    return note;
  };

  const sections = nodes.map((node, index): TutorialSection => {
    const number = index + 1;
    const content = book.nodes[node.id] ?? { task: "", analysis: "", tutorial: "", sources: [] };
    const cites = new Set<number>();
    const resolve = (id: string): Footnote | undefined => {
      const source = content.sources.find((item) => item.id === id);
      if (source) {
        const material = materialByKey.get(source.url);
        const key = source.url || `node:${node.id}:${id}`;
        return footnoteFor(key, () => ({ key, title: source.title, publisher: source.publisher, kept: source.kept,
          ...(sourceHref(workOrderId, source) ? { href: sourceHref(workOrderId, source)! } : {}), ...(material ? { material: material.index } : {}) }));
      }
      const shared = materialByKey.get(`id:${id}`);
      if (!shared) return undefined;
      const key = shared.docId ? `doc:${shared.docId}` : shared.url ?? `id:${id}`;
      const href = sourceHref(workOrderId, { url: shared.url ?? "", ...(shared.docId ? { docId: shared.docId } : {}) });
      return footnoteFor(key, () => ({ key, title: shared.title, publisher: shared.publisher, kept: shared.kept, material: shared.index, ...(href ? { href } : {}) }));
    };
    const cite = (text: string) => text.replace(CITATION, (whole, ids: string) => {
      const marks = ids.split(/\s*[,，、]\s*/).map(resolve).filter((item): item is Footnote => Boolean(item));
      if (!marks.length) return whole;
      for (const mark of marks) { cites.add(mark.n); if (!mark.usedIn.includes(number)) mark.usedIn.push(number); }
      return marks.map((mark) => `[^${mark.n}]`).join("");
    }).replace(/(\[\^\d+\])(\s*\1)+/g, "$1");
    const body = (text: string) => text.replace(/^# .*\n+/, "").trim();
    const guideRaw = liftMissing(cite(body(content.tutorial || "")));
    const analysisRaw = liftMissing(cite(body(content.analysis || "").replace(/\n##\s*参考来源[\s\S]*$/, "")));
    const guide = dropRepeats(guideRaw.text || cite(body(content.task || "").replace(/^\*\*目标\*\*[:：].*$/m, "").replace(/\n##\s*怎样算做到[\s\S]*?(?=\n##\s|$)/, "")));
    const analysis = dropRepeats(analysisRaw.text, guide.split(/\n{2,}/));
    const materials = book.materials.filter((item) => item.nodes?.includes(node.id)).map((item) => item.index);
    const stepId = stepOf.get(node.id);
    return { nodeId: node.id, ...(stepId ? { stepId } : {}), number, title: node.title, kind: node.kind, goal: node.goal,
      acceptance: sectionOf(content.task, "怎样算做到"), missing: [...new Set([...guideRaw.missing, ...analysisRaw.missing])],
      guide, analysis, cites: [...cites].sort((a, b) => a - b), materials };
  });

  const overview = book.manual.split(/\n## (?:假设|流程)/)[0]?.replace(/^# .*\n+/, "").trim() ?? "";
  const assumptions = sectionOf(book.manual, "假设").split("\n").map((line) => line.replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean);
  return { overview, assumptions, sections, footnotes };
}
