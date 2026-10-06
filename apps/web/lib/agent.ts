import "server-only";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { AGENT_CATEGORIES, AGENT_CATEGORY_EXPLAINED, isSecretPath, type AccessContext, type AgentCategory } from "@crossline/core";
import {
  assistantPlanFor, CLEAN_RUNS_TO_TRUST, declinedCategories, isPaused, listAgentTasks, pendingAgentApprovals, pendingCategoryRequests, readCategories,
  type AgentApprovalRow, type AgentTaskRow
} from "@crossline/db";
import { getStore } from "./crossline";

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
  tasks: Array<AgentTaskRow & { workOrderTitle: string }>;
};

export function loadAssistant(ctx: AccessContext): AssistantView {
  const store = getStore();
  const approved = readCategories(store, ctx.workspaceId);
  const declined = new Set(declinedCategories(store, ctx.workspaceId));
  const titles = new Map(store.listWorkOrders(ctx.workspaceId).map((order) => [order.id, order.intent]));
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
    tasks: listAgentTasks(store, ctx.workspaceId).map((task) => ({ ...task, workOrderTitle: titles.get(task.workOrderId) ?? "" }))
  };
}

/** The counts 待确认 adds: kinds waiting to be allowed, questions mid-run, and results waiting for a look. */
export function countAssistantPending(ctx: AccessContext): { categories: number; approvals: number; reviews: number } {
  const store = getStore();
  return {
    categories: pendingCategoryRequests(store, ctx.workspaceId).length,
    approvals: pendingAgentApprovals(store, ctx.workspaceId).length,
    reviews: listAgentTasks(store, ctx.workspaceId).filter((task) => task.status === "needs_review").length
  };
}

/** What the Workbench says about handing one order over: whether it can go, as which kind, and what it would be told. */
export type AssistantOffer =
  | { available: false; reason: string }
  | { available: true; category: AgentCategory | undefined; categoryLabel: string; categoryAllowed: boolean; why: string; graded: boolean; humanPart: string };

export function assistantOffer(ctx: AccessContext, workOrderId: string): AssistantOffer {
  const store = getStore();
  const planned = assistantPlanFor(store, ctx.workspaceId, workOrderId);
  if (!planned.ok) return { available: false, reason: planned.message };
  const { plan } = planned;
  return {
    available: true, category: plan.category, categoryLabel: plan.category ? AGENT_CATEGORIES[plan.category] : "", why: plan.why,
    categoryAllowed: plan.category ? Boolean(readCategories(store, ctx.workspaceId)[plan.category]) : false, graded: plan.graded, humanPart: plan.humanPart
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

const MIME: Record<string, string> = {
  ".md": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".py": "text/plain; charset=utf-8", ".json": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8", ".js": "text/plain; charset=utf-8", ".ts": "text/plain; charset=utf-8", ".log": "text/plain; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".pdf": "application/pdf"
};
const FILE_LIMIT = 8 * 1024 * 1024;

/** One file from a task's directory, for the review page to open. Never a path that leaves the directory, a secret, or something huge. */
export function readTaskFile(ctx: AccessContext, taskId: string, relative: string): { body: Buffer; type: string } | undefined {
  const directory = taskDirectory(ctx, taskId);
  if (!directory || !relative || path.isAbsolute(relative)) return undefined;
  const full = path.resolve(directory, relative);
  if (!full.toLowerCase().startsWith(`${path.resolve(directory).toLowerCase()}${path.sep}`) || isSecretPath(full)) return undefined;
  try {
    const stat = statSync(full);
    if (!stat.isFile() || stat.size > FILE_LIMIT) return undefined;
    // An SVG is shown as text, not run: it can carry script, and this is an origin the person is signed in on.
    const type = MIME[path.extname(full).toLowerCase()];
    return { body: readFileSync(full), type: type === "image/svg+xml" ? "text/plain; charset=utf-8" : type ?? "application/octet-stream" };
  } catch { return undefined; }
}
