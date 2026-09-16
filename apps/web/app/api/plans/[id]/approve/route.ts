import { NextResponse } from "next/server";
import { approvePlanVersion } from "../../../../../lib/crossline";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const result = approvePlanVersion(id);
  if (!result.ok) return NextResponse.json(result, { status: result.code === "PLAN_VERSION_NOT_FOUND" ? 404 : 409 });
  return NextResponse.json(result);
}
