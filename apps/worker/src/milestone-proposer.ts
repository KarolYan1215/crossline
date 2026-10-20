import { personProfileFor } from "./planning-profile";
import { randomUUID } from "node:crypto";
import {
  ARTIFACT_PLAN_SCHEMA, ARTIFACT_PLAN_VERSION, MILESTONE_PROPOSAL_SCHEMA, deriveArtifactRelations, goalSettingKey, keptArtifactPlan, lineArtifacts, mergeArtifactPlan,
  profileFactId, relationFulfilment, supplyWarnings, MILESTONE_DRAFTING_SETTING, readMilestoneDrafting, validateArtifactPlan, validateMilestoneProposal, keepMilestoneProposal, computeMilestoneConfidence,
  type ArtifactMilestone, type ArtifactPlanContext, type CheckedArtifactPlan, type LineArtifacts, type MilestoneProposal, type MilestoneProposalContext,
  type StoredArtifactPlan, type MilestoneDrafting,
  domainMilestoneTemplates
} from "@crossline/core";
import { continueSkillTurn, runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import {
  latestFileDates, readStoredArtifactPlan, relationChecks, retireUnderivedRelations, saveStoredArtifactPlan, syncArtifactRelations, type CrosslineStore
} from "@crossline/db";

/** Only for a ledger that has no workspace owner on record, which a real account never is. */
import { ownerOf } from "./owner";
import { identityLines } from "./lines";
export const MILESTONE_ARCHITECT_SKILL = "crossline:crossline-milestone-architect";
export const ARTIFACT_PLANNER_SKILL = "crossline:crossline-artifact-planner";

/**
 * The scenario in short, for the system prompt; the Skill holds the rules and the examples. It used to be a second, older copy of the
 * Skill (「three to five milestones per line」 long after a chain became per project) and the two disagreed.
 */
const INSTRUCTIONS = "Design milestones as the crossline-milestone-architect Skill describes and return only the requested JSON. "
  + "They become drafts on the person's 主线 page; once approved, tasks are worked back from their criteria and the scheduler plans toward their deadlines. "
  + "A milestone is a result that has happened by its deadline (an exam score, a submission, someone's reply), never an ongoing condition and never a task. "
  + "With a `profile` you design one line: at least three milestones in it, a chain of one to five for every project in requiredProjects, each with a plan "
  + "whose deadline is worked back from the dates in the profile, and every score line derived from plan.outcome with a bareLine and at least 3% margin, written "
  + "out in plan.derivation. A course with no target_grade on record gets one in targetProposals. The line's long-term goal (identities[].summary) is the "
  + "direction; never copy it into a title. Thin information is an assumption, not a blocker. With `artifacts`, declare plan.outputs and plan.inputs as the Skill says.";

const INSTRUCTIONS_ARTIFACTS = "Plan what each line in planLines produces this period and the few cross-line supply pairs, as the "
  + "crossline-artifact-planner Skill describes, and return only the requested JSON. The milestones of these lines are designed from this plan next, and "
  + "each pair becomes a link the person checks on the receiving milestone's deadline, so a pair names an artifact someone can hand over, a numeric "
  + "transfer with its unit, a lag in days and what the receiving line would spend or lack without it. At most two pairs leave a line, and none is a valid "
  + "answer. Never list again what `kept` holds. When `feedback` is present, fix what it names.";

export type ProposalOutcome =
  | { state: "proposed"; drafts: Array<{ id: string; identityId: string; title: string }>; assumptions: string[]; threadId?: string;
      /** Lines that came back with nothing (not enough to go on, or the run failed): the rest were still saved. */
      skipped?: Array<{ identityId: string; code: string; message: string }>;
      /** The cross-line relations derived after this run, and what could not be derived (with why). */
      relations?: { derived: string[]; refused: Array<{ artifactId: string; toMilestoneId: string; code: string; detail: string }> } }
  | { state: "blocked"; code: string; message: string };

/** What the person accepted from the web research, with the claims and pages behind each proposal. */
function acceptedDiligence(store: CrosslineStore, workspaceId: string): NonNullable<MilestoneProposalContext["diligence"]> {
  return store.listDiligenceReports(workspaceId).filter((report) => report.status === "done").flatMap((report) => {
    const findings = (report.findings as Array<{ id: string; claim: string; sourceIds: string[] }>) ?? [];
    const sources = (report.sources as Array<{ id: string; title: string; finalUrl?: string; url?: string }>) ?? [];
    return ((report.proposals as Array<{ title: string; why: string; kind: string; dueDate: string; findingIds: string[]; status: string }>) ?? [])
      .filter((proposal) => proposal.status === "accepted").map((proposal) => {
        const used = findings.filter((finding) => proposal.findingIds.includes(finding.id));
        const pages = new Set(used.flatMap((finding) => finding.sourceIds));
        return { identityId: report.scope, title: proposal.title, why: proposal.why, kind: proposal.kind, dueDate: proposal.dueDate,
          claims: used.map((finding) => finding.claim),
          sources: sources.filter((source) => pages.has(source.id)).map((source) => `${source.title} ${source.finalUrl ?? source.url ?? ""}`.trim()) };
      });
  });
}

/** A line is worth a whole chain only once the profile says something about it. */
const FACTS_PER_REQUIRED_LINE = 2;
/** A project the person has confirmed at least this much about must come back with a milestone. */
const CONFIRMED_FACTS_PER_REQUIRED_PROJECT = 3;

const isUntouchedDraft = (milestone: { status: string; version: number }) => milestone.status === "draft" && milestone.version === 1;

/**
 * A new proposal replaces the drafts the person never touched: they were someone's first guess, and asking again with more
 * information must not leave twelve stale ones beside the fifteen new ones for the person to sort out. Archived, not deleted,
 * and only version 1 — a draft the person edited or approved is theirs.
 *
 * The relations that touched them are no longer archived here in bulk: that is how redoing one line used to lose every cross-line link
 * for good. They are re-derived from the new drafts' references, and only those that cannot be derived again are retired
 * (`retireUnderivedRelations`).
 */
function supersedeUntouchedDrafts(store: CrosslineStore, workspaceId: string, keep: ReadonlySet<string>, lines: ReadonlySet<string>): void {
  // Only in the lines that got new drafts: a line whose run failed keeps the drafts the person already had.
  const old = store.listMilestones(workspaceId).filter((milestone) => isUntouchedDraft(milestone) && !keep.has(milestone.id) && lines.has(milestone.identityId));
  for (const milestone of old) store.saveMilestone({ ...milestone, status: "archived" });
}

/**
 * Every live milestone with its deadline (the confirmed one when the person set it, else the planned one) and the artifacts it produces and
 * uses — what the artifact plan is asked against and what relations are derived from. `exclude` leaves out drafts about to be replaced.
 */
export function artifactMilestones(store: CrosslineStore, workspaceId: string, exclude: (milestone: { id: string; identityId: string; status: string; version: number }) => boolean = () => false): ArtifactMilestone[] {
  const anchors = new Map(store.listMilestoneAnchors(workspaceId).map((anchor) => [anchor.milestoneId, anchor]));
  return store.listMilestones(workspaceId).filter((milestone) => milestone.status !== "archived" && !exclude(milestone)).map((milestone) => {
    const anchor = anchors.get(milestone.id);
    let confirmed: string | undefined;
    try { confirmed = (JSON.parse(store.getSetting(workspaceId, goalSettingKey(milestone.id)) ?? "{}") as { confirmedDeadline?: string }).confirmedDeadline; } catch { /* none */ }
    return { id: milestone.id, line: milestone.identityId, title: milestone.title, status: milestone.status,
      deadline: confirmed ?? anchor?.deadline, outputs: anchor?.outputs ?? [], inputs: anchor?.inputs ?? [] };
  });
}

/**
 * Derives the cross-line relations from the stored artifact plan and every live milestone's references, stores them (candidates until the
 * downstream milestone is approved; never one the person removed or a check refuted), retires the candidates that can no longer be derived,
 * and hands the new ones whose pair the loose checks flagged to the reviewer.
 */
export function rederiveArtifactRelations(store: CrosslineStore, workspaceId: string, labels: Record<string, string> = {}, options: { revised?: boolean } = {}) {
  const plan = readStoredArtifactPlan(store, workspaceId);
  const locked = new Set(store.listMilestoneRelations(workspaceId).filter((relation) => relation.status === "approved" && relation.artifactId).map((relation) => relation.id));
  const derived = deriveArtifactRelations(artifactMilestones(store, workspaceId), plan, { labels, locked });
  const ownerId = ownerOf(store, workspaceId);
  const before = new Set(store.listMilestoneRelations(workspaceId).map((relation) => relation.id));
  const { saved } = syncArtifactRelations(store, workspaceId, ownerId, derived.relations);
  retireUnderivedRelations(store, workspaceId, new Set(derived.relations.map((relation) => relation.id)));
  for (const relation of derived.relations.filter((item) => saved.includes(item.id) && !before.has(item.id))) {
    const warnings = supplyWarnings({ use: relation.use, counterfactual: relation.counterfactual, hoursSaved: relation.transfer.hoursSaved });
    if (!warnings.length) continue;
    const version = store.listEvents(workspaceId, { type: "validation.warned", entityId: relation.id }).length + 1;
    store.appendEvent({ ownerId, workspaceId, idempotencyKey: `validation.warned:milestone_relation:${relation.id}:${version}`, type: "validation.warned",
      entityId: relation.id, payload: { subject: "milestone_relation", version, warnings, revised: Boolean(options.revised) } });
  }
  return { derived: derived.relations.map((relation) => relation.id), refused: derived.refused };
}

export function buildProposalContext(store: CrosslineStore, workspaceId: string, request: string,
  options: { requireChains?: boolean; replaceUntouchedDrafts?: boolean; now?: () => Date } = {}): MilestoneProposalContext {
  // Drafts nobody has touched are about to be replaced, so they are not precedent to avoid duplicating: left in, the model could
  // not reuse a title it had just been asked to improve on.
  // An archived milestone is retired, not precedent: a real run read 「已有归档里程碑覆盖最终投稿」 and left the paper's 10/31 submission
  // out, because the archived copies of exactly those milestones (retired by the previous design) were still in its list of what exists.
  const milestones = store.listMilestones(workspaceId).filter((milestone) => milestone.status !== "archived"
    && !(options.replaceUntouchedDrafts && isUntouchedDraft(milestone)));
  const facts = store.listProfileFacts(workspaceId);
  const identities = identityLines(store, workspaceId);
  // A domain line's templates are added the first time its milestones are designed (INSERT OR IGNORE: a person's own edits stay).
  for (const pack of identities) if (pack.domain) store.seedMilestoneTemplates(workspaceId, domainMilestoneTemplates(pack.id, pack.domain));
  const now = options.now?.() ?? (process.env.CROSSLINE_FIXED_NOW ? new Date(process.env.CROSSLINE_FIXED_NOW) : new Date());
  return {
    // How the person works and what the plan serves (planningProfile): every line's chain is paced for this person.
    personProfile: personProfileFor(store, workspaceId),
    version: "crossline.milestone-proposal.v1",
    // A line's long-term goal, when the person gave one, is what its milestones are worked toward.
    // The attributes the person chose are named too, so the milestones serve what they adopted and nothing the model adds to it.
    identities: identities.map((pack) => ({ id: pack.id, label: pack.label, summary: pack.goal
      ? `长期目标：${pack.goal}${pack.goalParts?.length ? `（本人选定的定语：${pack.goalParts.join("；")}）` : ""}` : pack.workflowTemplates.join(", ")
      // A domain line's milestones are numbers against the person's own baseline (its facts' health_* / wealth_* slots), never advice.
      + (pack.domain === "wealth" ? "。财富领域：里程碑是可核对的数字（应急金月数、储蓄率、还清的负债），不含买卖建议" : "")
      + (pack.domain === "wellness" ? "。健康领域：里程碑是可测的数字（体重、每周运动次数、配速、体检指标），尊重 health_limits，不含医疗建议" : "") })),
    // Drafts are included so the Skill does not re-propose something already waiting for a decision.
    existingMilestones: milestones.map((milestone) => ({
      id: milestone.id, identityId: milestone.identityId, title: milestone.title, status: milestone.status
    })),
    recentWork: store.listWorkOrders(workspaceId).slice(-20).map((order) => ({
      milestoneId: order.milestoneId ?? "", intent: order.intent, state: order.state
    })),
    templates: store.listMilestoneTemplates(workspaceId).map((template) => ({
      id: template.id, identityId: template.identityId, kind: template.kind, titleHint: template.titleHint
    })),
    request: request.slice(0, 2000),
    personalPreferences: store.preferenceLines(workspaceId, identities.map((pack) => pack.id), 20),
    ...(acceptedDiligence(store, workspaceId).length ? { diligence: acceptedDiligence(store, workspaceId) } : {}),
    ...(facts.length ? { profile: {
      today: now.toISOString().slice(0, 10),
      requiredIdentities: options.requireChains
        // At least one fact the person confirmed: a milestone must rest on one (a chain built only on guesses is refused), so a line with
        // only guesses cannot be asked for — the model, rightly, answered that it could not, and the line was lost with a blocker.
        ? identities.map((pack) => pack.id).filter((id) => {
            const own = facts.filter((fact) => fact.identityId === id);
            return own.length >= FACTS_PER_REQUIRED_LINE && own.some((fact) => fact.status === "confirmed");
          })
        : [],
      projects: store.listProjects(workspaceId).map(({ id, identityId, name }) => ({ id, identityId, name })),
      dates: latestFileDates(store, workspaceId).dates,
      undated: latestFileDates(store, workspaceId).undated,
      requiredProjects: options.requireChains
        ? store.listProjects(workspaceId).map((project) => project.id)
            .filter((id) => facts.filter((fact) => fact.projectId === id && fact.status === "confirmed").length >= CONFIRMED_FACTS_PER_REQUIRED_PROJECT)
        : [],
      facts: facts.map((fact) => ({ id: profileFactId(fact), identityId: fact.identityId, projectId: fact.projectId,
        slot: fact.slot, value: fact.value, status: fact.status }))
    } } : {})
  };
}

/**
 * Example milestones and work orders the app used to seed so a new board was not empty. Once the person has a profile they are
 * archived (kept, never deleted) so the new ones are not judged against a placeholder, and the relations that
 * only connected placeholders go with them.
 */
function retireStarterExamples(store: CrosslineStore, workspaceId: string): void {
  // Version 1 only: a starter the person revised is theirs now.
  const starters = store.listMilestones(workspaceId)
    .filter((milestone) => milestone.id.endsWith("-starter") && milestone.version === 1 && milestone.status !== "archived");
  const retired = new Set(starters.map((milestone) => milestone.id));
  for (const milestone of starters) store.saveMilestone({ ...milestone, status: "archived" });
  for (const relation of store.listMilestoneRelations(workspaceId)) {
    if (relation.status !== "archived" && (retired.has(relation.fromMilestoneId) || retired.has(relation.toMilestoneId))) {
      store.saveMilestoneRelation({ ...relation, status: "archived" });
    }
  }
  // Example work orders that were never touched. An accepted one is real history and stays.
  for (const order of store.listWorkOrders(workspaceId)) {
    if ((order.payload as { seeded?: boolean }).seeded && !["accepted", "archived", "active"].includes(order.state)) {
      store.transitionWorkOrder(workspaceId, order.id, { type: "archived" }, `archive:${order.id}`);
    }
  }
}

/**
 * Asks the architect Skill for new milestones and stores them as drafts.
 *
 * Drafts, never approved ones: analysis only offers approved milestones and the gate only judges
 * against them, so a draft is inert until the user says otherwise. A system that could approve its own
 * milestones would be choosing what the person is working towards, which is the one decision that
 * cannot be delegated here.
 */
export function createMilestoneProposer(store: CrosslineStore, workspaceId: string, cwd: string,
  getClient: () => CodexRpcBoundary | undefined, now?: () => Date) {
  /** One architect run, validated against exactly the context it was given. */
  async function runLine(client: CodexRpcBoundary, context: MilestoneProposalContext, signal?: AbortSignal) {
    let threadId: string | undefined;
    const result = await runCodexSkill<MilestoneProposal>(client, context, {
      skillName: MILESTONE_ARCHITECT_SKILL,
      cwd,
      // The person may answer this proposal in a conversation (`continueConversation` below).
      keepThread: true,
      developerInstructions: INSTRUCTIONS,
      outputSchema: MILESTONE_PROPOSAL_SCHEMA,
      prepareInput: () => context,
      validateOutput: (output) => validateMilestoneProposal(output, context),
      // Quality refusals still standing after the repairs keep the line, with a warning for the reviewer.
      softAccept: (rejection, output) => keepMilestoneProposal(output, context, rejection.message),
      onAudit: (audit) => { threadId = audit.threadId; },
      ...(signal ? { signal } : {}),
      timeoutMs: 60 * 60_000
    });
    return { result, threadId };
  }

  /**
   * The artifact plan for `planLines`, before any of their milestones is designed: everything else in the stored plan is kept as it is, and
   * the answer is merged into it. A failed run leaves the stored plan in place, so the lines are still designed against what was planned.
   */
  async function planArtifacts(client: CodexRpcBoundary, context: MilestoneProposalContext, planLines: string[], replaced: (milestone: { id: string; identityId: string; status: string; version: number }) => boolean,
    signal?: AbortSignal, feedback?: string): Promise<{ plan: StoredArtifactPlan; note?: string; checked?: CheckedArtifactPlan }> {
    const stored = readStoredArtifactPlan(store, workspaceId);
    const milestones = artifactMilestones(store, workspaceId, replaced);
    const kept = keptArtifactPlan(stored, milestones, planLines);
    const facts = context.profile?.facts ?? [];
    const lines = identityLines(store, workspaceId);
    const planContext: ArtifactPlanContext = {
      version: ARTIFACT_PLAN_VERSION, today: context.profile?.today ?? new Date().toISOString().slice(0, 10), planLines,
      lines: lines.map((pack) => ({ id: pack.id, label: pack.label, goal: pack.goal ?? "",
        facts: facts.filter((fact) => fact.identityId === pack.id && !fact.slot.startsWith("flywheel_"))
          .sort((a, b) => (a.status === b.status ? 0 : a.status === "confirmed" ? -1 : 1)).slice(0, 40)
          .map(({ id, projectId, slot, value, status }) => ({ id, projectId, slot, value, status })) })),
      milestones: milestones.map((milestone) => ({ id: milestone.id, line: milestone.line, projectId: store.getMilestone(workspaceId, milestone.id)?.projectId ?? "",
        title: milestone.title, status: milestone.status, deadline: milestone.deadline ?? "", outputs: milestone.outputs, inputs: milestone.inputs })),
      flywheelFacts: facts.filter((fact) => fact.slot.startsWith("flywheel_")).map((fact) => ({ id: fact.id, line: fact.identityId, slot: fact.slot, value: fact.value, status: fact.status })),
      kept: { artifacts: kept.artifacts, supplies: kept.supplies },
      lowFulfilment: relationFulfilment(relationChecks(store, workspaceId)).low,
      ...(feedback ? { feedback: feedback.slice(0, 2000) } : {})
    };
    const result = await runCodexSkill<CheckedArtifactPlan>(client, planContext, {
      skillName: ARTIFACT_PLANNER_SKILL, cwd, developerInstructions: INSTRUCTIONS_ARTIFACTS, outputSchema: ARTIFACT_PLAN_SCHEMA,
      prepareInput: () => planContext, validateOutput: (output) => validateArtifactPlan(output, planContext),
      onAudit: () => {}, ...(signal ? { signal } : {}), timeoutMs: 60 * 60_000
    });
    if (!result.ok) return { plan: stored, note: result.blocker.message };
    const at = new Date().toISOString();
    const plan = mergeArtifactPlan(kept, result.output, at);
    saveStoredArtifactPlan(store, workspaceId, plan);
    const round = store.listEvents(workspaceId, { type: "artifact_plan.saved" }).length;
    store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `artifact_plan.saved:${round}`, type: "artifact_plan.saved", entityId: "artifact-plan",
      payload: { planLines, artifacts: result.output.artifacts.map((artifact) => artifact.id), supplies: result.output.supplies.length,
        dropped: result.output.dropped, warnings: result.output.warnings, assumptions: result.output.assumptions } });
    return { plan, checked: result.output };
  }

  /** `only` limits the run to those lines: changing a course's target redoes its line, not the whole board. */
  /** `options.revised` marks a run the reviewer asked for, so its own warnings are not sent back for another redo; `options.feedback` is its brief for the artifact plan. */
  return async function propose(request: string, signal?: AbortSignal, only?: string[], options?: { revised?: boolean; feedback?: string }): Promise<ProposalOutcome> {
    const client = getClient();
    if (!client) return { state: "blocked", code: "CODEX_SUPERVISOR_UNAVAILABLE", message: "Codex 运行时不可用。" };

    // The starters go first: they would otherwise sit in `existingMilestones` and be offered back as precedent.
    if (store.listProfileFacts(workspaceId).length) retireStarterExamples(store, workspaceId);
    const context = buildProposalContext(store, workspaceId, request, { requireChains: true, replaceUntouchedDrafts: true, ...(now ? { now } : {}) });
    if (!context.identities.length) {
      return { state: "blocked", code: "NO_IDENTITIES", message: "没有身份包，无法提议里程碑。" };
    }

    const allLines = context.profile?.requiredIdentities ?? [];
    const lines = allLines.filter((id) => !only?.length || only.includes(id));
    // Without a profile there is nothing to split by: one run over everything, as before.
    if (!allLines.length) {
      const { result, threadId } = await runLine(client, context, signal);
      if (!result.ok) return { state: "blocked", code: result.blocker.code, message: result.blocker.message };
      persistTargetProposals(store, workspaceId, result.output.targetProposals ?? []);
      const drafts = persistProposals(store, workspaceId, result.output.milestones, context.request);
      supersedeUntouchedDrafts(store, workspaceId, new Set(drafts.map((draft) => draft.id)), new Set(drafts.map((draft) => draft.identityId)));
      const relations = rederiveArtifactRelations(store, workspaceId, labelsOf(context), { revised: Boolean(options?.revised) });
      return { state: "proposed", drafts, assumptions: result.output.assumptions, relations, ...(threadId ? { threadId } : {}) };
    }

    if (!lines.length) return { state: "blocked", code: "NO_MATCHING_LINE", message: "该主线信息不足或没有已确认的事实，未重新设计。" };

    // One run per line. A single answer for every line was eleven to fifteen milestones — about four and a half minutes a turn, so
    // that not even one repair fitted in a deadline — and one line's trouble (a thin profile, a refused date) threw away the lines
    // that had been done well. Per line the answer is a few milestones, a repair is cheap, and what succeeds is kept.
    const drafts: Array<{ id: string; identityId: string; title: string }> = [];
    const assumptions: string[] = [];
    const skipped: Array<{ identityId: string; code: string; message: string }> = [];
    let lastThread: string | undefined;
    // Progress for the 主线 page, line by line (`MILESTONE_DRAFTING_SETTING`). A run limited to some lines keeps what the last run said
    // about the others.
    const previous = readMilestoneDrafting(store.getSetting(workspaceId, MILESTONE_DRAFTING_SETTING));
    const others = <T>(list: T[] | undefined, lineOf: (item: T) => string) => (list ?? []).filter((item) => !lines.includes(lineOf(item)));
    const drafting: MilestoneDrafting = { startedAt: clockNow(now).toISOString(), lines, done: [],
      skipped: others(previous?.skipped, (item) => item.lineId),
      thin: [...others(previous?.thin, (line) => line), ...thinLines(context, allLines).filter((id) => !only?.length || only.includes(id))] };
    const saveDrafting = () => store.setSetting(workspaceId, MILESTONE_DRAFTING_SETTING, JSON.stringify(drafting));
    saveDrafting();
    // Drafts about to be replaced (untouched, in a line designed now, not from this run) are neither producers nor consumers any more.
    const planned = new Set(lines);
    const replaced = (milestone: { id: string; identityId: string; status: string; version: number }) =>
      isUntouchedDraft(milestone) && planned.has(milestone.identityId) && !drafts.some((draft) => draft.id === milestone.id);
    // Artifacts first, for every line designed now, when more than one line has anything on record to plan between.
    const crossLine = new Set((context.profile?.facts ?? []).map((fact) => fact.identityId)).size >= 2;
    let plan = readStoredArtifactPlan(store, workspaceId);
    if (crossLine && !signal?.aborted) {
      const planning = await planArtifacts(client, context, lines, replaced, signal, options?.feedback);
      plan = planning.plan;
      if (planning.note) assumptions.push(`跨主线产物计划本次未生成，按上次的计划设计：${planning.note}`);
      for (const line of planning.checked?.dropped ?? []) assumptions.push(line);
    }
    for (const identityId of lines) {
      if (signal?.aborted) break;
      // Recomputed per line: a line designed earlier in this run is already a producer or consumer for the next one.
      const own = lineContext(context, identityId, crossLine ? lineArtifacts(plan, identityId, artifactMilestones(store, workspaceId, replaced), labelsOf(context)) : undefined);
      const { result, threadId } = await runLine(client, own, signal);
      if (threadId) lastThread = threadId;
      if (!result.ok) {
        skipped.push({ identityId, code: result.blocker.code, message: result.blocker.message });
        drafting.skipped.push({ lineId: identityId, why: `这次没有设计出来：${result.blocker.message}` });
        saveDrafting();
        continue;
      }
      persistTargetProposals(store, workspaceId, result.output.targetProposals ?? []);
      const saved = persistProposals(store, workspaceId, result.output.milestones, context.request, own.artifacts);
      drafts.push(...saved);
      drafting.done.push(identityId);
      saveDrafting();
      if (result.audit.warnings?.length) {
        const entityId = `line:${identityId}`;
        const version = store.listEvents(workspaceId, { type: "validation.warned", entityId }).length + 1;
        store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `validation.warned:milestone_line:${identityId}:${version}`,
          type: "validation.warned", entityId, payload: { subject: "milestone_line", version, warnings: result.audit.warnings,
            revised: Boolean(options?.revised), milestoneIds: saved.map((draft) => draft.id) } });
      }
      assumptions.push(...result.output.assumptions);
      for (const proposal of result.output.targetProposals ?? []) {
        const name = context.profile?.projects.find((project) => project.id === proposal.projectId)?.name ?? proposal.projectId;
        assumptions.push(`「${name}」分数线暂定为 ${proposal.value}（${proposal.why}）；各里程碑的分数线均由此倒推，可在「主线」页修改并重算。`);
      }
    }
    drafting.finishedAt = clockNow(now).toISOString();
    saveDrafting();
    if (!drafts.length) {
      return { state: "blocked", code: skipped[0]?.code ?? "PROPOSAL_EMPTY",
        message: skipped.map((item) => `${labelOf(context, item.identityId)}：${item.message}`).join("；").slice(0, 400) || "没有生成任何里程碑。" };
    }
    // Only the lines that got new drafts lose their old untouched ones: a line that failed keeps what the person already had.
    supersedeUntouchedDrafts(store, workspaceId, new Set(drafts.map((draft) => draft.id)), new Set(drafts.map((draft) => draft.identityId)));
    for (const item of skipped) assumptions.push(`「${labelOf(context, item.identityId)}」主线本次未生成：${item.message}`);
    for (const identityId of thinLines(context, allLines).filter((id) => !only?.length || only.includes(id))) assumptions.push(`「${labelOf(context, identityId)}」主线信息不足或仅有推断，暂未设计里程碑；在访谈中补充或确认后重新设计。`);

    // The links between lines follow from the references; nothing is asked of the model for them.
    const relations = rederiveArtifactRelations(store, workspaceId, labelsOf(context), { revised: Boolean(options?.revised) });
    return { state: "proposed", drafts, assumptions, relations, ...(skipped.length ? { skipped } : {}), ...(lastThread ? { threadId: lastThread } : {}) };
  };
}

/** The clock a run reads, as the context does: the test seam, else `CROSSLINE_FIXED_NOW`, else now. */
const clockNow = (now?: () => Date) => now?.() ?? (process.env.CROSSLINE_FIXED_NOW ? new Date(process.env.CROSSLINE_FIXED_NOW) : new Date());

const labelsOf = (context: MilestoneProposalContext) => Object.fromEntries(context.identities.map((identity) => [identity.id, identity.label]));
const labelOf = (context: MilestoneProposalContext, identityId: string) => context.identities.find((item) => item.id === identityId)?.label ?? identityId;

/** Lines the profile has something about but too little for a chain; they are named so the person knows why they are absent. */
const thinLines = (context: MilestoneProposalContext, asked: string[]): string[] =>
  context.identities.map((identity) => identity.id).filter((id) => !asked.includes(id) && (context.profile?.facts.some((fact) => fact.identityId === id) ?? false));

/**
 * The context for one line's run: its own identity, projects, facts and templates, so everything the validator holds the answer to
 * (the identity it may name, the projects it must cover, the chain it owes) is about this line alone.
 */
function lineContext(context: MilestoneProposalContext, identityId: string, artifacts?: LineArtifacts): MilestoneProposalContext {
  const profile = context.profile!;
  const ownProjects = profile.projects.filter((project) => project.identityId === identityId);
  return {
    ...context,
    ...(artifacts ? { artifacts } : {}),
    identities: context.identities.filter((identity) => identity.id === identityId),
    templates: context.templates.filter((template) => template.identityId === identityId),
    ...(context.diligence ? { diligence: context.diligence.filter((item) => item.identityId === identityId) } : {}),
    profile: {
      ...profile,
      requiredIdentities: [identityId],
      requiredProjects: (profile.requiredProjects ?? []).filter((id) => ownProjects.some((project) => project.id === id)),
      dates: (profile.dates ?? []).filter((entry) => ownProjects.some((project) => project.id === entry.project)),
      undated: (profile.undated ?? []).filter((entry) => ownProjects.some((project) => project.id === entry.project)),
      projects: ownProjects,
      facts: profile.facts.filter((fact) => fact.identityId === identityId)
    }
  };
}

export type ConversationOutcome =
  | { state: "proposed"; drafts: Array<{ id: string; identityId: string; title: string }>; assumptions: string[] }
  | { state: "blocked"; code: string; message: string };

/**
 * A follow-up message on a thread a previous `propose` call already opened — the conversational path
 * item 8 asked for, so the person can steer the architect ("再窄一点"/"这个方向我不想要") instead of
 * getting one shot per click. Still proposal-only: the reply is validated against the exact same schema
 * and lands as `draft` milestones through the same save path, so approval never moves off the existing
 * batch-approval button.
 */
export function createMilestoneConversation(store: CrosslineStore, workspaceId: string, cwd: string,
  getClient: () => CodexRpcBoundary | undefined) {
  return async function continueConversation(threadId: string, message: string, signal?: AbortSignal): Promise<ConversationOutcome> {
    const client = getClient();
    if (!client) return { state: "blocked", code: "CODEX_SUPERVISOR_UNAVAILABLE", message: "Codex 运行时不可用。" };
    // The existing milestones list is re-read fresh so a reply cannot duplicate a draft the first turn
    // already produced — `validateMilestoneProposal` checks titles against whatever context it is given.
    const context = buildProposalContext(store, workspaceId, message);

    const result = await continueSkillTurn<MilestoneProposal>(client, threadId, message.slice(0, 2000), {
      skillName: MILESTONE_ARCHITECT_SKILL,
      cwd,
      outputSchema: MILESTONE_PROPOSAL_SCHEMA,
      validateOutput: (output) => validateMilestoneProposal(output, context),
      onAudit: () => {},
      ...(signal ? { signal } : {}),
      timeoutMs: 60 * 60_000
    });
    if (!result.ok) return { state: "blocked", code: result.blocker.code, message: result.blocker.message };

    persistTargetProposals(store, workspaceId, result.output.targetProposals ?? []);
    const drafts = persistProposals(store, workspaceId, result.output.milestones, context.request);
    return { state: "proposed", drafts, assumptions: result.output.assumptions };
  };
}

/**
 * Shared by `propose` and `continueConversation`: writes each proposed milestone as a `draft`, with its
 * confidence computed deterministically from whichever template (if any) it was built from —
 * `computeMilestoneConfidence` reads the shape match, not a model self-rating (`crossline-milestone-
 * architect/SKILL.md` already forbids the Skill from emitting a numeric score; the same reasoning applies
 * to confidence).
 */
/**
 * A target the architect proposed for a course, kept as an unconfirmed profile fact: it shows on the Milestones page with its reason and
 * the person changes it in one click. A target already on record (theirs, or an earlier proposal they have since confirmed) is never
 * overwritten by a new proposal.
 */
export function persistTargetProposals(store: CrosslineStore, workspaceId: string, proposals: Array<{ projectId: string; value: string; why: string }>): void {
  const now = new Date().toISOString();
  for (const proposal of proposals) {
    const project = store.listProjects(workspaceId).find((item) => item.id === proposal.projectId);
    if (!project) continue;
    const existing = store.listProfileFacts(workspaceId, { projectId: project.id }).find((fact) => fact.slot === "target_grade");
    if (existing) continue;
    store.upsertProfileFact({ workspaceId, identityId: project.identityId, projectId: project.id, slot: "target_grade",
      value: `${proposal.value.trim()}（暂定：${proposal.why.trim()}）`, status: "inferred", sourceRef: "inference", sourceQuote: "", updatedAt: now });
  }
}

function persistProposals(store: CrosslineStore, workspaceId: string,
  milestones: MilestoneProposal["milestones"], request: string, artifacts?: LineArtifacts): Array<{ id: string; identityId: string; title: string }> {
  // Only ids the run was given are stored: a reference to nothing would derive nothing, and would read as a promise on the board.
  const produced = new Set(artifacts?.produce.map((item) => item.id) ?? []);
  const consumed = new Set(artifacts?.consume.map((item) => item.id) ?? []);
  const templates = store.listMilestoneTemplates(workspaceId);
  const ownerId = ownerOf(store, workspaceId);
  const drafts: Array<{ id: string; identityId: string; title: string }> = [];
  // Real ids are assigned first so a `dependsOn` written in the answer's own keys can be turned into them.
  const idByKey = new Map(milestones.flatMap((proposal) => proposal.plan ? [[proposal.plan.key, `proposed-${randomUUID()}`] as const] : []));
  for (const proposal of milestones) {
    const id = (proposal.plan && idByKey.get(proposal.plan.key)) ?? `proposed-${randomUUID()}`;
    const template = proposal.templateId ? templates.find((item) => item.id === proposal.templateId) : undefined;
    const confidence = computeMilestoneConfidence(proposal.successCriteria, template);
    // A template-backed proposal's bank comes from the template itself, the same deterministic-over-
    // self-reported reasoning `confidence` already uses — a free-form proposal's bank is the model's own.
    const evidenceQuestionBank = template?.evidenceQuestionDefaults ?? proposal.evidenceQuestionBank;
    store.saveMilestone({
      id, ownerId, workspaceId,
      identityId: proposal.identityId, projectId: proposal.projectId,
      title: proposal.title, version: 1, status: "draft",
      successCriteria: proposal.successCriteria,
      ...(proposal.templateId ? { templateId: proposal.templateId } : {}), confidence,
      ...(evidenceQuestionBank.length ? { evidenceQuestionBank } : {})
    });
    if (proposal.plan) {
      store.saveMilestoneAnchor({
        workspaceId, milestoneId: id, stage: proposal.plan.stage, deadline: proposal.plan.deadline,
        baseline: proposal.plan.baseline, target: proposal.plan.target, stakeholders: proposal.plan.stakeholders,
        sourceFactIds: proposal.plan.sourceFactIds,
        dependsOn: proposal.plan.dependsOn.map((dependency) => idByKey.get(dependency) ?? dependency),
        outputs: (proposal.plan.outputs ?? []).filter((id) => produced.has(id)), inputs: (proposal.plan.inputs ?? []).filter((id) => consumed.has(id)),
        updatedAt: new Date().toISOString()
      });
    }
    store.appendEvent({
      ownerId, workspaceId,
      idempotencyKey: `milestone:proposed:${id}`,
      type: "milestone.proposed", entityId: id,
      // The rationale is kept with the proposal: judging a milestone without knowing why it was
      // suggested is the same problem as approving a relation with no stated claim.
      payload: { rationale: proposal.plan ? `${proposal.rationale}
从结果倒推：${proposal.plan.outcome.replace(/[。.\s]+$/, "")}。${proposal.plan.derivation}` : proposal.rationale, request }
    });
    drafts.push({ id, identityId: proposal.identityId, title: proposal.title });
  }
  return drafts;
}

/**
 * The reviewer's redo for one cross-line relation: relations are no longer proposed, so a link that should claim something else is fixed
 * where it comes from — the receiving line is designed again (its artifact part and its untouched drafts), with the reviewer's notes as
 * the brief, and the relations are derived again from the new drafts. One that is no longer derived is retired.
 */
export function createRelationReviser(store: CrosslineStore, workspaceId: string, cwd: string, getClient: () => CodexRpcBoundary | undefined, now?: () => Date) {
  return async function revise(relationId: string, notes: string): Promise<void> {
    const relation = store.getMilestoneRelation(workspaceId, relationId);
    if (!relation || relation.status !== "candidate") return;
    const downstream = store.listMilestones(workspaceId).find((milestone) => milestone.id === relation.toMilestoneId);
    if (!downstream) return;
    await createMilestoneProposer(store, workspaceId, cwd, getClient, now)(`复核意见（飞轮关系「${relation.explanation ?? relation.id}」）：${notes}`, undefined,
      [downstream.identityId], { revised: true, feedback: notes });
  };
}
