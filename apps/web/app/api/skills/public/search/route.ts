import { NextResponse } from "next/server";
import { requestSkillSearch } from "../../../../../lib/skill-library";
import { writeGuard } from "../../../agent/guard";

/** `{lineId}`: one more search of that line's public skills, run by the worker at its next tick as the line's setup search. */
export async function POST(request: Request) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const { lineId } = guard.body;
  if (typeof lineId !== "string" || !/^[a-z0-9_-]{1,64}$/i.test(lineId)) return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  const result = requestSkillSearch(guard.ctx, lineId);
  return NextResponse.json(result, { status: result.ok ? 200 : 404 });
}
