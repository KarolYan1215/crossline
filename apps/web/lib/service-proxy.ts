import "server-only";
import type { AccessContext } from "@crossline/core";
import { CodexSupervisorRequestError, requestCodexSupervisor } from "./codex-runtime";
import { tOf } from "./locale";

/**
 * A worker service's route answered through the supervisor (the mailbox, automations — docs/personal-agent.md): the worker holds
 * the passwords and runs the model, the web app only passes the person's request on and the answer back.
 */
export async function serviceProxy(ctx: AccessContext, path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<Response> {
  try {
    const answer = await requestCodexSupervisor<unknown>(ctx, path, {
      method: init.method ?? "GET", headers: { "content-type": "application/json" },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}), signal: AbortSignal.timeout(init.timeoutMs ?? 60_000)
    });
    return Response.json(answer, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof CodexSupervisorRequestError) return Response.json({ ok: false, blocker: error.blocker }, { status: error.status });
    return Response.json({ ok: false, blocker: { code: "WORKER_UNAVAILABLE", message: tOf(ctx)("后台服务没有连上，稍后再试。") } }, { status: 503 });
  }
}
