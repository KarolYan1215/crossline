import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  DILIGENCE_OUTPUT_SCHEMA, publicHttpsUrl, profileFactId, validateDiligence, budgetPolicy,
  type CostSignal, type DiligenceContext, type DiligenceOutput, type DiligenceSource, type DiligenceTopic
} from "@crossline/core";
import { runCodexSkill, webResearchBlocker, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore, StoredDiligenceReport } from "@crossline/db";
import { defaultIdentityPacks } from "@crossline/identity-packs";

export const DILIGENCE_SKILL = "crossline:crossline-due-diligence";
import { ownerOf } from "./owner";
/** A weekly refresh, not a loop: a line is researched again only once its last report is this old. */
export const DILIGENCE_REFRESH_DAYS = 7;

const INSTRUCTIONS = "Research the question on the public web, then report only what you actually read. Every "
  + "finding cites sources by id; every source is a public https page you opened, with its real title and the "
  + "date you read it (today or within three days). Never cite a page you did not read and never invent a "
  + "deadline, price, requirement or number. Propose only things that follow from a finding AND from the "
  + "person's own facts (cite their ids in basedOnFacts), and respect every constraint listed. Put what you "
  + "could not establish in `gaps` instead of guessing. Do not repeat anything in `alreadyDecided`. For the "
  + "investment line give findings, tracking frameworks and memo templates only: no buy or sell call, no price "
  + "target. Write every human-readable field in Chinese.";

const QUESTIONS: Record<DiligenceTopic, string> = {
  opportunities: "找出适合这个人当前阶段和身份约束的外部机会（比赛、孵化器、资助、合作渠道）。每一项都要有申请条件、是否对在读学生开放和截止日期。",
  positioning: "基于公开的事实（同类账号的数据、平台规则、受众需求）判断这条线最可行的定位和选题方向，并说明依据。",
  literature: "为这个人正在做的项目梳理最相关的文献和代表性工作，给出可以直接开始读的清单，并指出尚未被充分回答的空白。",
  tracking_framework: "给出个人账户收益率与风险的追踪框架和研究备忘录模板（指标口径、记录频率、数据来源），不包含任何买卖建议。"
};

export type SourceCheck =
  | { ok: true; finalUrl: string; pageTitle: string; status: number; text: string }
  | { ok: false; reason: string };

export type DiligenceDeps = {
  /** Why web research cannot run on this machine, if it cannot. */
  webBlocker: () => { code: string; message: string } | undefined;
  fetchImpl: typeof fetch;
  /** True when every address the host resolves to is public. Injected so tests never touch the network. */
  isPublicHost: (host: string) => Promise<boolean>;
  readCost: () => Promise<CostSignal>;
  now: () => Date;
};

const PRIVATE_V4 = [/^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];
export function isPrivateAddress(address: string): boolean {
  const mapped = address.toLowerCase().replace(/^::ffff:/, "");
  if (isIP(mapped) === 4) return PRIVATE_V4.some((pattern) => pattern.test(mapped));
  return mapped === "::1" || mapped === "::" || /^f[cd]/.test(mapped) || /^fe[89ab]/.test(mapped);
}

export const resolvesPublicly = async (host: string): Promise<boolean> => {
  try {
    const records = await lookup(host, { all: true });
    return records.length > 0 && records.every((record) => !isPrivateAddress(record.address));
  } catch { return false; }
};

/** Latin words and CJK character pairs, so a Chinese title is compared as well as an English one. */
function tokens(value: string): Set<string> {
  const lower = value.toLowerCase();
  const out = new Set<string>(lower.match(/[a-z0-9]{3,}/g) ?? []);
  for (const run of lower.match(/[㐀-鿿]+/g) ?? []) for (let i = 0; i + 1 < run.length; i += 1) out.add(run.slice(i, i + 2));
  return out;
}

/** Does a page's own text share enough of the title the model gave it? A page that does not is not the page it was said to be. */
export function claimedTitleMatches(claimedTitle: string, pageText: string): boolean {
  const claimed = tokens(claimedTitle);
  if (!claimed.size) return true;
  const haystack = tokens(pageText);
  return [...claimed].filter((token) => haystack.has(token)).length / claimed.size >= 0.4;
}

const decode = (html: string) => html.replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");

/**
 * Opens a source the way the person's machine would, and says whether it is what was claimed. A model that
 * names a page it never read usually names a page that does not exist or does not say that, and a link that
 * resolves but whose title shares nothing with the claimed one is treated the same way.
 */
export async function verifySource(source: DiligenceSource, deps: Pick<DiligenceDeps, "fetchImpl" | "isPublicHost">): Promise<SourceCheck> {
  let url = publicHttpsUrl(source.url);
  for (let hop = 0; hop < 4; hop += 1) {
    if (!url) return { ok: false, reason: "地址不是公开的 https 页面" };
    if (!(await deps.isPublicHost(url.hostname))) return { ok: false, reason: "域名解析到非公开地址" };
    let response: Response;
    try {
      response = await deps.fetchImpl(url.toString(), {
        redirect: "manual", signal: AbortSignal.timeout(10_000),
        headers: { "user-agent": "Crossline/1.0 (personal research; local)", accept: "text/html,application/xhtml+xml" }
      });
    } catch { return { ok: false, reason: "打不开" }; }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      try { url = location ? publicHttpsUrl(new URL(location, url).toString()) : undefined; } catch { url = undefined; }
      continue;
    }
    if (response.status < 200 || response.status >= 300) return { ok: false, reason: `返回 ${response.status}` };
    const body = (await response.text().catch(() => "")).slice(0, 200_000);
    const pageTitle = decode(body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() ?? "");
    if (!claimedTitleMatches(source.title, `${pageTitle} ${body.replace(/<[^>]+>/g, " ").slice(0, 4000)}`)) return { ok: false, reason: "页面内容与声称的标题对不上" };
    return { ok: true, finalUrl: url.toString(), pageTitle, status: response.status, text: `${pageTitle} ${body.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/gi, " ")}`.toLowerCase().slice(0, 150_000) };
  }
  return { ok: false, reason: "跳转过多" };
}

/**
 * Does a page actually say what a finding claims it says? The names and figures in the claim — Latin words of
 * four letters or more — have to appear in the page it cites. A claim about one organisation filed under
 * another's page is the usual way a model miscites, and this catches it without trying to judge meaning. Figures are
 * left out on purpose: a date is written `2026-11-15` in the claim and "Nov 15" on the page. A claim with no Latin
 * names (plain Chinese prose) cannot be tested this way and passes.
 */
export function pageSupports(claim: string, pageText: string): boolean {
  const tokens = [...new Set(claim.toLowerCase().match(/[a-z]{4,}/g) ?? [])];
  if (!tokens.length) return true;
  return tokens.filter((token) => pageText.includes(token)).length / tokens.length >= 0.5;
}

export type DiligenceOutcome =
  | { state: "done"; reportId: string; findings: number; proposals: number; droppedSources: number }
  | { state: "skipped"; reason: "recent_report" | "no_profile" }
  | { state: "blocked"; code: string; message: string };

export function topicFor(identityId: string): DiligenceTopic {
  const pack = defaultIdentityPacks().find((item) => item.id === identityId);
  return pack?.diligenceTopic ?? "opportunities";
}

/** What this person has already answered for this line, so a refresh never offers the same idea twice. */
function decidedProposals(reports: StoredDiligenceReport[], identityId: string): DiligenceContext["alreadyDecided"] {
  return reports.filter((report) => report.scope === identityId).flatMap((report) =>
    ((report.proposals as Array<{ title: string; status: string }>) ?? [])
      .filter((proposal) => proposal.status === "accepted" || proposal.status === "rejected")
      .map((proposal) => ({ title: proposal.title, decision: proposal.status as "accepted" | "rejected" })));
}

export function createDiligenceRunner(store: CrosslineStore, workspaceId: string, cwd: string,
  getClient: () => CodexRpcBoundary | undefined, deps: Partial<DiligenceDeps> & Pick<DiligenceDeps, "readCost">) {
  const all: DiligenceDeps = { fetchImpl: fetch, isPublicHost: resolvesPublicly, now: () => new Date(), webBlocker: webResearchBlocker, ...deps };

  return async function run(identityId: string, options: { force?: boolean } = {}): Promise<DiligenceOutcome> {
    const client = getClient();
    if (!client) return { state: "blocked", code: "CODEX_SUPERVISOR_UNAVAILABLE", message: "Codex 运行时不可用。" };
    const unavailable = all.webBlocker();
    if (unavailable) return { state: "blocked", ...unavailable };
    const pack = defaultIdentityPacks().find((item) => item.id === identityId && item.kind === "identity");
    if (!pack) return { state: "blocked", code: "DILIGENCE_IDENTITY_UNKNOWN", message: "没有这条主线。" };
    const facts = store.listProfileFacts(workspaceId).filter((fact) => fact.identityId === identityId);
    if (facts.length < 2) return { state: "skipped", reason: "no_profile" };

    const now = all.now();
    const reports = store.listDiligenceReports(workspaceId);
    const latest = reports.find((report) => report.scope === identityId && report.status === "done");
    if (!options.force && latest && now.getTime() - Date.parse(latest.runAt) < DILIGENCE_REFRESH_DAYS * 86_400_000) {
      return { state: "skipped", reason: "recent_report" };
    }

    // Web research is discretionary spend: when the window is nearly used up, the person's own work comes first.
    const cost = await all.readCost();
    const mode = cost.available ? budgetPolicy(Math.max(cost.short?.usedPercent ?? 0, cost.long?.usedPercent ?? 0)).mode : "manual_core_only";
    // Stricter than material preparation: this is background work nobody is waiting on, so it stops as soon as
    // the window is tight (economy mode) and not only when it is gone.
    if (mode !== "normal") {
      return { state: "blocked", code: cost.available ? "DILIGENCE_BUDGET_LOW" : "COST_SIGNAL_UNAVAILABLE",
        message: cost.available ? "额度已经比较紧张；尽调等额度恢复后再做。" : "读不到用量信号；尽调暂缓。" };
    }

    const topic = topicFor(identityId);
    const ownerId = ownerOf(store, workspaceId);
    const preferences = store.getSetting(workspaceId, "schedule.preferences");
    let timeZone = "America/Chicago";
    try { const zone = preferences ? (JSON.parse(preferences) as { timeZone?: unknown }).timeZone : undefined; if (typeof zone === "string" && zone) timeZone = zone; }
    catch { /* an unreadable setting falls back to the default zone */ }
    const reportId = `dd-${randomUUID()}`;
    const runAt = now.toISOString();
    const context: DiligenceContext = {
      version: "crossline.diligence.v1", today: runAt.slice(0, 10), timeZone,
      identity: { id: pack.id, label: pack.label }, topic: { kind: topic, question: QUESTIONS[topic] },
      projects: store.listProjects(workspaceId).filter((project) => project.identityId === identityId)
        .map(({ id, name, summary }) => ({ id, name, summary })),
      facts: facts.map((fact) => ({ id: profileFactId(fact), projectId: fact.projectId, slot: fact.slot, value: fact.value, status: fact.status })),
      // Whatever the person said limits the answer: stated constraints are facts in the slots that name them.
      constraints: facts.filter((fact) => /constraint|limit|约束|限制/.test(fact.slot) || /无法|不能|不要|不做|不给/.test(fact.value)).map((fact) => fact.value).slice(0, 8),
      alreadyDecided: decidedProposals(reports, identityId)
    };
    store.saveDiligenceReport({ id: reportId, ownerId, workspaceId, scope: identityId, question: context.topic.question,
      findings: [], proposals: [], sources: [], status: "running", runAt });

    const result = await runCodexSkill<DiligenceOutput>(client, context, {
      skillName: DILIGENCE_SKILL, cwd, developerInstructions: INSTRUCTIONS, outputSchema: DILIGENCE_OUTPUT_SCHEMA,
      allowWebSearch: true, prepareInput: () => context, validateOutput: (output) => validateDiligence(output, context),
      onAudit: () => {}, timeoutMs: 60 * 60_000
    });
    if (!result.ok) {
      store.saveDiligenceReport({ id: reportId, ownerId, workspaceId, scope: identityId, question: context.topic.question,
        findings: [], proposals: [], sources: [], status: "failed", note: result.blocker.message, runAt });
      return { state: "blocked", code: result.blocker.code, message: result.blocker.message };
    }

    // The model's word about its sources is not enough: each one is opened here.
    const checks = await Promise.all(result.output.sources.map(async (source) => [source, await verifySource(source, all)] as const));
    const good = new Map(checks.flatMap(([source, check]) => check.ok ? [[source.id, { source, check }] as const] : []));
    const droppedSources = checks.length - good.size;
    // A source stays on a finding only if the page opened AND says what the finding claims.
    let unsupported = 0;
    const findings = result.output.findings.map((finding) => ({ ...finding, sourceIds: finding.sourceIds.filter((id) => {
      const entry = good.get(id);
      const supported = Boolean(entry && entry.check.ok && pageSupports(finding.claim, entry.check.text));
      if (entry && !supported) unsupported += 1;
      return supported;
    }) })).filter((finding) => finding.sourceIds.length > 0);
    const keptFindings = new Set(findings.map((finding) => finding.id));
    const proposals = result.output.proposals.map((proposal) => ({ ...proposal, findingIds: proposal.findingIds.filter((id) => keptFindings.has(id)) }))
      .filter((proposal) => proposal.findingIds.length > 0).map((proposal) => ({ ...proposal, status: "pending" as const }));
    const used = new Set(findings.flatMap((finding) => finding.sourceIds));
    const sources = [...good.values()].filter(({ source }) => used.has(source.id)).map(({ source, check }) => ({
      ...source, finalUrl: check.ok ? check.finalUrl : source.url, pageTitle: check.ok ? check.pageTitle : "", verifiedAt: runAt
    }));

    if (!findings.length) {
      store.saveDiligenceReport({ id: reportId, ownerId, workspaceId, scope: identityId, question: context.topic.question,
        findings: [], proposals: [], sources: [], status: "failed", runAt,
        note: `没有一个来源能被核实（${droppedSources} 个来源被丢弃），所以没有写入任何结论。` });
      return { state: "blocked", code: "DILIGENCE_NO_VERIFIED_SOURCE", message: "没有一个来源能被核实，所以没有写入任何结论。" };
    }
    store.saveDiligenceReport({ id: reportId, ownerId, workspaceId, scope: identityId, question: context.topic.question,
      findings, proposals, sources, status: "done", runAt,
      ...(result.output.gaps.length || droppedSources || unsupported
        ? { note: [...result.output.gaps, ...(droppedSources ? [`${droppedSources} 个来源无法核实，已丢弃。`] : []),
            ...(unsupported ? [`${unsupported} 处引用与所引页面的内容对不上，已去掉。`] : [])].join("；") } : {}) });
    store.appendEvent({ ownerId, workspaceId, idempotencyKey: `diligence:done:${reportId}`, type: "diligence.done", entityId: reportId,
      payload: { identityId, topic, findings: findings.length, proposals: proposals.length, droppedSources } });
    return { state: "done", reportId, findings: findings.length, proposals: proposals.length, droppedSources };
  };
}

/** Lines that have enough profile to research and no recent report: what the weekly pass should run. */
export function linesDueForDiligence(store: CrosslineStore, workspaceId: string, now: Date): string[] {
  const reports = store.listDiligenceReports(workspaceId);
  return defaultIdentityPacks().filter((pack) => pack.kind === "identity").map((pack) => pack.id).filter((id) => {
    if (store.listProfileFacts(workspaceId).filter((fact) => fact.identityId === id).length < 2) return false;
    const latest = reports.find((report) => report.scope === id && (report.status === "done" || report.status === "running"));
    return !latest || now.getTime() - Date.parse(latest.runAt) >= DILIGENCE_REFRESH_DAYS * 86_400_000;
  });
}
