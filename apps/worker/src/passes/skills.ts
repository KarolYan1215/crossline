// Split out of index.ts (move only). The worker's singletons (store, supervisor, services) stay in index.ts, which runs the
// side effects in order; this module reads them from `../index` only inside functions, after index.ts has set them up.
import path from "node:path";
import { enterUsageWorkspace, withUsagePurpose } from "@crossline/codex";
import { aiToolsFor, grownHomeLine, isPaused, readGrownSkills, readPublicSkills } from "@crossline/db";
import { favouritesTopicPass } from "../favourites-topics";
import { workflowImprovePass } from "../workflow-improver";
import { workflowMergeDue, workflowMergePass } from "../workflow-merge";
import { methodResearchDue, runMethodResearch } from "../method-research";
import { grownSkillName, publicSkillName, spendAllows, NON_CORE_PURPOSE } from "@crossline/core";
import { createInsightCompiler, linesAwaitingMineSkill } from "../insight-compiler";
import { cleanPublicSkills, createSkillScout, lineSetupDue, rescanDue, rescanPublicSkills, scoutDue } from "../public-skills";
import { browserProfilesRoot, cleanGrownSkills, growCandidates, growTask, installGrown, growLabel, sayToPerson, workflowSchedulePass } from "../workflow-smith";
import { localeOf, tOfWorkspace } from "../locale";
import { ownerOf } from "../owner";
import { skillLibraryDir } from "../skill-library";
import { identityLines } from "../lines";
import { nonCoreAllowed } from "../spend";
import { accountClient, agentService, analysisStore, codexSupervisor, dataDir, paused, repoRoot, sandboxNow, shellAssistant, spendFor } from "../index";

/**
 * Rewrites a line's own skill (`crossline-mine:<line>`, docs/skills-library.md §1) when the person has said or decided something new about how
 * they do that line's work: one line a tick, while the quota allows core work. The version it replaces stays in the ledger.
 */
const compilingMine = new Set<string>();
export async function minePass(workspaceId: string, checkedAt: string): Promise<void> {
  if (paused(workspaceId, "planning")) return;
  if (compilingMine.has(workspaceId) || !codexSupervisor || !linesAwaitingMineSkill(analysisStore, workspaceId).length) return;
  // Core by its quota rule (as before), non-core for the saver (docs/token-economy.md §2.3).
  if (!nonCoreAllowed(analysisStore, workspaceId, await spendFor(workspaceId), "core")) return;
  compilingMine.add(workspaceId);
  try {
    enterUsageWorkspace(workspaceId);
    const outcome = await withUsagePurpose(NON_CORE_PURPOSE, () => createInsightCompiler(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId))()).catch(() => undefined);
    if (outcome) console.info(JSON.stringify({ type: "skill.mine.compiled", checkedAt, workspaceId, ...outcome }));
  } finally { compilingMine.delete(workspaceId); }
}

/**
 * Public skills (docs/skills-library.md §2): once a day the ones not called for thirty days are removed; the scout searches once for each
 * line when it is set up (the interview done, or a line added later), then once a month (checking installed ones for a newer commit
 * too). The setup search is core work; the monthly one is non-core (the quota saver), as are its reviews.
 */
const scoutingSkills = new Set<string>();
/**
 * After the interview (the owner, 2026-11-18): the person's habits and the researched way to do their kinds of work (method-research.ts),
 * once per finished interview. Core work: every later plan is shaped by it.
 */
const researchingMethods = new Set<string>();
export async function methodResearchPass(workspaceId: string, checkedAt: string): Promise<void> {
  if (researchingMethods.has(workspaceId) || !codexSupervisor || paused(workspaceId, "research")) return;
  if (!methodResearchDue(analysisStore, workspaceId)) return;
  const retryAt = analysisStore.getSetting(workspaceId, "method.research.retryAt");
  if (retryAt && retryAt > checkedAt) return;
  if (!spendAllows(await spendFor(workspaceId), "core")) return;
  const client = accountClient(workspaceId);
  if (!client) return;
  researchingMethods.add(workspaceId);
  try {
    enterUsageWorkspace(workspaceId);
    const outcome = await runMethodResearch(analysisStore, workspaceId, repoRoot, { client });
    if ("blocked" in outcome) analysisStore.setSetting(workspaceId, "method.research.retryAt", new Date(Date.parse(checkedAt) + 6 * 3_600_000).toISOString());
    console.info(JSON.stringify({ type: "method.research", checkedAt, workspaceId, ...("blocked" in outcome ? outcome
      : { habits: outcome.habits.length, methods: outcome.methods.length, sources: outcome.sources.length, droppedSources: outcome.droppedSources }) }));
  } catch (error) { console.warn(JSON.stringify({ type: "method.research_failed", workspaceId, message: String(error) })); }
  finally { researchingMethods.delete(workspaceId); }
}

export async function publicSkillPass(workspaceId: string, checkedAt: string, offPeakWait = false): Promise<void> {
  try {
    const removed = cleanPublicSkills(analysisStore, workspaceId);
    if (removed.length) console.info(JSON.stringify({ type: "skill.public.cleaned", checkedAt, workspaceId, removed }));
  } catch { /* housekeeping */ }
  // The daily rescan of installed public skills (and at once after a scanner upgrade): a safety check, so not held by the planning pause;
  // without a model only the hashes and the code scan run, and a skill that needs the injection check waits, unused, for the next pass.
  if (!scoutingSkills.has(workspaceId) && rescanDue(skillLibraryDir(workspaceId))) {
    scoutingSkills.add(workspaceId);
    try {
      const rescan = await rescanPublicSkills(analysisStore, workspaceId, codexSupervisor ? accountClient(workspaceId) : undefined);
      if (rescan.checked.length || rescan.disabled.length || rescan.waiting.length) console.info(JSON.stringify({ type: "skill.public.rescanned", checkedAt, workspaceId, ...rescan }));
    } catch (error) { console.warn(JSON.stringify({ type: "skill.public.rescan_failed", workspaceId, message: String(error).slice(0, 200) })); }
    finally { scoutingSkills.delete(workspaceId); }
  }
  if (paused(workspaceId, "planning")) return;
  if (scoutingSkills.has(workspaceId) || !codexSupervisor) return;
  // A line's search when it is set up is part of setting the account up: it runs as core work and does not wait for the developer's
  // model's cheaper hours. The monthly search is non-core and waits.
  const setup = lineSetupDue(analysisStore, workspaceId);
  if (!setup.length && (offPeakWait || !scoutDue(analysisStore, workspaceId))) return;
  const spend = await spendFor(workspaceId);
  if (setup.length ? !spendAllows(spend, "core") : !nonCoreAllowed(analysisStore, workspaceId, spend, "discretionary")) return;
  scoutingSkills.add(workspaceId);
  try {
    enterUsageWorkspace(workspaceId);
    const scout = createSkillScout(analysisStore, workspaceId, repoRoot, () => accountClient(workspaceId), setup.length ? { mode: "setup", lines: setup } : { mode: "routine" });
    const outcome = await (setup.length ? scout() : withUsagePurpose(NON_CORE_PURPOSE, scout)).catch(() => undefined);
    if (outcome) console.info(JSON.stringify({ type: "skill.public.scouted", checkedAt, workspaceId, mode: setup.length ? "setup" : "routine", ...outcome }));
  } finally { scoutingSkills.delete(workspaceId); }
}

/**
 * Grown workflows (docs/skills-library.md §6): reminders and scheduled runs whose time has come, the daily clean-up, and — when the
 * assistant is free, not paused and the quota allows — one errand grown into a workflow. Growing and scheduled runs go through the same
 * assistant machinery as any task (owner only, approved kinds only); reminders go out whatever the assistant is doing.
 */
const growingWorkflows = new Set<string>();
export async function workflowPass(workspaceId: string, checkedAt: string): Promise<void> {
  try {
    const removed = cleanGrownSkills(analysisStore, workspaceId);
    if (removed.length) console.info(JSON.stringify({ type: "skill.grown.cleaned", checkedAt, workspaceId, removed }));
  } catch { /* housekeeping */ }
  const assistantOff = isPaused(analysisStore, workspaceId) || !codexSupervisor;
  try {
    const fired = workflowSchedulePass(analysisStore, workspaceId, (input, after) => assistantOff
      ? { state: "blocked", code: "AGENT_PAUSED", message: tOfWorkspace(analysisStore, workspaceId)("助手已暂停。") } : agentService.runFree(workspaceId, input, after), new Date(), browserProfilesRoot(workspaceId));
    if (fired.length) console.info(JSON.stringify({ type: "skill.grown.scheduled", checkedAt, workspaceId, fired }));
  } catch { /* next tick */ }
  // Favourites organised by topic: the day's share by day, everything in order by night (favourites-topics.ts).
  try {
    const started = favouritesTopicPass(analysisStore, workspaceId, readGrownSkills(analysisStore, workspaceId), (input, after) => assistantOff
      ? { state: "blocked", code: "AGENT_PAUSED", message: tOfWorkspace(analysisStore, workspaceId)("助手已暂停。") } : agentService.runFree(workspaceId, input, after), browserProfilesRoot(workspaceId));
    if (started.length) console.info(JSON.stringify({ type: "favourites.topics_started", checkedAt, workspaceId, started }));
  } catch { /* next tick */ }
  // Workflows that do the same job are merged (workflow-merge.ts): once a day, or now when the person asked; a merge is folded in below.
  try {
    const today = new Date().toISOString().slice(0, 10);
    const due = workflowMergeDue(analysisStore, workspaceId, today);
    if (due && readGrownSkills(analysisStore, workspaceId).length > 1 && spendAllows(await spendFor(workspaceId), due === "requested" ? "core" : "discretionary")) {
      const merged = await workflowMergePass(analysisStore, workspaceId, accountClient(workspaceId), repoRoot, today);
      if (merged.length) console.info(JSON.stringify({ type: "skill.grown.merged", checkedAt, workspaceId, merged }));
    }
  } catch { /* next tick */ }
  // A workflow the person commented on, or whose runs keep failing, is revised by the assistant (workflow-improver.ts); every account.
  if (!assistantOff && !agentService.runningTasks(workspaceId).some((taskId) => taskId.startsWith("improve-"))) {
    try {
      const spend = await spendFor(workspaceId);
      const improving = workflowImprovePass(analysisStore, workspaceId, (input, after) => agentService.runFree(workspaceId, input, after),
        { client: () => accountClient(workspaceId), cwd: repoRoot, workRoot: path.join(dataDir, "workflow-improve"), spend: (kind) => spendAllows(spend, kind) });
      if (improving) console.info(JSON.stringify({ type: "skill.grown.improve_started", checkedAt, workspaceId, id: improving }));
    } catch { /* next tick */ }
  }
  // Growing a workflow writes and tests scripts with the runtime's `skill-creator`: only an assistant with a shell can (the owner's own
  // Codex, a node of the account's own with the shell allowed, or the server's bubblewrap sandbox when it is on and starts).
  if (assistantOff || !(shellAssistant(workspaceId) || sandboxNow().ok) || growingWorkflows.has(workspaceId) || agentService.runningTasks(workspaceId).length) return;
  const candidate = growCandidates(analysisStore, workspaceId)[0];
  // What the person asked for in words is their own work, like a capture: it runs while the quota lasts. An errand the system noticed
  // repeating is its own idea, and waits for a normal quota.
  if (!candidate || !spendAllows(await spendFor(workspaceId), candidate.origin.kind === "asked" ? "core" : "discretionary")) return;
  // What this line's library already holds, so the new workflow names and builds on it instead of copying it.
  const library = [...readPublicSkills(analysisStore, workspaceId).filter((skill) => skill.lines.includes(candidate.lineId) && skill.review.final !== "reject")
    .map((skill) => ({ name: publicSkillName(skill.id), description: skill.description })),
    ...readGrownSkills(analysisStore, workspaceId).filter((skill) => skill.status === "active" && grownHomeLine(analysisStore, workspaceId, skill) === candidate.lineId)
      .map((skill) => ({ name: grownSkillName(skill.id), description: skill.manifest.summary }))];
  const input = growTask(candidate, identityLines(analysisStore, workspaceId).map((line) => line.id), aiToolsFor(analysisStore, workspaceId), library, localeOf(analysisStore, workspaceId));
  growingWorkflows.add(workspaceId);
  const started = agentService.runFree(workspaceId, input, (outcome) => {
    void installGrown(analysisStore, workspaceId, candidate, outcome, { client: accountClient(workspaceId), cwd: repoRoot })
      .then((result) => console.info(JSON.stringify({ type: "skill.grown." + result.state, workspaceId, ...result })))
      .catch(() => undefined).finally(() => {
        growingWorkflows.delete(workspaceId);
        // A request the person made while this one was growing is taken up now, not a tick later (found 2026-10-14: a request typed
        // during a system-noticed growth waited behind it for the next tick).
        if (growCandidates(analysisStore, workspaceId).some((next) => next.origin.kind === "asked")) void workflowPass(workspaceId, new Date().toISOString()).catch(() => undefined);
      });
  });
  if (started.state !== "started") growingWorkflows.delete(workspaceId);
  // A busy assistant or another account's workspace is tried again on a later tick; nothing is recorded for it.
  if (started.state === "blocked") return;
  // Tried once per errand or request: a kind the person has not allowed is said once, not every tick.
  analysisStore.appendEvent({ ownerId: ownerOf(analysisStore, workspaceId), workspaceId, idempotencyKey: "skill.grown.attempted:" + input.taskId, type: "skill.grown.attempted",
    entityId: candidate.lineId, payload: { taskId: input.taskId, state: started.state, ...(candidate.origin.kind === "asked" ? { requestId: candidate.origin.requestId } : { taskIds: candidate.origin.taskIds }) } });
  if (started.state === "needs_category_approval") {
    const t = tOfWorkspace(analysisStore, workspaceId);
    sayToPerson(analysisStore, workspaceId, t("要把「{{text}}」固化成工作流，需要先允许助手做「{{label}}」这类工作。", { text: growLabel(candidate.text), label: t(started.label) }),
      "skill_grown", "grow-needs:" + input.taskId, [{ label: t("去开启"), href: "/automation#capabilities" }]);
  }
}
