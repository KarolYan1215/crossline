import {
  AVAILABILITY_PROPOSED_SETTING, AVAILABILITY_SETTING, goalSettingKey, keepMilestoneRisks, MILESTONE_RISK_RETRY_MS, MILESTONE_RISK_SCHEMA,
  MILESTONE_RISKS_SETTING, milestoneRiskFingerprint, parseMilestoneRisks, readMilestoneReadings, resolveAvailability, riskCriteriaKeys, ruleMilestoneRisks,
  validateMilestoneRisks, weeklyAvailableHours, withReadings, type MilestoneRiskAnswer, type MilestoneRiskContext, type StoredMilestoneRisk
} from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";
import { localToday } from "./analysis";
import { identityLines } from "./lines";
import { ownerOf } from "./owner";

export const MILESTONE_RISK_REVIEWER = "crossline:crossline-milestone-review:risk";
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
 * run. An approved milestone edited after its review is not reviewed again — the 主线 page shows the rule estimate for it. A review from
 * before the reviewer weighed milestones (no `reading`, 2026-11-22) is read once more for the weight; its risks are kept.
 */
export function milestonesAwaitingRiskReview(store: CrosslineStore, workspaceId: string, now = new Date()): string[] {
  const stored = parseMilestoneRisks(store.getSetting(workspaceId, MILESTONE_RISKS_SETTING));
  const retry = (entry: StoredMilestoneRisk) => "failed" in entry && now.getTime() - Date.parse(entry.at) > MILESTONE_RISK_RETRY_MS;
  const unweighed = (entry: StoredMilestoneRisk) => "risks" in entry && !entry.reading && !entry.weighed;
  const live = liveMilestones(store, workspaceId);
  const drafts = live.filter(({ milestone, fingerprint }) => {
    if (milestone.status !== "draft") return false;
    const entry = stored[milestone.id];
    return !entry || entry.fingerprint !== fingerprint || retry(entry) || unweighed(entry);
  });
  const approved = live.filter(({ milestone }) => {
    if (milestone.status !== "approved") return false;
    const entry = stored[milestone.id];
    return !entry || retry(entry) || unweighed(entry);
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
  // What the weight reads (what the point score used to add up): the line's standing, the relations, a stated grade, past slider moves.
  const standing = new Map(identityLines(store, workspaceId).map((line) => [line.id, { rank: line.rank ?? null, hard: Boolean(line.hard) }]));
  const relations = store.listMilestoneRelations(workspaceId).filter((item) => item.status === "approved" || item.status === "candidate");
  const graded = new Set(store.listProfileFacts(workspaceId).filter((fact) => fact.slot === "grading" || fact.slot === "target_grade").map((fact) => fact.projectId));
  const lineOf = new Map(live.map((item) => [item.milestone.id, item.milestone.identityId]));
  const adjustments = new Map<string, number[]>();
  for (const event of store.listEvents(workspaceId, { type: "goal.changed", change: "settings_confirmed" })) {
    const payload = event.payload as { next?: { weight?: number }; presetWeight?: number | null };
    const line = lineOf.get(event.entityId);
    if (!line || typeof payload.next?.weight !== "number" || typeof payload.presetWeight !== "number") continue;
    adjustments.set(line, [...(adjustments.get(line) ?? []), payload.next.weight - payload.presetWeight]);
  }
  // Fixed events of each day (the plan's read-only blocks: classes, synced and file events), for whether a milestone is a sitting.
  const fixedBlocks = ((store.listPlanVersions(workspaceId)[0]?.payload as { blocks?: Array<{ day?: string; start: string; end: string; title: string; readOnly?: boolean }> } | undefined)?.blocks ?? [])
    .filter((block) => block.readOnly && block.day);
  return {
    version: "crossline.milestone-risk.v2", today, weeklyHours: hours > 0 ? Math.round(hours) : null,
    milestones: chosen.map(({ milestone, deadline, dependsOn, criteria }) => {
      const parents = dependsOn.flatMap((id) => byId.get(id) ? [{ title: byId.get(id)!.milestone.title, deadline: byId.get(id)!.deadline }] : []);
      return { id: milestone.id, status: milestone.status, line: milestone.identityId, lineLabel: labels.get(milestone.identityId) ?? milestone.identityId,
        project: milestone.projectId ? projects.get(milestone.projectId) ?? "" : "", title: milestone.title, deadline,
        daysLeft: deadline ? dayDiff(today, deadline) : null,
        criteria: criteria.map((criterion) => criterion.statement), rationale: (rationale.get(milestone.id) ?? "").slice(0, 1500), dependsOn: parents,
        ruleFindings: ruleMilestoneRisks({ today, deadline, criteria, dependsOn: parents,
          otherDeadlines: live.filter((other) => other.milestone.id !== milestone.id && other.deadline).map((other) => other.deadline!) }),
        standing: standing.get(milestone.identityId) ?? { rank: null, hard: false },
        relations: relations.filter((item) => item.fromMilestoneId === milestone.id || item.toMilestoneId === milestone.id).length,
        graded: Boolean(milestone.projectId && graded.has(milestone.projectId)), pastAdjustments: (adjustments.get(milestone.identityId) ?? []).slice(-6),
        sameDayEvents: deadline ? fixedBlocks.filter((block) => block.day === deadline).map((block) => ({ start: block.start, end: block.end, title: block.title.slice(0, 80) }))
          .sort((a, b) => a.start.localeCompare(b.start)).slice(0, 8) : [] };
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
      developerInstructions: "Review each milestone for what could keep it from being reached on its date, and weigh it and say whether it is a sitting, "
        + "as the crossline-milestone-review:risk Skill describes, and return only the requested JSON. The person sees each risk as a tag on the 主线 page before approving, and a medium or high risk " // i18n-ignore: model-facing
        + "on an approved milestone is put to them as a question. One entry per milestone; `risks: []` when nothing follows from the dates, numbers, "
        + "criteria and competing milestones given. Each note is one clause of at most 60 characters that names the figure it rests on, never advice.",
      // The prompt cache (docs/token-economy.md §2.5): the week's hours and the competing milestones before the ones under review and the date.
      stableKeys: ["version", "weeklyHours", "others"],
      prepareInput: () => context,
      validateOutput: (output) => withReadings(validateMilestoneRisks(output, context), readMilestoneReadings(output, context)),
      softAccept: (_rejection, output) => keepMilestoneRisks(output, context),
      onAudit: () => {}, timeoutMs: 20 * 60_000
    });
    const at = now.toISOString();
    // Read again: the page or another run may have written meanwhile; only these milestones' entries change.
    const stored = parseMilestoneRisks(store.getSetting(workspaceId, MILESTONE_RISKS_SETTING));
    const answered = new Map(result.ok ? result.output.milestones.map((item) => [item.milestoneId, item]) : []);
    const ownerId = ownerOf(store, workspaceId);
    let reviewed = 0;
    for (const id of ids) {
      const fingerprint = fingerprints.get(id);
      if (!fingerprint) continue;
      const item = answered.get(id);
      const risks = item?.risks;
      const old = stored[id];
      const reading = item?.reading ?? old?.reading;
      // A review read again only for the weight keeps its risks (and so asks nothing new about them).
      const reweighed = Boolean(risks && old && "risks" in old && old.fingerprint === fingerprint && !old.reading && !old.weighed);
      const entry: StoredMilestoneRisk = reweighed && old && "risks" in old ? { ...old, weighed: true, ...(reading ? { reading } : {}) }
        : risks ? { fingerprint, at, source: "model", risks, weighed: true, ...(reading ? { reading } : {}) }
        : { fingerprint, at, failed: result.ok ? "MILESTONE_RISK_MISSING" : result.blocker.code, ...(reading ? { reading } : {}) };
      stored[id] = entry;
      if (!risks || reweighed) { if (reweighed) reviewed += 1; continue; }
      reviewed += 1;
      store.appendEvent({ ownerId, workspaceId, idempotencyKey: `milestone:risk:${id}:${fingerprint}`, type: "milestone.changed", entityId: id,
        payload: { fingerprint, risks, change: "risk_reviewed" } });
    }
    store.setSetting(workspaceId, MILESTONE_RISKS_SETTING, JSON.stringify(stored));
    return result.ok || reviewed ? { reviewed, failed: ids.length - reviewed } : { blocked: result.blocker.code };
  };
}
