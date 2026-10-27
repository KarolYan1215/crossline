import { localStamp, type AccessContext } from "@crossline/core";
import { quotaFallbackOf } from "./background";
import { requestCodexSupervisor } from "./codex-runtime";
import { getStore, readSchedulePreferences } from "./crossline";
import { devicePrimaryUrl } from "./device-mode";
import { tOf } from "./locale";

/**
 * Why the AI cannot work at all right now, or null when it can. An error to show, not a decision: it is never one of the asks.
 * `sponsor_standin` is the one notice that is not an error: ChatGPT's quota is spent and the developer's model carries on.
 */
export type RuntimeStatus = { code: "worker_down" | "signed_out" | "sponsor_waiting" | "sponsor_standin"; title: string; message: string };

export type RuntimeCheck = { at: number; status: RuntimeStatus | null; misses: number };

const WORKER_DOWN: RuntimeStatus = { code: "worker_down", title: "后台服务没有运行",
  message: "自动分析、倒推、材料准备、验收与提醒都已停止；已收集的内容不受影响。在运行 Crossline 的那台电脑上重新启动后恢复。" };
/** A check that reached the worker is kept a minute; a miss only a few seconds, so the next page asks again. */
const CHECK_TTL_MS = 60_000;
const MISS_TTL_MS = 10_000;
/** Misses this far apart are not counted together. */
const MISS_WINDOW_MS = 5 * 60_000;

/**
 * What one unanswered check means. The worker is called down only on the second miss in a row: one slow answer is a worker under
 * load, not a stopped one (2026-10-24: the hosted worker sat at its memory ceiling with the collection's Chromium, missed the
 * 2.5 s once, and every page showed 「后台服务没有运行」 for the cached minute while it ticked normally). Until then the last
 * status that did reach the worker stands.
 */
export function afterMiss(previous: RuntimeCheck | undefined, now: number): RuntimeCheck {
  const recent = previous && now - previous.at < MISS_WINDOW_MS ? previous : undefined;
  const misses = (recent?.misses ?? 0) + 1;
  const kept = recent?.status?.code === "worker_down" ? null : recent?.status ?? null;
  return { at: now, misses, status: misses >= 2 ? WORKER_DOWN : kept };
}

const checks = new Map<string, RuntimeCheck>();

/**
 * Whether the worker answers and its model runtime is signed in. Asked over the network (a minute's cache, two and a half seconds
 * to answer; see `afterMiss` for a check that gets no answer). Under e2e and vitest nothing listens on the supervisor port on
 * purpose, so it reports nothing there.
 */
export async function runtimeStatus(ctx: AccessContext, now = Date.now()): Promise<RuntimeStatus | null> {
  if (process.env.CROSSLINE_E2E_DATA_DIR || process.env.VITEST) return null;
  // A linked device runs no model at all (docs/device-mode.md): its one page says its own state.
  if (devicePrimaryUrl()) return null;
  // The cache keeps the finding; its words are written in the language of each request (`worded`).
  const cached = checks.get(ctx.workspaceId);
  if (cached && now - cached.at < (cached.misses ? MISS_TTL_MS : CHECK_TTL_MS)) return worded(ctx, cached.status);
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
  if (account === "timeout" || !account.ok) {
    const check = afterMiss(cached, now);
    checks.set(ctx.workspaceId, check);
    return worded(ctx, check.status);
  }
  const status: RuntimeStatus | null = !account.value.account && sponsorWait
      ? { code: "sponsor_waiting", title: sponsorWait.code === "MODEL_SPONSOR_BUDGET" ? "本月邀请额度已用完" : "邀请码已生效，模型还在检验", message: sponsorWait.message }
      : !account.value.account && !viaApi
        ? { code: "signed_out", title: "还没有连接模型", message: "访谈、自动分析、倒推、材料准备与验收都要用它；用本人的 ChatGPT 账号或自己的模型 API 连接一次即可。" }
        : standIn(ctx, now);
  checks.set(ctx.workspaceId, { at: now, status, misses: 0 });
  return worded(ctx, status);
}

/**
 * The status in this request's language. Titles and the fixed messages are keys; the sponsor's own message comes from the worker
 * already worded, and the stand-in's message is built in the language of the request that made it.
 */
function worded(ctx: AccessContext, status: RuntimeStatus | null): RuntimeStatus | null {
  if (!status) return null;
  const t = tOf(ctx);
  const fixed = status.code === "worker_down" || status.code === "signed_out";
  return { ...status, title: t(status.title), message: fixed ? t(status.message) : status.message };
}

/** ChatGPT's quota spent and the developer's model standing in (the worker's mark), said with when ChatGPT comes back. */
function standIn(ctx: AccessContext, now: number): RuntimeStatus | null {
  const { quotaFallback } = quotaFallbackOf(getStore(), ctx.workspaceId, new Date(now));
  if (!quotaFallback) return null;
  const zone = readSchedulePreferences(ctx)?.timeZone ?? process.env.CROSSLINE_TIME_ZONE ?? "America/Chicago";
  const t = tOf(ctx);
  return { code: "sponsor_standin", title: "已改用开发者提供的模型",
    message: quotaFallback.resetsAt
      ? t("ChatGPT 额度已用尽，后台工作改由开发者提供的模型继续，到 {{at}} ChatGPT 额度恢复后切回。", { at: localStamp(quotaFallback.resetsAt, zone) })
      : t("ChatGPT 额度已用尽，后台工作改由开发者提供的模型继续，ChatGPT 额度恢复后切回。") };
}
