import { assistantAvailable as machineOwner } from "@crossline/db";
import { NextResponse } from "next/server";
import { AGENT_HISTORY_CONSENT, AGENT_HISTORY_SUMMARY } from "@crossline/core";
import { getStore } from "../../../../lib/crossline";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/** Whether the worker may read when and where the person used Codex and Claude Code (time only). Turning it off forgets the summary. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { on?: unknown } | null;
  // This computer's own readings belong to its owner's account only; a guest's device is elsewhere (2026-10-15 walkthrough).
  if (body?.on === true && !machineOwner(getStore(), access.ctx.workspaceId)) return Response.json({ ok: false, code: "MACHINE_OWNER_ONLY" }, { status: 403 });
  if (typeof body?.on !== "boolean") return NextResponse.json({ ok: false, code: "INVALID_AGENT_HISTORY" }, { status: 400 });
  const store = getStore();
  store.setSetting(access.ctx.workspaceId, AGENT_HISTORY_CONSENT, body.on ? "on" : "off");
  if (!body.on) store.setSetting(access.ctx.workspaceId, AGENT_HISTORY_SUMMARY, "null");
  return NextResponse.json({ ok: true });
}
