import { NextResponse } from "next/server";
import { resolvePlanChange } from "../../../../../lib/crossline";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ ok: false, code: "INVALID_JSON" }, { status: 400 }); }
  const { status } = (body ?? {}) as { status?: unknown };
  if (status !== "approved" && status !== "excluded") {
    return NextResponse.json({ ok: false, code: "INVALID_STATUS" }, { status: 400 });
  }
  const result = resolvePlanChange(id, status);
  if (!result.ok) return NextResponse.json(result, { status: 404 });
  return NextResponse.json(result);
}
