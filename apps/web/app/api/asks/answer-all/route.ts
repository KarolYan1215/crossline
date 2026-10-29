import { NextResponse } from "next/server";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { answerAllPlan, runAnswerAll } from "../../../../lib/answer-all";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/**
 * 「全部按推荐」 (docs/rituals.md). GET says what it would settle — how many of each kind — so the button can say it before it is pressed;
 * POST settles them under one undo and answers with how many went through and the operation to undo.
 */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const plan = answerAllPlan(access.ctx);
  return NextResponse.json({ ok: true, total: plan.total, groups: plan.groups });
}

export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return NextResponse.json(await runAnswerAll(access.ctx));
}
