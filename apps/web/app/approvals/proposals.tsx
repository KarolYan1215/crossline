import { onPersonsBoard, type AccessContext } from "@crossline/core";
import { getStore, type loadCurrentPlan } from "../../lib/crossline";
import { preparingProposalIds } from "../../lib/proposal-ready";
import { decisionHorizon } from "../../lib/horizon";
import { cardView, type TaskDetail } from "../../lib/task-detail";
import { tFor, type Locale } from "../../lib/i18n";
import { TaskCard } from "../task/task-card";
import { entryDay } from "../task/format";

type Order = ReturnType<ReturnType<typeof getStore>["listWorkOrders"]>[number];
type Slot = { day: string; start: string; end: string };

/**
 * The task proposals on 待确认, in the order they are decided: soonest milestone deadline first; those whose work need not start within a
 * week wait under 「以后再定」, the soonest to come up first, and come into the week's list by themselves (`lib/horizon.ts`). A proposal
 * whose steps are still being planned is not a decision yet (`preparingProposalIds`), and questions to the person waiting as orders are
 * asked, not approved (docs/work-split.md). Shared by the page and by its 「以后再定」 fold, which is read when it is opened (`later.tsx`).
 */
export function orderProposals(ctx: AccessContext, plan: Awaited<ReturnType<typeof loadCurrentPlan>>) {
  const preparing = preparingProposalIds(ctx);
  const waiting = getStore().listWorkOrders(ctx.workspaceId).filter((item) => item.state === "awaiting_plan_approval" && onPersonsBoard(item));
  const proposals = waiting.filter((item) => !preparing.has(item.id));
  const horizon = decisionHorizon(ctx);
  const anchors = new Map(getStore().listMilestoneAnchors(ctx.workspaceId).map((anchor) => [anchor.milestoneId, anchor]));
  const deadlineOf = (milestoneId: string) => anchors.get(milestoneId)?.deadline ?? "9999-12-31";
  const sorted = [...proposals].sort((a, b) => deadlineOf(a.milestoneId).localeCompare(deadlineOf(b.milestoneId)));
  const entersOn = new Map(sorted.map((item) => [item.id, horizon.orderEntry(item)]));
  // The earliest suggested block per proposal (a split task has several; the first is when it would start).
  const slotOf = new Map<string, Slot>();
  for (const block of [...plan.blocks].filter((item) => item.id.startsWith("proposed:") && item.day)
    .sort((a, b) => `${a.day} ${a.start}`.localeCompare(`${b.day} ${b.start}`))) {
    const id = block.id.split(":")[1]!;
    if (!slotOf.has(id)) slotOf.set(id, { day: block.day!, start: block.start, end: block.end });
  }
  return {
    proposals, preparingCount: waiting.length - proposals.length, horizon, entersOn, slotOf,
    week: sorted.filter((item) => !entersOn.get(item.id)),
    later: sorted.filter((item) => entersOn.get(item.id)).sort((a, b) => entersOn.get(a.id)!.localeCompare(entersOn.get(b.id)!))
  };
}

/** One proposal: its tick for the batch approval, its card, and the day it comes into the week when it can wait. */
export function ProposalItem({ item, detail, slot, enters, locale }: { item: Order; detail: TaskDetail | undefined; slot: Slot | undefined; enters: string | undefined; locale: Locale }) {
  if (!detail) return null;
  const t = tFor(locale);
  return <div className="proposal-item">
    <label className="proposal-check"><input type="checkbox" name="proposal" value={item.id} defaultChecked /><span className="sr-only">{t("选中「{{title}}」", { title: item.intent })}</span></label>
    <TaskCard detail={cardView(detail)} slot={slot} />
    {enters && <small className="proposal-enters">{t("{{day}} 起列入本周", { day: entryDay(locale, enters) })}</small>}
  </div>;
}
