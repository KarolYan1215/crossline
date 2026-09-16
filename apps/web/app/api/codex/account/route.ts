import { NextResponse } from "next/server";
import { CodexSupervisorRequestError, requestCodexSupervisor } from "../../../../lib/codex-runtime";

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

export async function GET() {
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

export async function POST() {
  try {
    return NextResponse.json(await requestCodexSupervisor("/v1/codex/login", { method: "POST" }));
  } catch (error) {
    return blockerResponse(error);
  }
}

export async function DELETE() {
  try {
    return NextResponse.json(await requestCodexSupervisor("/v1/codex/login/cancel", { method: "POST" }));
  } catch (error) {
    return blockerResponse(error);
  }
}
