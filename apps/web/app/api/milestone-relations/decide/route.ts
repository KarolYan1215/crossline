import { NextResponse } from "next/server";
import { decideMilestoneRelations } from "../../../../lib/crossline";

/**
 * Batch approve or archive candidate milestone relations.
 *
 * `archived` rather than `refuted` for a rejection: the user declining a suggestion is not the same as
 * evidence contradicting it, and `refuted` is reserved for the latter — it is what the milestone gate
 * writes when submitted evidence actually disproves a relation.
 */
export async function POST(request: Request) {
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ ok: false, code: "INVALID_JSON" }, { status: 400 }); }
  const { ids, decision } = (body ?? {}) as { ids?: unknown; decision?: unknown };
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
    return NextResponse.json({ ok: false, code: "INVALID_RELATION_IDS" }, { status: 400 });
  }
  if (decision !== "approved" && decision !== "archived") {
    return NextResponse.json({ ok: false, code: "INVALID_DECISION" }, { status: 400 });
  }
  const result = decideMilestoneRelations(ids as string[], decision);
  if (!result.ok) return NextResponse.json(result, { status: 400 });
  return NextResponse.json(result);
}
