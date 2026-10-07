import { NextResponse } from "next/server";
import { resolveAccessContext } from "../../../lib/access-guard";
import { loadAsks } from "../../../lib/asks";

/** The open asks, most urgent first — what Today's list reloads after each answer. Read-only. */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return NextResponse.json({ ok: true, asks: await loadAsks(access.ctx) }, { headers: { "cache-control": "no-store" } });
}
