import { NextResponse } from "next/server";
import { resolveAccessContext } from "../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../lib/same-origin";
import { dismissFront, frontForToday, overrideGate, reportSetback, saveGateGoal } from "../../../lib/gates";

/**
 * The execution gates (docs/plans/execution-gates-1124.md §四). GET: today's front task (J4). POST `{action}`:
 * - `override` `{judgedId, to, note?}`: turn a judgement over (or confirm it, when `to` is its own verdict);
 * - `not_front` `{eventId, note?}`: 「不是这件」 on Today;
 * - `setback` `{text, line?}`: a setback in the person's own words, classified by the worker (J2b);
 * - `goal` `{text}`: the goal the gates judge against (`gates.goal`).
 */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return NextResponse.json({ ok: true, front: frontForToday(access.ctx) }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, blocker: { code: "REQUEST_FORBIDDEN", message: "Use the local Web API" } }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* validated below */ }
  const text = (value: unknown) => typeof value === "string" ? value : "";
  const result = body.action === "override" ? overrideGate(access.ctx, { judgedId: text(body.judgedId), to: text(body.to), note: text(body.note) })
    : body.action === "not_front" ? dismissFront(access.ctx, text(body.eventId), text(body.note) || undefined)
    : body.action === "setback" ? reportSetback(access.ctx, text(body.text), text(body.line) || undefined)
    : body.action === "goal" ? saveGateGoal(access.ctx, text(body.text))
    : { ok: false as const, code: "GATE_ACTION_UNKNOWN" };
  return NextResponse.json(result, { status: result.ok ? 200 : result.code === "GATE_JUDGEMENT_NOT_FOUND" ? 404 : 400 });
}
