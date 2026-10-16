/**
 * Due diligence: what the app finds out on the web about something the person asked for, before it proposes
 * anything. A proposal that arrives with no source is an opinion, so the contract is built around sources.
 *
 * Three layers keep it honest. This file refuses an answer whose findings cite nothing, whose sources are not
 * public https pages, or whose proposals rest on no finding. The worker then actually fetches every source and
 * drops the ones that do not resolve or do not match what was claimed about them. Last, the person decides:
 * nothing here becomes a milestone or a task until they accept it.
 */
export const DILIGENCE_TOPICS = ["opportunities", "positioning", "literature", "tracking_framework"] as const;
export type DiligenceTopic = (typeof DILIGENCE_TOPICS)[number];

export type DiligenceSource = { id: string; url: string; title: string; publisher: string; accessedOn: string };
export type DiligenceFinding = { id: string; claim: string; sourceIds: string[]; confidence: "high" | "medium" | "low"; staleWhen: string };
export type DiligenceProposal = {
  id: string; title: string; why: string; kind: "milestone" | "task" | "watch";
  /** `YYYY-MM-DD`, or empty when the finding gives no date. */
  dueDate: string; basedOnFacts: string[]; findingIds: string[];
};
export type DiligenceOutput = {
  question: string; sources: DiligenceSource[]; findings: DiligenceFinding[]; proposals: DiligenceProposal[];
  gaps: string[]; blockers: Array<{ code: string; message: string }>;
};

export type DiligenceContext = {
  version: "crossline.diligence.v1";
  today: string; timeZone: string;
  identity: { id: string; label: string };
  topic: { kind: DiligenceTopic; question: string };
  projects: Array<{ id: string; name: string; summary: string }>;
  /** The profile, each fact addressed by id so a proposal can say which of the person's own facts it follows from. */
  facts: Array<{ id: string; projectId: string; slot: string; value: string; status: "confirmed" | "inferred" }>;
  /** Limits the person has set, in their words. A finding that ignores one is not useful however true it is. */
  constraints: string[];
  /** Titles already proposed and answered, so the same idea is not offered twice. */
  alreadyDecided: Array<{ title: string; decision: "accepted" | "rejected" }>;
};

const text = (max: number, min = 0) => ({ type: "string", minLength: min, maxLength: max }) as const;
const object = (properties: Record<string, unknown>) =>
  ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

export const DILIGENCE_OUTPUT_SCHEMA = object({
  question: text(400, 1),
  sources: { type: "array", maxItems: 30, items: object({ id: text(40, 1), url: text(500, 8), title: text(300, 1), publisher: text(200), accessedOn: text(10, 10) }) },
  findings: { type: "array", maxItems: 30, items: object({
    id: text(40, 1), claim: text(600, 8), sourceIds: { type: "array", minItems: 1, maxItems: 6, items: text(40, 1) },
    confidence: { type: "string", enum: ["high", "medium", "low"] }, staleWhen: text(300, 1)
  }) },
  proposals: { type: "array", maxItems: 12, items: object({
    id: text(40, 1), title: text(200, 6), why: text(600, 8), kind: { type: "string", enum: ["milestone", "task", "watch"] },
    dueDate: text(10), basedOnFacts: { type: "array", maxItems: 8, items: text(200, 1) },
    findingIds: { type: "array", minItems: 1, maxItems: 8, items: text(40, 1) }
  }) },
  gaps: { type: "array", maxItems: 10, items: text(300, 1) },
  blockers: { type: "array", maxItems: 10, items: object({ code: text(80, 1), message: text(300, 1) }) }
});

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const day = (value: string) => Date.parse(`${value}T00:00:00Z`);
/** Buying, selling and price calls are not research. The investment line gets findings and frameworks only. */
const TRADING_ADVICE = /买入|卖出|加仓|减仓|建仓|清仓|抄底|止损|止盈|目标价|\b(buy|sell|short|overweight|underweight)\b|price target/i;

function refuse(code: string, detail: string): never {
  const error = new Error(code);
  (error as Error & { detail?: string }).detail = detail.slice(0, 400);
  throw error;
}

/**
 * A page the worker is willing to request from the person's machine: public https, a real hostname, the default
 * port. Literal IPs and local names are refused here because a model-supplied URL must never be a way to make
 * this machine call something on its own network.
 */
export function publicHttpsUrl(value: string): URL | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return undefined;
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || host === "localhost" || /\.(local|localhost|internal|lan|home|test)$/.test(host)) return undefined;
  if (/^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[")) return undefined;
  return url;
}

/** Checks one answer against the context it was produced for. Its refusals are repair messages to the model, not interface text. */
/* i18n-ignore-start */
export function validateDiligence(value: unknown, context: DiligenceContext): DiligenceOutput {
  const out = value as DiligenceOutput | undefined;
  if (!out || !Array.isArray(out.sources) || !Array.isArray(out.findings) || !Array.isArray(out.proposals)
    || !Array.isArray(out.gaps) || !Array.isArray(out.blockers)) refuse("DILIGENCE_SCHEMA_INVALID", "输出结构不符合要求。");
  if (out.blockers.length) refuse("DILIGENCE_BLOCKED", out.blockers.map((blocker) => blocker.message).join("；"));

  const today = day(context.today);
  const sources = new Set<string>();
  for (const source of out.sources) {
    if (sources.has(source.id)) refuse("DILIGENCE_DUPLICATE_ID", `来源 id「${source.id}」重复。`);
    sources.add(source.id);
    if (!publicHttpsUrl(source.url)) refuse("DILIGENCE_SOURCE_URL_INVALID", `来源「${source.title}」的网址必须是公开的 https 页面（不能是 IP、本地地址或带端口的地址）。`);
    if (!ISO.test(source.accessedOn) || Math.abs(day(source.accessedOn) - today) > 3 * 86_400_000) {
      refuse("DILIGENCE_SOURCE_DATE_INVALID", `来源「${source.title}」的读取日期 ${source.accessedOn} 必须是今天前后 3 天内（今天是 ${context.today}）。`);
    }
  }

  const findings = new Set<string>();
  for (const finding of out.findings) {
    if (findings.has(finding.id)) refuse("DILIGENCE_DUPLICATE_ID", `结论 id「${finding.id}」重复。`);
    findings.add(finding.id);
    if (!finding.sourceIds.length || finding.sourceIds.some((id) => !sources.has(id))) {
      refuse("DILIGENCE_FINDING_UNSOURCED", `结论「${finding.claim.slice(0, 40)}」没有引用 sources 里存在的来源。`);
    }
    if (context.identity.id === "investment" && TRADING_ADVICE.test(finding.claim)) {
      refuse("DILIGENCE_ADVICE_FORBIDDEN", `投资线只做收益率/风险追踪、配置分析和研究备忘，结论「${finding.claim.slice(0, 40)}」含买卖建议或目标价。`);
    }
  }

  const known = new Set(context.facts.map((fact) => fact.id));
  for (const proposal of out.proposals) {
    if (findings.has(proposal.id)) refuse("DILIGENCE_DUPLICATE_ID", `建议 id「${proposal.id}」与结论 id 重复。`);
    if (!proposal.findingIds.length || proposal.findingIds.some((id) => !findings.has(id))) {
      refuse("DILIGENCE_PROPOSAL_UNSOURCED", `建议「${proposal.title}」没有建立在 findings 里存在的结论上。`);
    }
    if (proposal.basedOnFacts.some((id) => !known.has(id))) refuse("DILIGENCE_FACT_UNKNOWN", `建议「${proposal.title}」引用了画像里不存在的事实。`);
    if (proposal.dueDate && (!ISO.test(proposal.dueDate) || day(proposal.dueDate) < today)) {
      refuse("DILIGENCE_DUE_DATE_INVALID", `建议「${proposal.title}」的日期「${proposal.dueDate}」必须是今天或之后的 YYYY-MM-DD，或留空。`);
    }
    if (context.identity.id === "investment" && TRADING_ADVICE.test(`${proposal.title} ${proposal.why}`)) {
      refuse("DILIGENCE_ADVICE_FORBIDDEN", `投资线的建议「${proposal.title}」含买卖建议或目标价。`);
    }
    if (context.alreadyDecided.some((item) => item.title.trim() === proposal.title.trim())) {
      refuse("DILIGENCE_PROPOSAL_REPEATED", `建议「${proposal.title}」你已经回答过了，不要再提。`);
    }
  }
  return out;
}
/* i18n-ignore-end */
