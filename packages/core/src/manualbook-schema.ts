import { publicHttpsUrl } from "./diligence-schema";

/**
 * A manualbook: what a task becomes once someone has thought about how to do it.
 *
 * Instead of a folder of loose text files, each task gets a flow chart of the steps it takes, left to right, and for
 * every step the instructions, the best material found for it, an analysis of that material and a tutorial. Three
 * model passes build it — design the flow, find material for each step, write each step up — and the checks between
 * them are in code: the flow must be a real chain with no loops and must cover what the task needs, every source must
 * be a public page the worker then actually opens, and every claim in a write-up must cite a source that exists.
 * Whether a source may be *downloaded* in full is not the model's decision at all; see `openAccessVerdict`.
 */
export const NODE_KINDS = ["read", "do", "decide", "verify", "write"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export type ManualNode = {
  id: string; title: string; kind: NodeKind; goal: string; steps: string[]; acceptance: string;
  /** The contract items (materials and evidence) this step serves, by id. */
  serves: string[];
  needsResearch: boolean; researchQuestions: string[];
};
export type ManualEdge = { from: string; to: string };
export type ManualDesign = { overview: string; nodes: ManualNode[]; edges: ManualEdge[]; assumptions: string[]; blockers: Array<{ code: string; message: string }> };

export type ManualDesignContext = {
  version: "crossline.manualbook.design.v1";
  today: string;
  workOrder: { id: string; intent: string; identityId: string; milestone: { title: string; target: string; deadline: string } | null };
  /** What the task has to be able to show at the end; every one must be served by some step. */
  contract: Array<{ id: string; kind: "material" | "evidence"; description: string; required: boolean }>;
  inputs: Array<{ id: string; text: string }>;
  /** Files the person has given the app, by name, so a step can say "start from this". */
  localFiles: string[];
  /** What is known about the person that bears on how to do this (confirmed facts only). */
  profile: Array<{ id: string; value: string }>;
  constraints: string[];
  /** The task's own steps, when it has a step plan: the tutorial follows them, one part per step, in this order. */
  plannedSteps?: Array<{ id: string; title: string; role: string; doneCriterion: string }>;
};

const text = (max: number, min = 1) => ({ type: "string", minLength: min, maxLength: max }) as const;
const object = (properties: Record<string, unknown>) =>
  ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const strings = (maxItems: number, max = 300) => ({ type: "array", maxItems, items: text(max) }) as const;

export const MANUAL_DESIGN_SCHEMA = object({
  overview: text(1500),
  nodes: { type: "array", minItems: 1, maxItems: 10, items: object({
    id: text(40), title: text(120), kind: { type: "string", enum: [...NODE_KINDS] }, goal: text(400),
    steps: { type: "array", minItems: 1, maxItems: 12, items: text(300) }, acceptance: text(400),
    serves: strings(10, 120), needsResearch: { type: "boolean" }, researchQuestions: strings(4, 300)
  }) },
  edges: { type: "array", maxItems: 30, items: object({ from: text(40), to: text(40) }) },
  assumptions: strings(8),
  blockers: { type: "array", maxItems: 6, items: object({ code: text(80), message: text(300) }) }
});

const SLUG = /^[a-z][a-z0-9-]{0,39}$/;
function refuse(code: string, detail: string): never {
  const error = new Error(code);
  (error as Error & { detail?: string }).detail = detail.slice(0, 400);
  throw error;
}

/** Orders node ids so every edge points forward; undefined when the flow has a loop. */
export function topologicalOrder(ids: string[], edges: ManualEdge[]): string[] | undefined {
  const incoming = new Map(ids.map((id) => [id, 0]));
  for (const edge of edges) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  const ready = ids.filter((id) => incoming.get(id) === 0);
  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const edge of edges.filter((item) => item.from === id)) {
      incoming.set(edge.to, incoming.get(edge.to)! - 1);
      if (incoming.get(edge.to) === 0) ready.push(edge.to);
    }
  }
  return order.length === ids.length ? order : undefined;
}

/**
 * The flow has to be a chain a person can follow: ids are well-formed and unique, every edge joins two real steps,
 * nothing loops, every step connects to the rest, and every required item the task must produce is served by some
 * step. A flow that fails any of these is sent back with the step named.
 */
export function validateManualDesign(value: unknown, context: ManualDesignContext): ManualDesign {
  const out = value as ManualDesign | undefined;
  if (!out || !Array.isArray(out.nodes) || !Array.isArray(out.edges) || !Array.isArray(out.blockers)) refuse("MANUAL_DESIGN_SCHEMA_INVALID", "输出结构不符合要求。");
  if (out.blockers.length) refuse("MANUAL_DESIGN_BLOCKED", out.blockers.map((blocker) => blocker.message).join("；"));
  const ids = new Set<string>();
  for (const node of out.nodes) {
    if (!SLUG.test(node.id)) refuse("MANUAL_NODE_ID_INVALID", `步骤 id「${node.id}」只能是小写字母、数字和连字符，字母开头。`);
    if (ids.has(node.id)) refuse("MANUAL_NODE_ID_DUPLICATE", `步骤 id「${node.id}」重复。`);
    ids.add(node.id);
    // Every step is researched (decided 2026-10-09): one written only from what the person already has told them nothing new.
    if (!node.needsResearch || node.researchQuestions.length < 2) refuse("MANUAL_RESEARCH_QUESTION_MISSING",
      `每一步都要联网查资料：步骤「${node.title}」需要 needsResearch=true 和至少两个具体的检索问题，其中至少一个能在公开网页上找到答案（教材、公开课讲义、官方文档或标准）。`);
  }
  for (const edge of out.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) refuse("MANUAL_EDGE_UNKNOWN_NODE", `连线 ${edge.from} → ${edge.to} 指向不存在的步骤。`);
    if (edge.from === edge.to) refuse("MANUAL_EDGE_SELF", `步骤「${edge.from}」连向自己。`);
  }
  if (!topologicalOrder([...ids], out.edges)) refuse("MANUAL_FLOW_HAS_LOOP", "流程里有回路；手册要是一条从左到右能走完的路径。");
  if (out.nodes.length > 1) {
    const linked = new Set(out.edges.flatMap((edge) => [edge.from, edge.to]));
    const loose = out.nodes.find((node) => !linked.has(node.id));
    if (loose) refuse("MANUAL_NODE_DISCONNECTED", `步骤「${loose.title}」没有和其它步骤相连。`);
  }
  const known = new Set(context.contract.map((item) => item.id));
  const served = new Set<string>();
  for (const node of out.nodes) {
    for (const id of node.serves) {
      if (!known.has(id)) refuse("MANUAL_CONTRACT_UNKNOWN", `步骤「${node.title}」声称服务的要求「${id}」不存在。`);
      served.add(id);
    }
  }
  const missing = context.contract.find((item) => item.required && !served.has(item.id));
  if (missing) refuse("MANUAL_CONTRACT_UNSERVED", `必需的要求「${missing.description.slice(0, 40)}」没有任何步骤负责。`);
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Finding material

export type FoundSourceKind = "paper" | "docs" | "tutorial" | "dataset" | "tool" | "other";
export type FoundSource = {
  id: string; url: string; title: string; publisher: string; kind: FoundSourceKind;
  /** The model's reading of whether the full text may be kept. Only a claim: `openAccessVerdict` decides. */
  openAccess: "yes" | "unknown" | "no"; licenseNote: string; summary: string;
};
export type MaterialSearch = { sources: FoundSource[]; gaps: string[]; blockers: Array<{ code: string; message: string }> };

export type MaterialSearchContext = {
  version: "crossline.manualbook.search.v1";
  today: string;
  task: { intent: string };
  node: Pick<ManualNode, "id" | "title" | "kind" | "goal" | "steps" | "researchQuestions">;
  localFiles: string[];
  constraints: string[];
};

export const MATERIAL_SEARCH_SCHEMA = object({
  sources: { type: "array", maxItems: 8, items: object({
    id: text(40), url: text(500, 8), title: text(300), publisher: text(200, 0),
    kind: { type: "string", enum: ["paper", "docs", "tutorial", "dataset", "tool", "other"] },
    openAccess: { type: "string", enum: ["yes", "unknown", "no"] }, licenseNote: text(300, 0), summary: text(800)
  }) },
  gaps: strings(6),
  blockers: { type: "array", maxItems: 4, items: object({ code: text(80), message: text(300) }) }
});

export function validateMaterialSearch(value: unknown): MaterialSearch {
  const out = value as MaterialSearch | undefined;
  if (!out || !Array.isArray(out.sources) || !Array.isArray(out.gaps) || !Array.isArray(out.blockers)) refuse("MANUAL_SEARCH_SCHEMA_INVALID", "输出结构不符合要求。");
  if (out.blockers.length) refuse("MANUAL_SEARCH_BLOCKED", out.blockers.map((blocker) => blocker.message).join("；"));
  const ids = new Set<string>();
  for (const source of out.sources) {
    if (ids.has(source.id)) refuse("MANUAL_SOURCE_ID_DUPLICATE", `来源 id「${source.id}」重复。`);
    ids.add(source.id);
    if (!publicHttpsUrl(source.url)) refuse("MANUAL_SOURCE_URL_INVALID", `来源「${source.title}」的网址必须是公开的 https 页面（不能是 IP、本地地址或带端口的地址）。`);
  }
  return out;
}

/**
 * May the full text of this page be kept? Not the model's call. Only a short list of hosts that publish
 * open-access work by policy qualify, and only when the model also said the page is open access; every other page
 * keeps just its link and a summary. A wrong "yes" from the model cannot put a copyrighted paper on disk, because the
 * host has to be on the list as well.
 */
const OPEN_ACCESS_HOSTS: Array<{ host: RegExp; why: string }> = [
  { host: /(^|\.)arxiv\.org$/, why: "arXiv 预印本（作者授权公开）" },
  { host: /(^|\.)biorxiv\.org$|(^|\.)medrxiv\.org$/, why: "bioRxiv / medRxiv 预印本" },
  { host: /(^|\.)ncbi\.nlm\.nih\.gov$|(^|\.)europepmc\.org$/, why: "PubMed Central / Europe PMC（开放获取子集）" },
  { host: /(^|\.)openreview\.net$/, why: "OpenReview（会议公开稿）" },
  { host: /(^|\.)aclanthology\.org$/, why: "ACL Anthology（开放获取）" },
  { host: /(^|\.)proceedings\.mlr\.press$|(^|\.)jmlr\.org$/, why: "PMLR / JMLR（开放获取）" },
  { host: /(^|\.)plos\.org$|(^|\.)journals\.plos\.org$/, why: "PLOS（CC-BY 开放获取）" },
  { host: /(^|\.)zenodo\.org$/, why: "Zenodo（带许可的公开存档）" },
  { host: /(^|\.)docs\.python\.org$|(^|\.)developer\.mozilla\.org$|(^|\.)docs\.github\.com$/, why: "公开技术文档" }
];

export type OpenAccessVerdict = { download: true; why: string } | { download: false; why: string };
export function openAccessVerdict(source: Pick<FoundSource, "url" | "openAccess">): OpenAccessVerdict {
  const url = publicHttpsUrl(source.url);
  if (!url) return { download: false, why: "不是公开的 https 页面" };
  const entry = OPEN_ACCESS_HOSTS.find((item) => item.host.test(url.hostname.toLowerCase()));
  if (!entry) return { download: false, why: "来源不在已知的开放获取站点里：只保留链接和摘要" };
  if (source.openAccess === "no") return { download: false, why: "模型判断这一篇不是开放获取：只保留链接和摘要" };
  return { download: true, why: entry.why };
}

// ---------------------------------------------------------------------------------------------------------
// Writing a step up

export type WriteContext = {
  version: "crossline.manualbook.write.v1";
  today: string;
  task: { intent: string };
  node: Pick<ManualNode, "id" | "title" | "kind" | "goal" | "steps" | "acceptance">;
  /** What was kept for this step: downloaded text (clipped) or a summary and link. Cite them by `id`. */
  sources: Array<{ id: string; title: string; url: string; kept: "full_text" | "summary_only" | "unverified"; text: string }>;
  inputs: Array<{ id: string; text: string }>;
  profile: Array<{ id: string; value: string }>;
};
export type NodeWriteup = { analysis: string; tutorial: string; citations: string[];
  /** One note per material used: what in it matters for this step and how to use it (the material's own preview page shows these). */
  sourceNotes: Array<{ sourceId: string; note: string }>;
  blockers: Array<{ code: string; message: string }> };

export const NODE_WRITEUP_SCHEMA = object({
  analysis: text(12_000), tutorial: text(12_000), citations: strings(20, 60),
  sourceNotes: { type: "array", maxItems: 12, items: object({ sourceId: text(60), note: text(1500) }) },
  blockers: { type: "array", maxItems: 4, items: object({ code: text(80), message: text(300) }) }
});

export function validateNodeWriteup(value: unknown, context: WriteContext): NodeWriteup {
  const out = value as NodeWriteup | undefined;
  if (!out || typeof out.analysis !== "string" || typeof out.tutorial !== "string" || !Array.isArray(out.citations) || !Array.isArray(out.blockers)) refuse("MANUAL_WRITEUP_SCHEMA_INVALID", "输出结构不符合要求。");
  if (out.blockers.length) refuse("MANUAL_WRITEUP_BLOCKED", out.blockers.map((blocker) => blocker.message).join("；"));
  const known = new Set(context.sources.map((source) => source.id));
  for (const id of out.citations) if (!known.has(id)) refuse("MANUAL_CITATION_UNKNOWN", `引用了不存在的来源「${id}」；只能引用 sources 里给出的 id。`);
  // A note about a source the step was not given is dropped rather than refused: the write-up itself stands.
  out.sourceNotes = (Array.isArray(out.sourceNotes) ? out.sourceNotes : []).filter((item) => item && known.has(item.sourceId) && typeof item.note === "string" && item.note.trim());
  // A write-up that cites nothing, for a step that had sources to cite, is opinion with headings on it.
  if (context.sources.length && !out.citations.length) refuse("MANUAL_WRITEUP_UNCITED", "这一步有可引用的来源，但分析和教程没有引用任何一个。");
  // A page the model was not given cannot be quoted by address either.
  const urls = (out.analysis + out.tutorial).match(/https?:\/\/[^\s)>\]"']+/g) ?? [];
  const given = new Set(context.sources.map((source) => source.url));
  const stray = urls.find((url) => ![...given].some((address) => url.startsWith(address.replace(/\/$/, ""))));
  if (stray) refuse("MANUAL_URL_INVENTED", `正文里出现了没有提供给你的网址：${stray.slice(0, 80)}。要引用就用来源 id，不要自己写网址。`);
  return out;
}
