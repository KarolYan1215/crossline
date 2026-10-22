import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import {
  MANUAL_DESIGN_SCHEMA, MATERIAL_SEARCH_SCHEMA, NODE_WRITEUP_SCHEMA, backgroundSpend, openAccessVerdict, profileFactId, relevantDocuments, topologicalOrder,
  validateManualDesign, validateMaterialSearch, validateNodeWriteup,
  type CostSignal, type FoundSource, type ManualDesign, type ManualDesignContext, type ManualNode, type MaterialSearch,
  type MaterialSearchContext, type NodeWriteup, type WriteContext
} from "@crossline/core";
import { continueSkillTurn, releaseThread, runCodexSkill, webResearchBlocker, type CodexRpcBoundary, type SkillRunResult } from "@crossline/codex";
import { aiToolsFor, doneKinds, listAgentTasks, openNeedsOf, preparationOf, provisionsOf, type CrosslineStore } from "@crossline/db";
import { aiToolBrief, onPersonsBoard, requiredApproval, taskTitleOf, tutorialSteps } from "@crossline/core";
import { claimedTitleMatches } from "./diligence";
import { arxivPdfAddress, defaultSafeGetDeps, htmlToText, safeGet, type SafeGetDeps } from "./safe-fetch";
import { extractText } from "./extract";

export const MANUAL_DESIGNER_SKILL = "crossline:crossline-manualbook-designer";
export const MATERIAL_RESEARCHER_SKILL = "crossline:crossline-material-researcher";
import { libraryInstruction, librarySkillsFor } from "./skill-library";
export const MATERIAL_WRITER_SKILL = "crossline:crossline-material-writer";
import { ownerOf } from "./owner";
import { startingWithin } from "./schedule-window";
import { planningContext } from "./step-planner";

// Short summaries of each scenario; each Skill carries the detail.
const DESIGN_INSTRUCTIONS = "Design the tutorial for one task as a short flow of the steps the person learns from (planned steps are only those), left to right; a researcher then searches "
  + "the web for the steps that need it and a writer writes each step from what was found. Every step is concrete and serves contract items "
  + "by id (every required one is served). Mark needsResearch only for the one to three steps that need knowledge or a method the person's own "
  + "files do not hold, each with two to four research questions the open web can answer, fitted to the person's setting and to the step's "
  + "scale; every other step has needsResearch false and no questions. When the task has planned steps, make one node per planned step in their order, with the planned step's title copied "
  + "exactly. No loops, no two steps overlapping. Do not do the work. Return only the requested JSON, every human-readable field in Chinese.";
const SEARCH_INSTRUCTIONS = "Find the best public material for ONE step of a task's tutorial: a writer will write the step from your sources alone. "
  + "Answer every research question; a source is a public https page you opened, with its real title, and its summary says faithfully what it "
  + "gives for this step. Prefer primary, open-access sources in the person's setting and language, at the step's scale. Say honestly whether you "
  + "believe the full text is open access; the app decides what is kept. Put what you could not find in gaps; never invent a source. Return only "
  + "the requested JSON, every human-readable field in Chinese.";
const WRITE_INSTRUCTIONS = "Write ONE section of the tutorial the person learns from: an analysis of what the supplied material says for this step and "
  + "a finished teaching document made from it — the key points with formulas and conditions, a worked example solved in full, the common mistakes "
  + "and a short self-check — fitted to this person's level and their own files, then a list of the materials used with what each gives and where and "
  + "how to get it (the link is the source id; for material behind a login, the path on that platform). Do not restate the step's own plan (title, "
  + "first move, hand-in, done criterion: it is on the task card), and process public sources the same way when the person has no file for it. "
  + "Cite sources only by their id and never write a web address yourself; where the "
  + "sources do not support a detail, say so. Cover this step fully and nothing of another, saying each point once. Return only the requested JSON, in Chinese.";

export type ManualProgress = { stage: "designing" | "researching" | "writing" | "assembling"; done: number; total: number };
export type ManualOutcome =
  | { state: "ready"; workOrderId: string; artifacts: number; nodes: number; sources: number; downloaded: number }
  | { state: "blocked"; workOrderId: string; code: string; message: string };

export type ManualbookDeps = {
  safeGet: SafeGetDeps; readCost: () => Promise<CostSignal>; now: () => Date;
  /** Why web research cannot run here, if it cannot. A manualbook is still built without it, just without found sources. */
  webBlocker: () => { code: string; message: string } | undefined;
  /** Where the person's skill library is written (tests); the default sits beside the Codex homes. */
  libraryDir?: string;
};

type KeptSource = {
  id: string; url: string; title: string; publisher: string; kind: string; summary: string; kept: "full_text" | "summary_only" | "unverified";
  /** A file the person uploaded (its source-document id): read from the app's own copy, never downloaded. */
  docId?: string;
  verdict: string; fetchedAt: string; file?: string; sha256?: string; bytes?: number; text: string;
  /** The downloaded file itself, held only until it is written into the manualbook folder. */
  raw?: Uint8Array;
};
type NodeResult = { node: ManualNode; sources: KeptSource[]; gaps: string[]; writeup: NodeWriteup | undefined; note?: string };

const TEXT_PER_SOURCE = 12_000;
const DOWNLOADS_PER_NODE = 3;
const MAX_PDF_BYTES = 15_000_000;
const MAX_PAGE_BYTES = 3_000_000;

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "source";
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** Where the person is and what language they work in, from their own confirmed facts (never an assumption), for the researcher. */
export function personSetting(facts: ReadonlyArray<{ identityId: string; slot: string; value: string; status: string }>): string[] {
  return facts.filter((fact) => fact.identityId === "person" && fact.status === "confirmed" && !fact.value.startsWith("假设")
    && /city|country|location|region|language|locale|所在|城市|国家|地区|语言/i.test(fact.slot)).map((fact) => fact.value.slice(0, 80)).slice(0, 4);
}

/** What the person attached when they captured this, still readable after promotion. */
function captureInputs(store: CrosslineStore, workspaceId: string, workOrderId: string): Array<{ id: string; text: string }> {
  const capture = store.listCaptures(workspaceId).find((item) => item.id === workOrderId);
  if (!capture) return [];
  return [{ id: "capture-context", text: capture.context.trim() }, { id: "capture-title", text: capture.title.trim() }].filter((input) => input.text);
}

export function buildManualContext(store: CrosslineStore, workspaceId: string, workOrderId: string, today: string): ManualDesignContext | undefined {
  const order = store.listWorkOrders(workspaceId).find((item) => item.id === workOrderId);
  if (!order) return undefined;
  const payload = order.payload as {
    materialContract?: Array<{ id?: string; description?: string; kind?: string; required?: boolean }>;
    evidenceContract?: Array<{ id?: string; description?: string; requirement?: string; kind?: string; required?: boolean }>;
    availableInputs?: Array<{ id?: string; text?: string }>;
  };
  const milestone = order.milestoneId ? store.getMilestone(workspaceId, order.milestoneId) : undefined;
  const anchor = order.milestoneId ? store.listMilestoneAnchors(workspaceId).find((item) => item.milestoneId === order.milestoneId) : undefined;
  // The tutorial is for the person's own steps; the assistant's preparation is done for them and shows up as material.
  const stepPlan = store.getStepPlan(workspaceId, order.id);
  // Only the steps the person learns from (`tutorialSteps`: product `ability`), and of those only the ones whose own material is in: a step
  // waiting on an upload (`openNeedsOf`) gets its section once the person gives it or says there is none.
  const steps = tutorialSteps(stepPlan?.steps.filter((step) => step.status === "planned") ?? [])
    .filter((step) => !openNeedsOf(stepPlan!, step).length);
  const unitTitle = new Map((stepPlan?.units ?? []).map((unit) => [unit.id, unit.title]));
  const prepared = listAgentTasks(store, workspaceId).filter((task) => task.workOrderId === order.id && task.artifacts.length)
    .map((task) => ({ step: stepPlan?.steps.find((step) => step.id === task.stepId)?.title ?? task.title, files: task.artifacts.map((artifact) => artifact.path.split(/[\\/]/).at(-1) ?? artifact.path) }));
  const explicit = [
    ...(payload.materialContract ?? []).map((item, index) => ({ id: item.id ?? `${order.id}-material-${index}`, kind: "material" as const,
      description: item.description ?? item.kind ?? "", required: item.required !== false })),
    ...(payload.evidenceContract ?? []).map((item, index) => ({ id: item.id ?? `${order.id}-evidence-${index}`, kind: "evidence" as const,
      description: item.description ?? item.requirement ?? item.kind ?? "", required: item.required !== false }))
  ].filter((item) => item.description);
  const projectName = store.listProjects(workspaceId, { includeArchived: true }).find((project) => project.id === order.projectId)?.name;
  return {
    version: "crossline.manualbook.design.v1", today,
    workOrder: { id: order.id, intent: order.intent, identityId: order.identityId,
      milestone: milestone ? { title: milestone.title, target: anchor?.target ?? "", deadline: anchor?.deadline ?? "" } : null },
    // A task worked back from a milestone has no contract of its own; its steps' completion criteria stand in for one.
    contract: explicit.length ? explicit : steps.map((step) => ({ id: `step-${step.id}`, kind: "evidence" as const,
      description: (step.doneCriterion || step.title).slice(0, 300), required: true })),
    inputs: [
      ...(payload.availableInputs ?? []).map((input, index) => ({ id: input.id ?? `${order.id}-input-${index}`, text: input.text ?? "" })),
      ...captureInputs(store, workspaceId, order.id)
    ].filter((input) => input.text),
    localFiles: relevantDocuments(store.listSourceDocuments(workspaceId), { projectId: order.projectId, projectName }).map((doc) => doc.fileName).slice(0, 30),
    profile: store.listProfileFacts(workspaceId).filter((fact) => fact.identityId === order.identityId && fact.status === "confirmed").slice(0, 30)
      .map((fact) => ({ id: profileFactId(fact), value: fact.value })),
    // This line's and the person's own: another line's 「不能……」 is not a constraint on this task.
    constraints: store.listProfileFacts(workspaceId).filter((fact) => (fact.identityId === order.identityId || fact.identityId === "person")
      && (/constraint|限制|约束/.test(fact.slot) || /无法|不能|不要/.test(fact.value))).map((fact) => fact.value).slice(0, 8),
    person: planningContext(store, workspaceId, order).person,
    setting: personSetting(store.listProfileFacts(workspaceId)),
    ...(prepared.length ? { prepared } : {}),
    ...(steps.length ? { plannedSteps: steps.map((step) => ({ id: step.id, title: step.title, role: step.role, doneCriterion: step.doneCriterion ?? "",
      covers: (step.covers ?? []).map((id) => unitTitle.get(id) ?? id), why: step.why ?? "", ...(step.aiAssist?.tool ? { aiAssist: step.aiAssist } : {}) })) } : {})
  };
}

export function createManualbookBuilder(store: CrosslineStore, workspaceId: string, materialsDir: string, cwd: string,
  getClient: () => CodexRpcBoundary | undefined, deps: Partial<ManualbookDeps> & Pick<ManualbookDeps, "readCost">) {
  const all: ManualbookDeps = { safeGet: defaultSafeGetDeps(), now: () => new Date(), webBlocker: webResearchBlocker, ...deps };

  /**
   * `prepare` (the default) is material preparation for an order in `preparing`, which moves it on when done. `tutorial` builds the same
   * book for committed work in any state short of done — following its step plan, reading the person's own files — and moves nothing.
   */
  return async function build(workOrderId: string, options: { mode?: "prepare" | "tutorial" } = {}): Promise<ManualOutcome> {
    const mode = options.mode ?? "prepare";
    const blocked = (code: string, message: string): ManualOutcome => ({ state: "blocked", workOrderId, code, message });
    const client = getClient();
    if (!client) return blocked("CODEX_SUPERVISOR_UNAVAILABLE", "模型服务不可用；可手动准备材料。");
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(workOrderId)) return blocked("MATERIAL_PATH_OUTSIDE_ROOT", "作业 id 不合法。");
    const order = store.getWorkOrder(workspaceId, workOrderId);
    if (!order) return blocked("WORK_ORDER_NOT_FOUND", "找不到该作业。");
    if (mode === "prepare" && order.state !== "preparing") return blocked("MATERIALS_NOT_PREPARING", "作业当前不在材料准备阶段。");
    if (mode === "tutorial" && !["approved", "preparing", "ready_for_human", "active"].includes(order.state)) return blocked("TUTORIAL_NOT_AVAILABLE", "任务当前状态不需要教程。");
    const ownerId = ownerOf(store, workspaceId);
    const today = (process.env.CROSSLINE_FIXED_NOW ? new Date(process.env.CROSSLINE_FIXED_NOW) : all.now()).toISOString().slice(0, 10);
    const context = buildManualContext(store, workspaceId, workOrderId, today)!;
    if (!context.contract.length) return blocked("MATERIALS_NOT_REQUIRED", "该任务没有步骤、材料或证据要求，无法生成教程。");
    // The person's own files for this task (a homework sheet, the syllabus), read from the app's copy and given to every step's writer.
    const uploads: KeptSource[] = tutorialUploads(store, workspaceId, order).map((doc, index) => ({ id: `upload-${index + 1}`, url: `local:${doc.id}`, title: doc.fileName,
        publisher: "本人上传", kind: "upload", summary: doc.extractedText.trim().slice(0, 300), kept: "full_text" as const, verdict: "本人上传的文件",
        fetchedAt: all.now().toISOString(), docId: doc.id, text: doc.extractedText.slice(0, TEXT_PER_SOURCE) }));
    // What the assistant prepared for this task (a formula sheet, a problem list) is material the tutorial builds on and links to.
    for (const task of listAgentTasks(store, workspaceId).filter((item) => item.workOrderId === workOrderId && item.status !== "blocked")) {
      for (const artifact of task.artifacts.filter((item) => /\.(md|txt|csv|json)$/i.test(item.path)).slice(0, 3)) {
        let text = "";
        try { text = readFileSync(artifact.path, "utf8"); } catch { continue; }
        if (!text.trim()) continue;
        uploads.push({ id: `prep-${uploads.length + 1}`, url: `agent:${task.taskId}/${artifact.path}`, title: artifact.path.split(/[\\/]/).at(-1) ?? artifact.path,
          publisher: "助手准备", kind: "prepared", summary: text.trim().slice(0, 300), kept: "full_text", verdict: "助手为此任务准备的文件",
          fetchedAt: all.now().toISOString(), text: text.slice(0, TEXT_PER_SOURCE) });
      }
    }

    // Discretionary spend: when the quota is gone the person prepares it themselves. A tight quota is handled one
    // level down, where the Skills step to a cheaper model instead of refusing.
    const cost = await all.readCost();
    const spend = backgroundSpend(cost).mode;
    if (spend === "manual_core_only") {
      return blocked(cost.available ? "MATERIAL_BUDGET_EXHAUSTED" : "COST_SIGNAL_UNAVAILABLE", cost.available ? "预算已用尽；材料请人工自备。" : "读不到用量信号；材料请人工自备。");
    }

    const progress = (stage: ManualProgress["stage"], done: number, total: number) => store.appendEvent({
      ownerId, workspaceId, idempotencyKey: `manualbook:progress:${workOrderId}:${stage}:${done}:${randomUUID()}`, type: "manualbook.progress",
      entityId: workOrderId, payload: { stage, done, total } satisfies ManualProgress });
    const fail = (code: string, message: string): ManualOutcome => {
      // Keyed per retry: a retry that failed with the same code as before used to collide with the first block, so the retry
      // request stayed the last word and the order was prepared again on every tick.
      // A tutorial's failure is its own event: `materials.blocked` decides whether a `preparing` order is retried on the tick.
      const kind = mode === "tutorial" ? "tutorial" : "materials";
      const attempt = store.listEvents(workspaceId, { type: mode === "tutorial" ? "tutorial.requested" : "materials.retry_requested", entityId: workOrderId }).length;
      store.appendEvent({ ownerId, workspaceId, idempotencyKey: `${kind}:blocked:${workOrderId}:${code}:${attempt}:${mode === "tutorial" ? all.now().getTime() : ""}`, type: `${kind}.blocked`, entityId: workOrderId, payload: { code, message } });
      return blocked(code, message);
    };

    // A task finished while its tutorial was being written needs it no more (walkthrough W-16: the tutorial kept being written after 完成).
    // Checked between model runs, so at most the run under way is spent; nothing is recorded, the task page simply stops asking.
    const finished = () => mode === "tutorial" && ["accepted", "archived"].includes(store.getWorkOrder(workspaceId, workOrderId)?.state ?? "archived");
    const stopped = (): ManualOutcome => blocked("TUTORIAL_TASK_FINISHED", "任务已完成，教程不再生成。");

    // 1. the flow ------------------------------------------------------------------------------------------------
    progress("designing", 0, 1);
    const designed = await runCodexSkill<ManualDesign>(client, context, {
      skillName: MANUAL_DESIGNER_SKILL, cwd, developerInstructions: DESIGN_INSTRUCTIONS, outputSchema: MANUAL_DESIGN_SCHEMA,
      // The prompt cache (docs/token-economy.md §2.5): the person's and the line's, then the project's, then this task and the date.
      stableKeys: ["version", "setting", "profile", "constraints", "person", "localFiles"],
      prepareInput: () => context, validateOutput: (output) => validateManualDesign(output, context), onAudit: () => {}, timeoutMs: 60 * 60_000
    });
    if (!designed.ok) return fail(designed.blocker.code, designed.blocker.message);
    const design = designed.output;
    const order_ = topologicalOrder(design.nodes.map((node) => node.id), design.edges)!;
    const nodes = order_.map((id) => design.nodes.find((node) => node.id === id)!);

    // 2. material, per step -------------------------------------------------------------------------------------
    const web = all.webBlocker();
    const results: NodeResult[] = [];
    // Only the steps the designer marked as needing outside material are researched, at most `MAX_RESEARCHED_STEPS` of them; a step another
    // tutorial of the same project already researched under the same title takes those sources instead of searching again.
    // The person's own material first (2026-10-22): a step whose needed material the person uploaded is written from it, not searched for.
    const ownMaterial = stepsWithOwnMaterial(store, workspaceId, order.id);
    const researched = new Set(nodes.filter((node) => node.needsResearch && !ownMaterial.has(node.title.trim())).slice(0, MAX_RESEARCHED_STEPS).map((node) => node.id));
    const earlier = researchedBefore(store, workspaceId, materialsDir, order, all.now());
    let searched = 0;
    for (const [index, node] of nodes.entries()) {
      if (finished()) return stopped();
      const result: NodeResult = { node, sources: [], gaps: [], writeup: undefined };
      results.push(result);
      // A step not researched is written from the person's own files and what the assistant prepared.
      if (!researched.has(node.id)) continue;
      const reused = earlier.get(titleKey(node.title));
      if (reused) { result.sources = reused.sources.map((source, at) => ({ ...source, id: `n${index + 1}-s${at + 1}` })); result.gaps.push(`${reused.note}，没有重新检索。`); }
      else if (web) { result.gaps.push(`没有联网查资料：${web.message}`); }
      else {
        progress("researching", searched, researched.size);
        searched += 1;
        const searchContext: MaterialSearchContext = { version: "crossline.manualbook.search.v1", today, task: { intent: context.workOrder.intent },
          node: { id: node.id, title: node.title, kind: node.kind, goal: node.goal, steps: node.steps,
            researchQuestions: node.researchQuestions.length ? node.researchQuestions : [`${node.title}：${node.goal}`] },
          localFiles: context.localFiles, constraints: context.constraints, ...(context.setting?.length ? { setting: context.setting } : {}) };
        const found = await runCodexSkill<MaterialSearch>(client, searchContext, {
          skillName: MATERIAL_RESEARCHER_SKILL, cwd, developerInstructions: SEARCH_INSTRUCTIONS, outputSchema: MATERIAL_SEARCH_SCHEMA, allowWebSearch: true,
          stableKeys: ["version", "setting", "constraints", "localFiles", "task"],
          prepareInput: () => searchContext, validateOutput: (output) => validateMaterialSearch(output), onAudit: () => {}, timeoutMs: 60 * 60_000
        });
        if (!found.ok) result.gaps.push(`这一步没有找到可核实的资料：${found.blocker.message}`);
        else {
          result.gaps.push(...found.output.gaps);
          // Ids made unique across the book (`n2-s1`): the writer answers every step in one conversation and must not mix two steps' `s1`.
          result.sources = (await keepSources(found.output.sources, all, today, result.gaps)).map((source) => ({ ...source, id: `n${index + 1}-${source.id}` }));
          noteResearch(materialsDir, workOrderId, node.title, result.sources);
        }
      }
    }

    // 3. the write-up, per step ---------------------------------------------------------------------------------
    // The line's own skill and the public skills that fit the task, read beside the writer's: a tutorial for the person's way of doing it.
    const writerSkills = await librarySkillsFor(client, store, workspaceId, order.identityId, { cwd, task: order.intent, ...(all.libraryDir ? { dir: all.libraryDir } : {}) });
    // Every step is written in ONE conversation (2026-10-21): the first turn carries what all steps share — the task, the person, their
    // files (`upload-N`, `prep-N`: most of a writer's input) — and each later turn only the next step and its own sources. A fresh thread
    // per step re-sent the shared part every time under a new cache key; on the owner's account 17 writer runs read 417k tokens, 30%
    // from cache. The stable part comes first in the first turn too, so a fresh thread after a lost one still shares its prefix.
    const aiTools = aiToolsFor(store, workspaceId).map(aiToolBrief);
    let thread: string | undefined;
    for (const [index, result] of results.entries()) {
      if (finished()) return stopped();
      progress("writing", index, results.length);
      const planned = context.plannedSteps?.find((step) => step.title === result.node.title);
      const node = { id: result.node.id, title: result.node.title, kind: result.node.kind, goal: result.node.goal, steps: result.node.steps, acceptance: result.node.acceptance };
      const own = result.sources.map((source) => ({ id: source.id, title: source.title, url: source.url, kept: source.kept, text: source.text }));
      const writeContext: WriteContext = { version: "crossline.manualbook.write.v1", today, task: { intent: context.workOrder.intent },
        inputs: context.inputs, profile: context.profile, person: context.person ?? [], aiTools,
        sources: [...uploads.map((source) => ({ id: source.id, title: source.title, url: source.url, kept: source.kept, text: source.text })), ...own],
        node, covers: planned?.covers ?? [], ...(planned?.aiAssist ? { aiAssist: planned.aiAssist } : {}) };
      const validate = (output: unknown) => validateNodeWriteup(output, writeContext);
      const fresh = () => runCodexSkill<NodeWriteup>(client, writeContext, {
        skillName: MATERIAL_WRITER_SKILL, cwd, developerInstructions: WRITE_INSTRUCTIONS,
        // The person's, then this task's shared material, then the step and the date; the library skills' note after the input.
        stableKeys: ["version", "profile", "person", "aiTools", "task", "inputs", "sources"],
        ...(writerSkills.length ? { runNote: libraryInstruction(writerSkills) } : {}),
        ...(writerSkills.length ? { extraSkills: writerSkills } : {}), outputSchema: NODE_WRITEUP_SCHEMA, keepThread: true,
        prepareInput: () => writeContext, validateOutput: validate, onAudit: () => {}, timeoutMs: 60 * 60_000
      });
      let written: SkillRunResult<NodeWriteup>;
      if (!thread) written = await fresh();
      else {
        const next = { version: writeContext.version, next: true, node, covers: writeContext.covers, ...(planned?.aiAssist ? { aiAssist: planned.aiAssist } : {}), sources: own };
        // No `$skill` mention again: the runtime would inject the whole SKILL.md into the conversation a second time.
        written = await continueSkillTurn<NodeWriteup>(client, thread, JSON.stringify(next), {
          skillName: MATERIAL_WRITER_SKILL, cwd, outputSchema: NODE_WRITEUP_SCHEMA, validateOutput: validate, onAudit: () => {}, timeoutMs: 60 * 60_000 });
        // The runtime lost the conversation (a restart): this step starts a new one with everything shared in it again.
        if (!written.ok && written.blocker.code === "SKILL_THREAD_LOST") { thread = undefined; written = await fresh(); }
      }
      if (written.audit.threadId && (written.ok || !thread)) thread = written.audit.threadId;
      if (written.ok) result.writeup = written.output;
      else result.note = `这一步的分析和教程没有写成：${written.blocker.message}`;
    }
    // Kept open between steps only (`keepThread`); let the runtime unload it now rather than ten minutes later.
    if (thread) releaseThread(client, thread);
    // The writer's own reason is what the person can act on (the material it was given was for another course, say): it is kept, not
    // replaced by a sentence that only says nothing was written.
    if (!results.some((result) => result.writeup)) {
      const reason = results.map((result) => result.note).find(Boolean)?.replace(/^这一步的分析和教程没有写成：/, "") ?? "";
      return fail("MANUALBOOK_NOTHING_WRITTEN", `每一步的分析和教程都没有写成，所以没有生成手册${reason ? `。第一步的原因：${reason}` : "。"}`);
    }

    // 4. assemble ---------------------------------------------------------------------------------------------
    if (finished()) return stopped();
    progress("assembling", 0, 1);
    const files = assemble({ design, nodes: results, context, uploads, builtAt: all.now().toISOString() });
    const root = path.join(materialsDir, workOrderId);
    const staging = `${root}.building-${randomUUID().slice(0, 8)}`;
    try {
      for (const file of files) {
        const target = path.join(staging, file.path);
        if (path.relative(staging, target).startsWith("..")) return fail("MATERIAL_PATH_OUTSIDE_ROOT", "手册里有越出目录的路径；没有写入。");
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, file.bytes);
      }
      if (existsSync(root)) rmSync(root, { recursive: true, force: true });
      renameSync(staging, root);
    } catch {
      rmSync(staging, { recursive: true, force: true });
      return fail("MATERIAL_PREPARATION_FAILED", "教程写入失败；可手动准备材料。");
    }
    // A rebuild writes the same paths again; a row per path is kept, not one per build.
    const known = new Set(store.listMaterials(workspaceId, workOrderId).map((item) => item.uri));
    for (const file of files.filter((item) => item.record && !known.has(pathToFileURL(path.join(root, item.path)).href))) {
      store.saveMaterial({ id: randomUUID(), ownerId, workspaceId, workOrderId, uri: pathToFileURL(path.join(root, file.path)).href,
        mediaType: file.mediaType, sourceRefs: file.sourceRefs.length ? file.sourceRefs : ["manualbook"], createdAt: all.now().toISOString() });
    }
    if (store.getWorkOrder(workspaceId, workOrderId)?.state === "preparing")
      store.transitionWorkOrder(workspaceId, workOrderId, { type: "materials.ready" }, `materials-ready:${workOrderId}:manualbook`);
    const sources = results.flatMap((result) => result.sources);
    const builds = store.listEvents(workspaceId, { type: "manualbook.built", entityId: workOrderId }).length;
    store.appendEvent({ ownerId, workspaceId, idempotencyKey: builds ? `manualbook:built:${workOrderId}:${builds}` : `manualbook:built:${workOrderId}`, type: "manualbook.built", entityId: workOrderId,
      payload: { nodes: nodes.length, sources: sources.length, downloaded: sources.filter((source) => source.kept === "full_text").length,
        inputs: tutorialInputs(store, workspaceId, workOrderId), inputsVersion: TUTORIAL_INPUTS_VERSION,
        researched: researched.size } });
    return { state: "ready", workOrderId, artifacts: files.filter((item) => item.record).length, nodes: nodes.length, sources: sources.length,
      downloaded: sources.filter((source) => source.kept === "full_text").length };
  };
}

/**
 * Opens every source the model named and decides what to keep. A page that does not open, or does not match its claimed
 * title, is dropped. An open-access page on a known host is downloaded in full (capped, typed, checksummed); everything
 * else keeps its link and the model's summary and nothing of the page itself.
 */
export async function keepSources(found: FoundSource[], deps: ManualbookDeps, today: string, gaps: string[]): Promise<KeptSource[]> {
  const kept: KeptSource[] = [];
  let downloads = 0;
  for (const source of found.slice(0, 6)) {
    const raw = openAccessVerdict(source);
    // Whether downloading is allowed at all is the approval policy's word, checked here rather than assumed.
    const verdict = raw.download && requiredApproval("download_open_access") !== "automatic" ? { download: false as const, why: "当前策略不允许自动下载" } : raw;
    const fetchedAt = deps.now().toISOString();
    if (verdict.download && downloads < DOWNLOADS_PER_NODE) {
      const address = arxivPdfAddress(source.url);
      const got = await safeGet(address, deps.safeGet, { maxBytes: MAX_PDF_BYTES, timeoutMs: 60_000 });
      if (got.ok) {
        const isPdf = got.contentType === "application/pdf";
        const text = isPdf ? (await extractText(got.bytes, "pdf")).text : got.contentType.startsWith("text/html") || got.contentType.includes("xhtml")
          ? htmlToText(new TextDecoder().decode(got.bytes)) : new TextDecoder().decode(got.bytes);
        if (text.trim() && claimedTitleMatches(source.title, text.slice(0, 6000))) {
          downloads += 1;
          kept.push({ id: source.id, url: source.url, title: source.title, publisher: source.publisher, kind: source.kind, summary: source.summary, kept: "full_text",
            verdict: verdict.why, fetchedAt, file: `${slug(source.title)}-${got.sha256.slice(0, 8)}.${isPdf ? "pdf" : got.contentType.startsWith("text/html") ? "html" : "txt"}`,
            sha256: got.sha256, bytes: got.bytes.byteLength, text: text.slice(0, TEXT_PER_SOURCE), raw: got.bytes });
          continue;
        }
        gaps.push(`「${source.title}」下载了，但内容与标题对不上，已丢弃。`);
        continue;
      }
      gaps.push(`「${source.title}」没能下载（${got.reason}）。`);
    }
    // Link and summary only: still opened, so a page that does not exist is not listed.
    const page = await safeGet(source.url, deps.safeGet, { maxBytes: MAX_PAGE_BYTES });
    // A site that refuses automated readers (401/403) or asks them to slow down (429) answered — the page exists — but could not be read
    // here: its link and the researcher's summary are kept, marked as not checked by the app, instead of being dropped.
    if (!page.ok && /返回 (401|403|429)$/.test(page.reason)) {
      gaps.push(`「${source.title}」拒绝自动访问（${page.reason}），保留链接与摘要，未能自动核实。`);
      kept.push({ id: source.id, url: source.url, title: source.title, publisher: source.publisher, kind: source.kind, summary: source.summary,
        kept: "unverified", verdict: `网站拒绝自动访问（${page.reason}），内容未经本应用核实`, fetchedAt, text: source.summary });
      continue;
    }
    if (!page.ok) { gaps.push(`「${source.title}」打不开（${page.reason}），已丢弃。`); continue; }
    if (page.contentType.startsWith("text/html") && !claimedTitleMatches(source.title, htmlToText(new TextDecoder().decode(page.bytes)).slice(0, 6000))) {
      gaps.push(`「${source.title}」的页面内容与标题对不上，已丢弃。`); continue;
    }
    kept.push({ id: source.id, url: source.url, title: source.title, publisher: source.publisher, kind: source.kind, summary: source.summary,
      kept: "summary_only", verdict: verdict.download ? "已达到下载数量上限：只保留链接和摘要" : verdict.why, fetchedAt, text: source.summary });
  }
  void today;
  return kept;
}

type OutFile = { path: string; bytes: Uint8Array | string; mediaType: string; record: boolean; sourceRefs: string[] };

function assemble(input: { design: ManualDesign; nodes: NodeResult[]; context: ManualDesignContext; uploads: KeptSource[]; builtAt: string }): Array<OutFile & { bytes: Uint8Array | string }> {
  const { design, nodes, context, uploads } = input;
  const files: OutFile[] = [];
  // Every material once, with what each step's writer said about it: the material's own preview page reads this.
  const materials = new Map<string, { id: string; title: string; publisher: string; url: string; docId?: string; kept: string; verdict: string; file?: string; summary: string;
    notes: Array<{ node: string; step: string; note: string }> }>();
  const keyOf = (source: KeptSource) => source.docId ? `doc:${source.docId}` : source.url;
  for (const source of [...uploads, ...nodes.flatMap((result) => result.sources)]) {
    if (materials.has(keyOf(source))) continue;
    const node = nodes.find((result) => result.sources.includes(source));
    materials.set(keyOf(source), { id: source.id, title: source.title, publisher: source.publisher, url: source.docId ? "" : source.url, ...(source.docId ? { docId: source.docId } : {}),
      kept: source.kept, verdict: source.verdict, summary: source.summary, ...(source.file && node ? { file: `nodes/${node.node.id}/sources/${source.file}` } : {}), notes: [] });
  }
  for (const result of nodes) for (const item of result.writeup?.sourceNotes ?? []) {
    const source = [...uploads, ...result.sources].find((candidate) => candidate.id === item.sourceId);
    const entry = source ? materials.get(keyOf(source)) : undefined;
    if (entry) entry.notes.push({ node: result.node.id, step: result.node.title, note: item.note });
  }
  files.push({ path: "materials.json", mediaType: "application/json", record: false, sourceRefs: [], bytes: JSON.stringify([...materials.values()], null, 2) });
  const order = new Map(nodes.map((result, index) => [result.node.id, index]));
  const depth = new Map<string, number>();
  for (const result of nodes) {
    const parents = design.edges.filter((edge) => edge.to === result.node.id).map((edge) => depth.get(edge.from) ?? 0);
    depth.set(result.node.id, parents.length ? Math.max(...parents) + 1 : 0);
  }
  files.push({ path: "flow.json", mediaType: "application/json", record: true, sourceRefs: [],
    // `stepId`: the task step this section is written for (one node per planned step, same title), so the reading page and the step
    // list link to each other.
    bytes: JSON.stringify({ version: 1, nodes: nodes.map((result) => {
      const stepId = context.plannedSteps?.find((step) => step.title.trim() === result.node.title.trim())?.id;
      return { id: result.node.id, title: result.node.title, kind: result.node.kind, goal: result.node.goal, ...(stepId ? { stepId } : {}),
        stage: depth.get(result.node.id) ?? 0, order: order.get(result.node.id), hasWriteup: Boolean(result.writeup), sources: result.sources.length };
    }), edges: design.edges }, null, 2) });

  const sourceList = (result: NodeResult) => result.sources.map((source) => `- **${source.id}** ${source.title}（${source.publisher || "—"}）${source.url}\n  - ${source.kept === "full_text" ? `已下载全文：${source.verdict}` : source.verdict}\n  - 摘要：${source.summary}`).join("\n");
  files.push({ path: "manual.md", mediaType: "text/markdown", record: true, sourceRefs: [],
    bytes: [`# ${context.workOrder.intent}`, "", design.overview, "", ...(design.assumptions.length ? ["## 假设", ...design.assumptions.map((item) => `- ${item}`), ""] : []),
      "## 流程", ...nodes.map((result, index) => `${index + 1}. [${result.node.title}](nodes/${result.node.id}/task.md) — ${result.node.goal}`)].join("\n") });
  for (const result of nodes) {
    const base = `nodes/${result.node.id}`;
    files.push({ path: `${base}/task.md`, mediaType: "text/markdown", record: true, sourceRefs: [],
      bytes: [`# ${result.node.title}`, "", `**目标**：${result.node.goal}`, "", "## 步骤", ...result.node.steps.map((step, index) => `${index + 1}. ${step}`), "",
        `## 怎样算做到\n${result.node.acceptance}`, ...(result.node.researchQuestions.length ? ["", "## 要查的问题", ...result.node.researchQuestions.map((q) => `- ${q}`)] : []),
        ...(result.gaps.length ? ["", "## 没查到的", ...result.gaps.map((gap) => `- ${gap}`)] : [])].join("\n") });
    if (result.writeup) {
      const cited = result.sources.filter((source) => result.writeup!.citations.includes(source.id));
      files.push({ path: `${base}/analysis.md`, mediaType: "text/markdown", record: true, sourceRefs: cited.map((source) => source.url),
        bytes: `# 分析：${result.node.title}\n\n${result.writeup.analysis}\n\n## 参考来源\n${sourceList(result) || "（这一步没有外部来源）"}\n` });
      files.push({ path: `${base}/tutorial.md`, mediaType: "text/markdown", record: true, sourceRefs: cited.map((source) => source.url),
        bytes: `# 教程：${result.node.title}\n\n${result.writeup.tutorial}\n` });
    } else if (result.note) {
      files.push({ path: `${base}/analysis.md`, mediaType: "text/markdown", record: true, sourceRefs: [], bytes: `# ${result.node.title}\n\n${result.note}\n` });
    }
    files.push({ path: `${base}/sources.json`, mediaType: "application/json", record: false, sourceRefs: [],
      bytes: JSON.stringify(result.sources.map(({ text: _text, raw: _raw, ...source }) => source), null, 2) });
    for (const source of result.sources) {
      if (source.file && source.raw) files.push({ path: `${base}/sources/${source.file}`, mediaType: source.file.endsWith(".pdf") ? "application/pdf" : "text/plain", record: true, sourceRefs: [source.url], bytes: source.raw });
    }
  }
  // Checksums last, over exactly what is written, so the manifest can be checked against the folder later.
  const manifest = { version: 1, builtAt: input.builtAt, workOrderId: context.workOrder.id,
    files: files.map((file) => ({ path: file.path, sha256: sha(file.bytes), bytes: typeof file.bytes === "string" ? Buffer.byteLength(file.bytes) : file.bytes.byteLength })),
    sources: nodes.flatMap((result) => result.sources.map((source) => ({ node: result.node.id, id: source.id, url: source.url, title: source.title, kept: source.kept,
      license: source.verdict, fetchedAt: source.fetchedAt, ...(source.sha256 ? { sha256: source.sha256, bytes: source.bytes } : {}) }))) };
  files.push({ path: "manifest.json", mediaType: "application/json", record: true, sourceRefs: [], bytes: JSON.stringify(manifest, null, 2) });
  return files;
}

/** Every WorkOrder currently waiting on material preparation that has not already had materials written. */
export function pendingMaterialWorkOrders(store: CrosslineStore, workspaceId: string): string[] {
  // A preparation that already failed is not retried on a timer: it would re-spend quota every tick with no new
  // information, and the human self-preparation path is open the whole time. Retrying is a deliberate act — so the
  // LAST word wins: a retry the person asked for re-opens the order, and a failure after that closes it again.
  const decidedAt = new Map<string, "blocked" | "retry">();
  for (const event of store.listEvents(workspaceId, { type: ["materials.blocked", "materials.retry_requested"] })) {
    decidedAt.set(event.entityId, event.type === "materials.blocked" ? "blocked" : "retry");
  }
  return store.listWorkOrders(workspaceId)
    .filter((order) => order.state === "preparing" && decidedAt.get(order.id) !== "blocked")
    .filter((order) => store.listMaterials(workspaceId, order.id).length === 0)
    .map((order) => order.id);
}

/** Folder listing for the person: what a built manualbook contains, for tests and for the task page. */
export function listManualbookFiles(materialsDir: string, workOrderId: string): string[] {
  const root = path.join(materialsDir, workOrderId);
  return existsSync(root) ? (readdirSync(root, { recursive: true }) as string[]).map((entry) => entry.replaceAll("\\", "/")).sort() : [];
}

/** At most this many steps of one tutorial are researched on the web (the first ones the designer marked; docs/task-preparation.md). */
export const MAX_RESEARCHED_STEPS = 3;
/** Another tutorial of the same project built within this many days lends its sources to a step of the same title. */
export const REUSE_SOURCES_DAYS = 30;
/** A tutorial whose inputs changed is made again at most once in this many hours: a day of replans and new files is one rebuild. */
export const TUTORIAL_REBUILD_HOURS = 24;
/** Before this, a tutorial is not made while assistant steps before the person's first step are still open (their files feed it). */
export const TUTORIAL_PREP_WAIT_HOURS = 24;

/** The person's files a tutorial reads (the writer's `upload-N`): the task's project's readable files, at most four. */
function tutorialUploads(store: CrosslineStore, workspaceId: string, order: { projectId: string }) {
  const projectName = store.listProjects(workspaceId, { includeArchived: true }).find((project) => project.id === order.projectId)?.name;
  return relevantDocuments(store.listSourceDocuments(workspaceId), { projectId: order.projectId, projectName }).filter((doc) => doc.extractedText.trim()).slice(0, 4);
}

const titleKey = (title: string) => title.replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();

/**
 * Where a build keeps each step's research as it goes, so a build cut short (a worker restart) does not search the same step again. Inside
 * the task's own folder: a finished build replaces the folder (and the draft with it), and deleting the account removes it.
 */
const researchDraft = (materialsDir: string, workOrderId: string) => path.join(materialsDir, workOrderId, ".research-draft.json");
type ResearchNote = { title: string; sources: Array<Omit<KeptSource, "text" | "raw">> };

function noteResearch(materialsDir: string, workOrderId: string, title: string, sources: KeptSource[]): void {
  if (!sources.length) return;
  const file = researchDraft(materialsDir, workOrderId);
  let notes: ResearchNote[] = [];
  try { notes = JSON.parse(readFileSync(file, "utf8")) as ResearchNote[]; } catch { /* the first step of this build */ }
  notes.push({ title, sources: sources.map(({ text: _text, raw: _raw, ...source }) => source) });
  try { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(notes)); } catch { /* a cache: losing it costs a search */ }
}

/** Checked pages from an earlier search, as link and summary (a downloaded copy stays in its own book). */
const reusable = (sources: ReadonlyArray<Omit<KeptSource, "text">>, verdict: string): KeptSource[] =>
  sources.filter((source) => source.kept !== "unverified" && !source.docId && source.url?.startsWith("https://"))
    .map(({ file: _file, sha256: _sha, bytes: _bytes, raw: _raw, ...source }) => ({ ...source, kept: "summary_only" as const, verdict, text: source.summary }));

/**
 * What was already researched for a step of this title (docs/task-preparation.md §3): first what this task's own build found before it
 * was cut short (`researchDraft`: a worker restart on 2026-10-20 threw away two half-built tutorials, eleven researcher and writer runs),
 * then this task's previous tutorial, then other tutorials of the same project built within `REUSE_SOURCES_DAYS` — a step called the
 * same in the next homework or the next revision session takes those sources instead of a new web search.
 */
function researchedBefore(store: CrosslineStore, workspaceId: string, materialsDir: string, order: { id: string; projectId: string }, now: Date):
  Map<string, { note: string; sources: KeptSource[] }> {
  const found = new Map<string, { note: string; sources: KeptSource[] }>();
  let draft: ResearchNote[] = [];
  try { draft = JSON.parse(readFileSync(researchDraft(materialsDir, order.id), "utf8")) as ResearchNote[]; } catch { /* none */ }
  for (const note of draft) {
    const sources = reusable(note.sources, "上次生成中途停止前已查到的资料");
    if (sources.length && !found.has(titleKey(note.title))) found.set(titleKey(note.title), { note: "沿用上次生成中途停止前这一步已查到的资料", sources });
  }
  const since = now.getTime() - REUSE_SOURCES_DAYS * 86_400_000;
  const built = new Set(store.listEvents(workspaceId, { type: "manualbook.built" }).filter((event) => Date.parse(event.createdAt) >= since).map((event) => event.entityId));
  const books = store.listWorkOrders(workspaceId).filter((item) => built.has(item.id) && (item.id === order.id || (order.projectId && item.projectId === order.projectId)))
    .sort((a, b) => Number(b.id === order.id) - Number(a.id === order.id));
  for (const other of books) {
    const root = path.join(materialsDir, other.id);
    const from = other.id === order.id ? "上一版教程" : `「${taskTitleOf(other)}」的教程`;
    let flow: { nodes?: Array<{ id: string; title: string }> } = {};
    try { flow = JSON.parse(readFileSync(path.join(root, "flow.json"), "utf8")) as typeof flow; } catch { continue; }
    for (const node of flow.nodes ?? []) {
      if (!/^[a-z][a-z0-9-]{0,39}$/.test(node.id) || found.has(titleKey(node.title))) continue;
      let stored: Array<Omit<KeptSource, "text">> = [];
      try { stored = JSON.parse(readFileSync(path.join(root, "nodes", node.id, "sources.json"), "utf8")) as typeof stored; } catch { continue; }
      const sources = reusable(stored, `沿用${from}的资料`);
      if (sources.length) found.set(titleKey(node.title), { note: `沿用${from}里这一步找到的资料`, sources });
    }
  }
  return found;
}

/**
 * What a tutorial is made from (version 2, 2026-10-21): the task's wording, its step plan (the person's steps, by title — progress does
 * not count), its required materials and the files the writer reads (`tutorialUploads`). A tutorial built from other inputs than these is
 * out of date. Version 1 also counted the due day and every file of the project, so moving a deadline or filing an unrelated upload under
 * the course rebuilt every tutorial of it (「ECE 548 整理两门课程当前成绩」 was built four times).
 */
export const TUTORIAL_INPUTS_VERSION = 2;
export function tutorialInputs(store: CrosslineStore, workspaceId: string, workOrderId: string): string {
  const order = store.getWorkOrder(workspaceId, workOrderId);
  const payload = (order?.payload ?? {}) as { materialContract?: unknown[]; evidenceContract?: unknown[] };
  const plan = store.getStepPlan(workspaceId, workOrderId);
  const steps = (plan?.steps ?? []).filter((step) => step.executor !== "agent").map((step) => step.title);
  const files = order ? tutorialUploads(store, workspaceId, order).map((doc) => doc.id).sort() : [];
  // A plan that asks the person for material: how each was settled, so an upload or 「没有」 writes the sections that waited on it.
  const needs = plan?.needs?.length ? { needs: Object.fromEntries([...provisionsOf(store, workspaceId, workOrderId)]) } : {};
  return createHash("sha256").update(JSON.stringify({ intent: order?.intent ?? "", steps,
    materials: payload.materialContract ?? [], evidence: payload.evidenceContract ?? [], files, ...needs })).digest("hex").slice(0, 16);
}

/** Titles of the planned steps whose every needed material the person uploaded: their sections are written from the person's files. */
function stepsWithOwnMaterial(store: CrosslineStore, workspaceId: string, workOrderId: string): Set<string> {
  const provided = provisionsOf(store, workspaceId, workOrderId);
  return new Set((store.getStepPlan(workspaceId, workOrderId)?.steps ?? [])
    .filter((step) => step.uses?.length && step.uses.every((need) => provided.get(need) === "file")).map((step) => step.title.trim()));
}

/** The hash a build recorded before version 2, compared only against builds that carry no version. */
function tutorialInputsV1(store: CrosslineStore, workspaceId: string, workOrderId: string): string {
  const order = store.getWorkOrder(workspaceId, workOrderId);
  const payload = (order?.payload ?? {}) as { dueDate?: string; materialContract?: unknown[]; evidenceContract?: unknown[] };
  const steps = (store.getStepPlan(workspaceId, workOrderId)?.steps ?? []).filter((step) => step.executor !== "agent").map((step) => step.title);
  const files = order ? store.listSourceDocuments(workspaceId).filter((doc) => doc.projectId === order.projectId).map((doc) => doc.id).sort() : [];
  return createHash("sha256").update(JSON.stringify({ intent: order?.intent ?? "", due: payload.dueDate ?? "", steps,
    materials: payload.materialContract ?? [], evidence: payload.evidenceContract ?? [], files })).digest("hex").slice(0, 16);
}

/**
 * Tutorials to make now (docs/task-preparation.md, 2026-10-21): committed work with a step plan
 * - whose preparation level is `tutorial` (`preparationOf`: learning work, or method-heavy craft work of a kind not done before);
 * - whose next block starts within `TUTORIAL_LEAD_DAYS` (three days; it was a week, and a week's replans rebuilt or wasted them), and,
 *   while the assistant's steps before the person's first step are still open, only within `TUTORIAL_PREP_WAIT_HOURS` (their files are
 *   what the tutorial builds on);
 * - never built, or built from inputs that have since changed — at most once a `TUTORIAL_REBUILD_HOURS`. A tutorial is no longer made
 *   again only for being a week old: unchanged inputs give the same tutorial.
 * A tutorial that failed after its last build waits for the person (the failure is asked about).
 */
export function pendingTutorials(store: CrosslineStore, workspaceId: string, now = new Date()): string[] {
  const soon = startingWithin(store, workspaceId, now);
  const imminent = startingWithin(store, workspaceId, now, TUTORIAL_PREP_WAIT_HOURS);
  const plans = store.listStepPlans(workspaceId);
  const planOf = new Map(plans.map((plan) => [plan.workOrderId, plan]));
  const done = doneKinds(store, workspaceId, plans);
  const latest = (type: string) => {
    const out = new Map<string, { createdAt: string; payload: Record<string, unknown> }>();
    for (const event of store.listEvents(workspaceId, { type })) {
      const seen = out.get(event.entityId);
      if (!seen || seen.createdAt <= event.createdAt) out.set(event.entityId, { createdAt: event.createdAt, payload: event.payload as Record<string, unknown> });
    }
    return out;
  };
  const built = latest("manualbook.built"), failed = latest("tutorial.blocked");
  const orders = new Map(store.listWorkOrders(workspaceId).map((order) => [order.id, order]));
  return [...soon].filter((id) => {
    const order = orders.get(id);
    const plan = planOf.get(id);
    // The assistant's own items and the questions to the person (docs/work-split.md) are not the person's to learn: no tutorial.
    if (!order || !["approved", "ready_for_human", "active"].includes(order.state) || !plan || !onPersonsBoard(order)) return false;
    // Only work that needs one gets a tutorial by itself; the person can still ask for one on the task page.
    if (preparationOf(order, plan, done).level !== "tutorial") return false;
    const build = built.get(id), failure = failed.get(id);
    if (failure && (!build || failure.createdAt > build.createdAt)) return false;
    if (!build) {
      const firstOwn = plan.steps.find((step) => step.executor !== "agent")?.seq ?? Infinity;
      const prepOpen = plan.steps.some((step) => step.executor === "agent" && step.status === "planned" && step.seq < firstOwn);
      return !prepOpen || imminent.has(id);
    }
    if (now.getTime() - Date.parse(build.createdAt) < TUTORIAL_REBUILD_HOURS * 3_600_000) return false;
    if (typeof build.payload.inputs !== "string") return false;
    const current = build.payload.inputsVersion === TUTORIAL_INPUTS_VERSION ? tutorialInputs(store, workspaceId, id) : tutorialInputsV1(store, workspaceId, id);
    return build.payload.inputs !== current;
  });
}
