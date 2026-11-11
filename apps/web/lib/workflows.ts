import "server-only";
import {
  AUTOMATIONS_SETTING, agreedScopeOf, automationDefinition, dryRunAutomation, dryRunGrown, readAutomations, readAutomationRuns, AUTOMATION_RUNS_SETTING,
  renderAutomationVersion, renderGrownVersion, scheduleLabel, triggerLabel,
  type AccessContext, type AutomationDefinition, type GrownSkillVersion, type WorkflowDryRun, type WorkflowKind, type WorkflowTurn, type WorkflowTurnItem
} from "@crossline/core";
import { agreedScope, currentGrownFiles, readCategories, readGrownSkills, readGrownVersions, restoreAutomationVersion, restoreGrownVersion } from "@crossline/db";
import { CodexSupervisorRequestError, requestCodexSupervisor } from "./codex-runtime";
import { effectiveSchedulePreferences, getStore } from "./crossline";
import { identityLines } from "./lines";
import { localeFor, tOf } from "./locale";

/**
 * The 自动化 page (2026-11-10): automations and grown workflows as one list of 工作流, each with its conversation, its versions (compared
 * line by line, tried without effect, gone back to as a new version). The conversation runs on the worker (`/v1/workflow-threads`); what
 * it wrote is read here from the ledger, so the page shows a turn as it streams by asking again.
 */
export type WorkflowListItem = { id: string; kind: WorkflowKind; tag: "automation" | "grown" | "remind"; name: string; summary: string; status: "active" | "off" | "needs_consent";
  when: string; lineId: string; lineLabel: string; version: number; versions: number; lastAt: string; runs: number };
export type WorkflowDraft = { threadId: string; title: string; at: string; running: boolean; failed: boolean };
export type WorkflowVersionView = { version: number; at: string; source: string; note: string; current: boolean; text: string };
export type WorkflowTurnView = Pick<WorkflowTurn, "id" | "role" | "text" | "state" | "createdAt"> & { items: WorkflowTurnItem[] };
export type WorkflowDetail = { id: string; kind: WorkflowKind; threadId: string; title: string; exists: boolean; item?: WorkflowListItem;
  turns: WorkflowTurnView[]; versions: WorkflowVersionView[]; running: boolean; lines: Array<{ id: string; label: string }> };

const lineLabel = (ctx: AccessContext, id: string) => identityLines(ctx).find((line) => line.id === id)?.label ?? id;

export function loadWorkflowList(ctx: AccessContext): { items: WorkflowListItem[]; drafts: WorkflowDraft[] } {
  const store = getStore();
  const locale = localeFor(ctx);
  const runs = readAutomationRuns(store.getSetting(ctx.workspaceId, AUTOMATION_RUNS_SETTING));
  const automations = readAutomations(store.getSetting(ctx.workspaceId, AUTOMATIONS_SETTING)).map((item): WorkflowListItem => {
    const versions = store.listWorkflowVersions(ctx.workspaceId, "automation", item.id);
    const lastRun = runs.filter((run) => run.automationId === item.id).at(-1);
    return { id: item.id, kind: "automation", tag: item.action.kind === "remind" ? "remind" : "automation", name: item.name, summary: item.summary, status: item.status,
      when: triggerLabel(item.trigger, locale), lineId: item.lineId, lineLabel: lineLabel(ctx, item.lineId), version: versions.at(-1)?.version ?? 1, versions: versions.length,
      lastAt: lastRun?.firedAt ?? item.lastFiredAt ?? item.updatedAt, runs: item.runs };
  });
  const grown = readGrownSkills(store, ctx.workspaceId).map((record): WorkflowListItem => ({ id: record.id, kind: "grown", tag: record.manifest.action === "remind" ? "remind" : "grown",
    name: record.manifest.summary || record.name, summary: record.manifest.steps.map((step) => step.title).join(" → ").slice(0, 200), status: record.status,
    when: record.manifest.trigger === "schedule" && record.manifest.schedule ? scheduleLabel(record.manifest.schedule, locale) : tOf(ctx)("有这类任务时使用"),
    lineId: record.lines[0] ?? "", lineLabel: lineLabel(ctx, record.lines[0] ?? ""), version: record.version ?? 1,
    versions: readGrownVersions(store, ctx.workspaceId, record.id).length + 1, lastAt: record.lastRunAt ?? record.lastUsedAt ?? record.updatedAt, runs: 0 }));
  // Conversations that have not made a workflow yet: a request still being designed, or one that asked a question back.
  const drafts = store.listWorkflowThreads(ctx.workspaceId).filter((thread) => !thread.workflowId).slice(0, 8).map((thread): WorkflowDraft => {
    const turns = store.listWorkflowTurns(ctx.workspaceId, thread.id);
    return { threadId: thread.id, title: thread.title, at: thread.updatedAt, running: turns.some((turn) => turn.state === "running"), failed: turns.at(-1)?.state === "failed" };
  });
  return { items: [...automations, ...grown].sort((a, b) => b.lastAt.localeCompare(a.lastAt)), drafts };
}

/** The versions of a workflow as text, oldest first; the one in force is marked. */
function versionsOf(ctx: AccessContext, kind: WorkflowKind, id: string): WorkflowVersionView[] {
  const store = getStore();
  const locale = localeFor(ctx);
  const t = tOf(ctx);
  if (kind === "automation") {
    const rows = store.listWorkflowVersions(ctx.workspaceId, "automation", id);
    const current = readAutomations(store.getSetting(ctx.workspaceId, AUTOMATIONS_SETTING)).find((item) => item.id === id);
    const now = current ? JSON.stringify(automationDefinition(current)) : "";
    return rows.map((row) => ({ version: row.version, at: row.createdAt, source: row.source, note: row.note,
      current: JSON.stringify(automationDefinition(row.data as AutomationDefinition)) === now && row.version === rows.at(-1)?.version,
      text: renderAutomationVersion(row.data as AutomationDefinition, locale) }));
  }
  const record = readGrownSkills(store, ctx.workspaceId).find((item) => item.id === id);
  if (!record) return [];
  const kept = readGrownVersions(store, ctx.workspaceId, id).map((version) => ({ version: version.version, at: version.at, source: "grown", note: version.replacedBecause, current: false,
    text: renderGrownVersion(version, locale) }));
  return [...kept, { version: record.version ?? 1, at: record.improvedAt ?? record.createdAt, source: "grown", note: t("当前版本"), current: true,
    text: renderGrownVersion({ manifest: record.manifest, files: currentGrownFiles(store, ctx.workspaceId, id) }, locale) }].sort((a, b) => a.version - b.version);
}

/**
 * One workflow (or a conversation still making one, by its thread id): its conversation — every thread it has, in time order, with the
 * revisions the improver made to a grown one shown where they happened — and its versions.
 */
export function loadWorkflowDetail(ctx: AccessContext, id: string): WorkflowDetail | undefined {
  const store = getStore();
  const t = tOf(ctx);
  const list = loadWorkflowList(ctx).items;
  const byThread = store.getWorkflowThread(ctx.workspaceId, id);
  const workflowId = byThread?.workflowId || (list.some((item) => item.id === id) ? id : "");
  if (!byThread && !workflowId) return undefined;
  const item = list.find((entry) => entry.id === workflowId);
  const kind: WorkflowKind = item?.kind ?? byThread?.kind ?? "automation";
  const threads = workflowId ? store.listWorkflowThreads(ctx.workspaceId).filter((thread) => thread.workflowId === workflowId) : [byThread!];
  const main = threads.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ?? byThread;
  const turns: WorkflowTurnView[] = threads.flatMap((thread) => store.listWorkflowTurns(ctx.workspaceId, thread.id))
    .map((turn) => ({ id: turn.id, role: turn.role, text: turn.text, state: turn.state, createdAt: turn.createdAt, items: turn.items }));
  if (kind === "grown" && workflowId) {
    for (const event of store.listEvents(ctx.workspaceId, { entityId: workflowId }).filter((entry) => ["skill.grown.revised", "skill.grown.reverted", "skill.grown.restored"].includes(entry.type))) {
      const payload = event.payload as { version?: number; to?: number; changes?: string; restoredFrom?: number };
      const version = payload.version ?? payload.to ?? 0;
      turns.push({ id: event.eventId, role: "system", state: "done", createdAt: event.createdAt,
        text: event.type === "skill.grown.revised" ? t("助手改好并通过检查：{{changes}}", { changes: (payload.changes ?? "").slice(0, 300) })
          : payload.restoredFrom ? t("回到第 {{from}} 版", { from: payload.restoredFrom }) : t("撤回了上一次修改"),
        items: version ? [{ type: "version", version, note: "" }] : [] });
    }
  }
  turns.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { id: workflowId || id, kind, threadId: main?.id ?? "", title: item?.name ?? byThread?.title ?? "", exists: Boolean(item), ...(item ? { item } : {}), turns,
    versions: workflowId ? versionsOf(ctx, kind, workflowId) : [], running: turns.some((turn) => turn.state === "running"),
    lines: identityLines(ctx).map((line) => ({ id: line.id, label: line.label })) };
}

/** A turn of the conversation, started on the worker; the answer is read back from the ledger as it streams. */
export async function startWorkflowTurn(ctx: AccessContext, body: { threadId?: string; workflowId?: string; text: string; lineId?: string }):
  Promise<{ ok: true; threadId: string } | { ok: false; status: number; code: string; message: string }> {
  try {
    const answer = await requestCodexSupervisor<{ ok: boolean; threadId: string }>(ctx, "/v1/workflow-threads/turn", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    return { ok: true, threadId: answer.threadId };
  } catch (error) {
    if (error instanceof CodexSupervisorRequestError) return { ok: false, status: error.status, code: error.blocker.code, message: error.blocker.message };
    return { ok: false, status: 503, code: "WORKER_UNAVAILABLE", message: tOf(ctx)("后台服务没有连上，稍后再试。") };
  }
}

/** Back to any version, as a new version; said in the conversation where it happened. */
export function rollbackWorkflow(ctx: AccessContext, id: string, version: number): { ok: true; version: number; needsConsent?: boolean } | { ok: false; code: string } {
  const store = getStore();
  const t = tOf(ctx);
  const detail = loadWorkflowDetail(ctx, id);
  if (!detail?.exists) return { ok: false, code: "WORKFLOW_NOT_FOUND" };
  const result = detail.kind === "automation"
    ? (() => { const made = restoreAutomationVersion(store, ctx.workspaceId, detail.id, version); return made === undefined ? undefined : { version: made, needsConsent: false }; })()
    : restoreGrownVersion(store, ctx.workspaceId, detail.id, version);
  if (!result) return { ok: false, code: "WORKFLOW_VERSION_UNCHANGED" };
  if (detail.threadId && detail.kind === "automation") {
    store.saveWorkflowTurn({ workspaceId: ctx.workspaceId, id: `rollback-${detail.id}-${result.version}`, threadId: detail.threadId, role: "system", state: "done",
      createdAt: new Date().toISOString(), text: t("回到第 {{from}} 版", { from: version }), items: [{ type: "version", version: result.version, note: "" }] });
  }
  return { ok: true, version: result.version, ...(result.needsConsent ? { needsConsent: true } : {}) };
}

/**
 * A fix asked of a grown workflow from the 小帮手 (`workflow.fix`): the person's words go into that workflow's conversation, opened if it
 * has none yet, so its page shows what was asked next to the revision it led to.
 */
export function noteWorkflowFix(ctx: AccessContext, workflowId: string, text: string): string {
  const store = getStore();
  const at = new Date().toISOString();
  const record = readGrownSkills(store, ctx.workspaceId).find((item) => item.id === workflowId);
  const thread = store.findWorkflowThread(ctx.workspaceId, workflowId) ?? (() => {
    const made = { workspaceId: ctx.workspaceId, id: `thread-${workflowId}`, workflowId, kind: "grown" as const, codexThreadId: "", lineId: record?.lines[0] ?? "",
      title: record?.manifest.summary ?? "", createdAt: at, updatedAt: at };
    store.saveWorkflowThread(made);
    return made;
  })();
  store.saveWorkflowTurn({ workspaceId: ctx.workspaceId, id: `fix-${workflowId}-${Date.parse(at)}`, threadId: thread.id, role: "person", text: text.slice(0, 1000), items: [],
    state: "done", createdAt: at });
  store.saveWorkflowTurn({ workspaceId: ctx.workspaceId, id: `fix-${workflowId}-${Date.parse(at)}-status`, threadId: thread.id, role: "system", text: "", state: "done", createdAt: at,
    items: [{ type: "status", text: tOf(ctx)("已交给助手改：改好并通过扫描与审查后成为新版本，会在这里出现") }] });
  return thread.id;
}

/** 试运行 of any version: worked out from the ledger, nothing run or written (`dryRunAutomation`, `dryRunGrown`). */
export function dryRunWorkflow(ctx: AccessContext, id: string, version: number): WorkflowDryRun | undefined {
  const store = getStore();
  const detail = loadWorkflowDetail(ctx, id);
  if (!detail?.exists) return undefined;
  const options = { now: new Date(), zone: effectiveSchedulePreferences(ctx).preferences.timeZone, locale: localeFor(ctx) };
  if (detail.kind === "automation") {
    const current = readAutomations(store.getSetting(ctx.workspaceId, AUTOMATIONS_SETTING)).find((item) => item.id === detail.id);
    const row = store.listWorkflowVersions(ctx.workspaceId, "automation", detail.id).find((item) => item.version === version);
    if (!current || !row) return undefined;
    const definition = row.data as AutomationDefinition;
    return dryRunAutomation({ ...definition, createdAt: current.createdAt, ...(current.lastFiredAt ? { lastFiredAt: current.lastFiredAt } : {}) }, version,
      { ...options, categoryOn: definition.action.kind !== "run" || Boolean(readCategories(store, ctx.workspaceId)[definition.action.category]) });
  }
  const record = readGrownSkills(store, ctx.workspaceId).find((item) => item.id === detail.id);
  if (!record) return undefined;
  const chosen: Pick<GrownSkillVersion, "version" | "manifest"> | undefined = version === (record.version ?? 1) ? { version, manifest: record.manifest }
    : readGrownVersions(store, ctx.workspaceId, detail.id).find((item) => item.version === version);
  if (!chosen) return undefined;
  const agreed = agreedScope(store, ctx.workspaceId, record);
  const consented = !(chosen.manifest.access ?? []).length || Boolean(agreed && (chosen.manifest.access ?? []).every((item) =>
    (agreed.access ?? agreedScopeOf(record.manifest).access).some((ok) => ok.site === item.site && ok.login === item.login)));
  return dryRunGrown(record, chosen, { ...options, consented });
}
