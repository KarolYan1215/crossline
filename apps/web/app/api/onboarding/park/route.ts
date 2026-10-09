import { NextResponse } from "next/server";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { parkInterview } from "../../../../lib/interview-status";

/** 「先开始使用」: the interview is put aside; its questions are asked on 待决事项 until the person replies in it again. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, blocker: { code: "REQUEST_FORBIDDEN", message: "Use the local Web API" } }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  parkInterview(access.ctx);
  return NextResponse.json({ ok: true });
}
