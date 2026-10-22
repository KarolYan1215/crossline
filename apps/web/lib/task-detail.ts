import "server-only";
import { archetypeById, completionRule, preparesOf, STEP_ANSWER_SLOT, stepAnswerSlot, finishedSteps, goalSettingKey, proposalReady, producedArtifacts, relevantDocuments, taskProgress, taskTitleOf, usedArtifacts, type AccessContext, type Preparation, type SuccessCriterion,
  type EvidenceQuestionTemplate } from "@crossline/core";
import { doneKinds, listAgentTasks, needStatesOf, preparationOf, readStoredArtifactPlan, type CrosslineStore, type StoredMilestone, type StoredWorkOrder, type StoredMaterial, type StoredExecution, type StoredMilestoneRelation,
  type StoredBackgroundFact, type StoredStepPlan, type StoredTaskStep } from "@crossline/db";
import { defaultIdentityPacks, identityPacksFor } from "@crossline/identity-packs";
import { effectiveSchedulePreferences, getStore, resolvedEstimate, relationKindLabel, accents, suggestedSessionMinutes } from "./crossline";
import { linePacks } from "./lines";

const quartersOfVerdict: Record<string, number> = { met: 4, partial: 2, unmet: 0, unverifiable: 0 };

/**
 * One read per table for a set of orders, then per-order extras. Both the single and the batch tier use it, so a card and the page it
 * opens always agree.
 */
function taskExtras(store: CrosslineStore, workspaceId: string, orders: StoredWorkOrder[]): Map<string, TaskExtras> {
  const ids = new Set(orders.map((order) => order.id));
  const projects = new Map(store.listProjects(workspaceId, { includeArchived: true }).map((project) => [project.id, project.name]));
  const allPlans = store.listStepPlans(workspaceId);
  const plans = new Map(allPlans.filter((plan) => ids.has(plan.workOrderId)).map((plan) => [plan.workOrderId, plan]));
  const done = doneKinds(store, workspaceId, allPlans);
  const milestones = new Map(store.listMilestones(workspaceId).map((milestone) => [milestone.id, milestone]));
  const anchors = new Map(store.listMilestoneAnchors(workspaceId).map((anchor) => [anchor.milestoneId, anchor.deadline]));
  const relations = store.listMilestoneRelations(workspaceId).filter((relation) => relation.status === "approved" || relation.status === "candidate");
  const labels = new Map(identityPacksFor((key) => store.getSetting(workspaceId, key), { includeArchived: true }).map((pack) => [pack.id, pack.label]));
  const executions = store.listExecutions(workspaceId);
  const documents = store.listSourceDocuments(workspaceId);
  // The assistant's own items for these tasks (`payload.prepares`, docs/work-split.md): what they made is the task's 「已备好」.
  const preparedFor = new Map(store.listWorkOrders(workspaceId).filter((order) => ids.has(preparesOf(order))).map((order) => [order.id, preparesOf(order)]));
  const agentTasks = listAgentTasks(store, workspaceId).filter((task) => ids.has(task.workOrderId) || preparedFor.has(task.workOrderId))
    .map((task) => preparedFor.has(task.workOrderId) ? { ...task, workOrderId: preparedFor.get(task.workOrderId)!, stepId: "" } : task);
  const confirmed = store.listEvents(workspaceId, { type: "criterion.confirmed" });
  const assessed = store.listEvents(workspaceId, { type: "criteria.assessed" });
  const notes = store.listEvents(workspaceId, { type: "task.note" }).filter((event) => ids.has(event.entityId));
  const artifactPlan = readStoredArtifactPlan(store, workspaceId);
  const artifactsById = new Map(artifactPlan.artifacts.map((artifact) => [artifact.id, artifact]));
  const liveOrders = store.listWorkOrders(workspaceId).filter((order) => order.state !== "archived");
  const label = (line: string) => labels.get(line) ?? line;
  const artifactRelations = relations.filter((relation) => relation.artifactId);
  const planBlocked = new Set(store.listEvents(workspaceId, { type: "task.steps_blocked" }).map((event) => event.entityId));
  const capacity = new Set(defaultIdentityPacks().filter((pack) => pack.kind === "capacity").map((pack) => pack.id));
  // Answers to step questions are kept per project (`step_answer_<hash>`): the person's own, or an assumption the app wrote (「假设：」).
  const stepAnswers = new Map(store.listProfileFacts(workspaceId).filter((fact) => fact.slot.startsWith(STEP_ANSWER_SLOT))
    .map((fact) => [`${fact.projectId}|${fact.slot}`, fact]));
  const answerOf = (projectId: string, question: string): StepQuestionView["answer"] => {
    const fact = stepAnswers.get(`${projectId}|${stepAnswerSlot(question)}`);
    if (!fact) return undefined;
    const text = fact.value.replace(/^假设：/, "").replace(/^【[^】]*】/, "");
    return { text, assumed: fact.status !== "confirmed" };
  };
  const result = new Map<string, TaskExtras>();
  for (const order of orders) {
    const payload = (order.payload ?? {}) as { notBefore?: string; dueDate?: string; byproducts?: Array<{ lineId: string; artifact: string }>;
      gateReview?: { criteriaVerdict?: Array<{ criterionId: string; met: string; observed: string }> } };
    let goalDeadline: string | undefined;
    try { goalDeadline = (JSON.parse(store.getSetting(workspaceId, goalSettingKey(order.milestoneId)) ?? "{}") as { confirmedDeadline?: string }).confirmedDeadline; } catch { /* none */ }
    const dueBy = [payload.dueDate, goalDeadline, anchors.get(order.milestoneId)].filter((value): value is string => Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value))).sort()[0];
    const plan = plans.get(order.id);
    const milestone = milestones.get(order.milestoneId);
    const supports = [
      ...relations.filter((relation) => relation.fromMilestoneId === order.milestoneId).flatMap((relation) => {
        const target = milestones.get(relation.toMilestoneId);
        return target && target.identityId !== order.identityId ? [{ line: target.identityId, lineLabel: labels.get(target.identityId) ?? target.identityId,
          target: target.title, ...(relation.explanation ? { artifact: relation.explanation } : {}), pending: relation.status === "candidate" }] : [];
      }),
      ...(payload.byproducts ?? []).map((item) => ({ line: item.lineId, lineLabel: labels.get(item.lineId) ?? item.lineId, target: item.artifact, artifact: item.artifact, pending: false }))
    ];
    // 「产出供 自媒体 · …」 and 「使用 研究 · … 的产出」: the task-level side of the artifact relations. A byproduct is already in `supports`.
    const artifactLinks: NonNullable<TaskExtras["artifactLinks"]> = [
      ...producedArtifacts(order).filter((id) => !id.startsWith("byproduct:")).flatMap((id) => {
        const artifact = artifactsById.get(id);
        const users = liveOrders.filter((other) => other.id !== order.id && usedArtifacts(other).includes(id));
        const downstream = artifactRelations.filter((relation) => relation.artifactId === id && relation.fromMilestoneId === order.milestoneId)
          .flatMap((relation) => { const target = milestones.get(relation.toMilestoneId); return target ? [target] : []; });
        const targets = users.length ? users.map((user) => ({ line: user.identityId, title: taskTitleOf(user) }))
          : downstream.length ? downstream.map((target) => ({ line: target.identityId, title: target.title }))
          : artifactPlan.supplies.filter((pair) => pair.from === id).map((pair) => ({ line: pair.toLine, title: pair.use }));
        return targets.map((target) => ({ direction: "produces" as const, line: target.line, lineLabel: label(target.line), title: target.title, artifact: artifact?.title ?? id }));
      }),
      ...usedArtifacts(order).flatMap((id) => {
        const producer = liveOrders.find((other) => other.id !== order.id && producedArtifacts(other).includes(id));
        const artifact = artifactsById.get(id);
        if (producer) return [{ direction: "uses" as const, line: producer.identityId, lineLabel: label(producer.identityId), title: taskTitleOf(producer), artifact: artifact?.title ?? taskTitleOf(producer) }];
        return artifact ? [{ direction: "uses" as const, line: artifact.line, lineLabel: label(artifact.line), title: artifact.title, artifact: artifact.title }] : [];
      })
    ];
    const worked = executions.filter((execution) => execution.workOrderId === order.id && execution.durationObserved).reduce((sum, execution) =>
      sum + Math.max(0, Math.round(((execution.endedAt ? Date.parse(execution.endedAt) : Date.now()) - Date.parse(execution.startedAt)) / 60_000) - execution.pauseMinutes), 0);
    const verdicts = new Map((payload.gateReview?.criteriaVerdict ?? []).map((item) => [item.criterionId, item]));
    const latestAssessment = new Map<string, { quarters: number; note: string }>();
    for (const event of assessed.filter((item) => item.entityId === order.id))
      for (const item of (event.payload as { criteria?: Array<{ criterionId: string; quarters: number; note?: string }> }).criteria ?? [])
        latestAssessment.set(item.criterionId, { quarters: item.quarters, note: item.note ?? "" });
    const personConfirmed = new Set(confirmed.filter((event) => event.entityId === order.id).map((event) => (event.payload as { criterionId: string }).criterionId));
    result.set(order.id, {
      ...(projects.get(order.projectId) ? { projectName: projects.get(order.projectId)! } : {}),
      ...(!proposalReady(order, plan, { planBlocked: planBlocked.has(order.id), exempt: capacity.has(order.identityId) }) ? { preparing: true } : {}),
      window: { ...(payload.notBefore ? { notBefore: payload.notBefore } : {}), ...(dueBy ? { dueBy } : {}) },
      ...(plan ? { stepPlan: { archetypeLabel: archetypeById(plan.archetypeId)?.label ?? plan.archetypeId, quantity: plan.quantity, rationale: plan.rationale,
        progress: taskProgress(finishedSteps(order.state, plan.steps)), units: plan.units,
        // A provide step says whether the system is still looking (files, then the web) or the person is asked (need-check.ts).
        steps: (() => { const states = plan.needs?.length ? needStatesOf(store, workspaceId, order.id) : new Map<string, "checking" | "ask">();
          return finishedSteps(order.state, plan.steps).map((step) => step.provides && states.get(step.provides) ? { ...step, needState: states.get(step.provides)! } : step); })(),
        questions: plan.questions.map((question) => { const answer = answerOf(order.projectId, question.text); return { ...question, ...(answer ? { answer } : {}) }; }) } } : {}),
      preparation: preparationOf(order, plan, done),
      supports, workedMinutes: worked, ...(artifactLinks.length ? { artifactLinks } : {}),
      criteria: (milestone?.successCriteria ?? []).map((criterion) => {
        if (personConfirmed.has(criterion.id)) return { id: criterion.id, statement: criterion.statement, quarters: 4, by: "person" as const };
        const assessment = latestAssessment.get(criterion.id);
        if (assessment) return { id: criterion.id, statement: criterion.statement, quarters: assessment.quarters, by: "assessment" as const, ...(assessment.note ? { note: assessment.note } : {}) };
        const verdict = verdicts.get(criterion.id);
        return verdict ? { id: criterion.id, statement: criterion.statement, quarters: quartersOfVerdict[verdict.met] ?? 0, by: "gate" as const, note: verdict.observed }
          : { id: criterion.id, statement: criterion.statement, quarters: 0, by: "none" as const };
      }),
      sources: relevantDocuments(documents, { projectId: order.projectId, projectName: projects.get(order.projectId) }).map((doc) => ({ id: doc.id, fileName: doc.fileName })),
      agentOutputs: agentTasks.filter((task) => task.workOrderId === order.id).map((task) => ({ taskId: task.taskId, title: task.title, status: task.status, stepId: task.stepId,
        files: task.artifacts.map((artifact) => ({ path: artifact.path, name: artifact.path.split(/[\\/]/).at(-1) ?? artifact.path })) })),
      // 「交给 Agent」 for every account: the owner's assistant has a shell, everyone else's works through Crossline's own functions.
      agentSteps: (plan?.steps ?? []).filter((step) => step.status === "planned" && step.schedulable && step.executor !== "human").map((step) => ({ id: step.id, title: step.title })),
      // 「助手留下的待补」 (written when the daily pass accepted a result in the person's place) shows only while that acceptance stands.
      notes: notes.filter((event) => event.entityId === order.id && !retractedAgentNote(event.payload, agentTasks)).map((event) => { const payload = event.payload as { text?: string; kind?: string };
        return { at: event.createdAt, text: payload.text ?? "", kind: payload.kind ?? "note" }; }).reverse().slice(0, 30),
      completion: (({ mode, why, by }) => ({ mode, why, by }))(completionRule(order))
    });
  }
  return result;
}

type StoredEvent = ReturnType<CrosslineStore["listEvents"]>[number];

/** An `agent_left` note whose result is no longer accepted (the daily pass's acceptance was undone). */
function retractedAgentNote(payload: unknown, agentTasks: Array<{ taskId: string; status: string }>): boolean {
  const note = payload as { kind?: string; agentTaskId?: string };
  return note.kind === "agent_left" && agentTasks.find((task) => task.taskId === note.agentTaskId)?.status !== "accepted";
}

/**
 * One canonical shape for "everything about this task", read once here instead of being assembled
 * separately by Workbench, Today, Milestones and Approvals — every entry point into a task's detail
 * (drawer or standalone page, see `task-detail-view.tsx`) renders exactly this.
 */
export type TaskDetail = {
  id: string;
  ownerId: string;
  /** Who is looking: what a command queued offline from this card is signed as. */
  viewerId: string;
  /** The person's zone, for times shown on the card and in the dialog. */
  timeZone?: string;
  workspaceId: string;
  paused: boolean;
  identityId: string;
  identityLabel: string;
  accent: string;
  /** The task's name: a short action from its verb. `intent` is the description. */
  title: string;
  intent: string;
  state: string;
  riskTier: "routine" | "milestone" | "high_risk";
  estimate: ReturnType<typeof resolvedEstimate>;
  /** For an order being worked on: what the screen record says this session took (a suggestion, detail consent only). */
  suggestedMinutes?: number;
  manualPromotion: boolean;
  /** A starter work order the app wrote on first run, not something the person created. */
  seeded: boolean;
  milestone?: { id: string; title: string };
  /** What falls to the person and what the AI prepares, with the source each was read from — the same
   * analysis the approval card shows. The detail page used to leave these out, so the page a card links
   * to knew less about the task than the card did. */
  humanCore: Array<{ id: string; intent: string; quote?: string; rationale?: string }>;
  automationParts: Array<{ id: string; intent: string; quote?: string; rationale?: string }>;
  /** Focused minutes by step; their sum is the analysis's median. Empty for an order with no breakdown. */
  estimateBreakdown: Array<{ step: string; minutes: number }>;
  /** What this work also produces for other lines, and — on a landing order — the main order it came from. */
  byproducts: Array<{ lineId: string; artifact: string; landingMinutes: number }>;
  byproductOf?: string;
  materialContract: Array<{ kind: string; description: string; why: string; required: boolean }>;
  evidenceContract: Array<{ kind: string; description: string; why: string; required: boolean }>;
  /** Pre-generated completion-time questions copied from the bound milestone at `plan.approved` — see
   * 工作块 E. Empty for an order whose milestone has no question bank; file/free-text evidence still works. */
  evidenceChecklist: EvidenceQuestionTemplate[];
  preparedMaterials: Array<{ id: string; uri: string; fileName: string; mediaType: string }>;
  executions: Array<{
    id: string; startedAt: string; endedAt?: string; pauseMinutes: number; durationObserved: boolean;
    outcome?: string; interruptions: Array<{ pausedAt: string; resumedAt?: string; reason: string }>;
  }>;
  blocker?: { reason: string };
  materialBlocker?: { message: string };
  gateReview?: {
    verdict: string;
    criteriaVerdict: Array<{ criterionId: string; met: string; observed: string; shortfall?: string }>;
    gaps: Array<{ code: string; whatWouldSatisfyIt: string }>;
  };
  discardReason?: string;
  relatedFlywheel: Array<{ id: string; fromTitle: string; toTitle: string; kindLabel: string; explanation: string | null; pending: boolean }>;
  /** This work order's identity's background facts (onboarding + per-capture compaction), `null` when
   * none have been extracted yet — the detail view shows "未设置背景资料" for that case rather than the
   * section simply not existing. */
  background: StoredBackgroundFact[] | null;
} & TaskExtras;

/** A plan question with its answer: the person's own, or the app's assumption (changeable on the task), or none yet (asked on 待确认). */
export type StepQuestionView = StoredStepPlan["questions"][number] & { answer?: { text: string; assumed: boolean } };

/** What the card and the task dialog show beyond the analysis: where the task sits, its steps, and what it is judged against. */
export type TaskExtras = {
  /** The course or project by name (「ECE 555」), not its id. */
  projectName?: string;
  /** A proposal whose steps are still being planned (`proposalReady` false): not a decision yet, so the card offers no 批准 (W-31). */
  preparing?: boolean;
  /** Earliest start and latest finish, as the scheduler uses them. */
  window: { notBefore?: string; dueBy?: string };
  stepPlan?: { archetypeLabel: string; quantity: { basis: string; amount: number; unit: string }; rationale: string; progress: number;
    steps: Array<StoredTaskStep & { needState?: "checking" | "ask" }>; units: StoredStepPlan["units"]; questions: StepQuestionView[] };
  /** How the card is prepared before its work starts (docs/task-preparation.md): nothing, its steps, or a full tutorial, and why. */
  preparation?: Preparation;
  /** Other lines this work feeds: the milestone relations from this task's milestone, and its byproducts. */
  supports: Array<{ line: string; lineLabel: string; target: string; artifact?: string; pending: boolean }>;
  /** Cross-line artifacts at task level: what this task produces for another line's work, and whose output it uses (docs/flywheel-and-views.md §5.5). */
  artifactLinks?: Array<{ direction: "produces" | "uses"; line: string; lineLabel: string; title: string; artifact: string }>;
  workedMinutes: number;
  /** Each standard the task is judged against, in quarters (0–4) and who said so. */
  criteria: Array<{ id: string; statement: string; quarters: number; by: "person" | "assessment" | "gate" | "none"; note?: string }>;
  /** The person's own files relevant to it (this project's and unassigned uploads). */
  sources: Array<{ id: string; fileName: string }>;
  /** What the assistant produced for it. */
  agentOutputs: Array<{ taskId: string; title: string; status: string; stepId: string; files: Array<{ path: string; name: string }> }>;
  /** Open steps the system could do; 「交给 Agent」 appears when there is one. */
  agentSteps: Array<{ id: string; title: string }>;
  /** The task's record in the person's own words (notes, postponements), newest first. */
  notes: Array<{ at: string; text: string; kind: string }>;
  /** How finishing it is taken (`completionRule`): the mode, the one-line reason, and who decided (the person, the model, old title rules). */
  completion?: { mode: "self_evident" | "needs_assessment"; why: string; by: "person" | "model" | "rule" };
};

export type MilestoneDetail = {
  id: string;
  identityId: string;
  identityLabel: string;
  accent: string;
  title: string;
  status: string;
  rationale?: string;
  successCriteria: SuccessCriterion[];
  relatedWorkOrders: Array<{ id: string; intent: string; state: string }>;
  relatedFlywheel: Array<{ id: string; fromTitle: string; toTitle: string; kindLabel: string; explanation: string | null; pending: boolean }>;
  background: StoredBackgroundFact[] | null;
};

function identityInfo(identityId: string, ctx?: AccessContext): { label: string; accent: string } {
  const pack = (ctx ? linePacks(ctx, { includeArchived: true }) : defaultIdentityPacks()).find((item) => item.id === identityId);
  return { label: pack?.label ?? "未分类", accent: accents[identityId] ?? "#5A5B54" };
}

/**
 * Shared by both the single-id and batch tiers below: given the relations that touch one milestone and
 * a way to resolve a title for any other milestone id, produce the same `relatedFlywheel` shape either
 * tier assembles into `TaskDetail`/`MilestoneDetail`. Kept independent of how `titleOf` gets its answer
 * (a point query per id for the single-id tier, a pre-built Map for the batch tier) so neither tier is
 * forced into the other's read pattern.
 */
function flywheelTouching(relations: StoredMilestoneRelation[], milestoneId: string | undefined,
  titleOf: (id: string) => string): TaskDetail["relatedFlywheel"] {
  if (!milestoneId) return [];
  return relations
    .filter((relation) => (relation.status === "approved" || relation.status === "candidate")
      && (relation.fromMilestoneId === milestoneId || relation.toMilestoneId === milestoneId))
    .map((relation) => ({
      id: relation.id, fromTitle: titleOf(relation.fromMilestoneId), toTitle: titleOf(relation.toMilestoneId),
      kindLabel: relationKindLabel[relation.kind] ?? relation.kind,
      explanation: relation.explanation ?? null, pending: relation.status === "candidate"
    }));
}

/** Last-word-wins over a `materials.blocked`/`materials.retry_requested` trail already narrowed to one
 * work order (by SQL `entityId` in the single-id tier, by a pre-grouped Map in the batch tier) — same
 * read Workbench's own `materialStatus` does. */
function materialBlockerFrom(events: StoredEvent[]): TaskDetail["materialBlocker"] {
  let blocker: TaskDetail["materialBlocker"];
  for (const event of events) {
    if (event.type === "materials.blocked") {
      const detail = event.payload as { code?: string; message?: string };
      blocker = { message: detail.message ?? detail.code ?? "材料准备被阻塞" };
    } else blocker = undefined;
  }
  return blocker;
}

function discardReasonFrom(state: string, events: StoredEvent[]): string | undefined {
  if (state !== "archived") return undefined;
  return (events.at(-1)?.payload as { reason?: string } | undefined)?.reason;
}

/** Same "is there an open execution with an unresolved interruption" read Workbench's own card does —
 * duplicated here (not exported from workbench/page.tsx, which is a route file, not a library) so the
 * detail view can embed the real `ExecutionActions` instead of only ever being read-only. */
function pausedFrom(executions: TaskDetail["executions"]): boolean {
  const open = executions.find((item) => !item.endedAt);
  return Boolean(open?.interruptions.at(-1) && !open.interruptions.at(-1)!.resumedAt);
}

/** The one place a `StoredWorkOrder` plus its already-resolved dependencies becomes a `TaskDetail` —
 * shared by the single-id and batch tiers so their output is byte-identical regardless of which one a
 * caller used to get here. */
/** The files of a built tutorial (`manual.md` and its per-step sections). */
const TUTORIAL_FILE = /(?:^|[\\/])(?:manual\.md|nodes[\\/])/;

function assembleTaskDetail(ctx: AccessContext, order: StoredWorkOrder, deps: {
  milestone: StoredMilestone | undefined; materials: StoredMaterial[]; executions: StoredExecution[];
  materialEvents: StoredEvent[]; archivedEvents: StoredEvent[]; relatedFlywheel: TaskDetail["relatedFlywheel"];
  background: StoredBackgroundFact[]; extras: TaskExtras;
}): TaskDetail {
  const payload = order.payload as {
    manualPromotion?: boolean; seeded?: boolean; materialContract?: TaskDetail["materialContract"]; evidenceContract?: TaskDetail["evidenceContract"];
    evidenceChecklist?: TaskDetail["evidenceChecklist"];
    humanCore?: TaskDetail["humanCore"]; automationParts?: TaskDetail["automationParts"];
    estimateBreakdown?: TaskDetail["estimateBreakdown"];
    byproducts?: Array<{ lineId: string; artifact: string; landing: { minutes: number } }>; byproductOf?: string;
    blocker?: { reason: string }; gateReview?: TaskDetail["gateReview"];
  };
  const { label: identityLabel, accent } = identityInfo(order.identityId, ctx);
  const executions = deps.executions.map((item) => ({
    id: item.id, startedAt: item.startedAt, ...(item.endedAt ? { endedAt: item.endedAt } : {}),
    pauseMinutes: item.pauseMinutes, durationObserved: item.durationObserved,
    ...(item.outcome ? { outcome: item.outcome } : {}), interruptions: item.interruptions
  }));
  const materialBlocker = materialBlockerFrom(deps.materialEvents);
  const discardReason = discardReasonFrom(order.state, deps.archivedEvents);

  return {
    id: order.id, ownerId: order.ownerId, viewerId: ctx.principalId, timeZone: effectiveSchedulePreferences(ctx).preferences.timeZone, workspaceId: order.workspaceId, paused: pausedFrom(executions),
    identityId: order.identityId, identityLabel, accent, title: taskTitleOf(order), intent: order.intent, state: order.state,
    riskTier: order.riskTier, estimate: resolvedEstimate(ctx, order),
    ...(() => { const minutes = order.state === "active" ? suggestedSessionMinutes(ctx, order.id) : undefined; return minutes ? { suggestedMinutes: minutes } : {}; })(), manualPromotion: Boolean(payload.manualPromotion), seeded: Boolean(payload.seeded),
    ...(deps.milestone ? { milestone: { id: deps.milestone.id, title: deps.milestone.title } } : {}),
    humanCore: payload.humanCore ?? [], automationParts: payload.automationParts ?? [],
    estimateBreakdown: payload.estimateBreakdown ?? [],
    byproducts: (payload.byproducts ?? []).map((item) => ({ lineId: item.lineId, artifact: item.artifact, landingMinutes: item.landing.minutes })),
    ...(payload.byproductOf ? { byproductOf: payload.byproductOf } : {}),
    materialContract: payload.materialContract ?? [], evidenceContract: payload.evidenceContract ?? [],
    evidenceChecklist: payload.evidenceChecklist ?? [],
    // A tutorial built before steps named their product (2026-10-22) is not shown on work that no longer warrants one (a delivery check,
    // a fix to the person's own system), unless the person asked for it.
    preparedMaterials: deps.materials.filter((item) => !TUTORIAL_FILE.test(item.uri) || (deps.extras.preparation?.level ?? "tutorial") === "tutorial"
      || getStore().listEvents(ctx.workspaceId, { type: "tutorial.requested", entityId: order.id }).length > 0)
      .map((item) => ({ id: item.id, uri: item.uri, fileName: item.uri.split("/").pop() ?? item.uri, mediaType: item.mediaType })),
    executions,
    ...(payload.blocker ? { blocker: payload.blocker } : {}),
    ...(materialBlocker ? { materialBlocker } : {}),
    ...(payload.gateReview ? { gateReview: payload.gateReview } : {}),
    ...(discardReason ? { discardReason } : {}),
    relatedFlywheel: deps.relatedFlywheel,
    ...(() => { const facts = relevantBackground(deps.background, [deps.extras.projectName ?? "", order.intent, deps.milestone?.title ?? ""]); return { background: facts.length ? facts : null }; })(),
    ...deps.extras
  };
}

/** Two-character words too common to say two texts are about the same thing. */
const COMMON_BIGRAMS = new Set(["完成", "任务", "进行", "相关", "已经", "需要", "可以", "一个", "一次", "这是", "方向", "主线", "项目", "持续", "推进", "整理",
  "确认", "准备", "内容", "当前", "本人", "通过", "支撑", "达到", "已支", "作为", "后续", "具体"]);
/**
 * The line's background facts that bear on this task: a fact is kept when it names the course or project, shares a distinctive Latin term
 * or code of three or more characters (ECE, 555, MoS2, SRAM), or shares a two-character Chinese word that is not a common one (论文,
 * 作业, 仿真) with the task or its milestone. Every fact of the line used to be listed under every task, so a homework showed the MoS₂
 * and sleep-replay projects as its background.
 */
export function relevantBackground<T extends { value: string; why: string }>(facts: T[], about: string[]): T[] {
  const squash = (text: string) => text.toLowerCase().replace(/[\s_\-·.]+/g, "");
  const names = about.slice(0, 1).map(squash).filter((name) => name.length >= 3);
  const joined = about.join(" ");
  const terms = new Set(joined.toLowerCase().match(/[a-z0-9₀-₉]{3,}/g) ?? []);
  const bigrams = new Set((joined.match(/[一-鿿]+/g) ?? []).flatMap((run) => Array.from({ length: Math.max(0, run.length - 1) }, (_, i) => run.slice(i, i + 2)))
    .filter((pair) => !COMMON_BIGRAMS.has(pair)));
  return facts.filter((fact) => {
    const text = squash(`${fact.value} ${fact.why}`);
    return names.some((name) => text.includes(name)) || [...terms].some((term) => text.includes(term)) || [...bigrams].some((pair) => text.includes(pair));
  });
}

function assembleMilestoneDetail(milestone: StoredMilestone, rationale: string | undefined,
  relatedWorkOrders: MilestoneDetail["relatedWorkOrders"], relatedFlywheel: TaskDetail["relatedFlywheel"],
  background: StoredBackgroundFact[]): MilestoneDetail {
  const { label: identityLabel, accent } = identityInfo(milestone.identityId);
  return {
    id: milestone.id, identityId: milestone.identityId, identityLabel, accent, title: milestone.title,
    status: milestone.status, ...(rationale ? { rationale } : {}),
    successCriteria: milestone.successCriteria, relatedWorkOrders, relatedFlywheel,
    background: background.length ? background : null
  };
}

/**
 * Single-id tier: every read is an indexed point query (or, for `listMilestoneRelations`, the one
 * unavoidable full-table read — the table carries no `from`/`to` index and is small enough on every
 * workspace this app has ever run against that adding one isn't worth it yet). Used by the two
 * standalone detail pages (`/workbench/[id]`, `/milestones/[id]`) and as the fallback a `TaskPreview`/
 * `MilestonePreview` takes when a page hasn't precomputed a batch (see `loadTaskDetailsBatch` below for
 * the tier list pages use instead, so N cards on one page don't mean N times this work).
 */
export function loadTaskDetail(ctx: AccessContext, workOrderId: string): TaskDetail | undefined {
  const store = getStore();
  const order = store.getWorkOrder(ctx.workspaceId, workOrderId);
  if (!order) return undefined;
  const milestone = order.milestoneId ? store.getMilestone(ctx.workspaceId, order.milestoneId) : undefined;
  const relations = store.listMilestoneRelations(ctx.workspaceId);
  // Every relation touching this milestone needs the OTHER endpoint's title too — resolved by point
  // query per distinct id encountered (memoized), rather than a full `listMilestones` scan.
  const titleCache = new Map<string, string>(milestone ? [[milestone.id, milestone.title]] : []);
  const titleOf = (id: string) => {
    const cached = titleCache.get(id);
    if (cached !== undefined) return cached;
    const title = store.getMilestone(ctx.workspaceId, id)?.title ?? id;
    titleCache.set(id, title);
    return title;
  };
  return assembleTaskDetail(ctx, order, {
    milestone, materials: store.listMaterials(ctx.workspaceId, workOrderId),
    executions: store.listExecutions(ctx.workspaceId, workOrderId),
    materialEvents: store.listEvents(ctx.workspaceId, { type: ["materials.blocked", "materials.retry_requested"], entityId: workOrderId }),
    archivedEvents: order.state === "archived"
      ? store.listEvents(ctx.workspaceId, { type: "work_order.archived", entityId: workOrderId }) : [],
    relatedFlywheel: flywheelTouching(relations, order.milestoneId, titleOf),
    background: store.getBackgroundFacts(ctx.workspaceId, order.identityId),
    extras: taskExtras(store, ctx.workspaceId, [order]).get(order.id)!
  });
}

export function loadMilestoneDetail(ctx: AccessContext, milestoneId: string): MilestoneDetail | undefined {
  const store = getStore();
  const milestone = store.getMilestone(ctx.workspaceId, milestoneId);
  if (!milestone) return undefined;
  const rationale = store.listEvents(ctx.workspaceId, { type: "milestone.proposed", entityId: milestoneId })
    .at(-1)?.payload as { rationale?: string } | undefined;
  const relatedWorkOrders = store.listWorkOrders(ctx.workspaceId).filter((order) => order.milestoneId === milestoneId)
    .map((order) => ({ id: order.id, intent: order.intent, state: order.state }));
  const relations = store.listMilestoneRelations(ctx.workspaceId);
  const titleCache = new Map<string, string>([[milestone.id, milestone.title]]);
  const titleOf = (id: string) => {
    const cached = titleCache.get(id);
    if (cached !== undefined) return cached;
    const title = store.getMilestone(ctx.workspaceId, id)?.title ?? id;
    titleCache.set(id, title);
    return title;
  };
  return assembleMilestoneDetail(milestone, rationale?.rationale, relatedWorkOrders,
    flywheelTouching(relations, milestoneId, titleOf), store.getBackgroundFacts(ctx.workspaceId, milestone.identityId));
}

/**
 * Batch tier: one read per underlying table for the whole workspace, then one assembly per requested
 * id from in-memory Maps — the same "read once, look up in a loop" pattern `workbench/page.tsx` and
 * `loadDashboard` already use for their own fields. A list page rendering N cards' preview drawers
 * should call this once with all N ids rather than let each `TaskPreview` call `loadTaskDetail`
 * separately, which is what turned this into an N+1 the first time it shipped.
 */
export function loadTaskDetailsBatch(ctx: AccessContext, workOrderIds: string[]): Map<string, TaskDetail> {
  const result = new Map<string, TaskDetail>();
  if (!workOrderIds.length) return result;
  const store = getStore();
  const ids = new Set(workOrderIds);
  const orders = store.listWorkOrders(ctx.workspaceId).filter((order) => ids.has(order.id));
  if (!orders.length) return result;
  const milestoneById = new Map(store.listMilestones(ctx.workspaceId).map((item) => [item.id, item]));
  const materialsByOrder = groupBy(store.listMaterials(ctx.workspaceId), (item) => item.workOrderId);
  const executionsByOrder = groupBy(store.listExecutions(ctx.workspaceId), (item) => item.workOrderId);
  const materialEventsByOrder = groupBy(
    store.listEvents(ctx.workspaceId, { type: ["materials.blocked", "materials.retry_requested"] }),
    (event) => event.entityId);
  const archivedEventsByOrder = groupBy(
    store.listEvents(ctx.workspaceId, { type: "work_order.archived" }), (event) => event.entityId);
  const relations = store.listMilestoneRelations(ctx.workspaceId);
  const titleOf = (id: string) => milestoneById.get(id)?.title ?? id;
  // Facts are per-identity, not per-order — a handful of distinct identities across however many orders
  // are in this batch, so one cached read per identity rather than one per order.
  const backgroundByIdentity = new Map<string, StoredBackgroundFact[]>();
  const backgroundOf = (identityId: string) => {
    const cached = backgroundByIdentity.get(identityId);
    if (cached) return cached;
    const facts = store.getBackgroundFacts(ctx.workspaceId, identityId);
    backgroundByIdentity.set(identityId, facts);
    return facts;
  };

  const extras = taskExtras(store, ctx.workspaceId, orders);
  for (const order of orders) {
    const milestone = order.milestoneId ? milestoneById.get(order.milestoneId) : undefined;
    result.set(order.id, assembleTaskDetail(ctx, order, { extras: extras.get(order.id)!,
      milestone, materials: materialsByOrder.get(order.id) ?? [], executions: executionsByOrder.get(order.id) ?? [],
      materialEvents: materialEventsByOrder.get(order.id) ?? [], archivedEvents: archivedEventsByOrder.get(order.id) ?? [],
      relatedFlywheel: flywheelTouching(relations, order.milestoneId, titleOf),
      background: backgroundOf(order.identityId)
    }));
  }
  return result;
}

export function loadMilestoneDetailsBatch(ctx: AccessContext, milestoneIds: string[]): Map<string, MilestoneDetail> {
  const result = new Map<string, MilestoneDetail>();
  if (!milestoneIds.length) return result;
  const store = getStore();
  const ids = new Set(milestoneIds);
  const milestones = store.listMilestones(ctx.workspaceId).filter((item) => ids.has(item.id));
  if (!milestones.length) return result;
  const milestoneById = new Map(milestones.map((item) => [item.id, item]));
  const rationaleByMilestone = groupBy(
    store.listEvents(ctx.workspaceId, { type: "milestone.proposed" }), (event) => event.entityId);
  const workOrdersByMilestone = groupBy(
    store.listWorkOrders(ctx.workspaceId).filter((order) => order.milestoneId && ids.has(order.milestoneId)),
    (order) => order.milestoneId);
  const relations = store.listMilestoneRelations(ctx.workspaceId);
  const titleOf = (id: string) => milestoneById.get(id)?.title ?? id;
  const backgroundByIdentity = new Map<string, StoredBackgroundFact[]>();
  const backgroundOf = (identityId: string) => {
    const cached = backgroundByIdentity.get(identityId);
    if (cached) return cached;
    const facts = store.getBackgroundFacts(ctx.workspaceId, identityId);
    backgroundByIdentity.set(identityId, facts);
    return facts;
  };

  for (const milestone of milestones) {
    const rationale = (rationaleByMilestone.get(milestone.id) ?? []).at(-1)?.payload as { rationale?: string } | undefined;
    const relatedWorkOrders = (workOrdersByMilestone.get(milestone.id) ?? [])
      .map((order) => ({ id: order.id, intent: order.intent, state: order.state }));
    result.set(milestone.id, assembleMilestoneDetail(milestone, rationale?.rationale, relatedWorkOrders,
      flywheelTouching(relations, milestone.id, titleOf), backgroundOf(milestone.identityId)));
  }
  return result;
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item); else groups.set(key, [item]);
  }
  return groups;
}
