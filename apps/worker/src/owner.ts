import path from "node:path";
import { codexProcessEnvironment, spentFor } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";

/**
 * Who a background job's rows belong to: the workspace's real owner. Every worker job used to stamp its
 * writes with the pre-accounts constant, and the goal backplanner even *filtered* on it — so on a real
 * account (whose owner is a principal UUID) 「从此目标反推步骤」 could never find an approved milestone.
 * `SYSTEM_OWNER_ID` covers only a workspace with no member row (a test store, the retired single-user
 * ledger); it is a label for "written by the system", not an identity anything checks against.
 */
export const SYSTEM_OWNER_ID = "system";

export function ownerOf(store: Pick<CrosslineStore, "getWorkspaceOwnerId">, workspaceId: string): string {
  return store.getWorkspaceOwnerId(workspaceId) ?? SYSTEM_OWNER_ID;
}

/** Marks the workspace whose account owns this machine's Codex runtime (and the shell assistant). */
export const RUNTIME_OWNER_SETTING = "deployment.runtimeOwner";

/**
 * The machine owner's workspace: the one already marked; else the one named by `CROSSLINE_RUNTIME_LEGACY_WORKSPACE`; else the first
 * workspace created on this machine — the owner's own, since every other account signs up later. Marked once, so an account created
 * later never becomes the owner and inherits the owner's Codex login, quota or memories.
 */
export function runtimeOwner(store: CrosslineStore, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const workspaces = store.listWorkspaces();
  const marked = workspaces.find((workspace) => store.getSetting(workspace.id, RUNTIME_OWNER_SETTING) === "1");
  if (marked) return marked.id;
  const named = env.CROSSLINE_RUNTIME_LEGACY_WORKSPACE?.trim();
  const owner = (named ? workspaces.find((workspace) => workspace.id === named) : undefined) ?? workspaces[0];
  if (owner) store.setSetting(owner.id, RUNTIME_OWNER_SETTING, "1");
  return owner?.id;
}

/** Guest accounts' Codex homes, beside the owner's (`%LOCALAPPDATA%\Crossline\runtimes`), never inside the data folder that is backed up. */
export function runtimesDir(env: NodeJS.ProcessEnv = process.env): string {
  try { return path.join(path.dirname(codexProcessEnvironment(env).CODEX_HOME!), "runtimes"); }
  catch { return path.join(env.CROSSLINE_DATA_DIR ?? path.resolve(process.cwd(), "../../data"), "runtimes"); }
}

/** The person's monthly cap for a pay-per-use login (`model.budget.monthly`, default $10, decided 2026-10-10). */
export const MONTHLY_BUDGET_SETTING = "model.budget.monthly";
export function monthSpend(store: CrosslineStore, workspaceId: string, now = new Date()): { spent: number; cap: number } {
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const cap = Number(store.getSetting(workspaceId, MONTHLY_BUDGET_SETTING));
  return { spent: spentFor(store.summarizeModelUsage(workspaceId, since)), cap: Number.isFinite(cap) && cap > 0 ? cap : 10 };
}
