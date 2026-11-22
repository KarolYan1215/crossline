import { NextResponse } from "next/server";
import { DEVICE_FOLDER_SCREEN_LIMIT } from "@crossline/core";
import { deviceAccess } from "../../../../lib/device";
import { requestCodexSupervisor } from "../../../../lib/codex-runtime";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/**
 * A linked computer's authorized folder, screened here before it imports anything (D3, docs/plans/2026-11-22-interview-and-import-redesign.md
 * §四.4: the hosted site cannot open the person's files later, so it screens first, then the device imports). Only names, sizes and dates
 * arrive; the device has already left out credentials, private papers and what the person excluded. `device` token only. Without an
 * answer (no model, quota) the device keeps the most recently changed files itself.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = deviceAccess(request, { needsKey: false });
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { folder?: unknown; files?: unknown } | null;
  const files = Array.isArray(body?.files) ? body.files.flatMap((file) => {
    const item = file as { path?: unknown; size?: unknown; modified?: unknown } | null;
    return item && typeof item.path === "string" && item.path.length <= 1000
      ? [{ path: item.path, size: Number(item.size) || 0, modified: Number(item.modified) || 0 }] : [];
  }).slice(0, 1000) : [];
  if (!files.length) return NextResponse.json({ ok: false, code: "FOLDER_SCREEN_INVALID" }, { status: 400 });
  const folder = typeof body?.folder === "string" ? body.folder.slice(0, 200) : "";
  const answer = await requestCodexSupervisor<{ keep?: unknown; why?: unknown }>(access.ctx, "/v1/sources/folders/screen", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ folder, files, limit: DEVICE_FOLDER_SCREEN_LIMIT }),
    signal: AbortSignal.timeout(150_000)
  }).catch(() => undefined);
  if (!answer || !Array.isArray(answer.keep)) return NextResponse.json({ ok: false, code: "FOLDER_SCREEN_UNAVAILABLE" });
  return NextResponse.json({ ok: true, keep: answer.keep.filter((path): path is string => typeof path === "string"), why: typeof answer.why === "string" ? answer.why : "" });
}
