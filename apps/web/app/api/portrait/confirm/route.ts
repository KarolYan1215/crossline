import { resolveAccessContext } from "../../../../lib/access-guard";
import { answerPortrait, type PortraitAnswer } from "../../../../lib/portrait";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

const ANSWERS = new Set<PortraitAnswer>(["yes", "mostly", "no"]);

/** `{answer: yes | mostly | no, note?}`: the person's answer to whether the portrait fits them (`answerPortrait`). */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { answer?: unknown; note?: unknown } | null;
  const answer = body?.answer as PortraitAnswer;
  if (!ANSWERS.has(answer)) return Response.json({ ok: false, code: "PORTRAIT_ANSWER_INVALID" }, { status: 400 });
  const note = typeof body?.note === "string" ? body.note.slice(0, 1000) : "";
  const result = await answerPortrait(access.ctx, answer, note);
  return Response.json(result, { status: result.ok ? 200 : 400 });
}
