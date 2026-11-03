import { NextResponse } from "next/server";
import type { Ask } from "@crossline/core";
import { answerOpportunityOffer, opportunityOwner } from "../../../../lib/opportunities";
import { writeGuard } from "../../agent/guard";

/**
 * A find decided from the weekly review's 视野外 (docs/opportunity-agent.md §17.3): `{id, option: "plan" | "apply" | "register" |
 * "decline" | "less_kind" | "later"}`, written exactly as the same answer on its offer card. Machine owner only.
 */
const OPTIONS = new Set(["plan", "apply", "register", "decline", "less_kind", "later"]);
export async function POST(request: Request) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  if (!opportunityOwner(guard.ctx)) return NextResponse.json({ ok: false, code: "OPPORTUNITY_NOT_OWNER" }, { status: 403 });
  const { id, option } = guard.body;
  if (typeof id !== "string" || !/^[\w-]{1,80}$/.test(id) || typeof option !== "string" || !OPTIONS.has(option))
    return NextResponse.json({ ok: false, code: "OPPORTUNITY_DECIDE_INVALID" }, { status: 400 });
  const result = answerOpportunityOffer(guard.ctx, { entityId: id } as Ask, option, {});
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
