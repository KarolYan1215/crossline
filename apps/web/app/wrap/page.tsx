import { AppShell } from "../app-shell";
import { requireSessionContext } from "../../lib/access-guard";
import { gateUntilReady } from "../../lib/start-gate";
import { loadWrap, wrapDayOf } from "../../lib/wrap";
import { loadTimeline } from "../../lib/timeline";
import { linePacks } from "../../lib/lines";
import { WrapBoard, type NextDayBlock } from "./wrap-board";
import "../rituals.css";

export const dynamic = "force-dynamic";

const plusDay = (day: string) => new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/**
 * The evening wrap-up (docs/rituals.md). Scene: the last available hours are over — the person records what each block that started
 * came to (完成 / 部分 / 没做), settles the day's decisions with a safe default, sees tomorrow's first blocks and presses 「收工」.
 * `?day=YYYY-MM-DD` opens one of the last seven days instead (Today's 「昨天没开始 → 逐个处理」): the same rows, written the same way.
 */
export default async function WrapPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const ctx = await requireSessionContext();
  gateUntilReady(ctx);
  const requested = (await searchParams).day;
  const day = wrapDayOf(ctx, typeof requested === "string" ? requested : undefined);
  const view = loadWrap(ctx, undefined, day);
  const labels = Object.fromEntries(linePacks(ctx, { includeArchived: true }).map((pack) => [pack.id, pack.label]));
  // Tomorrow's first work, the wrap-up's landing: only for today (an earlier day is caught up on, not ended).
  let tomorrow: NextDayBlock[] = [];
  if (view.today) {
    const timeline = await loadTimeline(ctx);
    const next = plusDay(timeline.today);
    tomorrow = timeline.items.filter((item) => item.day === next && item.kind === "scheduled" && item.workOrderId)
      .sort((a, b) => a.start.localeCompare(b.start)).slice(0, 3)
      .map((item) => ({ start: item.start, title: item.task ?? item.title, ...(item.step ? { step: item.step } : {}), ...(item.identityId ? { line: item.identityId } : {}) }));
  }
  return <AppShell active={"收工"} className="subpage rd-page"><div className="rd-inner">
    <WrapBoard view={view} labels={labels} tomorrow={tomorrow} />
  </div></AppShell>;
}
