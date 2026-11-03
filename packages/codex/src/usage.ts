import { AsyncLocalStorage } from "node:async_hooks";
import type { EffortPreference } from "@crossline/core";
import type { SpendMode } from "./model-policy";

/**
 * What a Skill run cost, and what the account's remaining quota allows.
 *
 * Both are process-wide hooks the worker installs once, so no runner has to be handed a store or a cost reader:
 * a run reports how many tokens it used to whoever is listening, and asks whoever is listening how tight the
 * budget is. With nobody listening a run behaves exactly as it did before either existed.
 */
export type TokenBreakdown = { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number; totalTokens: number };

export type SkillUsage = {
  /** The workspace the run was done for, when the caller said (see `enterUsageWorkspace`). */
  workspaceId?: string;
  skillName: string; tier?: string; model?: string; effort?: string; spendMode: SpendMode;
  threadId?: string; ok: boolean; errorCode?: string; repairs: number; turns: number; durationMs: number; at: string;
  /** Wall-clock seconds of each turn in order, so one stalled turn shows up as itself instead of inside a long total. */
  turnSeconds?: number[];
  /** What the run was for when the caller said (see `withUsagePurpose`). */
  purpose?: string;
} & TokenBreakdown;

export const emptyBreakdown = (): TokenBreakdown => ({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 });

/** Collects the usage notifications of one run: the latest reading per turn, summed when asked. */
export function createUsageCollector() {
  const perTurn = new Map<string, TokenBreakdown>();
  const seconds: number[] = [];
  return {
    noteTurnSeconds(value: number): void { seconds.push(Math.round(value)); },
    turnSeconds: () => [...seconds],
    /** `params` is a `thread/tokenUsage/updated` notification; its `last` is what that turn has used so far. */
    note(params: Record<string, unknown>): void {
      const turnId = typeof params.turnId === "string" ? params.turnId : "";
      const usage = params.tokenUsage as { last?: Record<string, unknown> } | undefined;
      const last = usage?.last;
      if (!turnId || !last) return;
      const n = (key: string) => typeof last[key] === "number" ? last[key] as number : 0;
      perTurn.set(turnId, { inputTokens: n("inputTokens"), cachedInputTokens: n("cachedInputTokens"), outputTokens: n("outputTokens"),
        reasoningOutputTokens: n("reasoningOutputTokens"), totalTokens: n("totalTokens") });
    },
    turns: () => perTurn.size,
    total(): TokenBreakdown {
      const sum = emptyBreakdown();
      for (const turn of perTurn.values()) for (const key of Object.keys(sum) as Array<keyof TokenBreakdown>) sum[key] += turn[key];
      return sum;
    }
  };
}
export type UsageCollector = ReturnType<typeof createUsageCollector>;

/**
 * Tokens this server's gateway counted for a thread run on someone's compute node (docs/compute-node.md, 方案 C): a node's own
 * `thread/tokenUsage/updated` is the person's computer speaking and may be wrong, so a provider run on a node is billed by what the
 * gateway saw it spend (keyed by the request's `prompt_cache_key`, which Codex sets to the thread id). Taken once by the run that ends.
 */
type Metered = { tokens: TokenBreakdown; workspaceId: string; skill?: string; model?: string; updatedAt: number };
const metered = new Map<string, Metered>();
const METERED_MAX = 2_000;
export function recordMeteredUsage(key: { threadId?: string; workspaceId: string; skill?: string; model?: string }, tokens: TokenBreakdown, now = Date.now()): void {
  // No thread named: kept under the account, so it is still billed (by `flushMeteredUsage`), only not beside a run.
  const id = key.threadId || `?${key.workspaceId}`;
  const entry = metered.get(id) ?? { tokens: emptyBreakdown(), workspaceId: key.workspaceId, updatedAt: now,
    ...(key.skill ? { skill: key.skill } : {}), ...(key.model ? { model: key.model } : {}) };
  for (const name of Object.keys(entry.tokens) as Array<keyof TokenBreakdown>) entry.tokens[name] += tokens[name];
  entry.updatedAt = now;
  metered.delete(id);
  metered.set(id, entry);
  if (metered.size > METERED_MAX) flushOne(metered.keys().next().value!, now);
}
export function takeMeteredUsage(threadId: string | undefined): TokenBreakdown {
  if (!threadId) return emptyBreakdown();
  const entry = metered.get(threadId);
  metered.delete(threadId);
  return entry?.tokens ?? emptyBreakdown();
}
function flushOne(id: string, now: number): void {
  const entry = metered.get(id);
  metered.delete(id);
  if (!entry) return;
  try {
    usageSink?.({ workspaceId: entry.workspaceId, skillName: entry.skill || "node-relay", ...(entry.model ? { model: entry.model } : {}), spendMode: "normal",
      ok: true, repairs: 0, turns: 0, durationMs: 0, at: new Date(now).toISOString(), purpose: "node_unclaimed", ...entry.tokens });
  } catch { /* accounting never fails the work */ }
}
/**
 * Metered tokens no run took (a thread quiet this long, or a request that named no thread or a made-up one) are billed as rows of their
 * own, so a node cannot spend unbilled by changing what its requests say. A long run's thread keeps being updated and is not touched.
 */
export function flushMeteredUsage(maxIdleMs: number, now = Date.now()): void {
  for (const [id, entry] of [...metered]) if (now - entry.updatedAt >= maxIdleMs) flushOne(id, now);
}
/** A Responses `usage` object (as `response.completed` carries it) as a breakdown. */
export function breakdownOfResponsesUsage(usage: unknown): TokenBreakdown | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const value = usage as Record<string, unknown>;
  const n = (raw: unknown) => typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : 0;
  const detail = (key: string, sub: string) => n((value[key] as Record<string, unknown> | undefined)?.[sub]);
  const inputTokens = n(value.input_tokens);
  const outputTokens = n(value.output_tokens);
  return { inputTokens, cachedInputTokens: detail("input_tokens_details", "cached_tokens"), outputTokens,
    reasoningOutputTokens: detail("output_tokens_details", "reasoning_tokens"), totalTokens: n(value.total_tokens) || inputTokens + outputTokens };
}

let usageSink: ((usage: SkillUsage) => void) | undefined;
/** Where finished runs are reported. A sink that throws never fails a run. */
export function setUsageSink(sink: ((usage: SkillUsage) => void) | undefined): void { usageSink = sink; }

const workspaceContext = new AsyncLocalStorage<{ workspaceId: string }>();
/**
 * Says which workspace the rest of this async chain is working for, so a run deep inside a runner can be
 * attributed without every runner passing a workspace id down to the Skill layer.
 */
export function enterUsageWorkspace(workspaceId: string): void { workspaceContext.enterWith({ workspaceId }); }
/** The same, for one call only: what concurrent callers use, since `enterWith` would leak into the caller's context. */
export function withUsageWorkspace<T>(workspaceId: string, run: () => Promise<T>): Promise<T> { return workspaceContext.run({ workspaceId }, run); }
/** The workspace this async chain is working for, if one was entered. */
export const currentUsageWorkspace = (): string | undefined => workspaceContext.getStore()?.workspaceId;

const purposeContext = new AsyncLocalStorage<string>();
/**
 * Says what the runs inside `run` are for, when the Skill's name does not (the quota saver's `non_core`: the reviewer judging public
 * skills is non-core, the same Skill judging a step plan is not). Scoped to the call, so concurrent passes never take each other's.
 */
export function withUsagePurpose<T>(purpose: string, run: () => Promise<T>): Promise<T> { return purposeContext.run(purpose, run); }

export function reportUsage(usage: Omit<SkillUsage, "workspaceId" | "purpose">): void {
  const workspaceId = workspaceContext.getStore()?.workspaceId;
  const purpose = purposeContext.getStore();
  try { usageSink?.({ ...usage, ...(workspaceId ? { workspaceId } : {}), ...(purpose ? { purpose } : {}) }); } catch { /* accounting must never fail the work it accounts for */ }
}

let spendProvider: ((workspaceId: string | undefined) => Promise<SpendMode>) | undefined;
const spendCache = new Map<string, { mode: SpendMode; at: number }>();
const SPEND_TTL_MS = 60_000;
/**
 * How tight the budget is, read through whatever knows (the worker reads the account's rate limits). Per workspace: each account
 * spends its own Codex, so one account's tight quota must not step another's runs down.
 */
export function setSpendModeProvider(provider: ((workspaceId: string | undefined) => Promise<SpendMode>) | undefined): void { spendProvider = provider; spendCache.clear(); }

/** Unknown is `normal`: a quota that cannot be read is not a reason to quietly run everything on a cheaper model. */
export async function currentSpendMode(now: number = Date.now()): Promise<SpendMode> {
  if (!spendProvider) return "normal";
  const workspaceId = workspaceContext.getStore()?.workspaceId;
  const cached = spendCache.get(workspaceId ?? "");
  if (cached && now - cached.at < SPEND_TTL_MS) return cached.mode;
  let mode: SpendMode = "normal";
  try { mode = await spendProvider(workspaceId); } catch { /* unreadable: stay normal */ }
  spendCache.set(workspaceId ?? "", { mode, at: now });
  return mode;
}

let effortProvider: ((workspaceId: string | undefined) => EffortPreference) | undefined;
/** Where a run reads the person's 模型强度 (the worker reads the ledger's `model.effort`). Read per run, so a change applies to the next. */
export function setEffortPreferenceProvider(provider: ((workspaceId: string | undefined) => EffortPreference) | undefined): void { effortProvider = provider; }
/** Unreadable is `default`. */
export function currentEffortPreference(): EffortPreference {
  try { return effortProvider?.(workspaceContext.getStore()?.workspaceId) ?? "default"; } catch { return "default"; }
}
