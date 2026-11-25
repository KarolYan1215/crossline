import { NextResponse } from "next/server";
import { resolveAccessContext } from "../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../lib/same-origin";
import { answerDrill, loadDrill } from "../../../lib/drill";

/** J7's weekly drill: GET this week's exercise (without its key until graded) and the trend; POST the person's answers, once a week. */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return NextResponse.json({ ok: true, drill: loadDrill(access.ctx) }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, blocker: { code: "REQUEST_FORBIDDEN", message: "Use the local Web API" } }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* validated below */ }
  const result = answerDrill(access.ctx, { week: body.week, answers: body.answers, fixedFile: body.fixedFile });
  return NextResponse.json(result, { status: result.ok ? 200 : result.code === "DRILL_NOT_FOUND" ? 404 : result.code === "DRILL_ALREADY_ANSWERED" ? 409 : 400 });
}
