import { NextResponse } from "next/server";
import { addWatch, changeWatch } from "../../../../lib/opportunities";
import { writeGuard } from "../../agent/guard";

/** A watch id as the ledger writes them (`need:<line>:<key>`, `explore:…`, `person:…`). */
const watchId = (value: unknown): value is string => typeof value === "string" && /^[\w:.-]{1,200}$/.test(value);

/**
 * The person's hand on the opportunity agent's watches (docs/opportunity-agent.md §17.9), machine owner only: `{action: "add", lineId,
 * title, query, everyDays?}` adds one of their own; `{action: "decide", id, decision: "active" | "retired", note?}` answers a proposal;
 * `{action: "state", id, state: "active" | "paused" | "retired"}` pauses, turns off or restores; `{action: "edit", id, title?, query?,
 * judge?, everyDays?}` changes it, which makes it the person's (never retired by the system).
 */
export async function POST(request: Request) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const { action, id } = guard.body;
  if (action === "add") {
    const added = addWatch(guard.ctx, guard.body);
    return NextResponse.json(added, { status: added.ok ? 200 : added.code === "OPPORTUNITY_NOT_OWNER" ? 403 : 400 });
  }
  if (!watchId(id)) return NextResponse.json({ ok: false, code: "OPPORTUNITY_WATCH_INVALID" }, { status: 400 });
  const changed = changeWatch(guard.ctx, id, guard.body);
  return NextResponse.json(changed, { status: changed.ok ? 200 : changed.code === "OPPORTUNITY_NOT_OWNER" ? 403 : changed.code === "OPPORTUNITY_WATCH_NOT_FOUND" ? 404 : 400 });
}
