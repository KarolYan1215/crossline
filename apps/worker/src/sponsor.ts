import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  admittedSkills, chooseSponsorModel, conformanceCases, conformanceCurrent, jsonSchemaProblems, parseSponsorModels, sponsorMonth, sponsorSpend,
  SPONSOR_MONTHLY_CAP_CNY, summarizeConformance, type ConformanceRecord, type ConformanceRun, type CostSignal, type ProviderCapabilities,
  type SponsorEvaluation, type SponsorModel
} from "@crossline/core";
import { runCodexSkill, withUsageWorkspace, threadProvider, type CodexRpcBoundary, type GatewayUpstream, type ModelGateway, type ProviderConfig, type SkillUsage } from "@crossline/codex";
import { sponsorshipOf, type CrosslineStore } from "@crossline/db";
import { RUNTIME_VERSION } from "./model-provider";

/**
 * The developer's model for invited accounts (2026-10-18; rules in `packages/core/src/sponsor.ts`). The key is the server's own
 * (`CROSSLINE_SPONSOR_API_KEY`, never written to the ledger or shown), the candidates and their prices come from the environment, and
 * which candidate serves is decided by running the conformance cases on each through the same gateway a person's own provider uses.
 * The measurements live beside the ledger in `sponsor.json`, so a restart does not test again until a record goes stale.
 */
export const SPONSOR_PROVIDER_ID = "sponsor";
/** Usage of evaluation runs is attributed to this prefix, never to a workspace: the sink hands it here instead of the ledger. */
export const SPONSOR_EVAL_PREFIX = "sponsor-eval:";
const CONFORMANCE_SKILL = "crossline:crossline-conformance";

type Saved = { evaluations: SponsorEvaluation[] };

export function sponsorFromEnv(env: NodeJS.ProcessEnv = process.env): { key: string; baseUrl: string; models: SponsorModel[]; capYuan: number } | undefined {
  const key = env.CROSSLINE_SPONSOR_API_KEY?.trim();
  const models = parseSponsorModels(env.CROSSLINE_SPONSOR_MODELS);
  if (!key || !models.length) return undefined;
  const cap = Number(env.CROSSLINE_SPONSOR_MONTHLY_CNY);
  return { key, baseUrl: (env.CROSSLINE_SPONSOR_BASE_URL?.trim() || "https://api.siliconflow.cn/v1").replace(/\/+$/, ""), models,
    capYuan: cap > 0 ? cap : SPONSOR_MONTHLY_CAP_CNY };
}

export function createSponsorService(options: {
  store: CrosslineStore; dataDir: string; cwd: string; gateway: ModelGateway; capabilities: ProviderCapabilities;
  /** A runtime to run the evaluation threads on (the owner's sidecar): the provider is defined per thread, so any client serves. */
  client: () => CodexRpcBoundary | undefined;
  env?: NodeJS.ProcessEnv; now?: () => Date; fetch?: typeof fetch;
}) {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const file = path.join(options.dataDir, "sponsor.json");
  const evalUsage = new Map<string, { inputTokens: number; outputTokens: number; reasoningTokens: number }>();
  let evaluating = false;

  const settings = () => sponsorFromEnv(env);
  const read = (): Saved => {
    try { return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as Saved : { evaluations: [] }; } catch { return { evaluations: [] }; }
  };
  const currentEvaluations = (): SponsorEvaluation[] => {
    const config = settings();
    if (!config) return [];
    return read().evaluations.filter((item) => config.models.some((model) => model.model === item.model)
      && conformanceCurrent(item.record, item.model, RUNTIME_VERSION, now()));
  };
  const chosen = (): SponsorEvaluation | undefined => {
    const config = settings();
    return config ? chooseSponsorModel(config.models, currentEvaluations(), options.capabilities) : undefined;
  };
  const providerFor = (model: string): ProviderConfig => ({ id: SPONSOR_PROVIDER_ID, kind: "chat", label: "开发者提供的模型", baseUrl: settings()?.baseUrl ?? "",
    model, responseFormat: "json_object", keyLast4: null, updatedAt: "1970-01-01T00:00:00.000Z" });

  /** Yuan the account has spent on the sponsor's models this calendar month, and the cap. */
  const budget = (workspaceId: string): { spent: number; cap: number; resetsAt: Date } | undefined => {
    const config = settings();
    if (!config) return undefined;
    const month = sponsorMonth(now());
    const usage = options.store.summarizeModelUsage(workspaceId, month.start)
      .map((row) => ({ model: row.model, inputTokens: row.inputTokens, outputTokens: row.outputTokens, reasoningTokens: row.reasoningTokens }));
    return { spent: Math.round(sponsorSpend(usage, config.models) * 100) / 100, cap: config.capYuan, resetsAt: month.next };
  };

  /** Whether this account runs on the sponsor: it redeemed a code and the server has a key and a chosen model. */
  const active = (workspaceId: string): boolean => Boolean(settings() && sponsorshipOf(options.store, workspaceId));

  /** The account's quota while it runs on the sponsor: its share of the monthly cap, as one window that resets on the 1st. */
  const cost = (workspaceId: string): CostSignal | undefined => {
    if (!active(workspaceId)) return undefined;
    const spend = budget(workspaceId)!;
    const usedPercent = Math.min(100, Math.round((spend.spent / spend.cap) * 100));
    return { available: true, limitReached: spend.spent >= spend.cap, money: { spent: spend.spent, cap: spend.cap },
      long: { usedPercent, windowDurationMins: null, resetsAt: Math.floor(spend.resetsAt.getTime() / 1000) } };
  };

  /** What the gateway forwards to: the sponsor's base URL with the server key; the model is the one the thread names. */
  const upstream = (): GatewayUpstream | undefined => {
    const config = settings();
    return config ? { kind: "chat", baseUrl: config.baseUrl, responseFormat: "json_object", key: config.key } : undefined;
  };

  /** Models the key can use, or undefined when the list cannot be read (then every candidate is tried). */
  async function listed(): Promise<Set<string> | undefined> {
    const config = settings();
    if (!config) return undefined;
    try {
      const answer = await (options.fetch ?? fetch)(`${config.baseUrl}/models`, { headers: { authorization: `Bearer ${config.key}` }, signal: AbortSignal.timeout(20_000) });
      if (!answer.ok) return undefined;
      const body = await answer.json() as { data?: Array<{ id?: string }> };
      const ids = (body.data ?? []).map((item) => item.id ?? "").filter(Boolean);
      // Which comparable models the key can use, so a candidate named wrongly in the list can be corrected from the log.
      console.info(JSON.stringify({ type: "sponsor.catalog", models: ids.filter((id) => /deepseek|glm|qwen|kimi/i.test(id)).slice(0, 40) }));
      return new Set(ids);
    } catch { return undefined; }
  }

  /** Tests every candidate without a current record, one after another; the choice follows from the records. Safe to call often. */
  async function evaluate(): Promise<{ chosen?: string; tested: string[]; skipped: string[] }> {
    const config = settings();
    const client = options.client();
    if (!config || !client || evaluating) return { tested: [], skipped: [] };
    evaluating = true;
    const tested: string[] = [];
    const skipped: string[] = [];
    try {
      const available = await listed();
      const have = new Set(currentEvaluations().map((item) => item.model));
      const pending = config.models.filter((model) => {
        if (have.has(model.model)) return false;
        if (available && !available.has(model.model)) { skipped.push(model.model); return false; }
        return true;
      });
      // The candidates are tested side by side (each run takes minutes, one model's thirty-odd runs one after another take an hour or
      // two); each result is written as soon as it is in, so a restart keeps the models already measured.
      await Promise.all(pending.map(async (model) => {
        const evaluation = await evaluateOne(client, model);
        const saved = read().evaluations.filter((item) => item.model !== model.model);
        writeFileSync(file, JSON.stringify({ evaluations: [...saved, evaluation] } satisfies Saved, null, 2), "utf8");
        tested.push(model.model);
        console.info(JSON.stringify({ type: "sponsor.evaluated", model: model.model, passRate: evaluation.record.passRate,
          repairRate: evaluation.record.repairRate, p95Ms: evaluation.record.p95Ms, yuanPerRun: evaluation.yuanPerRun,
          admitted: admittedSkills(evaluation.record, options.capabilities).length, failures: evaluation.record.failures.slice(0, 6) }));
      }));
    } finally { evaluating = false; }
    const pick = chosen();
    console.info(JSON.stringify({ type: "sponsor.chosen", model: pick?.model ?? null, skipped }));
    return { ...(pick ? { chosen: pick.model } : {}), tested, skipped };
  }

  async function evaluateOne(client: CodexRpcBoundary, model: SponsorModel): Promise<SponsorEvaluation> {
    const provider = providerFor(model.model);
    const thread = threadProvider({ provider, gatewayUrl: options.gateway.urlFor(`${SPONSOR_EVAL_PREFIX}${model.model}`, SPONSOR_PROVIDER_ID) }, model.model);
    const runs: ConformanceRun[] = [];
    const key = `${SPONSOR_EVAL_PREFIX}${model.model}`;
    evalUsage.set(key, { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 });
    for (const item of conformanceCases()) for (let attempt = 0; attempt < item.runs; attempt += 1) {
      const started = Date.now();
      const input = { version: "crossline.conformance.v1", caseId: item.id, prompt: item.prompt };
      const result = await withUsageWorkspace(key, () => runCodexSkill<unknown>(client, input, { skillName: CONFORMANCE_SKILL, cwd: options.cwd, provider: thread,
        developerInstructions: "Answer the conformance case as the Skill describes. Return raw JSON only.", outputSchema: item.schema,
        prepareInput: () => input, onAudit: () => {}, timeoutMs: 20 * 60_000,
        validateOutput: (output) => {
          const problems = jsonSchemaProblems(output, item.schema);
          if (problems.length) throw Object.assign(new Error("CONFORMANCE_SCHEMA_VIOLATED"), { detail: problems.slice(0, 6).join("; ") });
          return output;
        } })).catch((error: unknown) => ({ ok: false as const, blocker: { code: error instanceof Error ? error.message : "SKILL_RUNTIME_FAILED", message: "" }, audit: {} as { repairs?: number } }));
      runs.push({ caseId: item.id, ok: result.ok, repairs: result.audit.repairs ?? 0, ms: Date.now() - started, ...(result.ok ? {} : { code: result.blocker.code }) });
    }
    const record: ConformanceRecord = summarizeConformance({ providerId: SPONSOR_PROVIDER_ID, model: model.model, runtimeVersion: RUNTIME_VERSION, ranAt: now().toISOString() }, runs);
    const tokens = evalUsage.get(key)!;
    evalUsage.delete(key);
    const yuan = (tokens.inputTokens * model.priceIn + (tokens.outputTokens + tokens.reasoningTokens) * model.priceOut) / 1_000_000;
    return { model: model.model, record, yuanPerRun: runs.length ? Math.round((yuan / runs.length) * 10_000) / 10_000 : 0 };
  }

  /** The usage sink's share: evaluation runs are counted here, never written to a workspace's ledger. */
  function noteEvalUsage(usage: SkillUsage): boolean {
    if (!usage.workspaceId?.startsWith(SPONSOR_EVAL_PREFIX)) return false;
    const tally = evalUsage.get(usage.workspaceId);
    if (tally) {
      tally.inputTokens += usage.inputTokens;
      tally.outputTokens += usage.outputTokens;
      tally.reasoningTokens += usage.reasoningOutputTokens;
    }
    return true;
  }

  /** What 设置 and the interview read: the chosen model and its record, and the account's month. */
  function view(workspaceId: string) {
    const pick = chosen();
    return { configured: Boolean(settings()), active: active(workspaceId), model: pick?.model ?? null, evaluating,
      budget: active(workspaceId) ? budget(workspaceId) : undefined, admitted: pick ? admittedSkills(pick.record, options.capabilities) : [] };
  }

  return { settings, chosen, providerFor, budget, active, cost, upstream, evaluate, noteEvalUsage, view, isEvaluating: () => evaluating };
}
export type SponsorService = ReturnType<typeof createSponsorService>;
