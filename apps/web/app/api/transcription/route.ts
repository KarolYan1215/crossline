import { NextResponse } from "next/server";
import { tOf } from "../../../lib/locale";
import { requestCodexSupervisor, CodexSupervisorRequestError } from "../../../lib/codex-runtime";
import { resolveAccessContext } from "../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../lib/same-origin";

/**
 * Whether recordings can be turned into text here yet, and the one-time model download that makes it so.
 * The download only starts when the request says `consent: true`, which the screen sends only from the button
 * that names where the model comes from and how large it is.
 */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  try { return NextResponse.json(await requestCodexSupervisor<unknown>(access.ctx, "/v1/transcription/status")); }
  catch (error) {
    if (error instanceof CodexSupervisorRequestError) return NextResponse.json({ state: "unavailable", code: error.blocker.code, message: tOf(access.ctx)("后台服务没有运行，暂时无法转写录音。") });
    return NextResponse.json({ state: "unavailable", code: "TRANSCRIPTION_STATUS_FAILED", message: tOf(access.ctx)("读不到转写状态。") });
  }
}

export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => ({})) as { consent?: unknown };
  if (body.consent !== true) return NextResponse.json({ ok: false, code: "DOWNLOAD_CONSENT_REQUIRED" }, { status: 400 });
  try {
    return NextResponse.json(await requestCodexSupervisor<unknown>(access.ctx, "/v1/transcription/download", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}"
    }));
  } catch (error) {
    if (error instanceof CodexSupervisorRequestError) return NextResponse.json({ ok: false, blocker: error.blocker }, { status: error.status });
    return NextResponse.json({ ok: false, code: "TRANSCRIPTION_DOWNLOAD_FAILED" }, { status: 503 });
  }
}
