import { NextResponse } from "next/server";
import { resolveAccessContext } from "../../../lib/access-guard";
import { loadAsks, reviewAsks } from "../../../lib/asks";

/**
 * The open asks, most urgent first — what Today's list reloads after each answer. `?scope=review`: the questions that wait for the weekly
 * review instead (`Ask.inReview`). Read-only.
 */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const review = new URL(request.url).searchParams.get("scope") === "review";
  return NextResponse.json({ ok: true, asks: review ? reviewAsks(access.ctx) : await loadAsks(access.ctx) }, { headers: { "cache-control": "no-store" } });
}
