import { NextResponse } from "next/server";
import { EFFORT_PREFERENCES, MODEL_EFFORT_SETTING, effortPreferenceOf } from "@crossline/core";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { getStore } from "../../../../lib/crossline";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/** The person's 模型强度 (`lower | default | higher`); the worker reads it per run, for runs on the account's own Codex only. */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return NextResponse.json({ effort: effortPreferenceOf(getStore().getSetting(access.ctx.workspaceId, MODEL_EFFORT_SETTING)) });
}

export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { effort?: unknown } | null;
  const effort = typeof body?.effort === "string" ? body.effort : "";
  if (!(EFFORT_PREFERENCES as readonly string[]).includes(effort)) return NextResponse.json({ ok: false, code: "INVALID_MODEL_EFFORT" }, { status: 400 });
  getStore().setSetting(access.ctx.workspaceId, MODEL_EFFORT_SETTING, effort);
  return NextResponse.json({ ok: true });
}
