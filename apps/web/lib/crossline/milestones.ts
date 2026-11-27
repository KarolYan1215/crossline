import "server-only";
import { randomUUID } from "node:crypto";
import { approveArtifactRelationsFor, type StoredMilestone } from "@crossline/db";
import { requiredApproval, computeMilestoneConfidence, validateSuccessCriteria, type AccessContext, type SuccessCriterion } from "@crossline/core";
import { RELATION_KIND_LABEL } from "@crossline/core";
import { identityLines } from "../lines";
import { localeFor, tOf } from "../locale";
import { tFor, type Locale } from "../i18n";
import { getStore } from "./store";

// Shared with apps/web/lib/task-detail.ts, so a task/milestone detail view's relation labels and identity
// swatches never drift from what the homepage flywheel strip and star map already say.
export const relationKindLabel: Record<string, string> = RELATION_KIND_LABEL;
export const accents: Record<string, string> = {
  research: "#6D5EF5",
  startup: "#FF8A5B",
  media: "#E85D9E",
  investment: "#23A989"
};

export type MilestoneInput = {
  id?: string;
  identityId: string;
  projectId: string;
  title: string;
  status: StoredMilestone["status"];
  successCriteria: SuccessCriterion[];
  /** Which `StoredMilestoneTemplate` these criteria were built from, if any — drives the deterministic
   * confidence computed below. Left undefined for a deliberately free-formed milestone. */
  templateId?: string;
};

/**
 * Creates a milestone, or writes a new version of one that exists.
 *
 * Editing never overwrites: the primary key is `(id, version)`, so a change writes `version + 1` and
 * the version a gate already judged against stays readable forever. Without that, re-reading an old
 * acceptance would show it judged against criteria that did not exist at the time.
 */
export function saveMilestoneEdit(ctx: AccessContext, input: MilestoneInput): { ok: true; id: string; version: number } | { ok: false; code: string } {
  const title = input.title.trim();
  if (!title || title.length > 200) return { ok: false, code: "MILESTONE_TITLE_REQUIRED" };
  if (!identityLines(ctx).some((pack) => pack.id === input.identityId)) {
    return { ok: false, code: "MILESTONE_IDENTITY_UNKNOWN" };
  }
  const projectId = input.projectId.trim() || `${input.identityId}-default`;
  const store = getStore();
  const existing = input.id ? store.listMilestones(ctx.workspaceId).find((item) => item.id === input.id) : undefined;
  if (input.id && !existing) return { ok: false, code: "MILESTONE_NOT_FOUND" };

  const version = existing ? existing.version + 1 : 1;
  const id = existing?.id ?? `milestone-${randomUUID()}`;
  const template = input.templateId
    ? store.listMilestoneTemplates(ctx.workspaceId, input.identityId).find((item) => item.id === input.templateId)
    : undefined;
  if (input.templateId && !template) return { ok: false, code: "MILESTONE_TEMPLATE_UNKNOWN" };
  const confidence = computeMilestoneConfidence(input.successCriteria, template);
  try {
    store.saveMilestone({
      id, ownerId: ctx.principalId, workspaceId: ctx.workspaceId,
      identityId: input.identityId, projectId, title,
      version, status: input.status, successCriteria: input.successCriteria,
      ...(input.templateId ? { templateId: input.templateId } : {}), confidence,
      // Follows templateId the same way confidence does: present only when a template is actually
      // chosen (on this save, not merely at some point in the past), so re-picking "不套用" on an edit
      // correctly drops it rather than leaving a stale bank from a template no longer in effect.
      ...(template?.evidenceQuestionDefaults.length ? { evidenceQuestionBank: template.evidenceQuestionDefaults } : {})
    });
  } catch (error) {
    // `saveMilestone` throws the criterion blocker code, which is the specific thing the person needs
    // to fix — collapsing it into a generic failure would hide which criterion was rejected.
    return { ok: false, code: error instanceof Error ? error.message : "MILESTONE_SAVE_FAILED" };
  }
  store.appendEvent({
    ownerId: ctx.principalId, workspaceId: ctx.workspaceId,
    idempotencyKey: `milestone:saved:${id}:${version}`,
    type: "milestone.changed", entityId: id,
    payload: { version, status: input.status, title, criteria: input.successCriteria.length, change: existing ? "revised" : "created" }
  });
  // A cross-line relation is approved together with its downstream milestone (batch or single approval alike).
  if (input.status === "approved" && existing?.status !== "approved") approveArtifactRelationsFor(store, ctx.workspaceId, ctx.principalId, id);
  return { ok: true, id, version };
}

export type MilestoneTemplateInput = {
  identityId: string;
  kind: "deliverable" | "threshold" | "validation" | "recurring_cadence" | "decision";
  titleHint: string;
  successCriteriaDefaults: SuccessCriterion[];
};

/**
 * A user (or, via the assistant widget's `templateProposal`, the assistant on the user's explicit
 * request) adding a new milestone template directly — not a draft needing a second approval step, the
 * same way editing a milestone's own fields is not. `crossline-milestone-architect:design` only ever reads
 * `approved`-equivalent templates when proposing, and every template saved here is immediately usable.
 */
export function saveMilestoneTemplate(ctx: AccessContext, input: MilestoneTemplateInput):
  { ok: true; id: string } | { ok: false; code: string } {
  const titleHint = input.titleHint.trim();
  if (!titleHint || titleHint.length > 200) return { ok: false, code: "TEMPLATE_TITLE_REQUIRED" };
  if (!identityLines(ctx).some((pack) => pack.id === input.identityId)) {
    return { ok: false, code: "TEMPLATE_IDENTITY_UNKNOWN" };
  }
  const checked = validateSuccessCriteria(input.successCriteriaDefaults, localeFor(ctx));
  if (!checked.ok) return { ok: false, code: checked.blocker.code };
  const id = `template-${randomUUID()}`;
  getStore().saveMilestoneTemplate({
    id, workspaceId: ctx.workspaceId, kind: input.kind, identityId: input.identityId, titleHint,
    successCriteriaDefaults: input.successCriteriaDefaults, evidenceQuestionDefaults: [], source: "user"
  });
  return { ok: true, id };
}

/**
 * Batch decision on candidate milestone relations, which is the mode `requiredApproval` asks for.
 *
 * Only candidates move. An id that is already approved, refuted or simply unknown comes back in
 * `skipped` — reporting it as decided would tell the person their click did something it did not.
 */
export function decideMilestoneRelations(ctx: AccessContext, ids: string[], decision: "approved" | "archived"):
  | { ok: true; decided: string[]; skipped: string[] }
  | { ok: false; code: string } {
  if (requiredApproval("approve_milestone_relations") !== "batch") return { ok: false, code: "APPROVAL_MODE_UNEXPECTED" };
  const unique = [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0 && id.length <= 200))];
  if (!unique.length) return { ok: false, code: "NO_RELATIONS_SELECTED" };
  const store = getStore();
  // Keyed on the decision and the exact set, so a double-submitted form writes one event, and a
  // genuinely different selection later is still recorded.
  const key = `relations:${decision}:${[...unique].sort().join(",")}`.slice(0, 400);
  const result = store.decideMilestoneRelations(ctx.workspaceId, ctx.principalId, unique, decision, key);
  // A relation the person turned down says which kinds of link they do not believe in; later proposals are given it.
  if (decision === "archived") {
    const titles = new Map(store.listMilestones(ctx.workspaceId).map((milestone) => [milestone.id, milestone.title]));
    for (const relation of store.listMilestoneRelations(ctx.workspaceId).filter((item) => result.decided.includes(item.id))) {
      store.addPreference({ workspaceId: ctx.workspaceId, source: "relation_rejected", scope: "all", weight: 0.8, refId: relation.id,
        text: tOf(ctx)("跨主线关系「{{from}} → {{to}}」（{{kind}}）被本人驳回", { from: titles.get(relation.fromMilestoneId) ?? relation.fromMilestoneId,
          to: titles.get(relation.toMilestoneId) ?? relation.toMilestoneId, kind: relationKindLabel[relation.kind] ? tOf(ctx)(relationKindLabel[relation.kind]!) : relation.kind }) });
    }
  }
  return { ok: true, ...result };
}

/**
 * A milestone the architect replaced on its own: archived without the person ever editing it (every edit, archiving included, writes
 * `milestone.revised`). The 主线 page leaves these out; what the person archived stays in its fold.
 */
export function milestonesRetiredBySystem(ctx: AccessContext): Set<string> {
  const store = getStore();
  const touched = new Set(store.listEvents(ctx.workspaceId, { type: "milestone.changed", change: "revised" }).map((event) => event.entityId));
  return new Set(store.listMilestones(ctx.workspaceId).filter((milestone) => milestone.status === "archived" && !touched.has(milestone.id))
    .map((milestone) => milestone.id));
}

/**
 * The milestone a line's card names. Only an approved one is "current": the card used to take the first milestone of the line
 * in any state, so a line with nothing but unapproved drafts (or an archived starter) announced one of them as where it stood.
 * The earliest-due approved milestone wins; with only drafts, the card says so instead.
 */
export function currentMilestoneLabel(milestones: Array<{ id: string; identityId: string; status: string; title: string }>,
  deadlines: Map<string, string | null | undefined>, identityId: string, locale?: Locale): string {
  const mine = milestones.filter((milestone) => milestone.identityId === identityId);
  const approved = mine.filter((milestone) => milestone.status === "approved")
    .sort((a, b) => (deadlines.get(a.id) ?? "9999").localeCompare(deadlines.get(b.id) ?? "9999"));
  if (approved[0]) return approved[0].title;
  const drafts = mine.filter((milestone) => milestone.status === "draft").length;
  const t = tFor(locale);
  return drafts ? t("{{count}} 个里程碑草稿待批准", { count: drafts }) : t("等待批准里程碑");
}
