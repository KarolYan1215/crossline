import { ensureSeeded, getStore, loadCurrentPlan, planToday } from "../../lib/crossline";
import { SubpageShell } from "../subpage-shell";
import { FirstHint } from "../ui/first-hint";
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
import { loadAsks } from "../../lib/asks";
import { loadAssistant } from "../../lib/agent";
import { AskBoard } from "../asks/ask-board";
import { loadAskPreviews } from "../asks/previews";
import { uniqueAsks } from "../asks/model";
import { PendingSummary } from "./summary";
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

export default async function ApprovalsPage() {
  const ctx = await requireSessionContext();
  gateUntilReady(ctx);
  ensureSeeded(ctx);
  const locale = localeFor(ctx), t = tFor(locale);
  const plan = await timed("plan.current", () => loadCurrentPlan(ctx));
  const evidenceReviews = getStore().listWorkOrders(ctx.workspaceId).filter((item) => item.state === "evidence_review");
  const { preparingCount, horizon, entersOn, slotOf, week: weekProposals, later: laterProposals } = orderProposals(ctx, plan);
  const claims = getStore().listEvidenceClaims(ctx.workspaceId);
  // A revoked acceptance puts the order back here with the same evidence, and the gate deliberately
  // will not re-judge it on its own — so without the reason on screen the order looks stuck for no
  // stated cause, and the button that would move it looks like it does nothing.
  const revocations = new Map(getStore().listEvents(ctx.workspaceId, { type: "milestone_gate.auto_acceptance_revoked" })
    .map((event) => [event.entityId, String((event.payload as { reason?: string }).reason ?? "")]));
  // The gate's own refusal, last word wins against a later 「现在判定」 retry request. It used to be written
  // to the ledger and the worker log only, so the page said 「等待里程碑闸门」 indefinitely for a verdict
  // that had already come back — with the one thing the person could do about it (write criteria) nowhere.
  const gateBlocks = new Map<string, { code: string; message: string }>();
  for (const event of getStore().listEvents(ctx.workspaceId, { type: ["milestone_gate.blocked", "milestone_gate.retry_requested"] })) {
    if (event.type === "milestone_gate.blocked") gateBlocks.set(event.entityId, event.payload as { code: string; message: string });
    else gateBlocks.delete(event.entityId);
  }
  const pending = await timed("pending", () => countPending(ctx));
  const asks = uniqueAsks(await timed("asks", () => loadAsks(ctx)));
  const weekAsks = asks.filter((ask) => !ask.entersOn), laterAsks = asks.filter((ask) => ask.entersOn);
  // The week's only: what waits under 「以后再定」 is read when that fold is opened (`later.tsx`).
  const previews = await timed("approvals.previews", () => loadAskPreviews(ctx, weekAsks));
  const executions = getStore().listExecutions(ctx.workspaceId);
  const ordersById = new Map(getStore().listWorkOrders(ctx.workspaceId).map((item) => [item.id, item]));
  const deferredOrder = (workOrderId: string) => { const order = ordersById.get(workOrderId); return order ? horizon.orderEntry(order) : undefined; };
  const taskDetails = await timed("approvals.details", () => loadTaskDetailsBatch(ctx, [...evidenceReviews, ...weekProposals].map((item) => item.id)));
  const autoApproved = recentAutoApprovals(ctx);
  // When each decision that can wait comes into the week: asks, proposals, milestone drafts and assistant results — the same four
  // `pending.later` counts.
  const laterDays = [
    ...laterAsks.map((ask) => ask.entersOn!),
    ...laterProposals.map((item) => entersOn.get(item.id)!),
    ...getStore().listMilestones(ctx.workspaceId).filter((item) => item.status === "draft").flatMap((item) => horizon.milestoneEntry(item.id) ?? []),
    ...loadAssistant(ctx).reviews.flatMap((task) => deferredOrder(task.workOrderId) ?? [])
  ];
  const renderProposal = (item: (typeof weekProposals)[number]) => <ProposalItem key={item.id} item={item} detail={taskDetails.get(item.id)}
    slot={slotOf.get(item.id)} enters={entersOn.get(item.id)} locale={locale} />;
  const autoItem = (item: (typeof autoApproved)[number]) => <li key={item.id}>
    <a href={`/workbench/${encodeURIComponent(item.id)}`} title={item.intent}>{item.title}</a>
    {item.undoable ? <RevokeAutoApprovalButton workOrderId={item.id} /> : <small> · {t("已开始做")}</small>}
  </li>;
  const assistantCount = pending.assistantKinds + pending.assistantQuestions + pending.assistantReviews;
  // Drafts, targets and interview items are decided where they live (主线, 访谈); here they are counted and linked. What is decided here
  // is laid out below: the week's questions in four quadrants, then the assistant's results, evidence and task proposals.
  // The two live counts sit inside one translated sentence (docs/i18n.md): it is split around their marks, which come in this order in
  // both languages.
  const sentence = pending.later.total
    ? t("本周 {{total}} 项待确认，其中待决事项 {{asks}} 项；另有 {{later}} 项以后再定，不计入。只有需本人选择、授权登录或涉及对外动作的才需确认，其余自动生效，24 小时内可撤销。", { total: "\u0000", asks: "\u0001", later: pending.later.total })
    : t("本周 {{total}} 项待确认，其中待决事项 {{asks}} 项。只有需本人选择、授权登录或涉及对外动作的才需确认，其余自动生效，24 小时内可撤销。", { total: "\u0000", asks: "\u0001" });
  const [head = "", rest = ""] = sentence.split("\u0000");
  const [middle = "", tail = ""] = rest.split("\u0001");
  return <SubpageShell active={"待确认"} title={t("待确认")}
    description={<>{head}<LivePendingCount initial={pending.total} />{middle}<LivePendingCount initial={pending.asks} field="asks" />{tail}</>}>
    <PendingSummary later={laterDays} today={planToday(ctx)} locale={locale}
      here={[{ label: t("助手"), count: assistantCount, href: "#assistant" }, { label: t("待验收"), count: evidenceReviews.length, href: "#evidence" },
        { label: t("任务提案"), count: pending.workOrders, href: "#proposals" }, { label: t("最近自动生效"), count: autoApproved.length, href: "#auto" }]}
      elsewhere={[{ label: t("里程碑草稿"), count: pending.milestoneDrafts, href: "/milestones" }, { label: t("分数线待审阅"), count: pending.targets, href: "/milestones" },
        { label: t("调研建议"), count: pending.research, href: "/review" }, { label: t("文件中的日期"), count: pending.dates, href: "/onboarding" },
        { label: t("访谈问题"), count: pending.questions, href: "/onboarding" }]} />
    <FirstHint id="approvals" title={t("四个格子怎么排")}>
      <ul className="ui-first-hint-list">
        <li>{t("按「紧急」和「重要」分进四格，先处理「紧急重要」")}</li>
        <li>{t("紧急：两天内不定就会误事；重要：关系到权重高的里程碑或开始使用的基本信息")}</li>
        <li>{t("每格一次摊开一张，答完下一张自动顶上来，也可以「明天再问」")}</li>
      </ul>
    </FirstHint>
    <AskBoard initial={weekAsks} previews={previews} />
    <AssistantReview ctx={ctx} deferred={deferredOrder} body={(taskId) => <LazyRegion load={assistantResult.bind(null, taskId)} minHeight={160} />} />
    {evidenceReviews.length > 0 && <section className="approval-ledger" id="evidence" aria-label={t("待验收")}>
      <h2>{t("待验收 · {{count}}", { count: evidenceReviews.length })}</h2>
      {evidenceReviews.map((item) => {
        const own = claims.filter((claim) => claim.workOrderId === item.id && claim.reviewStatus === "submitted");
        const execution = executions.filter((entry) => entry.workOrderId === item.id).at(-1);
        return <article key={item.id}>
          <a href={`/workbench/${encodeURIComponent(item.id)}`}><strong>{item.intent}</strong></a>
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
    {weekProposals.length > 0 && <ProposalBatchForm count={weekProposals.length}>
      <section className="work-order-list" id="proposals">{weekProposals.map(renderProposal)}</section>
    </ProposalBatchForm>}
    {permissionModeEnabled(ctx) && <PermissionModePanel initialCandidates={permissionCandidates(ctx).filter((item) => item.kind !== "insight")} />}
    {autoApproved.length > 0 && <section className="pending-block ap-auto" id="auto" aria-label={t("最近自动生效")}>
      <h2>{t("最近自动生效 · {{count}}", { count: autoApproved.length })}</h2>
      <p className="review-note">{t("无需本人决定、不对外的任务已自动生效；24 小时内可撤销，撤销后回到提案。")}</p>
      {/* The newest few in view; the rest folded, so a busy day does not turn the section into a page-long list. */}
      <ul>{autoApproved.slice(0, AUTO_SHOWN).map(autoItem)}</ul>
      {autoApproved.length > AUTO_SHOWN && <details className="fold advanced"><summary>{t("其余 {{count}} 项", { count: autoApproved.length - AUTO_SHOWN })}</summary>
        <ul>{autoApproved.slice(AUTO_SHOWN).map(autoItem)}</ul></details>}
    </section>}
    {pending.later.total > 0 && <details className="fold advanced" id="later">
      {/* The same total as the line on top; the assistant's results it counts are listed in their own section. */}
      <summary>{t("以后再定 · {{count}} 项（工作一周后才需开始，到时自动列入本周）", { count: pending.later.total })}</summary>
      {/* Read when opened (`later.tsx`): it was a sixth of the page and few visits open it. */}
      <LazyRegion load={laterApprovals} when="open" />
    </details>}
  </SubpageShell>;
}
