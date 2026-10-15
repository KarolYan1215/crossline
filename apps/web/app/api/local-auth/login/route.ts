import { NextResponse } from "next/server";
import { isDirectLoopbackRequest } from "@crossline/auth";
import { CodexSupervisorRequestError } from "../../../../lib/codex-runtime";
import { bootstrapSupervisor, isLocalInstall } from "../../../../lib/local-install";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

export const runtime = "nodejs";

/**
 * Starts (POST) or cancels (DELETE) the machine's own Codex ChatGPT sign-in, before anyone has a session — the only way into an
 * installed copy (docs/local-installer.md, 登录). The page then opens the returned `authUrl`, and once Codex holds the account,
 * `/api/auth/codex-local/session` turns it into a session. Loopback only, like that route.
 */
function refuse(request: Request): NextResponse | undefined {
  if (isCrossSiteWrite(request)) return NextResponse.json({ code: "REQUEST_FORBIDDEN" }, { status: 403 });
  if (!isLocalInstall()) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  const base = process.env.CROSSLINE_WEB_BASE_URL || "http://127.0.0.1:3210";
  if (!isDirectLoopbackRequest(request.headers, base)) return NextResponse.json({ code: "LOCAL_SIGNIN_LOOPBACK_ONLY" }, { status: 403 });
  return undefined;
}

function blocker(error: unknown) {
  const status = error instanceof CodexSupervisorRequestError ? error.status : 503;
  const code = error instanceof CodexSupervisorRequestError ? error.blocker.code : "CODEX_UNAVAILABLE";
  return NextResponse.json({ code }, { status });
}

export async function POST(request: Request) {
  const refused = refuse(request); if (refused) return refused;
  try { return NextResponse.json(await bootstrapSupervisor<{ authUrl?: string; loginId?: string }>("POST", "/v1/codex/login", { type: "chatgpt" })); }
  catch (error) { return blocker(error); }
}

export async function DELETE(request: Request) {
  const refused = refuse(request); if (refused) return refused;
  try { return NextResponse.json(await bootstrapSupervisor("POST", "/v1/codex/login/cancel")); }
  catch (error) { return blocker(error); }
}
