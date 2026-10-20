import { closeDraft } from "../../../../../lib/mail-drafts";
import { writeGuard } from "../../../agent/guard";

/** Closes a reply draft: `{ how: "replied" }` (本人已回复) or `{ how: "dismissed" }` (不用回); either way it is not mentioned again. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const { id } = await context.params;
  const how = guard.body.how;
  if (how !== "replied" && how !== "dismissed") return Response.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  return Response.json({ ok: closeDraft(guard.ctx, id, how) });
}
