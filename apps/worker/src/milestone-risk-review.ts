import {
  AVAILABILITY_PROPOSED_SETTING, AVAILABILITY_SETTING, goalSettingKey, keepMilestoneRisks, MILESTONE_RISK_RETRY_MS, MILESTONE_RISK_SCHEMA,
  MILESTONE_RISKS_SETTING, milestoneRiskFingerprint, parseMilestoneRisks, resolveAvailability, riskCriteriaKeys, ruleMilestoneRisks,
  validateMilestoneRisks, weeklyAvailableHours, type MilestoneRiskAnswer, type MilestoneRiskContext, type StoredMilestoneRisk
} from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";
import { localToday } from "./analysis";
import { identityLines } from "./lines";
import { ownerOf } from "./owner";

export const MILESTONE_RISK_REVIEWER = "crossline:crossline-milestone-risk-reviewer";
/** Drafts reviewed in one run: one architect run makes three to five a line. */
const PER_RUN = 12;

const dayDiff = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);

/** Each live milestone with what a review reads of it: its deadline (a confirmed one wins), criteria and same-line prerequisites. */
function liveMilestones(store: CrosslineStore, workspaceId: string) {
  const anchors = new Map(store.listMilestoneAnchors(workspaceId).map((anchor) => [anchor.milestoneId, anchor]));
  const live = store.listMilestones(workspaceId).filter((item) => item.status !== "archived");
  const deadlineOf = (id: string) => {
    let confirmed: string | null = null;
    try { confirmed = (JSON.parse(store.getSetting(workspaceId, goalSettingKey(id)) ?? "null") as { confirmedDeadline?: string | null } | null)?.confirmedDeadline ?? null; }
    catch { /* unreadable settings: the anchor's date */ }
    return confirmed ?? anchors.get(id)?.deadline ?? null;
  };
  return live.map((milestone) => {
    const deadline = deadlineOf(milestone.id) || null;
    const dependsOn = anchors.get(milestone.id)?.dependsOn ?? [];
    const criteria = milestone.successCriteria ?? [];
    return { milestone, deadline, dependsOn, criteria,
      fingerprint: milestoneRiskFingerprint({ title: milestone.title, deadline, criteria: riskCriteriaKeys(criteria), dependsOn }) };
  });
}

/**
 * Drafts not yet reviewed in their current form (none on record, one made before an edit), then approved milestones that never had a
 * model review (approved before the reviewer existed, or approved straight from a failed run); either one retried a day after a failed
 * run. An approved milestone edited after its review is not reviewed again — the 主线 page shows the rule estimate for it.
 */
export function milestonesAwaitingRiskReview(store: CrosslineStore, workspaceId: string, now = new Date()): string[] {
  const stored = parseMilestoneRisks(store.getSetting(workspaceId, MILESTONE_RISKS_SETTING));
  const retry = (entry: StoredMilestoneRisk) => "failed" in entry && now.getTime() - Date.parse(entry.at) > MILESTONE_RISK_RETRY_MS;
  const live = liveMilestones(store, workspaceId);
  const drafts = live.filter(({ milestone, fingerprint }) => {
    if (milestone.status !== "draft") return false;
    const entry = stored[milestone.id];
    return !entry || entry.fingerprint !== fingerprint || retry(entry);
  });
  const approved = live.filter(({ milestone }) => {
    if (milestone.status !== "approved") return false;
    const entry = stored[milestone.id];
    return !entry || retry(entry);
  });
  return [...drafts, ...approved].map(({ milestone }) => milestone.id);
}

/** What the reviewer is given: the drafts with their reasoning and the rule findings, every other live milestone, the weekly hours. */
export function riskReviewContext(store: CrosslineStore, workspaceId: string, ids: string[], now = new Date()): MilestoneRiskContext {
  const today = localToday(store, workspaceId, now);
  const labels = new Map(identityLines(store, workspaceId).map((line) => [line.id, line.label]));
  const projects = new Map(store.listProjects(workspaceId, { includeArchived: true }).map((project) => [project.id, project.name]));
  const rationale = new Map(store.listEvents(workspaceId, { type: "milestone.proposed" })
    .map((event) => [event.entityId, String((event.payload as { rationale?: string }).rationale ?? "")]));
  const live = liveMilestones(store, workspaceId);
  const byId = new Map(live.map((item) => [item.milestone.id, item]));
  const { windows } = resolveAvailability({ saved: store.getSetting(workspaceId, AVAILABILITY_SETTING),
    proposed: store.getSetting(workspaceId, AVAILABILITY_PROPOSED_SETTING), facts: store.listProfileFacts(workspaceId) });
  const hours = weeklyAvailableHours(windows);
  const chosen = ids.flatMap((id) => byId.get(id) ? [byId.get(id)!] : []);
  return {
    version: "crossline.milestone-risk.v1", today, weeklyHours: hours > 0 ? Math.round(hours) : null,
    milestones: chosen.map(({ milestone, deadline, dependsOn, criteria }) => {
      const parents = dependsOn.flatMap((id) => byId.get(id) ? [{ title: byId.get(id)!.milestone.title, deadline: byId.get(id)!.deadline }] : []);
      return { id: milestone.id, status: milestone.status, line: milestone.identityId, lineLabel: labels.get(milestone.identityId) ?? milestone.identityId,
        project: milestone.projectId ? projects.get(milestone.projectId) ?? "" : "", title: milestone.title, deadline,
        daysLeft: deadline ? dayDiff(today, deadline) : null,
        criteria: criteria.map((criterion) => criterion.statement), rationale: (rationale.get(milestone.id) ?? "").slice(0, 1500), dependsOn: parents,
        ruleFindings: ruleMilestoneRisks({ today, deadline, criteria, dependsOn: parents,
          otherDeadlines: live.filter((other) => other.milestone.id !== milestone.id && other.deadline).map((other) => other.deadline!) }) };
    }),
    others: live.filter((item) => !ids.includes(item.milestone.id)).map(({ milestone, deadline }) => ({
      line: labels.get(milestone.identityId) ?? milestone.identityId, title: milestone.title, deadline, status: milestone.status }))
  };
}

/**
 * Reviews the drafts waiting for it in one run and stores each answer under its fingerprint (`MILESTONE_RISKS_SETTING`), one
 * `milestone.risk_reviewed` event each. A milestone the answer left out is marked failed and asked about again after a day.
 */
export function createMilestoneRiskReviewer(store: CrosslineStore, workspaceId: string, cwd: string, getClient: () => CodexRpcBoundary | undefined) {
  return async function review(now = new Date()): Promise<{ reviewed: number; failed: number } | { blocked: string }> {
    const client = getClient();
    if (!client) return { blocked: "CODEX_SUPERVISOR_UNAVAILABLE" };
    const ids = milestonesAwaitingRiskReview(store, workspaceId, now).slice(0, PER_RUN);
    if (!ids.length) return { reviewed: 0, failed: 0 };
    const context = riskReviewContext(store, workspaceId, ids, now);
    const fingerprints = new Map(liveMilestones(store, workspaceId).map((item) => [item.milestone.id, item.fingerprint]));
    const result = await runCodexSkill<MilestoneRiskAnswer>(client, context, {
      skillName: MILESTONE_RISK_REVIEWER, cwd, outputSchema: MILESTONE_RISK_SCHEMA,
      developerInstructions: "Review each milestone for what could keep it from being reached on its date, as the crossline-milestone-risk-reviewer Skill "
        + "describes, and return only the requested JSON. The person sees each risk as a tag on the 主线 page before approving, and a medium or high risk "
        + "on an approved milestone is put to them as a question. One entry per milestone; `risks: []` when nothing follows from the dates, numbers, "
        + "criteria and competing milestones given. Each note is one clause of at most 60 characters that names the figure it rests on, never advice.",
      prepareInput: () => context,
      validateOutput: (output) => ({ milestones: [...validateMilestoneRisks(output, context)].map(([milestoneId, risks]) => ({ milestoneId, risks })) }),
      softAccept: (_rejection, output) => keepMilestoneRisks(output, context),
      onAudit: () => {}, timeoutMs: 20 * 60_000
    });
    const at = now.toISOString();
    // Read again: the page or another run may have written meanwhile; only these milestones' entries change.
    const stored = parseMilestoneRisks(store.getSetting(workspaceId, MILESTONE_RISKS_SETTING));
    const answered = new Map(result.ok ? result.output.milestones.map((item) => [item.milestoneId, item.risks]) : []);
    const ownerId = ownerOf(store, workspaceId);
    let reviewed = 0;
    for (const id of ids) {
      const fingerprint = fingerprints.get(id);
      if (!fingerprint) continue;
      const risks = answered.get(id);
      const entry: StoredMilestoneRisk = risks ? { fingerprint, at, source: "model", risks } : { fingerprint, at, failed: result.ok ? "MILESTONE_RISK_MISSING" : result.blocker.code };
      stored[id] = entry;
      if (!risks) continue;
      reviewed += 1;
      store.appendEvent({ ownerId, workspaceId, idempotencyKey: `milestone:risk:${id}:${fingerprint}`, type: "milestone.risk_reviewed", entityId: id,
        payload: { fingerprint, risks } });
    }
    store.setSetting(workspaceId, MILESTONE_RISKS_SETTING, JSON.stringify(stored));
    return result.ok || reviewed ? { reviewed, failed: ids.length - reviewed } : { blocked: result.blocker.code };
  };
}
