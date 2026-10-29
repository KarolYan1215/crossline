import { ensureSeeded, getStore, loadCurrentPlan, planToday } from "../../lib/crossline";
import { AppShell } from "../app-shell";
import { LazyRegion } from "../ui/lazy-region";
import { AcceptEvidenceButton, JudgeMilestoneButton, ProposalBatchForm, RevokeAutoApprovalButton } from "./approval-actions";
import { AssistantReview } from "./assistant-review";
import { assistantResult, laterApprovals } from "./actions";
import { ProposalItem, orderProposals } from "./proposals";
import { recentAutoApprovals } from "../../lib/approvals";
import { permissionCandidates, permissionModeEnabled } from "../../lib/permission-mode";
import { PermissionModePanel } from "./permission-mode-panel";
import { requireSessionContext } from "../../lib/access-guard";
import { gateUntilReady } from "../../lib/start-gate";
import { loadTaskDetailsBatch } from "../../lib/task-detail";
import { countPending } from "../../lib/pending";
import { LivePendingCount } from "../pending-badge";
import { AnswerAll } from "../asks/answer-all";
import { loadAsks } from "../../lib/asks";
import { loadAssistant } from "../../lib/agent";
import { AskBoard } from "../asks/ask-board";
import { loadAskPreviews } from "../asks/previews";
import { uniqueAsks } from "../asks/model";
import { ElsewhereCard, LaterLink } from "./summary";
import { clearMinutes } from "./estimate";
import "./approvals.css";
import { timed } from "../../lib/sections";
import { localeFor } from "../../lib/locale";
import { tFor } from "../../lib/i18n";
import { punct } from "../task/format";

export const dynamic = "force-dynamic";

/** What each kind of evidence claim is called. */
const CLAIM_KIND: Record<string, string> = { file: "文件", link: "链接", record: "记录", telemetry: "遥测" };

/** How many of the last day's automatic approvals are listed before the rest fold. */
const AUTO_SHOWN = 5;

/**
 * 待确认 (2026-10-29, docs/plans/page-drafts-1028/approvals.html): its job is to be cleared fast. The head says how much this week holds and
 * about how long it takes, with 「全部按推荐」 beside it. Three columns: on the left the four quadrants and the kinds (each narrows the deck),
 * the keys, the decisions that can wait and what is decided elsewhere; in the middle one question at a time; on the right what is
 * handled in batches — the assistant's results, evidence to judge, task proposals, and the last day's automatic approvals with their undo.
 * On a phone the columns stack in that order of use (approvals-mobile.html).
 */
export default async function ApprovalsPage() {
  const ctx = await requireSessionContext();
  gateUntilReady(ctx);
  ensureSeeded(ctx);
  const locale = localeFor(ctx), t = tFor(locale);
  const store = getStore();
  const plan = await timed("plan.current", () => loadCurrentPlan(ctx));
  const evidenceReviews = store.listWorkOrders(ctx.workspaceId).filter((item) => item.state === "evidence_review");
  const { preparingCount, horizon, entersOn, slotOf, week: weekProposals, later: laterProposals } = orderProposals(ctx, plan);
  const claims = store.listEvidenceClaims(ctx.workspaceId);
  // A revoked acceptance puts the order back here with the same evidence, and the gate deliberately
  // will not re-judge it on its own — so without the reason on screen the order looks stuck for no
  // stated cause, and the button that would move it looks like it does nothing.
  const revocations = new Map(store.listEvents(ctx.workspaceId, { type: "milestone_gate.auto_acceptance_revoked" })
    .map((event) => [event.entityId, String((event.payload as { reason?: string }).reason ?? "")]));
  // The gate's own refusal, last word wins against a later 「现在判定」 retry request. It used to be written
  // to the ledger and the worker log only, so the page said 「等待里程碑闸门」 indefinitely for a verdict
  // that had already come back — with the one thing the person could do about it (write criteria) nowhere.
  const gateBlocks = new Map<string, { code: string; message: string }>();
  for (const event of store.listEvents(ctx.workspaceId, { type: ["milestone_gate.blocked", "milestone_gate.retry_requested"] })) {
    if (event.type === "milestone_gate.blocked") gateBlocks.set(event.entityId, event.payload as { code: string; message: string });
    else gateBlocks.delete(event.entityId);
  }
  const pending = await timed("pending", () => countPending(ctx));
  const asks = uniqueAsks(await timed("asks", () => loadAsks(ctx)));
  const weekAsks = asks.filter((ask) => !ask.entersOn), laterAsks = asks.filter((ask) => ask.entersOn);
  // The week's only: what waits under 「以后再定」 is read when that fold is opened (`later.tsx`).
  const previews = await timed("approvals.previews", () => loadAskPreviews(ctx, weekAsks));
  const executions = store.listExecutions(ctx.workspaceId);
  const ordersById = new Map(store.listWorkOrders(ctx.workspaceId).map((item) => [item.id, item]));
  const deferredOrder = (workOrderId: string) => { const order = ordersById.get(workOrderId); return order ? horizon.orderEntry(order) : undefined; };
  const taskDetails = await timed("approvals.details", () => loadTaskDetailsBatch(ctx, [...evidenceReviews, ...weekProposals].map((item) => item.id)));
  const autoApproved = recentAutoApprovals(ctx);
  // When each decision that can wait comes into the week: asks, proposals, milestone drafts and assistant results — the same four
  // `pending.later` counts.
  const laterDays = [
    ...laterAsks.map((ask) => ask.entersOn!),
    ...laterProposals.map((item) => entersOn.get(item.id)!),
    ...store.listMilestones(ctx.workspaceId).filter((item) => item.status === "draft").flatMap((item) => horizon.milestoneEntry(item.id) ?? []),
    ...loadAssistant(ctx).reviews.flatMap((task) => deferredOrder(task.workOrderId) ?? [])
  ];
  // What the person's own timed answers took, for the head's estimate.
  const timedAnswers = store.listEvents(ctx.workspaceId, { type: ["ask.answered", "ask.snoozed"] })
    .map((event) => Number((event.payload as { seconds?: unknown }).seconds)).filter((value) => Number.isFinite(value) && value > 0);
  const minutes = clearMinutes({ asks: pending.asks, workOrders: pending.workOrders, evidence: evidenceReviews.length,
    assistantReviews: pending.assistantReviews, assistantOther: pending.assistantKinds + pending.assistantQuestions }, timedAnswers);
  const renderProposal = (item: (typeof weekProposals)[number]) => <ProposalItem key={item.id} item={item} detail={taskDetails.get(item.id)}
    slot={slotOf.get(item.id)} enters={entersOn.get(item.id)} locale={locale} />;
  const autoItem = (item: (typeof autoApproved)[number]) => <li key={item.id}>
    <a href={`/workbench/${encodeURIComponent(item.id)}`} title={item.intent}>{item.title}</a>
    {item.undoable ? <RevokeAutoApprovalButton workOrderId={item.id} /> : <small> · {t("已开始做")}</small>}
  </li>;
  // One translated sentence with the live count in it (docs/i18n.md): split around its mark.
  const [head = "", tail = ""] = (pending.later.total
    ? t("本周 {{total}} 项 · 预计 {{minutes}} 分钟 · 以后再定 {{later}} 项", { total: "\u0000", minutes, later: pending.later.total })
    : t("本周 {{total}} 项 · 预计 {{minutes}} 分钟", { total: "\u0000", minutes })).split("\u0000");

  return <AppShell active={"待确认"} className="subpage ap-page"><div className="subpage-inner">
    <header className="subpage-header ap-head">
      <div><h1>{t("待确认")}</h1>
        <p className="muted">{head}<LivePendingCount initial={pending.total} />{tail}<span className="ap-head-rule"> · {t("只有本人选择、授权或对外动作才在这里，其余自动生效，24 小时内可撤销")}</span></p></div>
      <AnswerAll head />
    </header>
    <div className="ap-grid">
      <AskBoard initial={weekAsks} previews={previews} aside={<>
        <LaterLink later={laterDays} today={planToday(ctx)} />
        <ElsewhereCard items={[
          { label: t("访谈还有 {{count}} 题", { count: pending.questions }), count: pending.questions, href: "/onboarding", go: t("继续访谈") },
          { label: t("里程碑草稿"), count: pending.milestoneDrafts, href: "/milestones", go: t("去主线") },
          { label: t("分数线待审阅"), count: pending.targets, href: "/milestones", go: t("去主线") },
          { label: t("文件中的日期"), count: pending.dates, href: "/onboarding", go: t("去访谈") },
          { label: t("调研建议"), count: pending.research, href: "/review", go: t("去周复盘") },
          { label: t("候选关系"), count: pending.relations, href: "/review", go: t("去周复盘") }]} />
      </>} />

      <aside className="ap-right" aria-label={t("可批量处理的")}>
        <AssistantReview ctx={ctx} deferred={deferredOrder} compact body={(taskId) => <LazyRegion load={assistantResult.bind(null, taskId)} minHeight={160} />} />
        {evidenceReviews.length > 0 && <section className="ap-card approval-ledger" id="evidence" aria-label={t("待验收")}>
          <h2 className="ap-card-title">{t("待验收 · {{count}}", { count: evidenceReviews.length })}</h2>
          {evidenceReviews.map((item) => {
            const own = claims.filter((claim) => claim.workOrderId === item.id && claim.reviewStatus === "submitted");
            const execution = executions.filter((entry) => entry.workOrderId === item.id).at(-1);
            return <article key={item.id}>
              <a href={`/workbench/${encodeURIComponent(item.id)}`}><strong>{taskDetails.get(item.id)?.title ?? item.intent}</strong></a>
              <p>
                {own.length ? own.map((claim) => {
                  const kind = CLAIM_KIND[claim.kind];
                  return `${kind ? t(kind) : claim.kind} · ${claim.description}${claim.kind === "file" ? "" : ` · ${claim.uri}`}`;
                }).join(punct(locale, "；")) : t("本次提交没有证据声明")}
                {" · "}{execution?.durationObserved
                  ? t("实际执行记录：被中断 {{count}} 分钟", { count: execution.pauseMinutes })
                  : t("时长未观测")}
              </p>
              {item.milestoneId
                ? <>
                    {gateBlocks.has(item.id)
                      ? <p role="alert"><strong>{t("闸门没有判定这份证据")}</strong> · {gateBlocks.get(item.id)!.message}
                      </p>
                      : <p><strong>{t("等待里程碑闸门")}</strong> · {t("闸门判这份证据是否兑现了本任务的交付承诺；里程碑整体是否达成另行记录。")}</p>}
                    {revocations.has(item.id) && <p role="status">
                      {t("验收已撤销，原因：{{reason}}。同一份证据不会自动重判；补充后点「现在判定」。", { reason: revocations.get(item.id) })}
                    </p>}
                    <JudgeMilestoneButton workOrderId={item.id} />
                  </>
                : <AcceptEvidenceButton workOrderId={item.id} />}</article>;
          })}
        </section>}
        {preparingCount > 0 && <p className="ap-preparing" role="status">{t("{{count}} 项提案正在规划步骤，规划完成后列在这里。", { count: preparingCount })}</p>}
        {weekProposals.length > 0 && <section className="ap-card ap-proposals" aria-label={t("任务提案")}>
          <ProposalBatchForm count={weekProposals.length}>
            <div className="work-order-list" id="proposals">{weekProposals.map(renderProposal)}</div>
          </ProposalBatchForm>
        </section>}
        {permissionModeEnabled(ctx) && <PermissionModePanel initialCandidates={permissionCandidates(ctx).filter((item) => item.kind !== "insight")} />}
        {autoApproved.length > 0 && <section className="ap-card ap-auto" id="auto" aria-label={t("最近自动生效")}>
          <h2 className="ap-card-title">{t("最近自动生效 · {{count}}", { count: autoApproved.length })}<small>{t("24 小时内可撤销")}</small></h2>
          {/* The newest few in view; the rest folded, so a busy day does not turn the section into a page-long list. */}
          <ul>{autoApproved.slice(0, AUTO_SHOWN).map(autoItem)}</ul>
          {autoApproved.length > AUTO_SHOWN && <details className="fold advanced"><summary>{t("其余 {{count}} 项", { count: autoApproved.length - AUTO_SHOWN })}</summary>
            <ul>{autoApproved.slice(AUTO_SHOWN).map(autoItem)}</ul></details>}
        </section>}
      </aside>
    </div>
    {pending.later.total > 0 && <details className="fold advanced ap-later-fold" id="later">
      {/* The same total as the head's; the assistant's results it counts are listed in their own section. */}
      <summary>{t("以后再定 · {{count}} 项（工作一周后才需开始，到时自动列入本周）", { count: pending.later.total })}</summary>
      {/* Read when opened (`later.tsx`): it was a sixth of the page and few visits open it. */}
      <LazyRegion load={laterApprovals} when="open" />
    </details>}
  </div></AppShell>;
}
