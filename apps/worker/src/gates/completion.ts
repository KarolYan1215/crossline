import { DELIVERABLE_JUDGED, GIT_COMMIT_SEEN_EVENT, MAIL_LOG_SETTING, readMailLog, type DeviceCommit, type GateSubject } from "@crossline/core";
import type { CodexRpcBoundary } from "@crossline/codex";
import type { ImapMail } from "@crossline/connectors";
import type { CrosslineStore, StoredWorkOrder } from "@crossline/db";
import { buildLedgerBrief } from "../ledger-brief";
import { daysBefore, GATE_LIMITS, localDay } from "./context";
import { runGate, type GateResult } from "./run";
import { MAIL_SENT_SEEN, sentExcerpts, sentSeenSince } from "./sent-mail";
import { boardTasks, gateLookups, gateTask, isFinished, isOpen, priorityLabels, type GateTask } from "./tasks";
/* i18n-ignore-start: evidence and context written for a model, not interface text */

/**
 * J1, the completion gate (docs/plans/execution-gates-1124.md §四 J1). From evidence alone — files in the authorized folders, what the
 * person sent, confirmations in the inbox, commits, who is being waited on — each task is `done`, `submitted`, `waiting` (on whom),
 * `planned`, or `cannot_judge`. The model never sees whether the person pressed 完成: comparing that claim with the verdict is the web's
 * (`claimed_no_evidence` in the weekly review). Judged twice, the evidence reversed, for P1 and outward tasks (round 1).
 * Record only for now: the verdict changes no task's state until the evaluation set passes (§一.3).
 */
export const COMPLETION_SKILL = "crossline-gate-completion";
export const COMPLETION_VERSION = "crossline.gate.completion.v1";
const DETAIL = {
  type: "object", additionalProperties: false, required: ["waitingOn", "criteriaMet"],
  properties: { waitingOn: { type: "string" }, criteriaMet: { type: "array", items: { type: "object", additionalProperties: false, required: ["criterion", "met", "evidence"],
    properties: { criterion: { type: "string" }, met: { type: "string", enum: ["yes", "no", "no_evidence"] }, evidence: { type: "string" } } } } }
};

const LAST_RUN = "gates.completion.lastRunAt";
const LAST_FULL = "gates.completion.lastFullAt";
/** How far back a judgement looks for evidence, and how long a finished task stays a subject. */
export const COMPLETION_WINDOW_DAYS = 14;
const DAY = 86_400_000;

export type CompletionEvidence = { id: string; kind: "file" | "mail" | "commit" | "event"; at: string; ref: string; text: string };

/**
 * Everything that could show work went out or was produced in `[sinceIso, untilIso)`, the newest kept when there is too much. Mail text
 * only from `excerpts`.
 */
export function completionEvidence(store: CrosslineStore, workspaceId: string, sinceIso: string, excerpts: Map<string, string>, untilIso = "\uffff"): CompletionEvidence[] {
  const out: CompletionEvidence[] = [];
  const docs = new Map(store.listSourceDocuments(workspaceId).map((doc) => [doc.id, doc]));
  for (const event of store.listEvents(workspaceId, { type: DELIVERABLE_JUDGED })) {
    if (event.createdAt < sinceIso) continue;
    const payload = event.payload as { doc: string; verdict: string; fileName?: string };
    if (payload.verdict === "unrelated") continue;
    const doc = docs.get(payload.doc);
    out.push({ id: `file:${payload.doc}`, kind: "file", at: event.createdAt, ref: payload.fileName ?? doc?.fileName ?? payload.doc,
      text: (doc?.extractedText ?? "").slice(0, GATE_LIMITS.docChars) });
  }
  for (const sent of sentSeenSince(store, workspaceId, sinceIso)) {
    const key = `${sent.accountId}:${sent.uid}`;
    out.push({ id: `sent:${key}`, kind: "mail", at: sent.at, ref: `已发送 → ${sent.toDomains.join(", ")}：${sent.subject}`, text: excerpts.get(key) ?? "" });
  }
  for (const entry of readMailLog(store.getSetting(workspaceId, MAIL_LOG_SETTING))) {
    if ((entry.date || entry.at) < sinceIso) continue;
    out.push({ id: `inbox:${entry.accountId}:${entry.uid}`, kind: "mail", at: entry.date || entry.at, ref: `收到 ← ${entry.from}：${entry.subject}`, text: entry.title });
  }
  for (const event of store.listEvents(workspaceId, { type: GIT_COMMIT_SEEN_EVENT })) {
    const commit = event.payload as Partial<DeviceCommit>;
    if ((commit.at ?? event.createdAt) < sinceIso) continue;
    out.push({ id: `commit:${commit.sha ?? event.entityId}`, kind: "commit", at: commit.at ?? event.createdAt,
      ref: `${commit.repo ?? ""}@${String(commit.sha ?? "").slice(0, 10)}${commit.onDefaultBranch ? "（主分支）" : ""}`,
      text: `${commit.subject ?? ""}\n${(commit.files ?? []).slice(0, 30).join("\n")}` });
  }
  for (const item of store.listWaitingItems(workspaceId)) {
    if (item.updatedAt < sinceIso && item.state !== "open") continue;
    out.push({ id: `waiting:${item.id}`, kind: "event", at: item.updatedAt, ref: `在等 ${item.who}：${item.title}`,
      text: `状态 ${item.state}，预计 ${item.expectedAt}${item.blocks.length ? `，卡住任务 ${item.blocks.join(", ")}` : ""}` });
  }
  return out.filter((item) => item.at < untilIso).sort((a, b) => a.at.localeCompare(b.at)).slice(-GATE_LIMITS.evidencePerCall);
}

/**
 * The tasks to judge this pass, the most pressing first and at most one call's worth: P1 and outward ones (open, or finished in the
 * window), those the person finished since the last pass, and those new files were judged to belong to; with `full` (the daily pass),
 * every other open task after them, the soonest due first.
 */
export function completionSubjects(store: CrosslineStore, workspaceId: string, sinceIso: string, now: Date, full: boolean) {
  const labels = priorityLabels(store, workspaceId);
  const windowStart = daysBefore(now, COMPLETION_WINDOW_DAYS);
  const finishedAt = new Map(store.listEvents(workspaceId, { type: "human.completed" }).map((event) => [String((event.payload as { workOrderId?: string }).workOrderId ?? event.entityId), event.createdAt]));
  const touched = new Set(store.listEvents(workspaceId, { type: DELIVERABLE_JUDGED }).filter((event) => event.createdAt >= sinceIso)
    .map((event) => String((event.payload as { task?: string }).task ?? "")).filter(Boolean));
  const rank = (order: StoredWorkOrder) => {
    const label = labels.get(order.id);
    if (label?.p1 || label?.external) return 0;
    if ((finishedAt.get(order.id) ?? "") >= sinceIso || touched.has(order.id)) return 1;
    return full && isOpen(order) ? 2 : 3;
  };
  const due = (order: StoredWorkOrder) => (order.payload as { dueDate?: string } | undefined)?.dueDate || "\uffff";
  return boardTasks(store, workspaceId)
    .filter((order) => (isOpen(order) || (isFinished(order) && (finishedAt.get(order.id) ?? "") >= windowStart)) && rank(order) < 3)
    .sort((a, b) => rank(a) - rank(b) || due(a).localeCompare(due(b)))
    .slice(0, GATE_LIMITS.tasksPerCall);
}

export type CompletionDeps = { store: CrosslineStore; workspaceId: string; client: CodexRpcBoundary; cwd: string; timeZone?: string; now?: Date; full?: boolean;
  /** The workspace's mailboxes, to read sent text again (never stored). */
  openMail?: (accountId: string) => Promise<{ mail: ImapMail } | undefined>;
  /** Fresh excerpts of mail just read, so a pass right after the mail pass need not open the mailbox again. */
  excerpts?: Map<string, string> };

export async function completionGatePass(deps: CompletionDeps): Promise<GateResult[]> {
  const { store, workspaceId } = deps;
  const now = deps.now ?? new Date();
  const lastRun = store.getSetting(workspaceId, LAST_RUN) ?? daysBefore(now, COMPLETION_WINDOW_DAYS);
  const orders = completionSubjects(store, workspaceId, lastRun, now, deps.full ?? false);
  // Marked after the judgement: a failed call (it throws) leaves the pass due.
  const results = await judgeCompletion(deps, orders, daysBefore(now, COMPLETION_WINDOW_DAYS));
  store.setSetting(workspaceId, LAST_RUN, now.toISOString());
  if (deps.full) store.setSetting(workspaceId, LAST_FULL, now.toISOString());
  return results;
}

/**
 * Judges `orders` against everything seen since `sinceIso`. The resident pass calls it with its own subjects; the evaluation's backfill
 * (scripts/gate-eval.ts) with older tasks on a copy of the ledger, so both are the same judgement.
 */
export async function judgeCompletion(deps: CompletionDeps, orders: readonly StoredWorkOrder[], sinceIso: string): Promise<GateResult[]> {
  const { store, workspaceId } = deps;
  const now = deps.now ?? new Date();
  if (!orders.length) return [];
  const excerpts = new Map(deps.excerpts ?? []);
  if (deps.openMail) {
    const missing = sentSeenSince(store, workspaceId, sinceIso).filter((item) => !excerpts.has(`${item.accountId}:${item.uid}`));
    for (const [key, text] of await sentExcerpts(missing, deps.openMail)) excerpts.set(key, text);
  }
  const evidence = completionEvidence(store, workspaceId, sinceIso, excerpts);
  const lookups = gateLookups(store, workspaceId);
  const labels = priorityLabels(store, workspaceId);
  const tasks: Array<GateTask & { outward: boolean }> = orders.map((order) => ({ ...gateTask(store, workspaceId, order, lookups), outward: Boolean(labels.get(order.id)?.external) }));
  const brief = buildLedgerBrief(store, workspaceId, now);
  const input = { version: COMPLETION_VERSION, today: localDay(now, deps.timeZone), ledger: { lines: brief.lines, milestones: brief.milestones }, tasks, evidence };
  const subjects = new Map<string, GateSubject & { flagged?: boolean }>(orders.map((order) => {
    const label = labels.get(order.id);
    return [order.id, { kind: "task", id: order.id, flagged: Boolean(label?.p1 || label?.external) }];
  }));
  return runGate({ store, workspaceId, client: deps.client, cwd: deps.cwd, gate: "completion", skill: COMPLETION_SKILL, promptVersion: COMPLETION_VERSION,
    input, swap: (value, dual) => ({ ...value, tasks: value.tasks.filter((task) => dual.has(task.subject)).reverse(), evidence: [...value.evidence].reverse() }), detail: DETAIL,
    subjects, stableKeys: ["ledger"], round: now.toISOString().slice(0, 16),
    summary: `tasks ${tasks.length}, evidence ${evidence.length} (file ${evidence.filter((item) => item.kind === "file").length}, mail ${evidence.filter((item) => item.kind === "mail").length}, commit ${evidence.filter((item) => item.kind === "commit").length})`,
    now });
}

/** Whether a pass is due: something new arrived (a judged file, sent mail, a commit, a completion) since the last pass, or a day passed. */
export function completionDue(store: CrosslineStore, workspaceId: string, now: Date): { due: boolean; full: boolean } {
  const lastRun = store.getSetting(workspaceId, LAST_RUN);
  const lastFull = store.getSetting(workspaceId, LAST_FULL);
  if (!lastRun || !lastFull || now.getTime() - Date.parse(lastFull) >= DAY) return { due: true, full: true };
  const fresh = [DELIVERABLE_JUDGED, MAIL_SENT_SEEN, GIT_COMMIT_SEEN_EVENT, "human.completed"].some((type) => store.listEvents(workspaceId, { type }).some((event) => event.createdAt > lastRun));
  return { due: fresh, full: false };
}

/* i18n-ignore-end */