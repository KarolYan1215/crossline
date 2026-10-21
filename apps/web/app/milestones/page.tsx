import { SubpageShell } from "../subpage-shell";
import { MilestoneActions } from "./milestone-actions";
import { MilestoneTimeline } from "./milestone-timeline";
import { appNow, ensureSeeded, getStore, milestonesRetiredBySystem } from "../../lib/crossline";
import { loadMilestoneBoard } from "../../lib/milestone-board";
import { requireSessionContext } from "../../lib/access-guard";
import { gateUntilReady } from "../../lib/start-gate";
import { identityLines } from "../../lib/lines";
import { domainRecordViews } from "../../lib/records";
import { LINE_PALETTE } from "@crossline/identity-packs";
import { LinesBar } from "./lines-bar";
import { FirstHint } from "../ui/first-hint";
import { lineCardDetails } from "../../lib/line-cards";
import { timed } from "../../lib/sections";
import { memoByLedgerAsync } from "../../lib/ledger-memo";

export const dynamic = "force-dynamic";

/**
 * 主线 in one screen: the lines side by side on top, then one timeline every line shares, with the week's figures and the page's actions
 * (一键批准, 新建里程碑, 让 AI 重新提议草稿, 已归档) on its header. A milestone opens beside the timeline.
 */
export default async function MilestonesPage() {
  const ctx = await requireSessionContext();
  gateUntilReady(ctx);
  ensureSeeded(ctx);
  // Reused until the ledger changes or a minute passes (`lib/ledger-memo.ts`).
  const board = await timed("milestones.board", () => memoByLedgerAsync(getStore(), `milestoneBoard:${ctx.workspaceId}:${appNow().toISOString().slice(0, 16)}`,
    60_000, () => loadMilestoneBoard(ctx)));
  // Drafts the architect replaced on its own are not shown; what the person archived themselves can be put back.
  const retired = milestonesRetiredBySystem(ctx);
  const archived = getStore().listMilestones(ctx.workspaceId).filter((milestone) => milestone.status === "archived" && !retired.has(milestone.id))
    .map((milestone) => ({ id: milestone.id, identityId: milestone.identityId, projectId: milestone.projectId ?? "", title: milestone.title,
      successCriteria: milestone.successCriteria ?? [], ...(milestone.templateId ? { templateId: milestone.templateId } : {}) }));
  const drafts = board.milestones.filter((milestone) => milestone.status === "draft").length;
  const identities = identityLines(ctx);
  const details = lineCardDetails(ctx);
  const records = Object.fromEntries(domainRecordViews(ctx).filter((view) => view.lineId).map((view) => [view.lineId!, { domain: view.domain, ...view.metrics, trends: view.trends,
    recent: view.recent.map(({ id, kind, at, value, unit, currency, category, source }) => ({ id, kind, at, value, unit, currency, category, source })) }]));

  return <SubpageShell active="主线" title="主线"
    description={drafts ? `${drafts} 个里程碑待批准 · 点开查看风险与标准，或在时间轴右上方一键批准` : "各主线的里程碑排在同一条时间轴上，点开可修改。"}>
    <LinesBar lines={identities.map((pack) => ({ id: pack.id, label: pack.label, color: pack.color ?? pack.id, goals: pack.goals ?? [],
      hard: Boolean(pack.hard), rank: pack.rank ?? null, domain: pack.domain ?? null, records: records[pack.id] ?? null,
      attributes: (details[pack.id]?.attributes ?? []).map(({ text, kind }) => ({ text, kind })), goalParts: details[pack.id]?.goalParts ?? [],
      description: details[pack.id]?.description ?? "", pendingEdit: details[pack.id]?.pendingEdit ? { parts: details[pack.id]!.pendingEdit!.parts } : null,
      redraftDue: details[pack.id]?.redraftDue ?? false,
      interview: details[pack.id]?.interview ?? { reply: "", questions: [], waiting: false, turns: 0 },
      milestones: board.milestones.filter((milestone) => milestone.identityId === pack.id).length,
      drafts: board.milestones.filter((milestone) => milestone.identityId === pack.id && milestone.status === "draft").length }))}
      palette={Object.fromEntries(Object.entries(LINE_PALETTE).map(([key, value]) => [key, value.light]))} />
    <FirstHint id="milestones" title="主线页怎么看">
      <ul className="ui-first-hint-list">
        <li>上方每张卡是一条主线和它的长期目标</li>
        <li>下方共用一条时间轴：菱形是里程碑，落在它的截止日</li>
        <li>空心虚线是系统设计的草稿：点开可改标题、日期、标准和重要性，批准后才倒推成任务；不要的点「撤销草稿」</li>
        <li>同一条线上的弧线是先后顺序；跨线的曲线表示一条线的产出供另一条线使用</li>
      </ul>
    </FirstHint>
    <MilestoneTimeline board={board} actions={<MilestoneActions lines={identities.map((pack) => ({ id: pack.id, label: pack.label }))} archived={archived} />} />
    <p className="muted ms-foot"><a href="/review">本周复盘 →</a></p>
  </SubpageShell>;
}
