import { NextResponse } from "next/server";
import { SOURCE_FOLDERS_SETTING, readSourceFolders } from "@crossline/core";
import { assistantAvailable } from "@crossline/db";
import { getStore } from "../../../../lib/crossline";
import { identityLines } from "../../../../lib/lines";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { CodexSupervisorRequestError, requestCodexSupervisor } from "../../../../lib/codex-runtime";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/**
 * Authorized folders (docs/onboarding-v3.md 「文件夹授权」). The list is read here from the ledger; the walking and reading happen in the
 * worker, which checks every path itself: `preview` says what would be read before anything is, `add` keeps the folder and reads it in
 * the background, `lines` sets which lines it serves (the person's choice, kept as theirs), DELETE stops reading it.
 */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return NextResponse.json({
    folders: readSourceFolders(getStore().getSetting(access.ctx.workspaceId, SOURCE_FOLDERS_SETTING)),
    // The worker refuses a guest's folder (`FOLDER_OWNER_ONLY`); the card is not shown to one at all.
    available: assistantAvailable(getStore(), access.ctx.workspaceId),
    lines: identityLines(access.ctx).map((line) => ({ id: line.id, label: line.label }))
  }, { headers: { "cache-control": "no-store" } });
}

const unavailable = (error: unknown) => NextResponse.json({ state: "blocked", code: error instanceof CodexSupervisorRequestError ? error.blocker.code : "FOLDER_FAILED",
  message: "后台服务没有连上，稍后再试。" }, { status: 503 });

export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ state: "blocked", code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { action?: unknown; path?: unknown; id?: unknown; lines?: unknown } | null;
  try {
    if ((body?.action === "preview" || body?.action === "add") && typeof body.path === "string" && body.path.trim()) {
      return NextResponse.json(await requestCodexSupervisor(access.ctx, body.action === "preview" ? "/v1/sources/folders/preview" : "/v1/sources/folders", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: body.path.slice(0, 1000) }), signal: AbortSignal.timeout(120_000) }));
    }
    if (body?.action === "lines" && typeof body.id === "string" && /^[A-Za-z0-9-]{1,40}$/.test(body.id) && Array.isArray(body.lines)) {
      const known = new Set(identityLines(access.ctx).map((line) => line.id));
      const lines = body.lines.filter((line): line is string => typeof line === "string" && known.has(line));
      return NextResponse.json(await requestCodexSupervisor(access.ctx, `/v1/sources/folders/${body.id}/lines`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lines }), signal: AbortSignal.timeout(30_000) }));
    }
  } catch (error) { return unavailable(error); }
  return NextResponse.json({ state: "blocked", code: "FOLDER_REQUEST_INVALID", message: "先填写文件夹路径。" }, { status: 400 });
}

export async function DELETE(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ state: "blocked", code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!/^[A-Za-z0-9-]{1,40}$/.test(id)) return NextResponse.json({ state: "blocked", code: "FOLDER_ID_INVALID" }, { status: 400 });
  try { return NextResponse.json(await requestCodexSupervisor(access.ctx, `/v1/sources/folders/${id}`, { method: "DELETE", signal: AbortSignal.timeout(30_000) })); }
  catch (error) { return unavailable(error); }
}
