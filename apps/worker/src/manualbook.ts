import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import {
  MANUAL_DESIGN_SCHEMA, MATERIAL_SEARCH_SCHEMA, NODE_WRITEUP_SCHEMA, budgetPolicy, openAccessVerdict, profileFactId, topologicalOrder,
  validateManualDesign, validateMaterialSearch, validateNodeWriteup,
  type CostSignal, type FoundSource, type ManualDesign, type ManualDesignContext, type ManualNode, type MaterialSearch,
  type MaterialSearchContext, type NodeWriteup, type WriteContext
} from "@crossline/core";
import { runCodexSkill, webResearchBlocker, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";
import { requiredApproval } from "@crossline/core";
import { claimedTitleMatches } from "./diligence";
import { arxivPdfAddress, defaultSafeGetDeps, htmlToText, safeGet, type SafeGetDeps } from "./safe-fetch";
import { extractText } from "./extract";

export const MANUAL_DESIGNER_SKILL = "crossline:crossline-manualbook-designer";
export const MATERIAL_RESEARCHER_SKILL = "crossline:crossline-material-researcher";
export const MATERIAL_WRITER_SKILL = "crossline:crossline-material-writer";
import { ownerOf } from "./owner";

const DESIGN_INSTRUCTIONS = "Design how this one task gets done, as a short flow of steps a person can follow from left to "
  + "right. Return only the requested JSON. Every step is concrete (what to do, in what order, how you know it is done), "
  + "serves at least one item of the task's contract by id, and a step that needs material the person does not have "
  + "says what to look for. Every REQUIRED contract item must be served by some step. Steps form a chain with no loops: "
  + "edges point from what must come first to what follows. Use the person's own facts and local files where they bear "
  + "on the how. Do not do the work itself and do not claim it is done. Write every human-readable field in Chinese.";
const SEARCH_INSTRUCTIONS = "Find the best material for ONE step of a task on the public web. Return only the requested "
  + "JSON. A source is a public https page you opened, with its real title. Prefer primary and open-access sources "
  + "(official documentation, the paper itself, a maintained tutorial) over summaries of them. Say honestly whether you "
  + "believe the full text is open access; that is only your reading and the app decides what is kept. Put what you "
  + "could not find in `gaps` instead of guessing. Never invent a source. Write human-readable fields in Chinese.";
const WRITE_INSTRUCTIONS = "Write up ONE step of a task from the supplied sources: an analysis (what the material says that "
  + "matters for this step, what to trust and what to doubt) and a tutorial (the concrete way to do this step, in order, "
  + "with the commands, settings or reasoning someone needs). Cite sources only by their id from the input and never "
  + "write a web address yourself. Where the sources do not support something, say so rather than filling it in. "
  + "Return only the requested JSON. Write in Chinese.";

export type ManualProgress = { stage: "designing" | "researching" | "writing" | "assembling"; done: number; total: number };
export type ManualOutcome =
  | { state: "ready"; workOrderId: string; artifacts: number; nodes: number; sources: number; downloaded: number }
  | { state: "blocked"; workOrderId: string; code: string; message: string };

export type ManualbookDeps = {
  safeGet: SafeGetDeps; readCost: () => Promise<CostSignal>; now: () => Date;
  /** Why web research cannot run here, if it cannot. A manualbook is still built without it, just without found sources. */
  webBlocker: () => { code: string; message: string } | undefined;
};

type KeptSource = {
  id: string; url: string; title: string; publisher: string; kind: string; summary: string; kept: "full_text" | "summary_only";
  verdict: string; fetchedAt: string; file?: string; sha256?: string; bytes?: number; text: string;
  /** The downloaded file itself, held only until it is written into the manualbook folder. */
  raw?: Uint8Array;
};
type NodeResult = { node: ManualNode; sources: KeptSource[]; gaps: string[]; writeup: NodeWriteup | undefined; note?: string };

const TEXT_PER_SOURCE = 12_000;
const DOWNLOADS_PER_NODE = 3;
const MAX_PDF_BYTES = 15_000_000;
const MAX_PAGE_BYTES = 3_000_000;

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "source";
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** What the person attached when they captured this, still readable after promotion. */
function captureInputs(store: CrosslineStore, workspaceId: string, workOrderId: string): Array<{ id: string; text: string }> {
  const capture = store.listCaptures(workspaceId).find((item) => item.id === workOrderId);
  if (!capture) return [];
  return [{ id: "capture-context", text: capture.context.trim() }, { id: "capture-title", text: capture.title.trim() }].filter((input) => input.text);
}

export function buildManualContext(store: CrosslineStore, workspaceId: string, workOrderId: string, today: string): ManualDesignContext | undefined {
  const order = store.listWorkOrders(workspaceId).find((item) => item.id === workOrderId);
  if (!order) return undefined;
  const payload = order.payload as {
    materialContract?: Array<{ id?: string; description?: string; kind?: string; required?: boolean }>;
    evidenceContract?: Array<{ id?: string; description?: string; requirement?: string; kind?: string; required?: boolean }>;
    availableInputs?: Array<{ id?: string; text?: string }>;
  };
  const milestone = order.milestoneId ? store.getMilestone(workspaceId, order.milestoneId) : undefined;
  const anchor = order.milestoneId ? store.listMilestoneAnchors(workspaceId).find((item) => item.milestoneId === order.milestoneId) : undefined;
  return {
    version: "crossline.manualbook.design.v1", today,
    workOrder: { id: order.id, intent: order.intent, identityId: order.identityId,
      milestone: milestone ? { title: milestone.title, target: anchor?.target ?? "", deadline: anchor?.deadline ?? "" } : null },
    contract: [
      ...(payload.materialContract ?? []).map((item, index) => ({ id: item.id ?? `${order.id}-material-${index}`, kind: "material" as const,
        description: item.description ?? item.kind ?? "", required: item.required !== false })),
      ...(payload.evidenceContract ?? []).map((item, index) => ({ id: item.id ?? `${order.id}-evidence-${index}`, kind: "evidence" as const,
        description: item.description ?? item.requirement ?? item.kind ?? "", required: item.required !== false }))
    ].filter((item) => item.description),
    inputs: [
      ...(payload.availableInputs ?? []).map((input, index) => ({ id: input.id ?? `${order.id}-input-${index}`, text: input.text ?? "" })),
      ...captureInputs(store, workspaceId, order.id)
    ].filter((input) => input.text),
    localFiles: store.listSourceDocuments(workspaceId).map((doc) => doc.fileName).slice(0, 30),
    profile: store.listProfileFacts(workspaceId).filter((fact) => fact.identityId === order.identityId && fact.status === "confirmed").slice(0, 30)
      .map((fact) => ({ id: profileFactId(fact), value: fact.value })),
    constraints: store.listProfileFacts(workspaceId).filter((fact) => /constraint|限制|约束/.test(fact.slot) || /无法|不能|不要/.test(fact.value)).map((fact) => fact.value).slice(0, 8)
  };
}

export function createManualbookBuilder(store: CrosslineStore, workspaceId: string, materialsDir: string, cwd: string,
  getClient: () => CodexRpcBoundary | undefined, deps: Partial<ManualbookDeps> & Pick<ManualbookDeps, "readCost">) {
  const all: ManualbookDeps = { safeGet: defaultSafeGetDeps(), now: () => new Date(), webBlocker: webResearchBlocker, ...deps };

  return async function build(workOrderId: string): Promise<ManualOutcome> {
    const blocked = (code: string, message: string): ManualOutcome => ({ state: "blocked", workOrderId, code, message });
    const client = getClient();
    if (!client) return blocked("CODEX_SUPERVISOR_UNAVAILABLE", "Codex 运行时不可用；你仍可人工自备材料。");
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(workOrderId)) return blocked("MATERIAL_PATH_OUTSIDE_ROOT", "作业 id 不合法。");
    const order = store.getWorkOrder(workspaceId, workOrderId);
    if (!order) return blocked("WORK_ORDER_NOT_FOUND", "找不到该作业。");
    if (order.state !== "preparing") return blocked("MATERIALS_NOT_PREPARING", "作业当前不在材料准备阶段。");
    const ownerId = ownerOf(store, workspaceId);
    const today = (process.env.CROSSLINE_FIXED_NOW ? new Date(process.env.CROSSLINE_FIXED_NOW) : all.now()).toISOString().slice(0, 10);
    const context = buildManualContext(store, workspaceId, workOrderId, today)!;
    if (!context.contract.length) return blocked("MATERIALS_NOT_REQUIRED", "该作业没有材料或证据要求，不需要手册。");

    // Discretionary spend: when the quota is gone the person prepares it themselves. A tight quota is handled one
    // level down, where the Skills step to a cheaper model instead of refusing.
    const cost = await all.readCost();
    const mode = cost.available ? budgetPolicy(Math.max(cost.short?.usedPercent ?? 0, cost.long?.usedPercent ?? 0)).mode : "manual_core_only";
    if (mode === "manual_core_only") {
      return blocked(cost.available ? "MATERIAL_BUDGET_EXHAUSTED" : "COST_SIGNAL_UNAVAILABLE", cost.available ? "预算已用尽；材料请人工自备。" : "读不到用量信号；材料请人工自备。");
    }

    const progress = (stage: ManualProgress["stage"], done: number, total: number) => store.appendEvent({
      ownerId, workspaceId, idempotencyKey: `manualbook:progress:${workOrderId}:${stage}:${done}:${randomUUID()}`, type: "manualbook.progress",
      entityId: workOrderId, payload: { stage, done, total } satisfies ManualProgress });
    const fail = (code: string, message: string): ManualOutcome => {
      // Keyed per retry: a retry that failed with the same code as before used to collide with the first block, so the retry
      // request stayed the last word and the order was prepared again on every tick.
      const attempt = store.listEvents(workspaceId, { type: "materials.retry_requested", entityId: workOrderId }).length;
      store.appendEvent({ ownerId, workspaceId, idempotencyKey: `materials:blocked:${workOrderId}:${code}:${attempt}`, type: "materials.blocked", entityId: workOrderId, payload: { code, message } });
      return blocked(code, message);
    };

    // 1. the flow ------------------------------------------------------------------------------------------------
    progress("designing", 0, 1);
    const designed = await runCodexSkill<ManualDesign>(client, context, {
      skillName: MANUAL_DESIGNER_SKILL, cwd, developerInstructions: DESIGN_INSTRUCTIONS, outputSchema: MANUAL_DESIGN_SCHEMA,
      prepareInput: () => context, validateOutput: (output) => validateManualDesign(output, context), onAudit: () => {}, timeoutMs: 60 * 60_000
    });
    if (!designed.ok) return fail(designed.blocker.code, designed.blocker.message);
    const design = designed.output;
    const order_ = topologicalOrder(design.nodes.map((node) => node.id), design.edges)!;
    const nodes = order_.map((id) => design.nodes.find((node) => node.id === id)!);

    // 2. material, per step -------------------------------------------------------------------------------------
    const web = all.webBlocker();
    const results: NodeResult[] = [];
    const researchable = nodes.filter((node) => node.needsResearch);
    let searched = 0;
    for (const node of nodes) {
      const result: NodeResult = { node, sources: [], gaps: [], writeup: undefined };
      if (node.needsResearch) {
        progress("researching", searched, researchable.length);
        searched += 1;
        if (web) { result.gaps.push(`没有联网查资料：${web.message}`); }
        else {
          const searchContext: MaterialSearchContext = { version: "crossline.manualbook.search.v1", today, task: { intent: context.workOrder.intent },
            node: { id: node.id, title: node.title, kind: node.kind, goal: node.goal, steps: node.steps, researchQuestions: node.researchQuestions },
            localFiles: context.localFiles, constraints: context.constraints };
          const found = await runCodexSkill<MaterialSearch>(client, searchContext, {
            skillName: MATERIAL_RESEARCHER_SKILL, cwd, developerInstructions: SEARCH_INSTRUCTIONS, outputSchema: MATERIAL_SEARCH_SCHEMA, allowWebSearch: true,
            prepareInput: () => searchContext, validateOutput: (output) => validateMaterialSearch(output), onAudit: () => {}, timeoutMs: 60 * 60_000
          });
          if (!found.ok) result.gaps.push(`这一步没有找到可核实的资料：${found.blocker.message}`);
          else {
            result.gaps.push(...found.output.gaps);
            result.sources = await keepSources(found.output.sources, all, today, result.gaps);
          }
        }
      }
      results.push(result);
    }

    // 3. the write-up, per step ---------------------------------------------------------------------------------
    for (const [index, result] of results.entries()) {
      progress("writing", index, results.length);
      const writeContext: WriteContext = { version: "crossline.manualbook.write.v1", today, task: { intent: context.workOrder.intent },
        node: { id: result.node.id, title: result.node.title, kind: result.node.kind, goal: result.node.goal, steps: result.node.steps, acceptance: result.node.acceptance },
        sources: result.sources.map((source) => ({ id: source.id, title: source.title, url: source.url, kept: source.kept, text: source.text })),
        inputs: context.inputs, profile: context.profile };
      const written = await runCodexSkill<NodeWriteup>(client, writeContext, {
        skillName: MATERIAL_WRITER_SKILL, cwd, developerInstructions: WRITE_INSTRUCTIONS, outputSchema: NODE_WRITEUP_SCHEMA,
        prepareInput: () => writeContext, validateOutput: (output) => validateNodeWriteup(output, writeContext), onAudit: () => {}, timeoutMs: 60 * 60_000
      });
      if (written.ok) result.writeup = written.output;
      else result.note = `这一步的分析和教程没有写成：${written.blocker.message}`;
    }
    if (!results.some((result) => result.writeup)) return fail("MANUALBOOK_NOTHING_WRITTEN", "每一步的分析和教程都没有写成，所以没有生成手册。");

    // 4. assemble ---------------------------------------------------------------------------------------------
    progress("assembling", 0, 1);
    const files = assemble({ design, nodes: results, context, builtAt: all.now().toISOString() });
    const root = path.join(materialsDir, workOrderId);
    const staging = `${root}.building-${randomUUID().slice(0, 8)}`;
    try {
      for (const file of files) {
        const target = path.join(staging, file.path);
        if (path.relative(staging, target).startsWith("..")) return fail("MATERIAL_PATH_OUTSIDE_ROOT", "手册里有越出目录的路径；没有写入。");
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, file.bytes);
      }
      if (existsSync(root)) rmSync(root, { recursive: true, force: true });
      renameSync(staging, root);
    } catch {
      rmSync(staging, { recursive: true, force: true });
      return fail("MATERIAL_PREPARATION_FAILED", "手册写入失败；你仍可人工自备材料。");
    }
    for (const file of files.filter((item) => item.record)) {
      store.saveMaterial({ id: randomUUID(), ownerId, workspaceId, workOrderId, uri: pathToFileURL(path.join(root, file.path)).href,
        mediaType: file.mediaType, sourceRefs: file.sourceRefs.length ? file.sourceRefs : ["manualbook"], createdAt: all.now().toISOString() });
    }
    store.transitionWorkOrder(workspaceId, workOrderId, { type: "materials.ready" }, `materials-ready:${workOrderId}:manualbook`);
    const sources = results.flatMap((result) => result.sources);
    store.appendEvent({ ownerId, workspaceId, idempotencyKey: `manualbook:built:${workOrderId}`, type: "manualbook.built", entityId: workOrderId,
      payload: { nodes: nodes.length, sources: sources.length, downloaded: sources.filter((source) => source.kept === "full_text").length } });
    return { state: "ready", workOrderId, artifacts: files.filter((item) => item.record).length, nodes: nodes.length, sources: sources.length,
      downloaded: sources.filter((source) => source.kept === "full_text").length };
  };
}

/**
 * Opens every source the model named and decides what to keep. A page that does not open, or does not match its claimed
 * title, is dropped. An open-access page on a known host is downloaded in full (capped, typed, checksummed); everything
 * else keeps its link and the model's summary and nothing of the page itself.
 */
async function keepSources(found: FoundSource[], deps: ManualbookDeps, today: string, gaps: string[]): Promise<KeptSource[]> {
  const kept: KeptSource[] = [];
  let downloads = 0;
  for (const source of found.slice(0, 6)) {
    const raw = openAccessVerdict(source);
    // Whether downloading is allowed at all is the approval policy's word, checked here rather than assumed.
    const verdict = raw.download && requiredApproval("download_open_access") !== "automatic" ? { download: false as const, why: "当前策略不允许自动下载" } : raw;
    const fetchedAt = deps.now().toISOString();
    if (verdict.download && downloads < DOWNLOADS_PER_NODE) {
      const address = arxivPdfAddress(source.url);
      const got = await safeGet(address, deps.safeGet, { maxBytes: MAX_PDF_BYTES, timeoutMs: 60_000 });
      if (got.ok) {
        const isPdf = got.contentType === "application/pdf";
        const text = isPdf ? (await extractText(got.bytes, "pdf")).text : got.contentType.startsWith("text/html") || got.contentType.includes("xhtml")
          ? htmlToText(new TextDecoder().decode(got.bytes)) : new TextDecoder().decode(got.bytes);
        if (text.trim() && claimedTitleMatches(source.title, text.slice(0, 6000))) {
          downloads += 1;
          kept.push({ id: source.id, url: source.url, title: source.title, publisher: source.publisher, kind: source.kind, summary: source.summary, kept: "full_text",
            verdict: verdict.why, fetchedAt, file: `${slug(source.title)}-${got.sha256.slice(0, 8)}.${isPdf ? "pdf" : got.contentType.startsWith("text/html") ? "html" : "txt"}`,
            sha256: got.sha256, bytes: got.bytes.byteLength, text: text.slice(0, TEXT_PER_SOURCE), raw: got.bytes });
          continue;
        }
        gaps.push(`「${source.title}」下载了，但内容与标题对不上，已丢弃。`);
        continue;
      }
      gaps.push(`「${source.title}」没能下载（${got.reason}）。`);
    }
    // Link and summary only: still opened, so a page that does not exist is not listed.
    const page = await safeGet(source.url, deps.safeGet, { maxBytes: MAX_PAGE_BYTES });
    if (!page.ok) { gaps.push(`「${source.title}」打不开（${page.reason}），已丢弃。`); continue; }
    if (page.contentType.startsWith("text/html") && !claimedTitleMatches(source.title, htmlToText(new TextDecoder().decode(page.bytes)).slice(0, 6000))) {
      gaps.push(`「${source.title}」的页面内容与标题对不上，已丢弃。`); continue;
    }
    kept.push({ id: source.id, url: source.url, title: source.title, publisher: source.publisher, kind: source.kind, summary: source.summary,
      kept: "summary_only", verdict: verdict.download ? "已达到下载数量上限：只保留链接和摘要" : verdict.why, fetchedAt, text: source.summary });
  }
  void today;
  return kept;
}

type OutFile = { path: string; bytes: Uint8Array | string; mediaType: string; record: boolean; sourceRefs: string[] };

function assemble(input: { design: ManualDesign; nodes: NodeResult[]; context: ManualDesignContext; builtAt: string }): Array<OutFile & { bytes: Uint8Array | string }> {
  const { design, nodes, context } = input;
  const files: OutFile[] = [];
  const order = new Map(nodes.map((result, index) => [result.node.id, index]));
  const depth = new Map<string, number>();
  for (const result of nodes) {
    const parents = design.edges.filter((edge) => edge.to === result.node.id).map((edge) => depth.get(edge.from) ?? 0);
    depth.set(result.node.id, parents.length ? Math.max(...parents) + 1 : 0);
  }
  files.push({ path: "flow.json", mediaType: "application/json", record: true, sourceRefs: [],
    bytes: JSON.stringify({ version: 1, nodes: nodes.map((result) => ({ id: result.node.id, title: result.node.title, kind: result.node.kind, goal: result.node.goal,
      stage: depth.get(result.node.id) ?? 0, order: order.get(result.node.id), hasWriteup: Boolean(result.writeup), sources: result.sources.length })), edges: design.edges }, null, 2) });

  const sourceList = (result: NodeResult) => result.sources.map((source) => `- **${source.id}** ${source.title}（${source.publisher || "—"}）${source.url}\n  - ${source.kept === "full_text" ? `已下载全文：${source.verdict}` : source.verdict}\n  - 摘要：${source.summary}`).join("\n");
  files.push({ path: "manual.md", mediaType: "text/markdown", record: true, sourceRefs: [],
    bytes: [`# ${context.workOrder.intent}`, "", design.overview, "", ...(design.assumptions.length ? ["## 假设", ...design.assumptions.map((item) => `- ${item}`), ""] : []),
      "## 流程", ...nodes.map((result, index) => `${index + 1}. [${result.node.title}](nodes/${result.node.id}/task.md) — ${result.node.goal}`)].join("\n") });
  for (const result of nodes) {
    const base = `nodes/${result.node.id}`;
    files.push({ path: `${base}/task.md`, mediaType: "text/markdown", record: true, sourceRefs: [],
      bytes: [`# ${result.node.title}`, "", `**目标**：${result.node.goal}`, "", "## 步骤", ...result.node.steps.map((step, index) => `${index + 1}. ${step}`), "",
        `## 怎样算做到\n${result.node.acceptance}`, ...(result.node.researchQuestions.length ? ["", "## 要查的问题", ...result.node.researchQuestions.map((q) => `- ${q}`)] : []),
        ...(result.gaps.length ? ["", "## 没查到的", ...result.gaps.map((gap) => `- ${gap}`)] : [])].join("\n") });
    if (result.writeup) {
      const cited = result.sources.filter((source) => result.writeup!.citations.includes(source.id));
      files.push({ path: `${base}/analysis.md`, mediaType: "text/markdown", record: true, sourceRefs: cited.map((source) => source.url),
        bytes: `# 分析：${result.node.title}\n\n${result.writeup.analysis}\n\n## 参考来源\n${sourceList(result) || "（这一步没有外部来源）"}\n` });
      files.push({ path: `${base}/tutorial.md`, mediaType: "text/markdown", record: true, sourceRefs: cited.map((source) => source.url),
        bytes: `# 教程：${result.node.title}\n\n${result.writeup.tutorial}\n` });
    } else if (result.note) {
      files.push({ path: `${base}/analysis.md`, mediaType: "text/markdown", record: true, sourceRefs: [], bytes: `# ${result.node.title}\n\n${result.note}\n` });
    }
    files.push({ path: `${base}/sources.json`, mediaType: "application/json", record: false, sourceRefs: [],
      bytes: JSON.stringify(result.sources.map(({ text: _text, raw: _raw, ...source }) => source), null, 2) });
    for (const source of result.sources) {
      if (source.file && source.raw) files.push({ path: `${base}/sources/${source.file}`, mediaType: source.file.endsWith(".pdf") ? "application/pdf" : "text/plain", record: true, sourceRefs: [source.url], bytes: source.raw });
    }
  }
  // Checksums last, over exactly what is written, so the manifest can be checked against the folder later.
  const manifest = { version: 1, builtAt: input.builtAt, workOrderId: context.workOrder.id,
    files: files.map((file) => ({ path: file.path, sha256: sha(file.bytes), bytes: typeof file.bytes === "string" ? Buffer.byteLength(file.bytes) : file.bytes.byteLength })),
    sources: nodes.flatMap((result) => result.sources.map((source) => ({ node: result.node.id, id: source.id, url: source.url, title: source.title, kept: source.kept,
      license: source.verdict, fetchedAt: source.fetchedAt, ...(source.sha256 ? { sha256: source.sha256, bytes: source.bytes } : {}) }))) };
  files.push({ path: "manifest.json", mediaType: "application/json", record: true, sourceRefs: [], bytes: JSON.stringify(manifest, null, 2) });
  return files;
}

/** Every WorkOrder currently waiting on material preparation that has not already had materials written. */
export function pendingMaterialWorkOrders(store: CrosslineStore, workspaceId: string): string[] {
  // A preparation that already failed is not retried on a timer: it would re-spend quota every tick with no new
  // information, and the human self-preparation path is open the whole time. Retrying is a deliberate act — so the
  // LAST word wins: a retry the person asked for re-opens the order, and a failure after that closes it again.
  const decidedAt = new Map<string, "blocked" | "retry">();
  for (const event of store.listEvents(workspaceId, { type: ["materials.blocked", "materials.retry_requested"] })) {
    decidedAt.set(event.entityId, event.type === "materials.blocked" ? "blocked" : "retry");
  }
  return store.listWorkOrders(workspaceId)
    .filter((order) => order.state === "preparing" && decidedAt.get(order.id) !== "blocked")
    .filter((order) => store.listMaterials(workspaceId, order.id).length === 0)
    .map((order) => order.id);
}

/** Folder listing for the person: what a built manualbook contains, for tests and for the task page. */
export function listManualbookFiles(materialsDir: string, workOrderId: string): string[] {
  const root = path.join(materialsDir, workOrderId);
  return existsSync(root) ? (readdirSync(root, { recursive: true }) as string[]).map((entry) => entry.replaceAll("\\", "/")).sort() : [];
}
