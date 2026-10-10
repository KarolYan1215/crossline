import { SubpageShell } from "../subpage-shell";
import { MilestoneActions } from "./milestone-actions";
import { MilestoneStats, MilestoneTimeline } from "./milestone-timeline";
import { ensureSeeded, getStore, milestonesRetiredBySystem } from "../../lib/crossline";
import { loadMilestoneBoard } from "../../lib/milestone-board";
import { requireSessionContext } from "../../lib/access-guard";
import { identityLines } from "../../lib/lines";
import { LINE_PALETTE } from "@crossline/identity-packs";
import { LinesBar } from "./lines-bar";
import { lineCardDetails } from "../../lib/line-cards";

export const dynamic = "force-dynamic";

export default async function MilestonesPage() {
  const ctx = await requireSessionContext();
  ensureSeeded(ctx);
  const board = await loadMilestoneBoard(ctx);
  // Drafts the architect replaced on its own are not shown; what the person archived themselves can be put back.
  const retired = milestonesRetiredBySystem(ctx);
  const archived = getStore().listMilestones(ctx.workspaceId).filter((milestone) => milestone.status === "archived" && !retired.has(milestone.id))
    .map((milestone) => ({ id: milestone.id, identityId: milestone.identityId, projectId: milestone.projectId ?? "", title: milestone.title,
      successCriteria: milestone.successCriteria ?? [], ...(milestone.templateId ? { templateId: milestone.templateId } : {}) }));
  const drafts = board.milestones.filter((milestone) => milestone.status === "draft").length;
  const identities = identityLines(ctx);
  const details = lineCardDetails(ctx);

  return <SubpageShell active="主线" title="主线"
    description={drafts ? `${drafts} 个里程碑草稿待审阅：草稿以虚线显示，可按主线批准或撤销。批准后，三周内到期的里程碑自动倒推出任务。` : "各主线的里程碑按日期排列；刻度为里程碑之前的阶段结果。"}>
    <LinesBar lines={identities.map((pack) => ({ id: pack.id, label: pack.label, color: pack.color ?? pack.id, goals: pack.goals ?? [],
      hard: Boolean(pack.hard), rank: pack.rank ?? null,
      attributes: (details[pack.id]?.attributes ?? []).map(({ text, kind }) => ({ text, kind })), goalParts: details[pack.id]?.goalParts ?? [],
      description: details[pack.id]?.description ?? "", pendingEdit: details[pack.id]?.pendingEdit ? { parts: details[pack.id]!.pendingEdit!.parts } : null,
      redraftDue: details[pack.id]?.redraftDue ?? false,
      interview: details[pack.id]?.interview ?? { reply: "", questions: [], waiting: false, turns: 0 },
      milestones: board.milestones.filter((milestone) => milestone.identityId === pack.id).length }))}
      palette={Object.fromEntries(Object.entries(LINE_PALETTE).map(([key, value]) => [key, value.light]))} />
    <MilestoneActions lines={identities.map((pack) => ({ id: pack.id, label: pack.label }))} archived={archived} />
    <MilestoneStats board={board} />
    <MilestoneTimeline board={board} />
    <p className="muted"><a href="/review">本周复盘 →</a></p>
  </SubpageShell>;
}
