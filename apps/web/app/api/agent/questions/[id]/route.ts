import { answerAgentQuestion } from "@crossline/db";
import { getStore } from "../../../../../lib/crossline";
import { validId, writeGuard } from "../../guard";

/** The person's answer to a question a run asked mid-way: `{answers: {<question id>: [text]}}`, an option's label or their own words. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const { id } = await context.params;
  const answers = guard.body.answers;
  if (!validId(id) || typeof answers !== "object" || answers === null || Array.isArray(answers)) return Response.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  const recorded = answerAgentQuestion(getStore(), guard.ctx.workspaceId, id, answers as Record<string, string[]>);
  return Response.json({ ok: recorded }, { status: recorded ? 200 : 409 });
}
