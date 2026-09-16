import type { CostSignal, CostWindow } from "@crossline/core";
import type { CodexRpcBoundary } from "./index";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const window = (value: unknown): CostWindow | undefined => {
  const raw = record(value);
  if (!raw || typeof raw.usedPercent !== "number" || !Number.isFinite(raw.usedPercent)) return undefined;
  return {
    usedPercent: raw.usedPercent,
    windowDurationMins: typeof raw.windowDurationMins === "number" ? raw.windowDurationMins : null,
    resetsAt: typeof raw.resetsAt === "number" ? raw.resetsAt : null
  };
};

/**
 * The one place that knows this runtime reports quota rather than money. Everything downstream sees a
 * `CostSignal`. A malformed or missing reading becomes `available: false` with a reason, never a
 * zero-usage reading — a fabricated "0% used" would read as permission to spend.
 */
export async function readCostSignal(client: CodexRpcBoundary, limitId = "codex"): Promise<CostSignal> {
  let raw: unknown;
  try {
    raw = await client.request("account/rateLimits/read", {});
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message.slice(0, 120) : "rate limit read failed" };
  }
  const byId = record(record(raw)?.rateLimitsByLimitId);
  const snapshot = record(byId?.[limitId]);
  if (!snapshot) return { available: false, reason: `runtime reported no limit bucket for ${limitId}` };
  const short = window(snapshot.primary);
  const long = window(snapshot.secondary);
  if (!short && !long) return { available: false, reason: "runtime reported no usable window" };
  return {
    available: true,
    ...(short ? { short } : {}),
    ...(long ? { long } : {}),
    limitReached: typeof snapshot.rateLimitReachedType === "string"
  };
}
