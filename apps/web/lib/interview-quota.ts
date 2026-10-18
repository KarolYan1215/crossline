import "server-only";
import { addQuotaReading, interviewQuotaOutlook, ONBOARDING_QUOTA_TRACE, quotaReading, type AccessContext, type InterviewQuotaOutlook, type QuotaReading } from "@crossline/core";
import { sponsorshipOf } from "@crossline/db";
import { requestCodexSupervisor } from "./codex-runtime";
import { getStore } from "./crossline";
import { interviewStatus } from "./interview-status";
import { inviteState, type InviteState } from "./invites";
import { readQuota } from "./quota";

/**
 * Whether the account's ChatGPT quota carries the interview (packages/core/src/interview-quota.ts), with what to do when it does not:
 * Plus, or an invite code. An account on its own provider or on the developer's model is not asked about ChatGPT at all.
 */
export type InterviewQuota = InterviewQuotaOutlook & { plan?: string; invite: InviteState };

const readTrace = (ctx: AccessContext): QuotaReading[] => {
  try { return JSON.parse(getStore().getSetting(ctx.workspaceId, ONBOARDING_QUOTA_TRACE) || "[]") as QuotaReading[]; } catch { return []; }
};
const roundsOf = (ctx: AccessContext, sessionId: string | undefined) =>
  sessionId ? getStore().listOnboardingMessages(ctx.workspaceId, sessionId).filter((message) => message.role === "assistant").length : 0;

async function chatgptPlan(ctx: AccessContext): Promise<{ type?: string; plan?: string }> {
  try {
    const body = await requestCodexSupervisor<{ account?: { type?: string; planType?: string } | null }>(ctx, "/v1/codex/account", { signal: AbortSignal.timeout(2_500) });
    return { ...(body.account?.type ? { type: body.account.type } : {}), ...(body.account?.planType ? { plan: body.account.planType } : {}) };
  } catch { return {}; }
}

/** Notes the account's usage once per round, from the interview page's attention beat; skipped where ChatGPT does not serve the interview. */
export async function noteRoundQuota(ctx: AccessContext, rounds: number): Promise<void> {
  if (rounds < 1 || sponsorshipOf(getStore(), ctx.workspaceId)) return;
  const trace = readTrace(ctx);
  if (trace.some((item) => item.round === rounds)) return;
  const reading = quotaReading(await readQuota(ctx), rounds, new Date().toISOString());
  if (reading) getStore().setSetting(ctx.workspaceId, ONBOARDING_QUOTA_TRACE, JSON.stringify(addQuotaReading(trace, reading)));
}

export async function interviewQuota(ctx: AccessContext, options: { usageLimitHit?: boolean } = {}): Promise<InterviewQuota> {
  const invite = inviteState(ctx);
  const status = interviewStatus(ctx);
  const rounds = roundsOf(ctx, status.sessionId);
  if (invite.sponsored) return { verdict: "ok", message: "", remainingRounds: 0, invite };
  const account = await chatgptPlan(ctx);
  // Another model's API, or no ChatGPT account at all: nothing to say about a ChatGPT quota.
  if (account.type !== "chatgpt") return { verdict: "ok", message: "", remainingRounds: 0, invite };
  const outlook = interviewQuotaOutlook({ plan: account.plan, signal: await readQuota(ctx), trace: readTrace(ctx), roundsDone: rounds,
    complete: status.complete, ...(options.usageLimitHit ? { usageLimitHit: true } : {}) });
  return { ...outlook, ...(account.plan ? { plan: account.plan } : {}), invite };
}
