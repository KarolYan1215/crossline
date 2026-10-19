import { caseTools } from "./conformance-tools";
import {
  admittedSkills, conformanceCases, conformanceCurrent, conformanceProblems, SKILL_NEEDS, summarizeConformance, unavailableOnThirdParty,
  capabilityGap, THIRD_PARTY_CAPABILITIES, type ConformanceCase, type ConformanceRecord, type ConformanceRun, type CostSignal
} from "@crossline/core";
import {
  CODEX_FORK_BINARY_SHA256, isLocalProvider, MODEL_PROVIDER_SETTING, providerConfigProblem, runCodexSkill, threadProvider,
  type CodexRpcBoundary, type GatewayUpstream, type ModelGateway, type ProviderConfig, type ProviderRouting
} from "@crossline/codex";
import { imageBackendFromEnv, webSearchFromEnv, type ImageBackend, type SecretStore, type WebSearchBackend } from "@crossline/connectors";
import type { CrosslineStore } from "@crossline/db";
import { ownerOf } from "./owner";
import type { SponsorService } from "./sponsor";
import { createWebTools } from "./web-tools";

/**
 * A workspace's own model provider, as the worker keeps it (R7, decided 2026-10-13): the `model.provider` setting (no key), the key
 * in a DPAPI file, the gateway route Codex is pointed at, and the conformance runs that decide which Skills it may serve.
 */
export const CONFORMANCE_EVENT = "model.provider.conformance";
export const PROVIDER_CHANGED_EVENT = "model.provider.changed";
const SECRET_NAME = "provider-key";
/** The runtime that conformance was measured on: the pinned binary, named by its hash, so a runtime upgrade asks for a new test. */
export const RUNTIME_VERSION = CODEX_FORK_BINARY_SHA256.slice(0, 12);
const CONFORMANCE_SKILL = "crossline:crossline-conformance";

/** Starting points for the form; the person can change any field. */
export const PROVIDER_PRESETS: Array<{ id: string; label: string; kind: ProviderConfig["kind"]; baseUrl: string; model: string; responseFormat?: "json_object" }> = [
  { id: "deepseek", label: "DeepSeek", kind: "chat", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", responseFormat: "json_object" },
  { id: "kimi", label: "Kimi", kind: "chat", baseUrl: "https://api.moonshot.cn/v1", model: "kimi-k2-turbo-preview", responseFormat: "json_object" },
  { id: "qwen", label: "通义千问", kind: "chat", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", responseFormat: "json_object" },
  { id: "glm", label: "智谱 GLM", kind: "chat", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.6", responseFormat: "json_object" },
  { id: "claude", label: "Claude", kind: "chat", baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-5-5", responseFormat: "json_object" },
  { id: "gemini", label: "Gemini", kind: "chat", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-flash" },
  { id: "openai", label: "OpenAI API", kind: "responses", baseUrl: "https://api.openai.com/v1", model: "gpt-5.6-terra" },
  { id: "openrouter", label: "OpenRouter", kind: "responses", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-5.6-terra" },
  { id: "ollama", label: "本机 Ollama", kind: "responses", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen3:8b" }
];

type Progress = { done: number; total: number; startedAt: string };

export function createModelProviderService(options: {
  store: CrosslineStore;
  secrets: SecretStore;
  gateway: ModelGateway;
  /** The workspace's own Codex sign-in (never the machine owner's for a guest). */
  signedIn: (workspaceId: string) => boolean;
  /** The workspace's runtime, started if needed — what conformance runs on. */
  client: (workspaceId: string) => Promise<CodexRpcBoundary | undefined>;
  cwd: string;
  now?: () => Date;
  /** What Crossline adds on top of a provider (docs/beta-launch.md §10.4); from the environment unless given. Null turns one off. */
  search?: WebSearchBackend | null;
  image?: ImageBackend | null;
  /** The server runs the shell assistant inside Codex's Linux sandbox (sandbox-probe.ts): another model may then drive it too. */
  sandboxShell?: boolean;
  /** A conformance run just finished: what was decided while the provider was not admitted is decided again (W-11). */
  onConformance?: (workspaceId: string) => void;
  /** The developer's model for accounts that redeemed an invite code (`sponsor.ts`); a workspace's own provider comes first. */
  sponsor?: () => SponsorService | undefined;
}) {
  const now = options.now ?? (() => new Date());
  const search = options.search === undefined ? webSearchFromEnv() : options.search ?? undefined;
  const image = options.image === undefined ? imageBackendFromEnv() : options.image ?? undefined;
  // The shell assistant on another model only inside Codex's Linux sandbox, where the server allows it (sandbox-probe.ts).
  const capabilities = { ...THIRD_PARTY_CAPABILITIES, webSearch: Boolean(search), image: Boolean(image), shell: Boolean(options.sandboxShell) };
  const keys = new Map<string, string | null>();
  const testing = new Map<string, Progress>();

  const config = (workspaceId: string): ProviderConfig | undefined => {
    const raw = options.store.getSetting(workspaceId, MODEL_PROVIDER_SETTING);
    if (!raw) return undefined;
    try { return JSON.parse(raw) as ProviderConfig; } catch { return undefined; }
  };
  const latest = (workspaceId: string, provider: ProviderConfig): ConformanceRecord | undefined => {
    const events = options.store.listEvents(workspaceId, { type: CONFORMANCE_EVENT, entityId: provider.id });
    return events.at(-1)?.payload as ConformanceRecord | undefined;
  };
  /** The record that counts: same model and runtime, under thirty days old, and run after the configuration was last saved. */
  const current = (workspaceId: string, provider: ProviderConfig) => {
    const record = latest(workspaceId, provider);
    return conformanceCurrent(record, provider.model, RUNTIME_VERSION, now()) && record.ranAt >= provider.updatedAt ? record : undefined;
  };
  const key = async (workspaceId: string): Promise<string | undefined> => {
    if (!keys.has(workspaceId)) keys.set(workspaceId, (await options.secrets.read(workspaceId, SECRET_NAME).catch(() => undefined)) ?? null);
    return keys.get(workspaceId) ?? undefined;
  };

  /** The developer's model, for an account that redeemed a code and has no provider of its own. */
  const sponsorRouting = (workspaceId: string): ProviderRouting | undefined => {
    const sponsor = options.sponsor?.();
    if (!sponsor?.active(workspaceId)) return undefined;
    const pick = sponsor.chosen();
    const budget = sponsor.budget(workspaceId);
    const base = { gatewayUrl: options.gateway.urlFor(workspaceId, "sponsor"), codexSignedIn: options.signedIn(workspaceId), capabilities,
      ...(search ? { webTools: createWebTools(search) } : {}) };
    if (!pick) return { ...base, provider: sponsor.providerFor(""), admitted: new Set(),
      blocked: { code: "MODEL_SPONSOR_PENDING", message: "开发者提供的模型还在检验，通常一小时内可用；也可以先连接自己的 ChatGPT。" } };
    if (budget && budget.spent >= budget.cap) return { ...base, provider: sponsor.providerFor(pick.model), admitted: new Set(),
      blocked: { code: "MODEL_SPONSOR_BUDGET", message: `本月邀请额度（¥${budget.cap}）已用完，下月 1 日恢复；也可以在 设置 → 模型连接 连接自己的 ChatGPT 或 API。` } };
    return { ...base, provider: sponsor.providerFor(pick.model), admitted: new Set(admittedSkills(pick.record, capabilities)) };
  };

  const routing = (workspaceId: string | undefined): ProviderRouting | undefined => {
    if (!workspaceId) return undefined;
    const provider = config(workspaceId);
    if (!provider) return sponsorRouting(workspaceId);
    const record = current(workspaceId, provider);
    return { provider, gatewayUrl: options.gateway.urlFor(workspaceId, provider.id),
      admitted: new Set(record ? admittedSkills(record, capabilities) : []), codexSignedIn: options.signedIn(workspaceId),
      capabilities, ...(search ? { webTools: createWebTools(search) } : {}) };
  };

  /** What the gateway forwards to for a route; a Sign in with ChatGPT plan is OpenAI's own Responses endpoint. */
  const upstream = async (workspaceId: string, providerId: string): Promise<GatewayUpstream | undefined> => {
    if (providerId === "sponsor") {
      const sponsor = options.sponsor?.();
      return sponsor && (workspaceId.startsWith("sponsor-eval:") || (!config(workspaceId) && sponsor.active(workspaceId))) ? sponsor.upstream() : undefined;
    }
    const provider = config(workspaceId);
    if (!provider || provider.id !== providerId) return undefined;
    const secret = await key(workspaceId);
    return { kind: provider.kind === "chat" ? "chat" : "responses", baseUrl: provider.baseUrl,
      ...(provider.responseFormat ? { responseFormat: provider.responseFormat } : {}), ...(secret ? { key: secret } : {}) };
  };

  /**
   * The quota reading while a provider serves this workspace. A local model costs nothing. A paid one has no windows and no price the
   * app knows, so background work stays paused there (the person's own actions still run) rather than spending without a ceiling.
   */
  const cost = (workspaceId: string): CostSignal | undefined => {
    const provider = config(workspaceId);
    if (!provider) return options.sponsor?.()?.cost(workspaceId);
    if (options.signedIn(workspaceId)) return undefined;
    return isLocalProvider(provider.baseUrl) ? { available: true, limitReached: false }
      : { available: false, reason: "PROVIDER_BUDGET_UNKNOWN" };
  };

  async function runConformance(workspaceId: string, cases: ConformanceCase[] = conformanceCases()): Promise<ConformanceRecord | { blocked: string }> {
    const provider = config(workspaceId);
    if (!provider) return { blocked: "PROVIDER_NOT_CONFIGURED" };
    if (testing.has(workspaceId)) return { blocked: "CONFORMANCE_RUNNING" };
    const client = await options.client(workspaceId);
    if (!client) return { blocked: "RUNTIME_UNAVAILABLE" };
    const total = cases.reduce((sum, item) => sum + item.runs, 0);
    const progress: Progress = { done: 0, total, startedAt: now().toISOString() };
    testing.set(workspaceId, progress);
    const thread = threadProvider({ provider, gatewayUrl: options.gateway.urlFor(workspaceId, provider.id) }, provider.model);
    const runs: ConformanceRun[] = [];
    try {
      for (const item of cases) for (let attempt = 0; attempt < item.runs; attempt += 1) {
        const started = Date.now();
        const input = { version: "crossline.conformance.v1", caseId: item.id, prompt: item.prompt };
        const offered = caseTools(item);
        const result = await runCodexSkill<unknown>(client, input, { skillName: CONFORMANCE_SKILL, cwd: options.cwd, provider: thread,
          ...(offered.tools ? { tools: offered.tools } : {}),
          developerInstructions: "Answer the conformance case as the Skill describes. Return raw JSON only.", outputSchema: item.schema,
          prepareInput: () => input, onAudit: () => {}, timeoutMs: 20 * 60_000,
          validateOutput: (output) => {
            const problems = conformanceProblems(item.id, output, item.schema);
            if (problems.length) throw Object.assign(new Error("CONFORMANCE_SCHEMA_VIOLATED"), { detail: problems.slice(0, 6).join("; ") });
            offered.check(output);
            return output;
          } });
        runs.push({ caseId: item.id, ok: result.ok, repairs: result.audit.repairs ?? 0, ms: Date.now() - started, ...(result.ok ? {} : { code: result.blocker.code }) });
        progress.done += 1;
      }
    } finally { testing.delete(workspaceId); }
    const record = summarizeConformance({ providerId: provider.id, model: provider.model, runtimeVersion: RUNTIME_VERSION, ranAt: now().toISOString() }, runs);
    options.store.appendEvent({ ownerId: ownerOf(options.store, workspaceId), workspaceId, idempotencyKey: `${CONFORMANCE_EVENT}:${provider.id}:${record.ranAt}`,
      type: CONFORMANCE_EVENT, entityId: provider.id, payload: record });
    try { options.onConformance?.(workspaceId); } catch { /* the listener's own concern */ }
    return record;
  }

  /** What the settings card shows: the configuration (no key), and per function whether this provider serves it, and why not. */
  const view = (workspaceId: string) => {
    const provider = config(workspaceId);
    const record = provider ? latest(workspaceId, provider) : undefined;
    const valid = provider ? current(workspaceId, provider) : undefined;
    // An invited account with no provider of its own is served by the developer's model: its admitted Skills count as served.
    const sponsored = provider ? undefined : sponsorRouting(workspaceId);
    const admitted = new Set(valid ? admittedSkills(valid, capabilities) : sponsored && !sponsored.blocked ? sponsored.admitted : []);
    const features = Object.entries(SKILL_NEEDS).filter(([, needs]) => !needs.testOnly).map(([skill, needs]) => {
      const gap = capabilityGap(skill, capabilities);
      const failed = record?.runs.filter((run) => needs.schemas.includes(run.caseId) && !run.ok).length ?? 0;
      return { skill, label: needs.label, critical: Boolean(needs.critical), served: admitted.has(skill),
        reason: admitted.has(skill) ? "" : gap ?? (sponsored ? sponsored.blocked?.message ?? "开发者提供的模型没有通过这项功能的检验" : !valid ? "还没有检验，或检验已过期" : failed ? `检验中 ${failed} 次没有按格式回答` : needs.critical ? "要求每次都一次答对" : "整体通过率不到 90%") };
    });
    return { provider: provider ?? null, presets: PROVIDER_PRESETS, unavailable: unavailableOnThirdParty(capabilities), signedIn: options.signedIn(workspaceId),
      conformance: record ? { ranAt: record.ranAt, model: record.model, passRate: record.passRate, repairRate: record.repairRate, p95Ms: record.p95Ms,
        runs: record.runs.length, failures: record.failures, current: Boolean(valid) } : null,
      features, testing: testing.get(workspaceId) ?? null, sponsor: options.sponsor?.()?.view(workspaceId) ?? null,
      sponsorBlocked: sponsored?.blocked ?? null };
  };

  async function save(workspaceId: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
    const previous = config(workspaceId);
    const kind: ProviderConfig["kind"] | undefined = body.kind === "chat" || body.kind === "responses" ? body.kind : undefined;
    const next = { id: text(body.id), kind: kind ?? "responses" as const, label: text(body.label), baseUrl: text(body.baseUrl).replace(/\/+$/, ""), model: text(body.model) };
    const problem = !kind ? "接口类型不认识。" : providerConfigProblem(next);
    if (problem) return { status: 400, body: { blocker: { code: "PROVIDER_CONFIG_INVALID", message: problem } } };
    const apiKey = text(body.apiKey);
    if (apiKey.length > 400) return { status: 400, body: { blocker: { code: "PROVIDER_CONFIG_INVALID", message: "API key 太长。" } } };
    // A key is kept only for the same provider and address it was given for; changing either asks for it again.
    const sameTarget = previous && previous.id === next.id && previous.baseUrl === next.baseUrl;
    let keyLast4 = sameTarget ? previous.keyLast4 : null;
    if (apiKey) {
      try { await options.secrets.write(workspaceId, SECRET_NAME, apiKey); }
      catch { return { status: 503, body: { blocker: { code: "SECRET_STORE_UNAVAILABLE", message: "这台电脑上没有可用的加密存储，密钥没有保存。" } } }; }
      keys.set(workspaceId, apiKey);
      keyLast4 = apiKey.slice(-4);
    } else if (!sameTarget) { options.secrets.remove(workspaceId, SECRET_NAME); keys.delete(workspaceId); }
    const saved: ProviderConfig = { ...next, keyLast4, updatedAt: now().toISOString(),
      ...(body.responseFormat === "json_object" && kind === "chat" ? { responseFormat: "json_object" as const } : {}) };
    if (!saved.keyLast4 && !isLocalProvider(saved.baseUrl)) return { status: 400, body: { blocker: { code: "PROVIDER_KEY_MISSING", message: "这个接口需要 API key。" } } };
    options.store.setSetting(workspaceId, MODEL_PROVIDER_SETTING, JSON.stringify(saved));
    options.store.appendEvent({ ownerId: ownerOf(options.store, workspaceId), workspaceId, idempotencyKey: `${PROVIDER_CHANGED_EVENT}:${saved.updatedAt}`,
      type: PROVIDER_CHANGED_EVENT, entityId: saved.id, payload: { id: saved.id, kind: saved.kind, label: saved.label, baseUrl: saved.baseUrl, model: saved.model } });
    return { status: 200, body: view(workspaceId) };
  }

  async function handle(method: string, pathname: string, workspaceId: string, body: Record<string, unknown> | undefined): Promise<{ status: number; body: unknown } | undefined> {
    if (pathname === "/v1/model/provider" && method === "GET") return { status: 200, body: view(workspaceId) };
    if (pathname === "/v1/model/provider" && method === "POST") return save(workspaceId, body ?? {});
    if (pathname === "/v1/model/provider" && method === "DELETE") {
      const provider = config(workspaceId);
      options.store.deleteSetting(workspaceId, MODEL_PROVIDER_SETTING);
      options.secrets.remove(workspaceId, SECRET_NAME);
      keys.delete(workspaceId);
      if (provider) options.store.appendEvent({ ownerId: ownerOf(options.store, workspaceId), workspaceId, idempotencyKey: `${PROVIDER_CHANGED_EVENT}:${now().toISOString()}:removed`,
        type: PROVIDER_CHANGED_EVENT, entityId: provider.id, payload: { id: provider.id, removed: true } });
      return { status: 200, body: view(workspaceId) };
    }
    if (pathname === "/v1/model/provider/test" && method === "POST") {
      if (!config(workspaceId)) return { status: 409, body: { blocker: { code: "PROVIDER_NOT_CONFIGURED", message: "还没有添加模型连接。" } } };
      if (testing.has(workspaceId)) return { status: 202, body: view(workspaceId) };
      // Answered at once; the run takes minutes per case and writes its record to the ledger, which the card polls.
      void runConformance(workspaceId).catch((error: unknown) => console.warn(JSON.stringify({ type: "model.provider.conformance_failed",
        message: error instanceof Error ? error.message : "" })));
      return { status: 202, body: view(workspaceId) };
    }
    return undefined;
  }

  return { routing, upstream, cost, runConformance, view, handle, capabilities,
    hasProvider: (workspaceId: string) => Boolean(config(workspaceId)) || Boolean(options.sponsor?.()?.active(workspaceId)) };
}
export type ModelProviderService = ReturnType<typeof createModelProviderService>;
