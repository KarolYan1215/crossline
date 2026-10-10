import "server-only";
import type { AccessContext, CostSignal } from "@crossline/core";
import { requestCodexSupervisor } from "./codex-runtime";

/**
 * The account's own quota as the worker reads it (`/v1/codex/cost`): how much of each window is gone and when it resets. Settings
 * showed only the app's token counts, so the person could not see how close background work was to pausing. Bounded, because a
 * settings page must not wait on a worker that is down; any failure reads as unavailable with its reason, never as "0% used".
 */
export async function readQuota(ctx: AccessContext): Promise<CostSignal> {
  try {
    return await requestCodexSupervisor<CostSignal>(ctx, "/v1/codex/cost", { signal: AbortSignal.timeout(2_500) });
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message.slice(0, 120) : "worker unreachable" };
  }
}
