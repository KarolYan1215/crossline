import { FAMILIARITY_LEVELS, type FamiliarityLevel } from "@crossline/core";
import { setFamiliarity } from "../../../../../lib/familiarity";
import { rejectUnsafeRequest } from "../guard";

/** `{level: "near" | "mid" | "far"}`: how familiar this line's kind of work is to the person, which decides how much it is explained. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const guard = await rejectUnsafeRequest(request, id);
  if ("response" in guard) return guard.response;
  const body = (await request.json().catch(() => ({}))) as { level?: unknown };
  if (typeof body.level !== "string" || !(FAMILIARITY_LEVELS as readonly string[]).includes(body.level))
    return Response.json({ ok: false, code: "FAMILIARITY_INVALID" }, { status: 400 });
  const result = setFamiliarity(guard.ctx, id, body.level as FamiliarityLevel);
  return result.ok ? Response.json(result) : Response.json(result, { status: result.code === "WORK_ORDER_NOT_FOUND" ? 404 : 400 });
}
