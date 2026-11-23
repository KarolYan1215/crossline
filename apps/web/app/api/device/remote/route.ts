import { NextResponse } from "next/server";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { CodexSupervisorRequestError, requestCodexSupervisor } from "../../../../lib/codex-runtime";
import { devicePrimaryUrl } from "../../../../lib/device-mode";
import { isHostedBeta } from "../../../../lib/hosting";
import { tOf } from "../../../../lib/locale";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/**
 * 「从手机遥控」 on this computer's `/device` page (docs/plans/remote-control-1122.md §5.1, §7.2–§7.3): the phones confirmed here, a pairing,
 * the folders a session may work in, 「替手机转写录音」, 「断开遥控」, the audit log and 「核对」. Only on a linked device: the hosted site
 * never sets any of it.
 */
async function forward(request: Request, method: "GET" | "POST") {
  if (method === "POST" && isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  if (isHostedBeta() || !devicePrimaryUrl()) return NextResponse.json({ ok: false, code: "NOT_FOUND" }, { status: 404 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const raw = method === "POST" ? await request.json().catch(() => ({})) as Record<string, unknown> : undefined;
  const allowed = raw ? Object.fromEntries(Object.entries(raw).filter(([key]) => ["pair", "confirm", "remove", "folders", "transcribe", "disconnect", "check"].includes(key))) : undefined;
  try {
    return NextResponse.json(await requestCodexSupervisor<unknown>(access.ctx, "/v1/device/remote", { method, ...(allowed ? { headers: { "content-type": "application/json" }, body: JSON.stringify(allowed) } : {}),
      signal: AbortSignal.timeout(60_000) }));
  } catch (error) {
    return error instanceof CodexSupervisorRequestError
      ? NextResponse.json({ ok: false, code: error.blocker.code, message: error.blocker.message }, { status: error.status })
      : NextResponse.json({ ok: false, code: "DEVICE_REMOTE_FAILED", message: tOf(access.ctx)("后台服务没有响应。") }, { status: 503 });
  }
}

export const GET = (request: Request) => forward(request, "GET");
export const POST = (request: Request) => forward(request, "POST");
