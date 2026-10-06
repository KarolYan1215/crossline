import { randomUUID } from "node:crypto";
import {
  MILESTONE_PROPOSAL_SCHEMA, MILESTONE_RELATIONS_SCHEMA, profileFactId, validateMilestoneProposal, validateRelationsProposal, computeMilestoneConfidence,
  type MilestoneProposal, type MilestoneProposalContext, type RelationsContext, type RelationsProposal
} from "@crossline/core";
import { continueSkillTurn, runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import { defaultIdentityPacks } from "@crossline/identity-packs";
import { latestFileDates, type CrosslineStore } from "@crossline/db";

/** Only for a ledger that has no workspace owner on record, which a real account never is. */
const FALLBACK_OWNER_ID = "local-owner";
export const MILESTONE_ARCHITECT_SKILL = "crossline:crossline-milestone-architect";

const INSTRUCTIONS = "Propose milestones for the supplied identities. Return only the requested JSON. "
  + "Every milestone needs a checkable target: at least one non-judgement criterion, and for anything graded (exam, quiz, homework, project) a threshold criterion with a real score line — never just 'completed'. A course is a chain of its graded parts in date order. "
  + "A course with no target_grade fact on record gets one proposed by you in targetProposals (value and why, from the person's long-term goals), cited as <identityId>/<projectId>/target_grade in sourceFactIds. "
  + "Every number is worked backwards from the result the person wants (plan.outcome), written out in plan.derivation: the least this milestone must reach for that result to hold is bareLine, and the threshold value is set beyond it with at least 3% margin — never a number chosen because it sounds reasonable. "
  + "A line with thin information still gets its chain: state what you assumed in assumptions. Use blockers only when nothing can be proposed for any line. "
  + "A milestone is a state of the world the user could argue they had reached, not a task. Each needs "
  + "two to four criteria, and at least one criterion must have evidenceOf=\"outcome\" — something that "
  + "changed, not something that now exists — because a milestone whose criteria are all outputs passes "
  + "on a productive afternoon of writing documents while the goal stands still. Do not invent numbers "
  + "the user never gave you: when the honest measure is a judgement, use a judgement measure and say in "
  + "failsWhen what would make it not met. Do not duplicate an existing milestone. If the input is too "
  + "vague to produce a checkable criterion, return a blocker naming what is missing. When one of the "
  + "supplied templates genuinely fits, set templateId to its id and build criteria that actually match "
  + "its shape, not just its title — otherwise set templateId to null; never invent a templateId that was "
  + "not in the input. Always fill evidenceQuestionBank with 1-3 concrete completion-time questions "
  + "(checkbox or text, Codex-ask style) that actually check whether the milestone was reached; it is used "
  + "verbatim when templateId is null, and only ignored (replaced by the template's own bank) when a "
  + "template was chosen, so fill it in properly either way. When the input carries a `profile`, design "
  + "from it instead: every milestone gets a `plan` with a local `key`, a `stage` (1 first), a real "
  + "`deadline` worked backwards from the dates and hard requirements in the profile, a `baseline` (where "
  + "the person is now), a `target` (what done means in their words), `stakeholders`, `sourceFactIds` "
  + "copied exactly from the supplied fact ids (at least one confirmed), and `dependsOn` naming the earlier "
  + "milestone keys it builds on. Give each line in `profile.requiredIdentities` three to five milestones "
  + "chained in stage order, titled for this person's own work and never as a template. When `diligence` is "
  + "present it is web research the person has already accepted: build milestones on its findings and dates "
  + "(an accepted application deadline is a hard date), and do not re-propose what it already covers. Write "
  + "every human-readable field in Chinese.";

const INSTRUCTIONS_RELATIONS = "You are given milestones that already exist, in different lines, and profile facts (including the person's own guesses "
  + "about how the lines feed each other, slots starting with flywheel_). Return only the requested JSON: at most twelve cross-line relations, each between "
  + "two milestones in DIFFERENT lines, copied by id; kind is enables, reuses, informs, constrains or recurring_feedback; explanation says concretely what "
  + "it claims; refutedWhen says what would show it does not hold; sourceFactIds are copied exactly from the facts. Prefer the few that carry weight. "
  + "Write every human-readable field in Chinese.";

export type ProposalOutcome =
  | { state: "proposed"; drafts: Array<{ id: string; identityId: string; title: string }>; assumptions: string[]; threadId?: string;
      /** Lines that came back with nothing (not enough to go on, or the run failed): the rest were still saved. */
      skipped?: Array<{ identityId: string; code: string; message: string }> }
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
 */
function supersedeUntouchedDrafts(store: CrosslineStore, workspaceId: string, keep: ReadonlySet<string>, lines: ReadonlySet<string>): void {
  // Only in the lines that got new drafts: a line whose run failed keeps the drafts the person already had.
  const old = store.listMilestones(workspaceId).filter((milestone) => isUntouchedDraft(milestone) && !keep.has(milestone.id) && lines.has(milestone.identityId));
  const ids = new Set(old.map((milestone) => milestone.id));
  for (const milestone of old) store.saveMilestone({ ...milestone, status: "archived" });
  for (const relation of store.listMilestoneRelations(workspaceId)) {
    if (relation.status === "candidate" && (ids.has(relation.fromMilestoneId) || ids.has(relation.toMilestoneId))) store.saveMilestoneRelation({ ...relation, status: "archived" });
  }
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
  const identities = defaultIdentityPacks().filter((pack) => pack.kind === "identity");
  const now = options.now?.() ?? (process.env.CROSSLINE_FIXED_NOW ? new Date(process.env.CROSSLINE_FIXED_NOW) : new Date());
  return {
    version: "crossline.milestone-proposal.v1",
    identities: defaultIdentityPacks()
      .filter((pack) => pack.kind === "identity")
      .map((pack) => ({ id: pack.id, label: pack.label, summary: pack.workflowTemplates.join(", ") })),
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
      developerInstructions: INSTRUCTIONS,
      outputSchema: MILESTONE_PROPOSAL_SCHEMA,
      prepareInput: () => context,
      validateOutput: (output) => validateMilestoneProposal(output, context),
      onAudit: (audit) => { threadId = audit.threadId; },
      ...(signal ? { signal } : {}),
      timeoutMs: 60 * 60_000
    });
    return { result, threadId };
  }

  /** The links between lines: a second, small question about milestones that now exist. */
  async function proposeRelations(client: CodexRpcBoundary, context: MilestoneProposalContext, drafts: Array<{ id: string; identityId: string }>, signal?: AbortSignal): Promise<void> {
    if (!context.profile || new Set(drafts.map((draft) => draft.identityId)).size < 2) return;
    const ids = new Set(drafts.map((draft) => draft.id));
    const anchors = new Map(store.listMilestoneAnchors(workspaceId).map((anchor) => [anchor.milestoneId, anchor]));
    const milestones = store.listMilestones(workspaceId).filter((milestone) => ids.has(milestone.id)).map((milestone) => ({
      id: milestone.id, identityId: milestone.identityId, projectId: milestone.projectId ?? "", title: milestone.title,
      stage: anchors.get(milestone.id)?.stage ?? 1, deadline: anchors.get(milestone.id)?.deadline ?? "", target: anchors.get(milestone.id)?.target ?? ""
    }));
    // The interview's own guesses about how the lines feed each other, plus what each project is for.
    const facts = context.profile.facts.filter((fact) => fact.slot.startsWith("flywheel_") || fact.slot === "goal" || fact.slot === "what");
    const relationsContext: RelationsContext = { version: "crossline.milestone-relations.v1", milestones, facts };
    const result = await runCodexSkill<RelationsProposal>(client, relationsContext, {
      skillName: MILESTONE_ARCHITECT_SKILL, cwd, developerInstructions: INSTRUCTIONS_RELATIONS, outputSchema: MILESTONE_RELATIONS_SCHEMA,
      prepareInput: () => relationsContext, validateOutput: (output) => validateRelationsProposal(output, relationsContext),
      onAudit: () => {}, ...(signal ? { signal } : {}), timeoutMs: 60 * 60_000
    });
    if (!result.ok) return;
    const ownerId = store.getWorkspaceOwnerId(workspaceId) ?? FALLBACK_OWNER_ID;
    const when = new Date().toISOString();
    for (const relation of result.output.relations) {
      // The relation's evidence is the profile facts it rests on, so the 主线 page can show it dotted and the person can approve or
      // reject it; nothing here makes one true.
      store.saveMilestoneRelation({
        id: `proposed:${relation.fromId}->${relation.toId}:${relation.kind}`, ownerId, workspaceId, fromMilestoneId: relation.fromId, toMilestoneId: relation.toId,
        kind: relation.kind, status: "candidate", explanation: relation.explanation, refutedWhen: relation.refutedWhen,
        evidence: relation.sourceFactIds.map((factId) => ({ uri: "/onboarding", source: `画像事实 ${factId}`, observedAt: when }))
      });
    }
  }

  /** `only` limits the run to those lines: changing a course's target redoes its line, not the whole board. */
  return async function propose(request: string, signal?: AbortSignal, only?: string[]): Promise<ProposalOutcome> {
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
      return { state: "proposed", drafts, assumptions: result.output.assumptions, ...(threadId ? { threadId } : {}) };
    }

    if (!lines.length) return { state: "blocked", code: "NO_MATCHING_LINE", message: "这条主线现在说得太少，或没有你确认过的事实，所以没有重新设计。" };

    // One run per line. A single answer for every line was eleven to fifteen milestones — about four and a half minutes a turn, so
    // that not even one repair fitted in a deadline — and one line's trouble (a thin profile, a refused date) threw away the lines
    // that had been done well. Per line the answer is a few milestones, a repair is cheap, and what succeeds is kept.
    const drafts: Array<{ id: string; identityId: string; title: string }> = [];
    const assumptions: string[] = [];
    const skipped: Array<{ identityId: string; code: string; message: string }> = [];
    let lastThread: string | undefined;
    for (const identityId of lines) {
      if (signal?.aborted) break;
      const own = lineContext(context, identityId);
      const { result, threadId } = await runLine(client, own, signal);
      if (threadId) lastThread = threadId;
      if (!result.ok) { skipped.push({ identityId, code: result.blocker.code, message: result.blocker.message }); continue; }
      persistTargetProposals(store, workspaceId, result.output.targetProposals ?? []);
      drafts.push(...persistProposals(store, workspaceId, result.output.milestones, context.request));
      assumptions.push(...result.output.assumptions);
      for (const proposal of result.output.targetProposals ?? []) {
        const name = context.profile?.projects.find((project) => project.id === proposal.projectId)?.name ?? proposal.projectId;
        assumptions.push(`「${name}」的目标我暂定为 ${proposal.value}（${proposal.why}）；分数线都是从它倒推的，想改在「主线」页的“目标”里一键修改，会按新目标重算。`);
      }
    }
    if (!drafts.length) {
      return { state: "blocked", code: skipped[0]?.code ?? "PROPOSAL_EMPTY",
        message: skipped.map((item) => `${labelOf(context, item.identityId)}：${item.message}`).join("；").slice(0, 400) || "没有生成任何里程碑。" };
    }
    // Only the lines that got new drafts lose their old untouched ones: a line that failed keeps what the person already had.
    supersedeUntouchedDrafts(store, workspaceId, new Set(drafts.map((draft) => draft.id)), new Set(drafts.map((draft) => draft.identityId)));
    for (const item of skipped) assumptions.push(`「${labelOf(context, item.identityId)}」这条线这次没有生成：${item.message}`);
    for (const identityId of thinLines(context, allLines).filter((id) => !only?.length || only.includes(id))) assumptions.push(`「${labelOf(context, identityId)}」这条线目前说得太少，或只有推断、没有你确认过的事实，先没有排里程碑；在「先了解你」里补充或确认后再设计。`);

    try { await proposeRelations(client, context, drafts, signal); } catch { /* a failed link run never takes the milestones with it */ }
    return { state: "proposed", drafts, assumptions, ...(skipped.length ? { skipped } : {}), ...(lastThread ? { threadId: lastThread } : {}) };
  };
}

const labelOf = (context: MilestoneProposalContext, identityId: string) => context.identities.find((item) => item.id === identityId)?.label ?? identityId;

/** Lines the profile has something about but too little for a chain; they are named so the person knows why they are absent. */
const thinLines = (context: MilestoneProposalContext, asked: string[]): string[] =>
  context.identities.map((identity) => identity.id).filter((id) => !asked.includes(id) && (context.profile?.facts.some((fact) => fact.identityId === id) ?? false));

/**
 * The context for one line's run: its own identity, projects, facts and templates, so everything the validator holds the answer to
 * (the identity it may name, the projects it must cover, the chain it owes) is about this line alone.
 */
function lineContext(context: MilestoneProposalContext, identityId: string): MilestoneProposalContext {
  const profile = context.profile!;
  const ownProjects = profile.projects.filter((project) => project.identityId === identityId);
  return {
    ...context,
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
  milestones: MilestoneProposal["milestones"], request: string): Array<{ id: string; identityId: string; title: string }> {
  const templates = store.listMilestoneTemplates(workspaceId);
  const ownerId = store.getWorkspaceOwnerId(workspaceId) ?? FALLBACK_OWNER_ID;
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
