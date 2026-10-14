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
  const status: RuntimeStatus | null = account === "timeout" || !account.ok
    ? { code: "worker_down", title: "后台服务没有运行",
      message: "自动分析、倒推、材料准备、验收与提醒都已停止；已收集的内容不受影响。在本机重新启动 Crossline 后恢复。" }
    : !account.value.account
      ? { code: "signed_out", title: "模型服务未登录", message: "自动分析、倒推、材料准备与验收已暂停；在「设置 · 日历与连接」的模型连接里登录后恢复。" }
      : null;
  cached = { workspaceId: ctx.workspaceId, at: now, status };
  return status;
}
