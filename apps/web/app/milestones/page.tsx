import { defaultIdentityPacks } from "@crossline/identity-packs";
import { SubpageShell } from "../subpage-shell";
import { MilestoneMap } from "./milestone-map";
import { MilestoneAdmin, type AdminMilestone } from "./milestone-admin";
import { ensureSeeded, getStore, readGoalSettings, readSchedulePreferences } from "../../lib/crossline";
import { requireSessionContext } from "../../lib/access-guard";
import { MilestonePreview } from "../task-preview";

export const dynamic = "force-dynamic";

export default async function MilestonesPage({ searchParams }: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const ctx = await requireSessionContext();
  const params = await searchParams;
  const editId = typeof params.edit === "string" ? params.edit : undefined;
  ensureSeeded(ctx);
  const store = getStore();
  const milestones = store.listMilestones(ctx.workspaceId);
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

  const admin: AdminMilestone[] = milestones.map((milestone) => ({
    id: milestone.id, identityId: milestone.identityId, projectId: milestone.projectId ?? "",
    title: milestone.title, version: milestone.version, status: milestone.status,
    verifiability: milestone.verifiability, successCriteria: milestone.successCriteria,
    goalSettings: readGoalSettings(ctx, milestone.id),
    fallbackImportance: readSchedulePreferences(ctx)?.importance[milestone.id] ?? "ordinary",
    dateCandidates: dates.get(milestone.id) ?? [],
    ...(rationales.get(milestone.id) ? { rationale: rationales.get(milestone.id)! } : {}),
    ...(progress.get(milestone.id) ? { progress: progress.get(milestone.id)! } : {})
  }));

  return <SubpageShell eyebrow="03 / MILESTONE RELATIONS" title="里程碑星图" description="关系允许循环；实线为已批准，虚线为待周复盘确认。没有 LLM 总分。">
    {/* The map only shows approved and candidate relations, so drafts would be invisible here. */}
    <MilestoneMap
      milestones={milestones.filter((milestone) => milestone.status !== "archived")
        .map((milestone) => ({ id: milestone.id, identityId: milestone.identityId, title: milestone.title }))}
      relations={relations.map((relation) => ({ id: relation.id, source: relation.fromMilestoneId, target: relation.toMilestoneId, kind: relation.kind, status: relation.status }))}
    />
    <section className="review-block">
      <h2>里程碑</h2>
      <p className="review-note">
        修改会写入新版本，旧版本保留 —— 闸门判过的那一版永远可追溯。AI 只能提出草稿，批准是你的动作。
      </p>
      <MilestoneAdmin
        milestones={admin}
        identities={defaultIdentityPacks().filter((pack) => pack.kind === "identity")
          .map((pack) => ({ id: pack.id, label: pack.label }))}
        // Pre-rendered server output handed to a client component as data — MilestoneAdmin itself stays
        // "use client" for its form state, but the preview drawer's content still needs `loadMilestoneDetail`,
        // which only runs on the server.
        previews={Object.fromEntries(admin.map((milestone) => [milestone.id, <MilestonePreview key={milestone.id} ctx={ctx} milestoneId={milestone.id} />]))}
        {...(editId ? { initialEditId: editId } : {})}
      />
    </section>
  </SubpageShell>;
}
