import { NextResponse } from "next/server";
import { approvePlanVersion } from "../../../../../lib/crossline";
import { isCrossSiteWrite } from "../../../../../lib/same-origin";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const { id } = await context.params;
  const result = approvePlanVersion(id);
  if (!result.ok) return NextResponse.json(result, { status: result.code === "PLAN_VERSION_NOT_FOUND" ? 404 : 409 });
  return NextResponse.json(result);
}
