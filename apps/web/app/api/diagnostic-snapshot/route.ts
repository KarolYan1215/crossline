import { NextResponse } from "next/server";
import { getStore } from "../../../lib/crossline";
import { resolveAccessContext } from "../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../lib/same-origin";
import { currentLocalAccount, isLocalInstall } from "../../../lib/local-install";
import { FEEDBACK_MAX_CHARS, redactedSnapshot, rememberPreview, snapshotSummary, takePreview, uploadSnapshot } from "../../../lib/diagnostic-snapshot";

export const runtime = "nodejs";

/**
 * 「上传诊断快照」 (docs/local-installer.md, 脱敏快照). GET builds the redacted snapshot and returns it whole, with a summary and the
 * id it is kept under; POST uploads that very object with the person's note. Installed copies only: the salt that keys every hash
 * is the install's own, and without it there is nothing safe to build.
 */
function salt(): string | undefined {
  return isLocalInstall() ? process.env.CROSSLINE_TELEMETRY_SALT?.trim() || undefined : undefined;
}

export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const key = salt();
  if (!key) return NextResponse.json({ ok: false, code: "NOT_INSTALLED" }, { status: 404 });
  const snapshot = redactedSnapshot(getStore(), access.ctx.workspaceId, key);
  return NextResponse.json({ ok: true, id: rememberPreview(access.ctx.workspaceId, snapshot), summary: snapshotSummary(snapshot), snapshot });
}

export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  if (!salt()) return NextResponse.json({ ok: false, code: "NOT_INSTALLED" }, { status: 404 });
  const body = await request.json().catch(() => null) as { id?: unknown; feedback?: unknown } | null;
  if (typeof body?.id !== "string") return NextResponse.json({ ok: false, code: "SNAPSHOT_ID_REQUIRED" }, { status: 400 });
  const feedback = typeof body.feedback === "string" ? body.feedback.slice(0, FEEDBACK_MAX_CHARS) : "";
  // Only the object the person looked at goes out; an expired or unknown preview is built again by the page, never here.
  const snapshot = takePreview(access.ctx.workspaceId, body.id);
  if (!snapshot) return NextResponse.json({ ok: false, code: "SNAPSHOT_PREVIEW_EXPIRED" }, { status: 409 });
  const account = await currentLocalAccount();
  const result = await uploadSnapshot(snapshot, feedback, account?.email);
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
