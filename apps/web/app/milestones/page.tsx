import { profileFactId } from "@crossline/core";
import { defaultIdentityPacks } from "@crossline/identity-packs";
import { SubpageShell } from "../subpage-shell";
import { MilestoneAdmin, type AdminMilestone } from "./milestone-admin";
import { MilestoneStats, MilestoneTimeline } from "./milestone-timeline";
import { ensureSeeded, getStore, milestonesRetiredBySystem } from "../../lib/crossline";
import { loadMilestoneBoard } from "../../lib/milestone-board";
import { requireSessionContext } from "../../lib/access-guard";
import { MilestonePreview } from "../task-preview";
import { loadMilestoneDetailsBatch } from "../../lib/task-detail";

export const dynamic = "force-dynamic";

export default async function MilestonesPage({ searchParams }: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const ctx = await requireSessionContext();
  const params = await searchParams;
  const editId = typeof params.edit === "string" ? params.edit : undefined;
  ensureSeeded(ctx);
  const board = await loadMilestoneBoard(ctx);
  const store = getStore();
  // Drafts the architect replaced on its own are not shown; what the person archived themselves stays in the editor's archive.
  const retired = milestonesRetiredBySystem(ctx);
  const milestones = store.listMilestones(ctx.workspaceId).filter((milestone) => !retired.has(milestone.id));
  const anchors = new Map(store.listMilestoneAnchors(ctx.workspaceId).map((anchor) => [anchor.milestoneId, anchor]));
  const titles = new Map(milestones.map((milestone) => [milestone.id, milestone.title]));
  const factText = new Map(store.listProfileFacts(ctx.workspaceId).map((fact) => [profileFactId(fact), fact.value]));
  const rationales = new Map(board.milestones.flatMap((milestone) => milestone.rationale ? [[milestone.id, milestone.rationale] as const] : []));
  const progress = new Map(board.milestones.map((milestone) => [milestone.id, Object.fromEntries(milestone.criteria.filter((criterion) => criterion.quarters > 0)
    .map((criterion) => [criterion.id, criterion.quarters === 4 ? "met" as const : "partial" as const]))]));
  const admin: AdminMilestone[] = milestones.map((milestone) => ({
    id: milestone.id, identityId: milestone.identityId, projectId: milestone.projectId ?? "",
    title: milestone.title, version: milestone.version, status: milestone.status,
    verifiability: milestone.verifiability, successCriteria: milestone.successCriteria,
    ...(rationales.get(milestone.id) ? { rationale: rationales.get(milestone.id)! } : {}),
    ...(anchors.get(milestone.id) ? { anchor: (({ stage, deadline, baseline, target, stakeholders, dependsOn, sourceFactIds }) => ({
      stage, deadline, baseline, target, stakeholders,
      dependsOnTitles: dependsOn.map((id) => titles.get(id) ?? id),
      facts: sourceFactIds.map((id) => factText.get(id) ?? id)
    }))(anchors.get(milestone.id)!) } : {}),
    ...(progress.get(milestone.id) ? { progress: progress.get(milestone.id)! } : {}),
    ...(milestone.templateId ? { templateId: milestone.templateId } : {}),
    ...(milestone.confidence ? { confidence: milestone.confidence } : {})
  }));
  const details = loadMilestoneDetailsBatch(ctx, admin.map((milestone) => milestone.id));
  const drafts = board.milestones.filter((milestone) => milestone.status === "draft").length;
  const identities = defaultIdentityPacks().filter((pack) => pack.kind === "identity");

  return <SubpageShell active="主线" title="主线"
    description={drafts ? `${drafts} 个里程碑草稿待审阅：草稿以虚线显示，可按主线批准或撤销。批准后，三周内到期的里程碑自动倒推出任务。` : "各主线的里程碑按日期排列；刻度为里程碑之前的阶段结果。"}>
    <MilestoneStats board={board} />
    <MilestoneTimeline board={board} />
    <p className="muted"><a href="/review">本周复盘 →</a>　<a href="/onboarding">补充个人情况并重新设计里程碑 →</a></p>
    <details className="fold advanced" id="milestone-admin" open={Boolean(editId)}><summary>新建与完整编辑</summary>
      <section className="review-block">
        <MilestoneAdmin milestones={admin}
          identities={identities.map((pack) => ({ id: pack.id, label: pack.label }))}
          templates={store.listMilestoneTemplates(ctx.workspaceId).map((template) => ({
            id: template.id, identityId: template.identityId, kind: template.kind,
            titleHint: template.titleHint, successCriteriaDefaults: template.successCriteriaDefaults, source: template.source
          }))}
          // Server-rendered previews handed to the client editor as data: the preview needs `loadMilestoneDetail`, which runs only here.
          previews={Object.fromEntries(admin.map((milestone) => [milestone.id, <MilestonePreview key={milestone.id} detail={details.get(milestone.id)} />]))}
          {...(editId ? { initialEditId: editId } : {})} />
      </section>
    </details>
  </SubpageShell>;
}
