import { NextResponse } from "next/server";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { CodexSupervisorRequestError, requestCodexSupervisor } from "../../../../lib/codex-runtime";
import { forgetDeviceLink } from "../../../../lib/device-mode";
import type { Translate } from "../../../../lib/i18n";
import { tOf } from "../../../../lib/locale";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/**
 * This computer as a device of a hosted account (docs/device-mode.md), on the install itself: the link's state and what waits to be
 * sent (GET), linking with the hosted site's address and a `device` token (POST `{url, token}` — checked against the site before it is
 * kept), and unlinking (DELETE). The worker keeps the token (DPAPI) and restarts itself into the other mode; this app only relays.
 */
// The worker restarts into the other mode after every link change: for a few seconds there is nothing to answer, which is not a failure.
const failed = (error: unknown, t: Translate) => error instanceof CodexSupervisorRequestError
  ? NextResponse.json({ ok: false, code: error.blocker.code, message: error.blocker.code === "CODEX_SUPERVISOR_UNAVAILABLE"
    ? t("后台服务没有响应：可能正在重启，稍等几秒。") : error.blocker.message }, { status: error.status })
  : NextResponse.json({ ok: false, code: "DEVICE_LINK_FAILED", message: t("后台服务没有响应。") }, { status: 503 });

export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  try { return NextResponse.json(await requestCodexSupervisor<unknown>(access.ctx, "/v1/device/link")); }
  catch (error) { return failed(error, tOf(access.ctx)); }
}

export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => ({})) as { url?: unknown; token?: unknown };
  if (typeof body.url !== "string" || typeof body.token !== "string") return NextResponse.json({ ok: false, code: "DEVICE_LINK_INVALID", message: tOf(access.ctx)("需要地址和令牌。") }, { status: 400 });
  try {
    const result = await requestCodexSupervisor<unknown>(access.ctx, "/v1/device/link", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: body.url, token: body.token }), signal: AbortSignal.timeout(30_000) });
    forgetDeviceLink();
    return NextResponse.json(result);
  } catch (error) { return failed(error, tOf(access.ctx)); }
}

export async function DELETE(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  try {
    const result = await requestCodexSupervisor<unknown>(access.ctx, "/v1/device/link", { method: "DELETE" });
    forgetDeviceLink();
    return NextResponse.json(result);
  } catch (error) { return failed(error, tOf(access.ctx)); }
}
