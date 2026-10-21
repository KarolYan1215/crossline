import "server-only";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { AGENT_CATEGORIES, AGENT_CATEGORY_EXPLAINED, isSecretPath, type AccessContext, type AgentCategory } from "@crossline/core";
import {
  CLEAN_RUNS_TO_TRUST, declinedCategories, isPaused, listAgentTasks, pendingAgentApprovals, pendingAgentQuestions, pendingCategoryRequests, readCategories, resultsAwaitingReview,
  type AgentApprovalRow, type AgentQuestionRow, type AgentTaskRow
} from "@crossline/db";
import { getStore } from "./crossline";
import { namesFrom, type Names } from "../app/materials/humanize";

/**
 * What the Assistant page and the 待确认 summary show, read from the ledger. The worker writes it (tasks, requests, questions); the
 * person's answers go back through the routes under `/api/agent`, which write to the same ledger. The two never talk directly.
 */
export type CategoryView = {
  category: AgentCategory; label: string; explained: string; state: "approved" | "declined" | "unasked";
  trust: "review_all" | "auto_checked"; cleanRuns: number; runsToTrust: number;
};
export type AssistantView = {
  paused: boolean;
  categories: CategoryView[];
  categoryRequests: Array<{ category: AgentCategory; label: string; explained: string; why: string; workOrderId: string; workOrderTitle: string }>;
  approvals: AgentApprovalRow[];
  /** Questions a run asked mid-way (Codex's `request_user_input`), waiting for the person's answer. */
  questions: AgentQuestionRow[];
  tasks: Array<AgentTaskRow & { workOrderTitle: string }>;
  /** The results still the person's to look at (`resultsAwaitingReview`): not one for finished or archived work, not one a later run replaced. */
  reviews: Array<AgentTaskRow & { workOrderTitle: string }>;
};

export function loadAssistant(ctx: AccessContext): AssistantView {
  const store = getStore();
  const approved = readCategories(store, ctx.workspaceId);
  const declined = new Set(declinedCategories(store, ctx.workspaceId));
  const titles = new Map(store.listWorkOrders(ctx.workspaceId).map((order) => [order.id, order.intent]));
  const tasks = listAgentTasks(store, ctx.workspaceId).map((task) => ({ ...task, workOrderTitle: titles.get(task.workOrderId) ?? "" }));
  const reviewable = new Set(resultsAwaitingReview(store, ctx.workspaceId, tasks).map((task) => task.taskId));
  return {
    paused: isPaused(store, ctx.workspaceId),
    categories: (Object.keys(AGENT_CATEGORIES) as AgentCategory[]).map((category) => ({
      category, label: AGENT_CATEGORIES[category], explained: AGENT_CATEGORY_EXPLAINED[category],
      state: approved[category] ? "approved" : declined.has(category) ? "declined" : "unasked",
      trust: approved[category]?.trust ?? "review_all", cleanRuns: approved[category]?.cleanRuns ?? 0, runsToTrust: CLEAN_RUNS_TO_TRUST
    })),
    categoryRequests: pendingCategoryRequests(store, ctx.workspaceId).map((request) => ({
      ...request, label: AGENT_CATEGORIES[request.category], explained: AGENT_CATEGORY_EXPLAINED[request.category], workOrderTitle: titles.get(request.workOrderId) ?? ""
    })),
    approvals: pendingAgentApprovals(store, ctx.workspaceId),
    questions: pendingAgentQuestions(store, ctx.workspaceId),
    tasks,
    reviews: tasks.filter((task) => reviewable.has(task.taskId))
  };
}

/** The counts 待确认 adds: kinds waiting to be allowed, questions mid-run, and results waiting for a look. */
export function countAssistantPending(ctx: AccessContext): { categories: number; approvals: number; reviews: number } {
  const store = getStore();
  return {
    categories: pendingCategoryRequests(store, ctx.workspaceId).length,
    approvals: pendingAgentApprovals(store, ctx.workspaceId).length + pendingAgentQuestions(store, ctx.workspaceId).length,
    reviews: resultsAwaitingReview(store, ctx.workspaceId).length
  };
}

/** The full record the runner wrote beside a task's files: what ran, what was refused, what was made and checked. */
export type TaskAudit = {
  summary: string; durationMs: number;
  artifacts: Array<{ path: string; purpose: string; sha256: string; bytes: number }>;
  verification: Array<{ check: string; result: string; evidence: string }>;
  needsHuman: Array<{ what: string; why: string }>; notDone: Array<{ what: string; why: string }>; assumptions: string[];
  audit: { commands: Array<{ command: string; exitCode: number | null }>; filesChanged: Array<{ path: string; kind: string }>; searches: string[];
    decisions: Array<{ rule: string; reason: string; subject: string; outcome: string }>; requests?: { total: number; allowed: number } };
  inputsModified: string[]; checksPassed: boolean;
};

/** The task's directory as the ledger recorded it, and only if it still holds the audit file. Anything else is not served. */
function taskDirectory(ctx: AccessContext, taskId: string): string | undefined {
  const done = getStore().listEvents(ctx.workspaceId, { type: "agent.task.completed", entityId: taskId }).at(-1);
  const directory = (done?.payload as { directory?: unknown } | undefined)?.directory;
  return typeof directory === "string" && existsSync(path.join(directory, "audit.json")) ? directory : undefined;
}

export function loadTaskAudit(ctx: AccessContext, taskId: string): TaskAudit | undefined {
  const directory = taskDirectory(ctx, taskId);
  if (!directory) return undefined;
  try { return JSON.parse(readFileSync(path.join(directory, "audit.json"), "utf8")) as TaskAudit; } catch { return undefined; }
}

/**
 * The readable names behind what a run wrote: the person's uploaded files whose stored copies (named by hash) the run read, and the
 * codes it gave them (`S01`). Read from the run's text files and the inputs it was handed, so the materials page can call a file by its
 * own name instead of its hash.
 */
export function outputNames(ctx: AccessContext, taskId: string, audit: Pick<TaskAudit, "artifacts">): Names {
  const texts = audit.artifacts.filter((item) => /\.(md|csv|txt)$/i.test(item.path))
    .map((item) => readTaskFile(ctx, taskId, item.path)?.body.toString("utf8") ?? "");
  const requested = getStore().listEvents(ctx.workspaceId, { type: "agent.task.requested", entityId: taskId }).at(-1);
  const inputs = (requested?.payload as { inputs?: unknown } | undefined)?.inputs;
  if (Array.isArray(inputs)) texts.push(inputs.filter((item): item is string => typeof item === "string").join("\n"));
  return namesFrom(texts, getStore().listSourceDocuments(ctx.workspaceId).map((doc) => ({ sha256: doc.sha256, fileName: doc.fileName })));
}

const MIME: Record<string, string> = {
  ".md": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".py": "text/plain; charset=utf-8", ".json": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8", ".js": "text/plain; charset=utf-8", ".ts": "text/plain; charset=utf-8", ".log": "text/plain; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".pdf": "application/pdf"
};
const FILE_LIMIT = 8 * 1024 * 1024;

/** One file from a task's directory, for the review page to open. Never a path that leaves the directory, a secret, or something huge. */
export function readTaskFile(ctx: AccessContext, taskId: string, relative: string, limit = FILE_LIMIT): { body: Buffer; type: string } | undefined {
  const directory = taskDirectory(ctx, taskId);
  if (!directory || !relative || path.isAbsolute(relative)) return undefined;
  const full = path.resolve(directory, relative);
  if (!full.toLowerCase().startsWith(`${path.resolve(directory).toLowerCase()}${path.sep}`) || isSecretPath(full)) return undefined;
  try {
    const stat = statSync(full);
    if (!stat.isFile() || stat.size > limit) return undefined;
    // An SVG is shown as text, not run: it can carry script, and this is an origin the person is signed in on.
    const type = MIME[path.extname(full).toLowerCase()];
    return { body: readFileSync(full), type: type === "image/svg+xml" ? "text/plain; charset=utf-8" : type ?? "application/octet-stream" };
  } catch { return undefined; }
}
