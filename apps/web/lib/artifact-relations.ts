import "server-only";
import type { AccessContext, Ask } from "@crossline/core";
import { readStoredArtifactPlan, recordRelationCheck, relationsDueForCheck, removeArtifactRelation } from "@crossline/db";
import { getStore, planToday } from "./crossline";
import { identityLines } from "./lines";

/**
 * The web side of the cross-line artifact relations (docs/flywheel-and-views.md §5.4): taking one off a draft, and the question on its
 * check day. Everything that changes the ledger goes through `packages/db/src/artifacts.ts`.
 */

export function removeCrossLineArtifact(ctx: AccessContext, relationId: string): { ok: true } | { ok: false; code: string } {
  return removeArtifactRelation(getStore(), ctx.workspaceId, ctx.principalId, relationId);
}

const short = (text: string, length = 28) => text.length > length ? `${text.slice(0, length)}…` : text;

/**
 * On a relation's check day (the downstream deadline) the person is asked whether the artifact was delivered: 「研究 · X 是否给 自媒体 · Y
 * 提供了 3 张图表？」. 兑现 / 部分 / 没有; 没有 refutes the relation. Not urgent enough to interrupt, but this week's decision.
 */
export function relationCheckAsks(ctx: AccessContext, now = new Date()): Ask[] {
  const store = getStore();
  const today = planToday(ctx, now);
  const labels = new Map(identityLines(ctx).map((pack) => [pack.id, pack.label]));
  const milestones = new Map(store.listMilestones(ctx.workspaceId).map((milestone) => [milestone.id, milestone]));
  const artifacts = new Map(readStoredArtifactPlan(store, ctx.workspaceId).artifacts.map((artifact) => [artifact.id, artifact]));
  return relationsDueForCheck(store, ctx.workspaceId, today).flatMap((relation): Ask[] => {
    const from = milestones.get(relation.fromMilestoneId), to = milestones.get(relation.toMilestoneId);
    const transfer = relation.transfer!;
    if (!from || !to) return [];
    const artifact = artifacts.get(relation.artifactId!);
    const amount = `${transfer.expected} ${transfer.unit}${transfer.metric}`;
    return [{
      id: `relcheck:${relation.id}`, kind: "relation_check", entityId: relation.id, line: from.identityId, urgency: "soon",
      dueDay: relation.checkOn!, raisedAt: `${relation.checkOn}T00:00:00.000Z`, fingerprint: `${relation.checkOn}|${transfer.expected}`,
      title: `${labels.get(from.identityId) ?? from.identityId} · ${short(from.title)} 是否给 ${labels.get(to.identityId) ?? to.identityId} · ${short(to.title)} 提供了 ${amount}？`,
      why: `${artifact ? `产物「${artifact.title}」。` : ""}计划中的反事实：${(relation.counterfactual ?? "").replace(/[。.\s]+$/u, "")}。`
        + `今天是核对日（下游截止 ${relation.checkOn}）。兑现与部分计入跨线关系兑现率；没有则这条飞轮关系标为不成立，同类产物下次规划时会少安排。`,
      options: [
        { id: "fulfilled", label: "兑现", detail: `按 ${amount} 记录` },
        { id: "partial", label: "部分", fields: [{ id: "measured", label: `实际数量（${transfer.unit}${transfer.metric}）`, kind: "text", required: true, placeholder: `计划 ${transfer.expected}` }] },
        { id: "none", label: "没有", detail: "飞轮关系标为不成立", fields: [{ id: "note", label: "原因（可选）", kind: "text", required: false }] }
      ]
    }];
  });
}

export function answerRelationCheck(ctx: AccessContext, ask: Ask, optionId: string, values: Record<string, string>): { ok: true } | { ok: false; code: string } {
  if (optionId !== "fulfilled" && optionId !== "partial" && optionId !== "none") return { ok: false, code: "ASK_OPTION_UNKNOWN" };
  let measured: number | undefined;
  if (optionId === "partial") {
    measured = Number((values.measured ?? "").replace(/[^\d.]/g, ""));
    if (!Number.isFinite(measured) || measured < 0 || !/\d/.test(values.measured ?? "")) return { ok: false, code: "RELATION_MEASURED_INVALID" };
  }
  return recordRelationCheck(getStore(), ctx.workspaceId, ctx.principalId, ask.entityId, optionId, measured, values.note ?? "");
}
