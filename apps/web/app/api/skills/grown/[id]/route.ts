import { NextResponse } from "next/server";
import { changeGrownSkill } from "../../../../../lib/skill-library";
import { writeGuard, validId } from "../../../agent/guard";

/** A grown workflow, changed by the person: `{status: "active" | "off"}` turns it on or off, `{pinned}` keeps it from idle removal. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const { id } = await context.params;
  if (!validId(id)) return NextResponse.json({ ok: false, code: "INVALID_SKILL" }, { status: 400 });
  const { status, pinned } = guard.body;
  if ((status !== undefined && status !== "active" && status !== "off") || (pinned !== undefined && typeof pinned !== "boolean") || (status === undefined && pinned === undefined)) {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  }
  const result = changeGrownSkill(guard.ctx, id, { ...(status ? { status } : {}), ...(typeof pinned === "boolean" ? { pinned } : {}) });
  return NextResponse.json(result, { status: result.ok ? 200 : 404 });
}

/** Removes a grown workflow at the person's word (`skill.grown.removed`, by the person). */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const { id } = await context.params;
  if (!validId(id)) return NextResponse.json({ ok: false, code: "INVALID_SKILL" }, { status: 400 });
  const result = changeGrownSkill(guard.ctx, id, "remove");
  return NextResponse.json(result, { status: result.ok ? 200 : 404 });
}
