import { localStamp, type AccessContext } from "@crossline/core";
import { quotaFallbackOf } from "./background";
import { requestCodexSupervisor } from "./codex-runtime";
import { getStore, readSchedulePreferences } from "./crossline";

/**
 * Why the AI cannot work at all right now, or null when it can. An error to show, not a decision: it is never one of the asks.
 * `sponsor_standin` is the one notice that is not an error: ChatGPT's quota is spent and the developer's model carries on.
 */
export type RuntimeStatus = { code: "worker_down" | "signed_out" | "sponsor_waiting" | "sponsor_standin"; title: string; message: string };

let cached: { workspaceId: string; at: number; status: RuntimeStatus | null } | undefined;

/**
 * Whether the worker answers and its model runtime is signed in. Asked over the network (cached a minute, given two and a half
 * seconds). Under e2e and vitest nothing listens on the supervisor port on purpose, so it reports nothing there.
 */
export async function runtimeStatus(ctx: AccessContext, now = Date.now()): Promise<RuntimeStatus | null> {
  if (process.env.CROSSLINE_E2E_DATA_DIR || process.env.VITEST) return null;
  if (cached && cached.workspaceId === ctx.workspaceId && now - cached.at < 60_000) return cached.status;
  const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 2_500));
  const account = await Promise.race([requestCodexSupervisor<{ account?: unknown }>(ctx, "/v1/codex/account")
    .then((value) => ({ ok: true as const, value })).catch(() => ({ ok: false as const })), timeout]);
  // With no ChatGPT sign-in, another model's API that serves anything is a connection too (decided 2026-10-17): what it does not serve
  // is said on its own card, not as a red bar on every page.
  type ProviderView = { features?: Array<{ served: boolean }>; sponsorBlocked?: { code: string; message: string } | null };
  const view = account !== "timeout" && account.ok && !account.value.account
    ? await requestCodexSupervisor<ProviderView>(ctx, "/v1/model/provider").catch(() => undefined)
    : undefined;
  const viaApi = Boolean(view?.features?.some((feature) => feature.served));
  // An invited account is connected to the developer's model; while that model is still being checked, or its month is spent, the
  // bar says so in the sponsor's own words instead of sending the person to connect something (found on the live beta, 2026-10-19).
  const sponsorWait = viaApi ? undefined : view?.sponsorBlocked ?? undefined;
  const status: RuntimeStatus | null = account === "timeout" || !account.ok
    ? { code: "worker_down", title: "后台服务没有运行",
      message: "自动分析、倒推、材料准备、验收与提醒都已停止；已收集的内容不受影响。在运行 Crossline 的那台电脑上重新启动后恢复。" }
    : !account.value.account && sponsorWait
      ? { code: "sponsor_waiting", title: sponsorWait.code === "MODEL_SPONSOR_BUDGET" ? "本月邀请额度已用完" : "邀请码已生效，模型还在检验", message: sponsorWait.message }
      : !account.value.account && !viaApi
        ? { code: "signed_out", title: "还没有连接模型", message: "访谈、自动分析、倒推、材料准备与验收都要用它；用本人的 ChatGPT 账号或自己的模型 API 连接一次即可。" }
        : standIn(ctx, now);
  cached = { workspaceId: ctx.workspaceId, at: now, status };
  return status;
}

/** ChatGPT's quota spent and the developer's model standing in (the worker's mark), said with when ChatGPT comes back. */
function standIn(ctx: AccessContext, now: number): RuntimeStatus | null {
  const { quotaFallback } = quotaFallbackOf(getStore(), ctx.workspaceId, new Date(now));
  if (!quotaFallback) return null;
  const zone = readSchedulePreferences(ctx)?.timeZone ?? process.env.CROSSLINE_TIME_ZONE ?? "America/Chicago";
  return { code: "sponsor_standin", title: "已改用开发者提供的模型",
    message: `ChatGPT 额度已用尽，后台工作改由开发者提供的模型继续${quotaFallback.resetsAt ? `，到 ${localStamp(quotaFallback.resetsAt, zone)} ChatGPT 额度恢复后切回` : "，ChatGPT 额度恢复后切回"}。` };
}
