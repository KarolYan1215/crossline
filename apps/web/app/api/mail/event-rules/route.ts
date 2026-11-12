import { resolveAccessContext } from "../../../../lib/access-guard";
import { mailEventRules, removeMailEventRule } from "../../../../lib/mail-events";
import { writeGuard } from "../../agent/guard";

/** The person's rules per mail sender for events (2026-11-11): two 不去 cap a sender at optional, 去 to a required one lets it go on the plan. */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return Response.json({ rules: mailEventRules(access.ctx) });
}

/** Deletes one sender's rule (`{ source }`): its next events are tiered from their own structure again. */
export async function DELETE(request: Request) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const source = typeof guard.body.source === "string" ? guard.body.source.trim().toLowerCase() : "";
  if (!source || source.length > 320) return Response.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  return Response.json({ ok: removeMailEventRule(guard.ctx, source) });
}
