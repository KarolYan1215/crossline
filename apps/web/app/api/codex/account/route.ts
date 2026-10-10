import { NextResponse } from "next/server";
import { CodexSupervisorRequestError, requestCodexSupervisor } from "../../../../lib/codex-runtime";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { resolveAccessContext } from "../../../../lib/access-guard";

export const runtime = "nodejs";

function blockerResponse(error: unknown) {
  const supervisorError = error instanceof CodexSupervisorRequestError ? error : new CodexSupervisorRequestError(503, {
    code: "CODEX_SUPERVISOR_UNAVAILABLE",
    message: "Codex supervisor is unavailable"
  });
  return NextResponse.json({
    account: null,
    requiresOpenaiAuth: true,
    blocker: supervisorError.blocker
  }, { status: supervisorError.status });
}

export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  try {
    const [account, supervisor] = await Promise.all([
      requestCodexSupervisor<Record<string, unknown>>(access.ctx, "/v1/codex/account"),
      requestCodexSupervisor<Record<string, unknown>>(access.ctx, "/v1/codex/status")
    ]);
    return NextResponse.json({ ...account, supervisor });
  } catch (error) {
    return blockerResponse(error);
  }
}

// Starts a real OAuth flow, so a cross-site POST here is not a nuisance write — it is a forged sign-in
// attempt against the account this board is bound to. A CSRF probe reached this route once and got a
// live authUrl back before either guard existed.
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => ({})) as { type?: unknown; apiKey?: unknown; action?: unknown };
  try {
    // Signing an account out of its own Codex deletes that account's home on this machine (login and memories).
    if (body.action === "logout") return NextResponse.json(await requestCodexSupervisor(access.ctx, "/v1/codex/logout", { method: "POST" }));
    const type = body.type === "apiKey" || body.type === "chatgptDeviceCode" ? body.type : "chatgpt";
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    if (type === "apiKey" && (!apiKey || apiKey.length > 300)) return NextResponse.json({ blocker: { code: "API_KEY_INVALID", message: "请填写 API key" } }, { status: 400 });
    // The key passes through to the account's own runtime, which stores it in that account's home; nothing here keeps or echoes it.
    return NextResponse.json(await requestCodexSupervisor(access.ctx, "/v1/codex/login", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(type === "apiKey" ? { type, apiKey } : { type }) }));
  } catch (error) {
    return blockerResponse(error);
  }
}

export async function DELETE(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  try {
    return NextResponse.json(await requestCodexSupervisor(access.ctx, "/v1/codex/login/cancel", { method: "POST" }));
  } catch (error) {
    return blockerResponse(error);
  }
}
