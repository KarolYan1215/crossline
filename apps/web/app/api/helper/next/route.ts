import { NextResponse } from "next/server";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { loadTimeline } from "../../../../lib/timeline";
import { minuteInZone } from "../../../timeline/model";
import { nextBlock } from "../../../timeline/panel-model";

export const dynamic = "force-dynamic";

/**
 * The next block of work today, for the desktop 小帮手's 「开始下一项计时」 (helper-desk.tsx): the same reading as Today's day panel
 * (`nextBlock`), read only when the person opens that menu. Read-only; starting goes through the task's own execution route.
 */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const timeline = await loadTimeline(access.ctx);
  const item = nextBlock(timeline.items, timeline.today, timeline.today, minuteInZone(timeline.nowIso, timeline.timeZone));
  const next = item?.workOrderId ? {
    id: item.id, day: item.day, start: item.start, end: item.end, kind: item.kind, workOrderId: item.workOrderId,
    title: item.task ?? item.title, ...(item.step ? { step: item.step } : {}), ...(item.missed ? { missed: true } : {})
  } : null;
  return NextResponse.json({ ok: true, next }, { headers: { "cache-control": "no-store" } });
}
