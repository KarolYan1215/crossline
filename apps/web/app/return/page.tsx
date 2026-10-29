import { redirect } from "next/navigation";
import { SubpageShell } from "../subpage-shell";
import { requireSessionContext } from "../../lib/access-guard";
import { gateUntilReady } from "../../lib/start-gate";
import { appNow, getStore } from "../../lib/crossline";
import { cleanStale, returnDue, returnView } from "../../lib/return";
import { withUndo } from "../../lib/undo";
import { loadConversation } from "../../lib/conversation";
import { ensureOpener } from "../../lib/nudges";
import { ReturnPanel } from "./return-panel";
import "./return.css";
import { tOf } from "../../lib/locale";

export const dynamic = "force-dynamic";

/**
 * Coming back after days away (docs/review-2026-10-13.md §6.3): what happened meanwhile, the work that was due settled one tap each,
 * the input box for anything else, and what nobody touched for fourteen days already archived — undoable from the page.
 */
export default async function ReturnPage() {
  const ctx = await requireSessionContext();
  gateUntilReady(ctx);
  const now = appNow();
  const due = returnDue(ctx, now);
  const store = getStore();
  const since = due?.since ?? store.lastPersonActivity(ctx.workspaceId) ?? store.listWorkspaces().find((item) => item.id === ctx.workspaceId)?.createdAt;
  if (!since) redirect("/");
  const t = tOf(ctx);
  const before = returnView(ctx, since, now, due?.until);
  const cleaned = before.stale.orders.length || before.stale.milestones.length
    ? await withUndo(ctx, t("归档超过 14 天无人处理的 {{count}} 项", { count: before.stale.orders.length + before.stale.milestones.length }), () => cleanStale(ctx, now))
    : undefined;
  const view = cleaned ? returnView(ctx, since, now, due?.until) : before;
  // Today at the top, drawn the way Today's conversation draws it (written here when this is the day's first page).
  await ensureOpener(ctx, now).catch(() => false);
  const opener = loadConversation(ctx).messages.find((message) => message.card?.nudgeKind === "opener");
  return <SubpageShell active={"今日"} title={t("欢迎回来")} serif>
    <ReturnPanel view={view} opener={opener} cleaned={cleaned ? { orders: before.stale.orders, milestones: before.stale.milestones, opId: cleaned.op?.id } : undefined} />
  </SubpageShell>;
}
