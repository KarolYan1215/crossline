import { NextResponse } from "next/server";
import { resolveAccessContext } from "../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../lib/same-origin";
import { listCourseTargets, setCourseTarget } from "../../../lib/targets";

export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return NextResponse.json({ ok: true, targets: listCourseTargets(access.ctx) });
}

/** The person changes a course's target. It becomes theirs (confirmed); redoing the milestones from it is a separate, explicit call. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ ok: false, code: "INVALID_JSON" }, { status: 400 }); }
  const input = (body ?? {}) as { projectId?: unknown; value?: unknown };
  if (typeof input.projectId !== "string" || typeof input.value !== "string") return NextResponse.json({ ok: false, code: "INVALID_TARGET" }, { status: 400 });
  const result = setCourseTarget(access.ctx, { projectId: input.projectId, value: input.value });
  return NextResponse.json(result, { status: result.ok ? 200 : result.code === "PROJECT_UNKNOWN" ? 404 : 400 });
}
