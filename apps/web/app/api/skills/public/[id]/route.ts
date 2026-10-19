import { NextResponse } from "next/server";
import { allowScripts, deletePublicSkill } from "../../../../../lib/skill-library";
import { writeGuard, validId } from "../../../agent/guard";

/** `{action: "allow_scripts" | "disallow_scripts"}`: the person allows the scripts of a skill the checks capped to text, or takes it back. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const { id } = await context.params;
  const { action } = guard.body;
  if (!validId(id) || (action !== "allow_scripts" && action !== "disallow_scripts")) return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  const result = allowScripts(guard.ctx, "public", id, action === "allow_scripts");
  return NextResponse.json(result, { status: result.ok ? 200 : 409 });
}

/** Removes one public skill from the library at the person's word (`skill.public.removed`, by the person). */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const { id } = await context.params;
  if (!validId(id)) return NextResponse.json({ ok: false, code: "INVALID_SKILL" }, { status: 400 });
  const result = deletePublicSkill(guard.ctx, id);
  return NextResponse.json(result, { status: result.ok ? 200 : 404 });
}
