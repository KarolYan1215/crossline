import type { AccessContext } from "@crossline/core";
import { loadCurrentPlan } from "../../lib/crossline";
import { loadTaskDetailsBatch } from "../../lib/task-detail";
import { countPending } from "../../lib/pending";
import { loadAsks } from "../../lib/asks";
import { localeFor } from "../../lib/locale";
import { tFor } from "../../lib/i18n";
import { AskList } from "../ask-list";
import { loadAskPreviews } from "../asks/previews";
import { uniqueAsks } from "../asks/model";
import { ProposalBatchForm } from "./approval-actions";
import { ProposalItem, orderProposals } from "./proposals";

/**
 * What 「以后再定」 holds on 待确认: the decisions whose work need not start within a week. Folded by default and read when it is opened
 * (2026-10-28, `LazyRegion` + `laterApprovals` in actions.tsx), since it was a sixth of the page and few visits open it.
 */
export async function LaterApprovals({ ctx }: { ctx: AccessContext }) {
  const locale = localeFor(ctx), t = tFor(locale);
  const pending = countPending(ctx);
  const laterAsks = uniqueAsks(await loadAsks(ctx)).filter((ask) => ask.entersOn);
  const previews = loadAskPreviews(ctx, laterAsks);
  const { later, entersOn, slotOf } = orderProposals(ctx, await loadCurrentPlan(ctx));
  const details = loadTaskDetailsBatch(ctx, later.map((item) => item.id));
  return <>
    <AskList initial={laterAsks} scope="later" heading={t("以后再定的待决事项")} previews={previews} />
    {pending.later.assistantReviews > 0 && <p><a href="#assistant">{t("{{count}} 份助手成果", { count: pending.later.assistantReviews })}</a>{t("在「助手」一节，对应任务一周后才需开始。")}</p>}
    {pending.later.milestoneDrafts > 0 && <p><a href="/milestones">{t("{{count}} 个里程碑草稿", { count: pending.later.milestoneDrafts })}</a>{t("在主线页，截止较远。")}</p>}
    {later.length > 0 && <ProposalBatchForm count={later.length}>
      <section className="work-order-list">{later.map((item) => <ProposalItem key={item.id} item={item} detail={details.get(item.id)}
        slot={slotOf.get(item.id)} enters={entersOn.get(item.id)} locale={locale} />)}</section>
    </ProposalBatchForm>}
  </>;
}
