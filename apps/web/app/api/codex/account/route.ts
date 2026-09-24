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
      requestCodexSupervisor<Record<string, unknown>>("/v1/codex/account"),
      requestCodexSupervisor<Record<string, unknown>>("/v1/codex/status")
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
  try {
    return NextResponse.json(await requestCodexSupervisor("/v1/codex/login", { method: "POST" }));
  } catch (error) {
    return blockerResponse(error);
  }
}

export async function DELETE(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  try {
    return NextResponse.json(await requestCodexSupervisor("/v1/codex/login/cancel", { method: "POST" }));
  } catch (error) {
    return blockerResponse(error);
  }
}
