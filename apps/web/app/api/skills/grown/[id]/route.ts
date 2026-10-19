import { NextResponse } from "next/server";
import { allowScripts, changeGrownSkill, grownSkillAction } from "../../../../../lib/skill-library";
import { writeGuard, validId } from "../../../agent/guard";

/**
 * A grown workflow, changed by the person: `{status: "active" | "off"}` turns it on or off, `{pinned}` keeps it from idle removal,
 * `{action: "consent"}` accepts the risks of one that reads an account, `{action: "login", service}` opens a window to log in with and
 * `{action: "run"}` starts it now; `{action: "allow_scripts" | "disallow_scripts"}` allows the scripts the checks capped to text, or takes it back.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const { id } = await context.params;
  if (!validId(id)) return NextResponse.json({ ok: false, code: "INVALID_SKILL" }, { status: 400 });
  const { status, pinned, action, service } = guard.body;
  if (action === "allow_scripts" || action === "disallow_scripts") {
    const result = allowScripts(guard.ctx, "grown", id, action === "allow_scripts");
    return NextResponse.json(result, { status: result.ok ? 200 : 409 });
  }
  if (action === "consent") {
    const result = changeGrownSkill(guard.ctx, id, "consent");
    return NextResponse.json(result, { status: result.ok ? 200 : 409 });
  }
  if (action === "login" || action === "login_done" || action === "run") {
    if (action !== "run" && (typeof service !== "string" || !service.trim() || service.length > 40)) return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
    const result = await grownSkillAction(guard.ctx, id, action, typeof service === "string" ? service : "");
    return NextResponse.json(result, { status: result.ok ? 200 : 409 });
  }
  if ((status !== undefined && status !== "active" && status !== "off") || (pinned !== undefined && typeof pinned !== "boolean") || (status === undefined && pinned === undefined)) {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  }
  const result = changeGrownSkill(guard.ctx, id, { ...(status ? { status } : {}), ...(typeof pinned === "boolean" ? { pinned } : {}) });
  return NextResponse.json(result, { status: result.ok ? 200 : 404 });
}

/** Removes a grown workflow at the person's word (`skill.grown.removed`, by the person). */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const { id } = await context.params;
  if (!validId(id)) return NextResponse.json({ ok: false, code: "INVALID_SKILL" }, { status: 400 });
  const result = changeGrownSkill(guard.ctx, id, "remove");
  return NextResponse.json(result, { status: result.ok ? 200 : 404 });
}
