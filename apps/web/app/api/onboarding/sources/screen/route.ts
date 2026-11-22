import { NextResponse } from "next/server";
import { resolveAccessContext } from "../../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../../lib/same-origin";
import { requestCodexSupervisor } from "../../../../../lib/codex-runtime";

/**
 * A folder picked in the browser, screened by the model before it goes up (§四.3.3; only names, sizes and dates leave the page here). The
 * page has already left out credentials and private papers by code. Without an answer (no model, quota, the worker down) the page keeps
 * the most recently changed files itself, so an upload never waits on this.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { folder?: unknown; files?: unknown; limit?: unknown } | null;
  if (!body || !Array.isArray(body.files) || !body.files.length) return NextResponse.json({ ok: false, code: "FOLDER_SCREEN_INVALID" }, { status: 400 });
  const answer = await requestCodexSupervisor<{ keep?: unknown; why?: unknown; blocked?: unknown }>(access.ctx, "/v1/sources/folders/screen", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ folder: body.folder, files: body.files, limit: body.limit }),
    signal: AbortSignal.timeout(150_000)
  }).catch(() => undefined);
  if (!answer || !Array.isArray(answer.keep)) return NextResponse.json({ ok: false, code: "FOLDER_SCREEN_UNAVAILABLE" });
  return NextResponse.json({ ok: true, keep: answer.keep.filter((path): path is string => typeof path === "string"), why: typeof answer.why === "string" ? answer.why : "" });
}
