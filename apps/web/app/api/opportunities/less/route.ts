import { NextResponse } from "next/server";
import { undoLess } from "../../../../lib/opportunities";
import { writeGuard } from "../../agent/guard";

/** Takes one 「少来」 back (`{id}`, docs/opportunity-agent.md §17.4): only what that one changed is put back. Machine owner only. */
export async function POST(request: Request) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const { id } = guard.body;
  if (typeof id !== "string" || !/^less-[\w-]{1,40}$/.test(id)) return NextResponse.json({ ok: false, code: "OPPORTUNITY_LESS_INVALID" }, { status: 400 });
  const undone = undoLess(guard.ctx, id);
  return NextResponse.json(undone, { status: undone.ok ? 200 : undone.code === "OPPORTUNITY_NOT_OWNER" ? 403 : 404 });
}
