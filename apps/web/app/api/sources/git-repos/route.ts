import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { GIT_REPOS_SETTING } from "@crossline/core";
import { assistantAvailable } from "@crossline/db";
import { getStore } from "../../../../lib/crossline";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { tOf } from "../../../../lib/locale";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/**
 * The git repositories whose commits count as evidence (docs/plans/execution-gates-1124.md J1 「git 提交」): absolute paths on this
 * computer, kept in `git.repos`. The worker reads only commit ids, times, subjects and changed file names, masked before they leave; never
 * a diff. Only this computer's owner, never on the hosted site.
 */
const readRepos = (workspaceId: string): string[] => {
  try {
    const raw = JSON.parse(getStore().getSetting(workspaceId, GIT_REPOS_SETTING) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
};

export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const available = assistantAvailable(getStore(), access.ctx.workspaceId);
  return NextResponse.json({ available, repos: available ? readRepos(access.ctx.workspaceId) : [] }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ state: "blocked", code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const t = tOf(access.ctx);
  if (!assistantAvailable(getStore(), access.ctx.workspaceId)) return NextResponse.json({ state: "blocked", code: "GIT_REPOS_OWNER_ONLY" }, { status: 403 });
  const body = await request.json().catch(() => null) as { repos?: unknown } | null;
  if (!Array.isArray(body?.repos)) return NextResponse.json({ state: "blocked", code: "GIT_REPOS_REQUIRED" }, { status: 400 });
  const repos: string[] = [];
  for (const item of body.repos.slice(0, 50)) {
    if (typeof item !== "string" || !item.trim()) continue;
    const repo = path.resolve(item.trim().replace(/^["']|["']$/g, ""));
    const isDir = (() => { try { return statSync(repo).isDirectory(); } catch { return false; } })();
    // `.git` is a folder in a clone and a file in a worktree.
    if (!path.isAbsolute(item.trim().replace(/^["']|["']$/g, "")) || !isDir || !existsSync(path.join(repo, ".git")))
      return NextResponse.json({ state: "blocked", code: "GIT_REPO_INVALID", message: t("「{{path}}」不是这台电脑上的 git 仓库（需要完整路径，里面有 .git）。", { path: item.slice(0, 200) }) }, { status: 400 });
    if (!repos.some((known) => known.toLowerCase() === repo.toLowerCase())) repos.push(repo);
  }
  getStore().setSetting(access.ctx.workspaceId, GIT_REPOS_SETTING, JSON.stringify(repos));
  return NextResponse.json({ state: "saved", repos });
}
