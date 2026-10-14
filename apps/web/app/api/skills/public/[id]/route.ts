import { NextResponse } from "next/server";
import { deletePublicSkill } from "../../../../../lib/skill-library";
import { writeGuard, validId } from "../../../agent/guard";

/** Removes one public skill from the library at the person's word (`skill.public.removed`, by the person). */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const { id } = await context.params;
  if (!validId(id)) return NextResponse.json({ ok: false, code: "INVALID_SKILL" }, { status: 400 });
  const result = deletePublicSkill(guard.ctx, id);
  return NextResponse.json(result, { status: result.ok ? 200 : 404 });
}
