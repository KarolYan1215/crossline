import { AsyncLocalStorage } from "node:async_hooks";
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

let usageSink: ((usage: SkillUsage) => void) | undefined;
/** Where finished runs are reported. A sink that throws never fails a run. */
export function setUsageSink(sink: ((usage: SkillUsage) => void) | undefined): void { usageSink = sink; }

const workspaceContext = new AsyncLocalStorage<{ workspaceId: string }>();
/**
 * Says which workspace the rest of this async chain is working for, so a run deep inside a runner can be
 * attributed without every runner passing a workspace id down to the Skill layer.
 */
export function enterUsageWorkspace(workspaceId: string): void { workspaceContext.enterWith({ workspaceId }); }
/** The workspace this async chain is working for, if one was entered. */
export const currentUsageWorkspace = (): string | undefined => workspaceContext.getStore()?.workspaceId;

export function reportUsage(usage: Omit<SkillUsage, "workspaceId">): void {
  const workspaceId = workspaceContext.getStore()?.workspaceId;
  try { usageSink?.({ ...usage, ...(workspaceId ? { workspaceId } : {}) }); } catch { /* accounting must never fail the work it accounts for */ }
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
