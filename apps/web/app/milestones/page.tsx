import { profileFactId } from "@crossline/core";
import { defaultIdentityPacks } from "@crossline/identity-packs";
import { SubpageShell } from "../subpage-shell";
import { FlowChart } from "./flow-chart";
import { TargetsPanel } from "./targets-panel";
import { listCourseTargets } from "../../lib/targets";
import { MilestoneAdmin, type AdminMilestone } from "./milestone-admin";
import { ensureSeeded, getStore, milestonesRetiredBySystem, readGoalSettings, readSchedulePreferences } from "../../lib/crossline";
import { requireSessionContext } from "../../lib/access-guard";
import { MilestonePreview } from "../task-preview";
import { ApproveLineDraftsButton } from "../approvals/approval-actions";
import { loadMilestoneDetailsBatch } from "../../lib/task-detail";

export const dynamic = "force-dynamic";

export default async function MilestonesPage({ searchParams }: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const ctx = await requireSessionContext();
  const params = await searchParams;
  const editId = typeof params.edit === "string" ? params.edit : undefined;
  ensureSeeded(ctx);
  const store = getStore();
  // Drafts the architect replaced on its own are not shown: the page is the plan as it stands, with each milestone's reasoning in
  // 「依据与推导」, not every version the planning went through. What the person archived themselves stays.
  const retired = milestonesRetiredBySystem(ctx);
  const milestones = store.listMilestones(ctx.workspaceId).filter((milestone) => !retired.has(milestone.id));
  const relations = store.listMilestoneRelations(ctx.workspaceId);
  // Why a proposed milestone was suggested is part of reviewing it: approving a goal without the
  // reasoning is the same problem as approving a relation with no stated claim.
  const rationales = new Map(store.listEvents(ctx.workspaceId, { type: "milestone.proposed" })
    .map((event) => [event.entityId, String((event.payload as { rationale?: string }).rationale ?? "")]));
  const dates = new Map(store.listEvents(ctx.workspaceId, { type: "goal.backplan_proposed" })
    .map((event) => [event.entityId, (event.payload as { dateCandidates?: Array<{ date: string; quote: string }> }).dateCandidates ?? []]));

  // Every gate judgement leaves a per-criterion reading. The best one seen for a criterion is the
  // milestone's progress on it: a later work order that did not touch a criterion must not un-meet it.
  const rank = { unverifiable: 0, unmet: 1, partial: 2, met: 3 } as const;
  type Met = keyof typeof rank;
  const progress = new Map<string, Record<string, Met>>();
  for (const event of store.listEvents(ctx.workspaceId, { type: "milestone_gate.judged" })) {
    const payload = event.payload as { milestoneId?: string; criteriaVerdict?: Array<{ criterionId: string; met: Met }> };
    if (!payload.milestoneId) continue;
    const current = progress.get(payload.milestoneId) ?? {};
    for (const item of payload.criteriaVerdict ?? []) {
      const seen = current[item.criterionId];
      if (!seen || rank[item.met] > rank[seen]) current[item.criterionId] = item.met;
    }
    progress.set(payload.milestoneId, current);
  }

  const templates = store.listMilestoneTemplates(ctx.workspaceId);
  const anchors = new Map(store.listMilestoneAnchors(ctx.workspaceId).map((anchor) => [anchor.milestoneId, anchor]));
  const titles = new Map(milestones.map((milestone) => [milestone.id, milestone.title]));
  const factText = new Map(store.listProfileFacts(ctx.workspaceId).map((fact) => [profileFactId(fact), fact.value]));

  const admin: AdminMilestone[] = milestones.map((milestone) => ({
    id: milestone.id, identityId: milestone.identityId, projectId: milestone.projectId ?? "",
    title: milestone.title, version: milestone.version, status: milestone.status,
    verifiability: milestone.verifiability, successCriteria: milestone.successCriteria,
    goalSettings: readGoalSettings(ctx, milestone.id),
    fallbackImportance: readSchedulePreferences(ctx)?.importance[milestone.id] ?? "ordinary",
    dateCandidates: dates.get(milestone.id) ?? [],
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

  const milestoneDetails = loadMilestoneDetailsBatch(ctx, admin.map((milestone) => milestone.id));

  const identities = defaultIdentityPacks().filter((pack) => pack.kind === "identity");
  const flowNodes = milestones.filter((milestone) => milestone.status !== "archived").map((milestone) => {
    const anchor = anchors.get(milestone.id);
    const reading = progress.get(milestone.id) ?? {};
    return { id: milestone.id, identityId: milestone.identityId, title: milestone.title, status: milestone.status,
      stage: anchor?.stage, deadline: anchor?.deadline, dependsOn: anchor?.dependsOn,
      met: Object.values(reading).filter((value) => value === "met").length, total: milestone.successCriteria.length };
  });
  const draftList = milestones.filter((milestone) => milestone.status === "draft");
  const drafts = draftList.length;
  const labelOf = Object.fromEntries(identities.map((pack) => [pack.id, pack.label]));
  return <SubpageShell active="主线" title="主线"
    description={drafts ? `${drafts} 个里程碑草稿等你批准：整条线一次接受，或点节点逐个改。接受后，三周内到期的会自动倒推出本周的第一步。` : "每条主线在往哪走，按先后从左到右。"}>
    {drafts > 0 && <div className="line-drafts-bar">{[...new Set(draftList.map((milestone) => milestone.identityId))].map((line) => {
      const ids = draftList.filter((milestone) => milestone.identityId === line).map((milestone) => milestone.id);
      return <ApproveLineDraftsButton key={line} ids={ids} label={`接受${labelOf[line] ?? line}的 ${ids.length} 个草稿`} />;
    })}</div>}
    <FlowChart milestones={flowNodes} labels={Object.fromEntries(identities.map((pack) => [pack.id, pack.label]))}
      lineOrder={identities.map((pack) => pack.id)}
      relations={relations.map((relation) => ({ id: relation.id, source: relation.fromMilestoneId, target: relation.toMilestoneId, kind: relation.kind, status: relation.status }))} />
    <TargetsPanel courses={listCourseTargets(ctx)}
      milestones={milestones.filter((milestone) => milestone.status !== "archived" && milestone.successCriteria.some((criterion) => criterion.measure.kind === "threshold"))
        .map((milestone) => ({ id: milestone.id, identityId: milestone.identityId, projectId: milestone.projectId ?? "", title: milestone.title, status: milestone.status as "draft" | "approved",
          successCriteria: milestone.successCriteria, ...(milestone.templateId ? { templateId: milestone.templateId } : {}) }))} />
    <p className="muted"><a href="/review">本周复盘 →</a>　<a href="/onboarding">补充你的情况，重新设计里程碑 →</a></p>
    <details className="fold" open={drafts > 0 || Boolean(editId)}><summary>里程碑列表与编辑（修改写入新版本，旧版本保留）</summary>
    <section className="review-block">
      <MilestoneAdmin
        milestones={admin}
        identities={defaultIdentityPacks().filter((pack) => pack.kind === "identity")
          .map((pack) => ({ id: pack.id, label: pack.label }))}
        templates={templates.map((template) => ({
          id: template.id, identityId: template.identityId, kind: template.kind,
          titleHint: template.titleHint, successCriteriaDefaults: template.successCriteriaDefaults,
          source: template.source
        }))}
        // Pre-rendered server output handed to a client component as data — MilestoneAdmin itself stays
        // "use client" for its form state, but the preview drawer's content still needs `loadMilestoneDetail`,
        // which only runs on the server.
        previews={Object.fromEntries(admin.map((milestone) => [milestone.id, <MilestonePreview key={milestone.id} detail={milestoneDetails.get(milestone.id)} />]))}
        {...(editId ? { initialEditId: editId } : {})}
      />
    </section>
    </details>
  </SubpageShell>;
}
