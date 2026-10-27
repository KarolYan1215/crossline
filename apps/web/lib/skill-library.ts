import {
  AGENT_CATEGORIES, PUBLIC_SKILL_CATEGORY_LABEL, currentMineVersion, scriptCount, scriptsAllowable, scriptsRunnable, scheduleLabel, ensureMineFrontmatter, mineSkillSettingKey, publicSkillFilesKey, grownSkillFilesKey, readMineSkill, readableMineSourceLabel, readableMineText, parseTopicPlan, topicPlanKey, topicProgress, withTopicSettings,
  type AccessContext, type AiTool, type PublicSkillRecord, type StoredMineRule
} from "@crossline/core";
import { type CrosslineStore, unmergeGrownSkill, addWorkflowFeedback, aiToolsFor, listAgentTasks, allowSkillScripts, assistantMode, consentToGrownSkill, grownHomeLine, readGrownSkills, readGrownVersions, readPublicSkills, removeGrownSkill, removePublicSkill, revertGrownSkill, saveMineVersion, updateGrownSkill } from "@crossline/db";
import { CodexSupervisorRequestError, requestCodexSupervisor } from "./codex-runtime";
import { getStore } from "./crossline";
import { identityLines } from "./lines";

/**
 * The settings page's Skill 库 (docs/skills-library.md §5): each line's own skill — the version in force in full, where every rule came
 * from, every earlier version — and the public skills with where they came from, their licence, what the scan and the review found, and
 * when a run last used them.
 */
export type MineSkillView = {
  lineId: string; lineLabel: string;
  current?: { version: number; by: "compiler" | "person"; at: string; markdown: string; rules: StoredMineRule[]; restoredFrom?: number };
  /** Newest first, each in full, so 回到此版 shows what comes back. */
  versions: Array<{ version: number; by: "compiler" | "person"; at: string; markdown: string; rules: StoredMineRule[]; restoredFrom?: number }>;
};
/**
 * A skill's scripts as the person sees them: how many, whether the checks capped them to text and the person may allow them anyway, when
 * they did, and what the scan found (file, line, rule, the line itself), which is what they read before allowing.
 */
export type ScriptsView = { scripts: number; scriptsAllowable: boolean; scriptsAllowedAt?: string;
  findings: Array<{ file: string; line: number; rule: string; excerpt: string }> };
export type PublicSkillView = Pick<PublicSkillRecord, "id" | "name" | "description" | "lines" | "commit" | "license" | "installedAt" | "updatedAt" | "lastUsedAt" | "why"> & ScriptsView & {
  category: string; repo: string; path: string; url: string; files: number; skipped: number;
  risk: "low" | "high"; injection: boolean;
  verdict: "usable" | "text_only" | "reject"; reasons: string[];
};
/** A workflow the assistant grew: what it does and when, where it came from, which steps stay the person's, and what the checks found. */
export type GrownSkillView = { id: string; summary: string; name: string; category: string; lines: string[]; lineLabel: string; schedule: string; action: "run" | "remind";
  origin: string; steps: Array<{ title: string; person: boolean }>; status: "active" | "off" | "needs_consent"; pinned: boolean; verdict: "usable" | "text_only" | "reject";
  /** The sites it reads and the risks it was installed with; when the person accepted them and last logged in to each. */
  access: Array<{ service: string; site: string; login: boolean; how: string; loggedInAt?: string }>; risks: string[]; consentedAt?: string;
  risk: "low" | "high"; reasons: string[]; files: number; createdAt: string; lastUsedAt: string; lastRunAt?: string; skillText: string;
  /** Favourites organised by topic: the day's share, the night window, and each topic read so far (packages/core/src/favourite-topics.ts). */
  topics?: { perDay: number; from: number; to: number; listed: number; progress: Array<{ name: string; total: number; read: number }> };
  /** Running now: a collection between `collect.started` and `collect.ran`, or the assistant working on one of its runs. */
  running?: { since: string; what: string };
  /**
   * Its revisions (docs/skills-library.md 「工作流自我改进」): the version in force, what the last revision changed, whether one can be
   * taken back, and what the person said that no revision has answered yet.
   */
  improvement: { version: number; lastChange?: { at: string; changes: string }; canRevert: boolean; pending: string[]; improving: boolean };
  /** Merged into another workflow that does the same job (switched off until 撤销合并). */
  mergedInto?: { id: string; summary: string; at: string; why: string } } & ScriptsView;
/** `shell`: this account's assistant has a command line (the copy on the person's own computer) and can run an allowed script. */
export type SkillLibraryView = { mine: MineSkillView[]; grown: GrownSkillView[]; publics: PublicSkillView[]; aiTools: AiTool[];
  removed: Array<{ name: string; reason: string; at: string; by: string }>; growing: number; shell: boolean };

const scriptsView = (record: Parameters<typeof scriptsRunnable>[0]): ScriptsView => ({
  scripts: scriptCount(record), scriptsAllowable: scriptsAllowable(record),
  ...(scriptsAllowable(record) && scriptsRunnable(record) && record.scriptsAllowed ? { scriptsAllowedAt: record.scriptsAllowed.at } : {}),
  findings: record.scan.findings.slice(0, 12).map(({ file, line, rule, excerpt }) => ({ file, line, rule, excerpt }))
});

export function loadSkillLibrary(ctx: AccessContext): SkillLibraryView {
  const store = getStore();
  // Labels stored before W-19 name the interview's slot keys; they are made readable on the way out, never rewritten in the ledger.
  const readable = (rules: StoredMineRule[] | undefined) => (rules ?? []).map((rule) => ({ ...rule, sourceLabels: rule.sourceLabels.map(readableMineSourceLabel) }));
  const mine = identityLines(ctx).map((line): MineSkillView => {
    const stored = readMineSkill(store.getSetting(ctx.workspaceId, mineSkillSettingKey(line.id)));
    const current = currentMineVersion(stored);
    return { lineId: line.id, lineLabel: line.label,
      ...(current ? { current: { version: current.version, by: current.by, at: current.at, markdown: readableMineText(current.markdown), rules: readable(current.rules),
        ...(current.restoredFrom ? { restoredFrom: current.restoredFrom } : {}) } } : {}),
      versions: (stored?.versions ?? []).map((version) => ({ version: version.version, by: version.by, at: version.at, markdown: readableMineText(version.markdown), rules: readable(version.rules),
        ...(version.restoredFrom ? { restoredFrom: version.restoredFrom } : {}) })).reverse() };
  });
  const publics = readPublicSkills(store, ctx.workspaceId).map((record): PublicSkillView => {
    let skipped = 0;
    try { skipped = (JSON.parse(store.getSetting(ctx.workspaceId, publicSkillFilesKey(record.id)) ?? "{}") as { skipped?: unknown[] }).skipped?.length ?? 0; } catch { /* none recorded */ }
    return { id: record.id, name: record.name, description: record.description, lines: record.lines, commit: record.commit, license: record.license,
      installedAt: record.installedAt, updatedAt: record.updatedAt, lastUsedAt: record.lastUsedAt, why: record.why,
      category: PUBLIC_SKILL_CATEGORY_LABEL[record.category] ?? record.category, repo: record.source.repo, path: record.source.path, url: record.source.url,
      files: record.files.length, skipped, risk: record.scan.risk, injection: record.scan.injection,
      ...scriptsView(record), verdict: record.review.final, reasons: record.review.reasons };
  });
  const removed = store.listEvents(ctx.workspaceId, { type: "skill.public.removed" }).slice(-5).reverse().map((event) => {
    const payload = event.payload as { name?: string; reason?: string; by?: string };
    return { name: String(payload.name ?? event.entityId), reason: String(payload.reason ?? ""), at: event.createdAt, by: String(payload.by ?? "system") };
  });
  const agentRuns = listAgentTasks(store, ctx.workspaceId);
  const grown = readGrownSkills(store, ctx.workspaceId).map((record): GrownSkillView => {
    let skillText = "";
    try { skillText = ((JSON.parse(store.getSetting(ctx.workspaceId, grownSkillFilesKey(record.id)) ?? "{}") as { files?: Array<{ path: string; text: string }> }).files ?? [])
      .find((file) => file.path === "SKILL.md")?.text ?? ""; } catch { /* none stored */ }
    const home = grownHomeLine(store, ctx.workspaceId, record);
    const homeLabel = identityLines(ctx).find((line) => line.id === home)?.label ?? "";
    return { id: record.id, summary: record.manifest.summary, name: record.name, category: AGENT_CATEGORIES[record.category] ?? record.category,
      lines: home ? [home] : record.lines, lineLabel: homeLabel,
      schedule: scheduleLabel(record.manifest.schedule), action: record.manifest.action,
      origin: record.origin.kind === "asked" ? `本人要求：「${record.origin.text.slice(0, 60)}」` : `由 ${record.origin.taskIds.length} 次采纳的同类结果生成`,
      steps: record.manifest.steps.map((step) => ({ title: step.title, person: step.by === "person" })), status: record.status, pinned: record.pinned,
      access: (record.manifest.access ?? []).map((item) => ({ ...item, ...(record.logins?.[item.service] ? { loggedInAt: record.logins[item.service] } : {}) })),
      risks: record.manifest.risks ?? [], ...(record.consentedAt ? { consentedAt: record.consentedAt } : {}),
      verdict: record.review.final, risk: record.scan.risk, reasons: record.review.reasons, files: record.files.length, createdAt: record.createdAt,
      lastUsedAt: record.lastUsedAt, ...(record.lastRunAt ? { lastRunAt: record.lastRunAt } : {}), skillText: skillText.replace(/^---[\s\S]*?\n---\n/, ""),
      ...topicsView(store, ctx.workspaceId, record.id), ...runningView(store, ctx.workspaceId, record.id, agentRuns), ...scriptsView(record),
      improvement: improvementView(store, ctx.workspaceId, record, agentRuns),
      ...(record.mergedInto ? { mergedInto: { id: record.mergedInto.id, at: record.mergedInto.at, why: record.mergedInto.why,
        summary: readGrownSkills(store, ctx.workspaceId).find((item) => item.id === record.mergedInto!.id)?.manifest.summary ?? "另一个工作流" } } : {}) };
  });
  // Requests made in words that no growing run has picked up yet: the page says they are on their way.
  const tried = new Set(store.listEvents(ctx.workspaceId, { type: "skill.grown.attempted" }).map((event) => String((event.payload as { requestId?: string }).requestId ?? "")));
  const growing = store.listEvents(ctx.workspaceId, { type: "workflow.requested" }).filter((event) => !tried.has(event.entityId)).length;
  return { mine, grown, publics, removed, growing, aiTools: aiToolsFor(store, ctx.workspaceId), shell: assistantMode(store, ctx.workspaceId) === "shell" };
}

const MAX_SKILL_CHARS = 20_000;

/** The person's own text as a new version, in force at once; the compiler rewrites it only after they decide something new. */
export function editMineSkill(ctx: AccessContext, lineId: string, markdown: string): { ok: true; version: number } | { ok: false; code: string } {
  const line = identityLines(ctx).find((item) => item.id === lineId);
  if (!line) return { ok: false, code: "LINE_NOT_FOUND" };
  const text = markdown.replace(/\r\n/g, "\n").trim();
  // Headings and empty list items (the template's 「1. 」) are not rules: a skill with nothing in it would still be switched on for every run.
  const content = text.replace(/^---[\s\S]*?\n---\n?/, "").replace(/^\s*#.*$/gm, "").replace(/^\s*(\d+\.|[-*])\s*$/gm, "").trim();
  if (!content) return { ok: false, code: "SKILL_EMPTY" };
  if (text.length > MAX_SKILL_CHARS) return { ok: false, code: "SKILL_TOO_LONG" };
  const version = saveMineVersion(getStore(), ctx.workspaceId, lineId,
    { at: new Date().toISOString(), by: "person", markdown: ensureMineFrontmatter(text, { id: line.id, label: line.label }) });
  return { ok: true, version };
}

/** An earlier version brought back, as a new version of the person's (the history is never rewritten). */
export function restoreMineSkill(ctx: AccessContext, lineId: string, version: number): { ok: true; version: number } | { ok: false; code: string } {
  const store = getStore();
  const stored = readMineSkill(store.getSetting(ctx.workspaceId, mineSkillSettingKey(lineId)));
  const old = stored?.versions.find((item) => item.version === version);
  if (!old) return { ok: false, code: "VERSION_NOT_FOUND" };
  if (stored!.current === version) return { ok: false, code: "VERSION_IN_FORCE" };
  const number = saveMineVersion(store, ctx.workspaceId, lineId, { at: new Date().toISOString(), by: "person", markdown: old.markdown,
    ...(old.rules ? { rules: old.rules } : {}), restoredFrom: version });
  return { ok: true, version: number };
}

/** The person allows a skill's scripts after reading the scan, or takes the leave back. */
export function allowScripts(ctx: AccessContext, kind: "public" | "grown", id: string, allow: boolean): { ok: boolean; code?: string } {
  return allowSkillScripts(getStore(), ctx.workspaceId, kind, id, allow) ? { ok: true } : { ok: false, code: "SCRIPTS_NOT_ALLOWABLE" };
}

/**
 * The person asks for one more search of a line's public skills (docs/token-economy.md §2.4: a line is searched when it is set up, then
 * monthly, and again when the person asks). The worker's next tick runs it as that line's setup search.
 */
export function requestSkillSearch(ctx: AccessContext, lineId: string): { ok: boolean; code?: string } {
  if (!identityLines(ctx).some((line) => line.id === lineId)) return { ok: false, code: "LINE_NOT_FOUND" };
  const at = new Date().toISOString();
  getStore().appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `skill.public.search_requested:${lineId}:${at}`,
    type: "skill.public.search_requested", entityId: lineId, payload: { lineId, at } });
  return { ok: true };
}

export function deletePublicSkill(ctx: AccessContext, id: string): { ok: boolean; code?: string } {
  return removePublicSkill(getStore(), ctx.workspaceId, id, "本人删除", "person") ? { ok: true } : { ok: false, code: "SKILL_NOT_FOUND" };
}

/**
 * The person turns a grown workflow on or off, keeps it for good, removes it, or — for one that reads an account — accepts its risks,
 * which is the only way such a workflow is switched on.
 */
/** A collection is taken as over after this long without its end (a worker restarted mid-run never writes `collect.ran`). */
const COLLECT_STALE_MS = 8 * 3_600_000;
function runningView(store: CrosslineStore, workspaceId: string, id: string, agentRuns: ReturnType<typeof listAgentTasks>): Pick<GrownSkillView, "running"> {
  const started = store.listEvents(workspaceId, { type: "collect.started", entityId: id }).at(-1);
  const ended = store.listEvents(workspaceId, { type: "collect.ran", entityId: id }).at(-1);
  if (started && (!ended || ended.createdAt < started.createdAt) && Date.now() - Date.parse(started.createdAt) < COLLECT_STALE_MS) {
    const payload = started.payload as { listOnly?: boolean; notes?: number };
    return { running: { since: started.createdAt, what: payload.listOnly ? "读取收藏列表" : payload.notes ? `读取 ${payload.notes} 篇笔记` : "读取" } };
  }
  const prefix = `flow-${id.replace(/^flow-/, "")}-`;
  const agent = agentRuns.find((task) => task.taskId.startsWith(prefix) && task.status === "running");
  return agent ? { running: { since: agent.requestedAt, what: "助手整理中" } } : {};
}

function improvementView(store: CrosslineStore, workspaceId: string, record: ReturnType<typeof readGrownSkills>[number], agentRuns: ReturnType<typeof listAgentTasks>): GrownSkillView["improvement"] {
  const revised = store.listEvents(workspaceId, { type: "skill.grown.revised", entityId: record.id }).at(-1);
  const since = record.improvedAt ?? record.createdAt;
  const pending = store.listEvents(workspaceId, { type: "skill.grown.feedback", entityId: record.id }).filter((event) => event.createdAt > since)
    .map((event) => String((event.payload as { text?: string }).text ?? "")).filter(Boolean);
  const improving = agentRuns.some((run) => run.taskId.startsWith(`improve-${record.id.replace(/^flow-/, "")}-`) && run.status === "running");
  return { version: record.version ?? 1, canRevert: readGrownVersions(store, workspaceId, record.id).length > 0, pending, improving,
    ...(revised ? { lastChange: { at: revised.createdAt, changes: String((revised.payload as { changes?: string }).changes ?? "") } } : {}) };
}

/**
 * The person tells a workflow what to do differently: kept as `skill.grown.feedback`, and the worker is asked to look at once (its
 * workflow pass revises it with the assistant); the next tick does it when the worker cannot be reached now.
 */
export async function improveGrownSkill(ctx: AccessContext, id: string, text: string): Promise<{ ok: boolean; code?: string }> {
  if (!addWorkflowFeedback(getStore(), ctx.workspaceId, id, text)) return { ok: false, code: text.trim() ? "SKILL_NOT_FOUND" : "FEEDBACK_EMPTY" };
  await requestCodexSupervisor(ctx, "/v1/workflows/grow", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(10_000) })
    .catch(() => undefined);
  return { ok: true };
}

/** 撤销合并: the workflow merged into another is back as it was. */
export function unmergeGrownWorkflow(ctx: AccessContext, id: string): { ok: boolean; code?: string } {
  return unmergeGrownSkill(getStore(), ctx.workspaceId, id) ? { ok: true } : { ok: false, code: "NOT_MERGED" };
}

/** 「检查重复」: the worker's next workflow pass checks the person's workflows for ones doing the same job, whatever day it is. */
export async function requestWorkflowMergeCheck(ctx: AccessContext): Promise<{ ok: boolean }> {
  getStore().setSetting(ctx.workspaceId, "skills.grown.mergeRequested", new Date().toISOString());
  await requestCodexSupervisor(ctx, "/v1/workflows/grow", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(10_000) })
    .catch(() => undefined);
  return { ok: true };
}

/** The person takes the last revision back: the version before it is in force again. */
export function revertGrownRevision(ctx: AccessContext, id: string): { ok: boolean; code?: string; version?: number } {
  const version = revertGrownSkill(getStore(), ctx.workspaceId, id);
  return version === undefined ? { ok: false, code: "NO_EARLIER_VERSION" } : { ok: true, version };
}

function topicsView(store: CrosslineStore, workspaceId: string, id: string): Pick<GrownSkillView, "topics"> {
  const plan = parseTopicPlan(store.getSetting(workspaceId, topicPlanKey(id)));
  if (!plan) return {};
  let ledger: { read?: Record<string, unknown>; listed?: Record<string, unknown> } = {};
  try { ledger = JSON.parse(store.getSetting(workspaceId, `collect.notes.${id}`) ?? "{}") as typeof ledger; } catch { /* nothing read yet */ }
  const read = new Set(Object.keys(ledger.read ?? {}));
  return { topics: { perDay: plan.perDay, from: plan.window.from, to: plan.window.to, listed: Object.keys(ledger.listed ?? {}).length,
    progress: topicProgress(plan, read).map(({ name, total, read: done }) => ({ name, total, read: done })) } };
}

/** Whether a grown workflow is running now, and its topics' progress: what its card polls while it runs. */
export function grownSkillStatus(ctx: AccessContext, id: string): Pick<GrownSkillView, "running" | "topics"> {
  const store = getStore();
  return { ...runningView(store, ctx.workspaceId, id, listAgentTasks(store, ctx.workspaceId)), ...topicsView(store, ctx.workspaceId, id) };
}

/** The person's own pace for favourites by topic: notes a day and the night window (equal hours: no night reading). */
export function changeFavouriteTopics(ctx: AccessContext, id: string, change: { perDay?: number; from?: number; to?: number }): { ok: boolean; code?: string } {
  const store = getStore();
  const plan = parseTopicPlan(store.getSetting(ctx.workspaceId, topicPlanKey(id)));
  if (!plan) return { ok: false, code: "NOT_TOPIC_MODE" };
  const next = withTopicSettings(plan, change);
  store.setSetting(ctx.workspaceId, topicPlanKey(id), JSON.stringify(next));
  store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `favourites.topics_changed:${id}:${Date.now()}`, type: "favourites.topics_changed",
    entityId: id, payload: { perDay: next.perDay, window: next.window } });
  return { ok: true };
}

export function changeGrownSkill(ctx: AccessContext, id: string, change: { status?: "active" | "off"; pinned?: boolean } | "remove" | "consent"): { ok: boolean; code?: string } {
  const store = getStore();
  const done = change === "remove" ? removeGrownSkill(store, ctx.workspaceId, id, "本人删除", "person")
    : change === "consent" ? consentToGrownSkill(store, ctx.workspaceId, id) : updateGrownSkill(store, ctx.workspaceId, id, change);
  return done ? { ok: true } : { ok: false, code: change === "consent" ? "SKILL_NOT_AWAITING_CONSENT" : "SKILL_NOT_FOUND" };
}

/** 「登录」 (a browser window of its own opens on this computer) and 「立即运行」, both carried out by the worker. */
export async function grownSkillAction(ctx: AccessContext, id: string, action: "login" | "login_done" | "run", service = "", viewport: { width?: number; height?: number } = {}):
  Promise<{ ok: boolean; code?: string; message?: string; taskId?: string; remote?: boolean }> {
  try {
    // `remote: true` answers a login opened as the server's browser (no screen there): the page shows it in a dialog. Starting that
    // browser takes some seconds, closing it saves its cookies; both get longer than a run's start.
    return await requestCodexSupervisor<{ ok: boolean; code?: string; message?: string; taskId?: string; remote?: boolean }>(ctx, `/v1/workflows/${encodeURIComponent(id)}/${action}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ service, ...viewport }), signal: AbortSignal.timeout(action === "run" ? 15_000 : 60_000) });
  } catch (error) {
    if (error instanceof CodexSupervisorRequestError) {
      const blocker = error.blocker as { code?: string; message?: string } | undefined;
      return { ok: false, code: blocker?.code ?? "WORKER_UNAVAILABLE", message: blocker?.message ?? "后台服务没有回应。" };
    }
    return { ok: false, code: "WORKER_UNAVAILABLE", message: "后台服务没有回应。" };
  }
}
