import type { AccessContext } from "@crossline/core";
import { requestCodexSupervisor } from "./codex-runtime";

/** Why the AI cannot work at all right now, or null when it can. An error to show, not a decision: it is never one of the asks. */
export type RuntimeStatus = { code: "worker_down" | "signed_out"; title: string; message: string };

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
  const viaApi = account !== "timeout" && account.ok && !account.value.account
    ? await requestCodexSupervisor<{ features?: Array<{ served: boolean }> }>(ctx, "/v1/model/provider")
      .then((view) => Boolean(view.features?.some((feature) => feature.served))).catch(() => false)
    : false;
  const status: RuntimeStatus | null = account === "timeout" || !account.ok
    ? { code: "worker_down", title: "后台服务没有运行",
      message: "自动分析、倒推、材料准备、验收与提醒都已停止；已收集的内容不受影响。在运行 Crossline 的那台电脑上重新启动后恢复。" }
    : !account.value.account && !viaApi
      ? { code: "signed_out", title: "还没有连接模型", message: "访谈、自动分析、倒推、材料准备与验收都要用它；用本人的 ChatGPT 账号或自己的模型 API 连接一次即可。" }
      : null;
  cached = { workspaceId: ctx.workspaceId, at: now, status };
  return status;
}
