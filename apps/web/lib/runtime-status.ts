import type { AccessContext } from "@crossline/core";
import { requestCodexSupervisor } from "./codex-runtime";
import { tOf } from "./locale";

/** Why the AI cannot work at all right now, or null when it can. An error to show, not a decision: it is never one of the asks. */
export type RuntimeStatus = { code: "worker_down" | "signed_out"; title: string; message: string };

let cached: { workspaceId: string; at: number; status: RuntimeStatus | null } | undefined;

/**
 * Whether the worker answers and its model runtime is signed in. Asked over the network (cached a minute, given two and a half
 * seconds). Under e2e and vitest nothing listens on the supervisor port on purpose, so it reports nothing there.
 */
export async function runtimeStatus(ctx: AccessContext, now = Date.now()): Promise<RuntimeStatus | null> {
  if (process.env.CROSSLINE_E2E_DATA_DIR || process.env.VITEST) return null;
  // The cache keeps the finding; its words are written in the language of each request.
  if (cached && cached.workspaceId === ctx.workspaceId && now - cached.at < 60_000) return worded(ctx, cached.status);
  const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 2_500));
  const account = await Promise.race([requestCodexSupervisor<{ account?: unknown }>(ctx, "/v1/codex/account")
    .then((value) => ({ ok: true as const, value })).catch(() => ({ ok: false as const })), timeout]);
  const status: RuntimeStatus | null = account === "timeout" || !account.ok
    ? { code: "worker_down", title: "后台服务没有运行",
      message: "自动分析、倒推、材料准备、验收与提醒都已停止；已收集的内容不受影响。在运行 Crossline 的那台电脑上重新启动后恢复。" }
    : !account.value.account
      ? { code: "signed_out", title: "还没有连接 ChatGPT", message: "访谈、自动分析、倒推、材料准备与验收都要用它；用本人的 ChatGPT 账号连接一次即可，约 1 分钟。" }
      : null;
  cached = { workspaceId: ctx.workspaceId, at: now, status };
  return worded(ctx, status);
}

function worded(ctx: AccessContext, status: RuntimeStatus | null): RuntimeStatus | null {
  if (!status) return null;
  const t = tOf(ctx);
  return { ...status, title: t(status.title), message: t(status.message) };
}
