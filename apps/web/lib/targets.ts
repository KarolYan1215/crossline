import "server-only";
import { isCourse, type AccessContext } from "@crossline/core";
import { latestFileDates } from "@crossline/db";
import { getStore } from "./crossline";

/**
 * The targets every number in a plan is worked back from. A course's target grade is proposed by the architect from the person's
 * long-term goals (an unconfirmed `target_grade` fact with its reason) and the person changes it in one click; changing it makes it
 * theirs (confirmed), and the line's milestones are redone from it.
 */
export type CourseTarget = {
  projectId: string; identityId: string; name: string;
  /** What the target says, without the reason. */
  value: string;
  /** Why it was proposed; empty once the person has set it themselves. */
  why: string;
  /** Still the model's proposal. */
  proposed: boolean;
};

const PROPOSED = /^(.*?)（暂定：(.*)）$/s;

export function listCourseTargets(ctx: AccessContext): CourseTarget[] {
  const store = getStore();
  const facts = store.listProfileFacts(ctx.workspaceId);
  const { dates, undated } = latestFileDates(store, ctx.workspaceId);
  return store.listProjects(ctx.workspaceId).flatMap((project) => {
    const own = facts.filter((fact) => fact.projectId === project.id);
    const target = own.find((fact) => fact.slot === "target_grade");
    if (!target || !isCourse(project.id, own, dates, undated)) return [];
    const match = PROPOSED.exec(target.value);
    const proposed = target.status !== "confirmed";
    return [{ projectId: project.id, identityId: project.identityId, name: project.name,
      value: proposed && match ? match[1]!.trim() : target.value, why: proposed && match ? match[2]!.trim() : "", proposed }];
  });
}

/** How many proposed targets are still waiting for the person to look at them. */
export const countProposedTargets = (ctx: AccessContext): number => listCourseTargets(ctx).filter((target) => target.proposed).length;

export function setCourseTarget(ctx: AccessContext, input: { projectId: string; value: string }):
  { ok: true; identityId: string } | { ok: false; code: "PROJECT_UNKNOWN" | "TARGET_INVALID" } {
  const store = getStore();
  const project = store.listProjects(ctx.workspaceId).find((item) => item.id === input.projectId);
  if (!project) return { ok: false, code: "PROJECT_UNKNOWN" };
  const value = input.value.trim();
  if (value.length < 2 || value.length > 120) return { ok: false, code: "TARGET_INVALID" };
  const now = new Date().toISOString();
  store.upsertProfileFact({ workspaceId: ctx.workspaceId, identityId: project.identityId, projectId: project.id, slot: "target_grade",
    value, status: "confirmed", sourceRef: "manual", sourceQuote: value, updatedAt: now });
  const ownerId = store.getWorkspaceOwnerId(ctx.workspaceId);
  if (ownerId) store.appendEvent({ ownerId, workspaceId: ctx.workspaceId, idempotencyKey: `target:set:${project.id}:${now}`, type: "target.set", entityId: project.id,
    payload: { projectId: project.id, value } });
  return { ok: true, identityId: project.identityId };
}
