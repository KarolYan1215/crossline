import { NextResponse } from "next/server";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { CodexSupervisorRequestError, requestCodexSupervisor } from "../../../../lib/codex-runtime";
import { tOf } from "../../../../lib/locale";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/**
 * 「作为算力节点」 on this computer's `/device` page (docs/compute-node.md): `{enabled}` is kept by the worker, which restarts and, while it
 * is on and the hosted site switched it on too, offers this computer's Codex runtime to the site. The state is in GET `/api/device/link`.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => ({})) as { enabled?: unknown; apiKey?: unknown };
  // An OpenAI API key for this computer's Codex is passed straight through to the worker, never kept or logged by this app.
  const forward = typeof body.apiKey === "string" ? { apiKey: body.apiKey } : { enabled: body.enabled === true };
  try {
    return NextResponse.json(await requestCodexSupervisor<unknown>(access.ctx, "/v1/device/node", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(forward), signal: AbortSignal.timeout(60_000) }));
  } catch (error) {
    return error instanceof CodexSupervisorRequestError
      ? NextResponse.json({ ok: false, code: error.blocker.code, message: error.blocker.message }, { status: error.status })
      : NextResponse.json({ ok: false, code: "DEVICE_NODE_FAILED", message: tOf(access.ctx)("后台服务没有响应。") }, { status: 503 });
  }
}
