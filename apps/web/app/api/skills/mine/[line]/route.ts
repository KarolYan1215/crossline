import { NextResponse } from "next/server";
import { editMineSkill, restoreMineSkill } from "../../../../../lib/skill-library";
import { writeGuard, validId } from "../../../agent/guard";

/**
 * A line's own skill, changed by the person on the settings page: `{markdown}` saves their text as a new version, `{restore: n}` brings
 * version n back as a new version. Either is in force at once; nothing earlier is deleted.
 */
export async function POST(request: Request, context: { params: Promise<{ line: string }> }) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const { line } = await context.params;
  if (!validId(line)) return NextResponse.json({ ok: false, code: "INVALID_LINE" }, { status: 400 });
  const { markdown, restore } = guard.body;
  const result = typeof restore === "number" && Number.isInteger(restore) ? restoreMineSkill(guard.ctx, line, restore)
    : typeof markdown === "string" ? editMineSkill(guard.ctx, line, markdown) : { ok: false as const, code: "INVALID_REQUEST" };
  return NextResponse.json(result, { status: result.ok ? 200 : result.code === "INVALID_REQUEST" ? 400 : result.code.endsWith("NOT_FOUND") ? 404 : 409 });
}
