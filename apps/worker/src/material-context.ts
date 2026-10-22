import { CONTEXT_BUDGETS, MATERIAL_TOOL_BUDGET, oneLine, relevantDocuments, searchTerms, termHits, withinBudget } from "@crossline/core";
import type { SkillTools } from "@crossline/codex";
import type { CrosslineStore, DocChunk, StoredProfileFact } from "@crossline/db";
import { folderDocuments } from "./source-folders";
import { ledgerId, ledgerLookup, ledgerSummary, type LedgerEntry } from "./ledger-index";

/**
 * What a task's context is built from, and only that (docs/context-selection.md, decided 2026-10-20): code proposes candidates — the
 * task's own files, the passages of any file that match the task (the full-text index, migration 19), the project's and the line's facts
 * ranked by the task's terms — and the model picks what to read through two lookups. Before this the step planner got the project's
 * files cut blind at 16k each and 48k in all, and a task with no file of its own got nothing at all.
 */

/** What a task is searched by, and whose files count as its own. */
export type MaterialScope = { query: string; workspaceId: string; projectId: string; identityId: string; projectName?: string;
  /** The words that name the task itself (title, project, milestone): searched again on their own and added, so the contract's general
   * wording (「核验结果」「确定结论」) does not outweigh what the task is about. */
  core?: string };

type Passage = DocChunk & { score: number };
export type ShownPassage = { id: string; doc: string; at: string; text: string };
export type CandidatePassage = { id: string; doc: string; at: string; line: string };
export type ShownFile = { doc: string; name: string; project: string; passages: number; own: boolean };

/** How much of the selection reached the model, for the measurement in docs/context-selection.md and the run log. */
export type SelectionStats = { files: number; candidates: number; shownChars: number; toolCalls: number; toolChars: number };

const passageId = (chunk: { id: number }) => `c${chunk.id}`;
const PASSAGES_PER_SEARCH = 8;
/** A passage scoring under this share of the best match is not handed to the capture analysis. */
const ANALYSIS_MIN_SHARE = 0.5;

/**
 * The material half of a step plan's context for one task. `view` is what goes in the input when the model can call the lookups (the
 * files, the strongest passages in full, the rest as one line each); `fallback` is what goes instead on a route that cannot (the passages
 * code picked, in full, within `CONTEXT_BUDGETS.noTools`); `tools` are the lookups; `documents()` is every file the run was shown or read,
 * whole, for checking the quotes the plan cites.
 */
export function selectMaterial(store: CrosslineStore, scope: MaterialScope) {
  const { workspaceId } = scope;
  const readable = store.listSourceDocuments(workspaceId).filter((doc) => doc.extractionStatus === "done" && doc.extractedText.trim());
  const byId = new Map(readable.map((doc) => [doc.id, doc]));
  const projects = new Map(store.listProjects(workspaceId, { includeArchived: true }).map((project) => [project.id, project.name]));
  // The task's own files: filed under its project, or naming it. The unfiled material of the folders put on its line is the line's, not
  // the task's: it is searched like any file and counts a little more (a whole Downloads folder had been handed to every task of a line).
  const own = new Set(relevantDocuments(readable, { projectId: scope.projectId, projectName: scope.projectName }).map((doc) => doc.id));
  const line = lineDocumentIds(store, workspaceId, scope.identityId);
  const elsewhere = otherLineDocumentIds(store, workspaceId, scope.identityId);
  // `doc-N` in the order a file is first met: the task's own files first, then any file a passage came from.
  const docIds = new Map<string, string>();
  const docOf = (documentId: string) => { if (!docIds.has(documentId)) docIds.set(documentId, `doc-${docIds.size + 1}`); return docIds.get(documentId)!; };
  for (const id of own) docOf(id);
  const totals = store.docChunkCounts(workspaceId);
  const totalOf = (documentId: string) => totals.get(documentId) ?? 0;
  const at = (chunk: DocChunk) => `${chunk.ord + 1}/${totalOf(chunk.documentId)}`;

  // Candidates: the passages that match the task (the words naming it count twice: once in the whole query, once on their own), the task's
  // own files counting double, its line's 1.4× and another line's half, spread over files (at most two of one file before any file gets a
  // third); then the opening of each own file no term reached, so the model knows every file it has.
  const found = new Map<number, Passage>();
  for (const query of [scope.query, scope.core ?? ""].filter((text) => text.trim()))
    for (const hit of store.searchDocChunks(workspaceId, query, { limit: 80 }))
      found.set(hit.id, { ...hit, score: (found.get(hit.id)?.score ?? 0) + hit.score });
  const weight = (documentId: string) => own.has(documentId) ? 2 : line.has(documentId) ? 1.4 : elsewhere.has(documentId) ? 0.5 : 1;
  const hits: Passage[] = spreadOverFiles([...found.values()].map((hit) => ({ ...hit, score: hit.score * weight(hit.documentId) }))
    .sort((a, b) => b.score - a.score || a.id - b.id), 2);
  const reached = new Set(hits.map((hit) => hit.documentId));
  const openings: Passage[] = [...own].filter((id) => !reached.has(id))
    .flatMap((id) => store.documentChunks(workspaceId, id, 1).map((chunk) => ({ ...chunk, score: 0 })));
  const ranked = [...hits, ...openings];

  const shown = (chunk: Passage): ShownPassage => ({ id: passageId(chunk), doc: docOf(chunk.documentId), at: at(chunk), text: chunk.body });
  const topFull = withinBudget(hits.slice(0, 8), (chunk) => chunk.body.length + 40, CONTEXT_BUDGETS.topFull);
  const topIds = new Set(topFull.map((chunk) => chunk.id));
  const listed = withinBudget(ranked.filter((chunk) => !topIds.has(chunk.id)), (chunk) => oneLine(chunk.body).length + 40, CONTEXT_BUDGETS.candidates);
  const fallbackPassages = withinBudget(ranked, (chunk) => chunk.body.length + 40, CONTEXT_BUDGETS.noTools);

  const files = (): ShownFile[] => [...docIds.entries()].flatMap(([documentId, doc]) => {
    const file = byId.get(documentId);
    return file ? [{ doc, name: file.fileName, project: file.projectId ? projects.get(file.projectId) ?? file.projectId : "", passages: totalOf(documentId), own: own.has(documentId) }] : [];
  });
  // Built eagerly so the doc ids of everything listed exist before `files()` is read.
  const view = { passages: topFull.map(shown), candidates: listed.map((chunk): CandidatePassage => ({ id: passageId(chunk), doc: docOf(chunk.documentId), at: at(chunk), line: oneLine(chunk.body) })) };
  const fallback = { passages: fallbackPassages.map(shown) };

  let toolChars = 0, toolCalls = 0;
  const spend = (text: string) => {
    toolCalls += 1;
    if (toolChars >= MATERIAL_TOOL_BUDGET) return "本次查阅已到上限（约 3 万字）。用已读到的内容完成计划；没读到而又需要的，写进 questions。";
    toolChars += text.length;
    return text;
  };
  const tools: SkillTools = {
    specs: [
      { name: "search_material", description: "Search the person's files for passages about a topic (words or a phrase, Chinese or English). "
        + "scope: \"task\" = this task's own files, \"line\" = files of this line, \"all\" = every file (default). Returns up to 8 passages: id, file, position and their opening line.",
        inputSchema: { type: "object", additionalProperties: false, required: ["query", "scope"], properties: {
          query: { type: "string", minLength: 1, maxLength: 200 }, scope: { type: "string", enum: ["task", "line", "all"] } } } },
      { name: "read_chunk", description: "Read one passage in full by its id (c123), with the ids of the passages before and after it in its file.",
        inputSchema: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string", minLength: 1, maxLength: 20 } } } }
    ],
    call: (name, args) => {
      const input = (args ?? {}) as { query?: unknown; scope?: unknown; id?: unknown };
      if (name === "search_material") {
        const query = String(input.query ?? "").slice(0, 200);
        const within = input.scope === "task" ? { documentIds: [...own] } : input.scope === "line" ? { documentIds: [...own, ...line] } : {};
        const found = store.searchDocChunks(workspaceId, query, { identityId: scope.identityId, projectId: scope.projectId, ...within, limit: PASSAGES_PER_SEARCH });
        if (!found.length) return spend(`没有找到与「${query}」相关的段落。换个说法（课程代号、章节名、英文术语），或扩大 scope。`);
        return spend(found.map((hit) => `${passageId(hit)} ${docOf(hit.documentId)}《${hit.fileName}》第 ${at(hit)} 段：${oneLine(hit.body, 160)}`).join("\n"));
      }
      if (name === "read_chunk") {
        const id = Number(String(input.id ?? "").replace(/^c/i, ""));
        const chunk = Number.isInteger(id) ? store.readDocChunk(workspaceId, id) : undefined;
        if (!chunk) return spend(`没有编号为 ${String(input.id ?? "")} 的段落。`);
        const near = [chunk.previousId ? `前一段 c${chunk.previousId}` : "", chunk.nextId ? `后一段 c${chunk.nextId}` : ""].filter(Boolean).join("，");
        return spend(`${passageId(chunk)} ${docOf(chunk.documentId)}《${chunk.fileName}》第 ${chunk.ord + 1}/${chunk.total} 段${near ? `（${near}）` : ""}\n${chunk.body}`);
      }
      throw new Error(`没有名为 ${name} 的工具`);
    }
  };
  const shownChars = (passages: ShownPassage[], candidates: CandidatePassage[] = []) =>
    JSON.stringify({ files: files(), passages, candidates }).length;
  return {
    /** With the lookups: the files, the strongest passages in full and the other candidates as one line each. */
    view: () => ({ files: files(), ...view }),
    /** Without them: the files and the passages code picked, in full. */
    fallback: () => ({ files: files(), ...fallback }),
    tools,
    /** Every file the run was shown or read through the lookups, whole: what a cited quote is checked against. */
    documents: () => [...docIds.entries()].flatMap(([documentId, doc]) => { const file = byId.get(documentId); return file ? [{ id: doc, name: file.fileName, text: file.extractedText }] : []; }),
    stats: (mode: "tools" | "fallback"): SelectionStats => ({ files: docIds.size, candidates: ranked.length,
      shownChars: mode === "tools" ? shownChars(view.passages, view.candidates) : shownChars(fallback.passages), toolCalls, toolChars }),
    /** The passages behind the selection, best first (the measurement prints their headings). */
    ranked: () => ranked.map((chunk) => ({ id: passageId(chunk), heading: chunk.heading, at: at(chunk), score: Math.round(chunk.score * 100) / 100, own: own.has(chunk.documentId) }))
  };
}

/** Passages in rank order with at most `perFile` of one file first, the rest after (so the first screen names several files). */
function spreadOverFiles<T extends { documentId: string }>(ranked: T[], perFile: number): T[] {
  const taken = new Map<string, number>();
  const first: T[] = [], later: T[] = [];
  for (const item of ranked) {
    const count = taken.get(item.documentId) ?? 0;
    (count < perFile ? first : later).push(item);
    taken.set(item.documentId, count + 1);
  }
  return [...first, ...later];
}

/** A line's files: those filed under one of its projects, and the unfiled ones of folders put on the line (docs/onboarding-v3.md). */
export function lineDocumentIds(store: CrosslineStore, workspaceId: string, identityId: string): Set<string> {
  const projects = new Set(store.listProjects(workspaceId, { includeArchived: true }).filter((project) => project.identityId === identityId).map((project) => project.id));
  const folders = folderDocuments(store, workspaceId);
  return new Set(store.listSourceDocuments(workspaceId).filter((doc) => doc.projectId ? projects.has(doc.projectId)
    : (folders.get(doc.id)?.lines ?? []).includes(identityId)).map((doc) => doc.id));
}

/** Files that belong to another line: filed under another line's project, or from a folder put only on other lines. */
function otherLineDocumentIds(store: CrosslineStore, workspaceId: string, identityId: string): Set<string> {
  const lineOf = new Map(store.listProjects(workspaceId, { includeArchived: true }).map((project) => [project.id, project.identityId]));
  const folders = folderDocuments(store, workspaceId);
  return new Set(store.listSourceDocuments(workspaceId).filter((doc) => {
    if (doc.projectId) { const line = lineOf.get(doc.projectId); return Boolean(line) && line !== identityId; }
    const lines = folders.get(doc.id)?.lines ?? [];
    return lines.length > 0 && !lines.includes(identityId);
  }).map((doc) => doc.id));
}

/**
 * Passages as short excerpts for a Skill that gets no lookups (the backplanner, the milestone architect): the best matches of `query`
 * within `within` (a project, else the line), each clipped to `CONTEXT_BUDGETS.excerpt`, within `budget` in all.
 */
export function materialExcerpts(store: CrosslineStore, workspaceId: string, query: string,
  scope: { projectId?: string; identityId: string; within: "project" | "line" }, budget: number = CONTEXT_BUDGETS.excerpts) {
  const hits = spreadOverFiles(scope.within === "project" && scope.projectId
    ? store.searchDocChunks(workspaceId, query, { projectId: scope.projectId, within: "project", limit: 24 })
    : store.searchDocChunks(workspaceId, query, { documentIds: [...lineDocumentIds(store, workspaceId, scope.identityId)], limit: 24 }), 2);
  return withinBudget(hits.map((hit) => ({ id: passageId(hit), file: hit.fileName, text: oneLine(hit.body, CONTEXT_BUDGETS.excerpt) })),
    (item) => item.text.length + item.file.length + 30, budget);
}

/**
 * Passages for the capture analysis, which reads only supplied text (its quotes are checked against it): the files' passages that match
 * the capture, each clipped to `CONTEXT_BUDGETS.analysisPassage`, within `CONTEXT_BUDGETS.analysis`, plus one line naming how many other
 * files the system holds. It used to be the opening 300 characters of the first eight files uploaded, whatever the capture was about.
 */
export function analysisMaterialInputs(store: CrosslineStore, workspaceId: string, query: string): Array<{ id: string; text: string }> {
  // Only passages within reach of the best match: a capture that names nothing in the files gets a list of them, not the noise.
  const found = store.searchDocChunks(workspaceId, query, { limit: 24 });
  const best = found[0]?.score ?? 0;
  const hits = spreadOverFiles(found.filter((hit) => hit.score >= best * ANALYSIS_MIN_SHARE), 2);
  const picked = withinBudget(hits, (hit) => Math.min(hit.body.length, CONTEXT_BUDGETS.analysisPassage) + hit.fileName.length + 60, CONTEXT_BUDGETS.analysis);
  const readable = store.listSourceDocuments(workspaceId).filter((doc) => doc.extractionStatus === "done" && doc.extractedText.trim());
  const inputs = picked.map((hit) => ({ id: `uploaded-${hit.documentId}-${hit.ord + 1}`,
    text: `用户此前已交给系统的资料《${hit.fileName}》中的一段（已读取，不必再向用户要）：${hit.body.replace(/\s+/g, " ").trim().slice(0, CONTEXT_BUDGETS.analysisPassage)}` }));
  const rest = readable.filter((doc) => !picked.some((hit) => hit.documentId === doc.id));
  if (rest.length) inputs.push({ id: "uploaded-other-files", text: `系统另外还存着本人的 ${rest.length} 份资料（与这条收集无明显关系），文件名：${
    rest.slice(0, 12).map((doc) => doc.fileName).join("、")}${rest.length > 12 ? " 等" : ""}。` });
  return inputs;
}

/**
 * The project's and the line's confirmed facts (and assumptions) for one task, ranked: the project's first, then the line's by how
 * many of the task's terms they hold, within `CONTEXT_BUDGETS.facts`. It used to be the first fifty in storage order, so on a line with a
 * hundred facts which fifty a plan saw was chance.
 */
export function relevantFacts(facts: StoredProfileFact[], task: { query: string; projectId: string; identityId: string },
  options: { exclude?: (fact: StoredProfileFact) => boolean; budget?: number;
    /** A short id put in front of each fact given (`createRefBook`), so the answer can say which it rested on. */
    ref?: (fact: StoredProfileFact) => string } = {}): string[] {
  const line = (fact: StoredProfileFact) => `${fact.projectId ? `[${fact.projectId}] ` : ""}${fact.slot}：${fact.value.slice(0, 240)}${fact.status === "inferred" ? "（假设）" : ""}`;
  // The id is not counted in the budget, and only facts that fit are given one.
  return withinBudget(rankedFacts(facts, task, options), (fact) => line(fact).length + 4, options.budget ?? CONTEXT_BUDGETS.facts)
    .map((fact) => options.ref ? `[${options.ref(fact)}] ${line(fact)}` : line(fact));
}

/** The facts `relevantFacts` lists, in its order, before they are written out. */
function rankedFacts(facts: StoredProfileFact[], task: { query: string; projectId: string; identityId: string },
  options: { exclude?: (fact: StoredProfileFact) => boolean } = {}): StoredProfileFact[] {
  const terms = searchTerms(task.query);
  const usable = facts.filter((fact) => (fact.status === "confirmed" || fact.value.startsWith("假设")) && !options.exclude?.(fact)
    && (fact.projectId === task.projectId || fact.identityId === task.identityId));
  return usable.map((fact) => ({ fact, own: fact.projectId === task.projectId && Boolean(task.projectId) ? 1 : 0, hits: termHits(`${fact.slot} ${fact.value}`, terms) }))
    // The task's own project first, then what the person confirmed, then by the task's terms, then the facts answers really used (migration 20).
    .sort((a, b) => b.own - a.own || Number(b.fact.status === "confirmed") - Number(a.fact.status === "confirmed") || b.hits - a.hits
      || (b.fact.useCount ?? 0) - (a.fact.useCount ?? 0) || (b.fact.lastUsedAt ?? "").localeCompare(a.fact.lastUsedAt ?? ""))
    .map(({ fact }) => fact);
}

/**
 * The same facts as an index for a route that calls functions (token-economy.md §2), one line each with a stable short id and the slot
 * (with the project when it is not the task's own): the task's own project's facts and those naming its terms carry the value's first
 * 60 characters; the rest of the line's facts (another project's dates, say) carry only the slot, ending in 「…」. Any of them is read
 * whole through `read_ledger`. The index lists every fact `relevantFacts` lists and, room permitting, the ones its budget left out;
 * `full` is that list, what a route without functions keeps getting.
 */
export function factLedger(facts: StoredProfileFact[], task: { query: string; projectId: string; identityId: string },
  options: { exclude?: (fact: StoredProfileFact) => boolean;
    /** The run's short id for a fact (`createRefBook`), used as its index id so `usedRefs` and `read_ledger` name it the same way. */
    ref?: (fact: StoredProfileFact) => string } = {}) {
  const taken = new Set<string>();
  const terms = searchTerms(task.query);
  const entries: Array<LedgerEntry & { near: boolean }> = rankedFacts(facts, task, options).map((fact) => ({
    id: options.ref ? options.ref(fact) : ledgerId("f", `${fact.identityId}|${fact.projectId}|${fact.slot}`, taken),
    label: `${fact.projectId && fact.projectId !== task.projectId ? `[${fact.projectId}] ` : ""}${fact.slot}${fact.status === "inferred" ? "（假设）" : ""}`,
    text: fact.value,
    near: (Boolean(task.projectId) && fact.projectId === task.projectId) || termHits(`${fact.slot} ${fact.value}`, terms) > 0 }));
  const lines: string[] = [];
  let left = CONTEXT_BUDGETS.facts;
  for (const entry of entries) {
    const line = entry.near ? `${entry.id} ${entry.label}：${ledgerSummary(entry.text)}` : `${entry.id} ${entry.label}：…`;
    if (line.length + 4 > left) break;
    left -= line.length + 4;
    lines.push(line);
  }
  const lookup = ledgerLookup(entries);
  return { index: lines, full: relevantFacts(facts, task, options), tools: lookup.tools, stats: lookup.stats };
}
