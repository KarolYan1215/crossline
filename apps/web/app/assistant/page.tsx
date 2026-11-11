import { requireSessionContext } from "../../lib/access-guard";
import { gateUntilReady } from "../../lib/start-gate";
import { tOf } from "../../lib/locale";
import { listThreads } from "../../lib/threads";
import { SubpageShell } from "../subpage-shell";
import { AssistantThreads } from "./assistant-threads";

export const dynamic = "force-dynamic";

/**
 * 小帮手's own page (2026-11-10, the owner: a Codex with Crossline's tools and cards): the thread list beside one thread, each turn
 * showing the lookups it made. Today's conversation is the default thread — the one Today's box and the floating 小帮手 write to.
 * `?thread=<id>` opens another one. (From 2026-10-07 until now this address only redirected to 待确认 or 设置.)
 */
export default async function AssistantPage({ searchParams }: { searchParams: Promise<{ thread?: string }> }) {
  const ctx = await requireSessionContext();
  gateUntilReady(ctx);
  const { thread } = await searchParams;
  const t = tOf(ctx);
  const threads = listThreads(ctx);
  const open = thread && /^[a-zA-Z0-9_-]{1,80}$/.test(thread) ? thread : threads[0]!.id;
  return <SubpageShell title={t("小帮手")} serif description={t("用一句话让 Crossline 查、改、安排；每一步查了什么都看得到，改动先确认、可撤销。")}>
    <AssistantThreads initial={threads} open={open} />
  </SubpageShell>;
}
