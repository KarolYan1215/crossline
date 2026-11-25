import { execFile } from "node:child_process";
import path from "node:path";
import {
  GIT_REPOS_SETTING, GIT_SEEN_SETTING, LOCAL_ONLY_MASK, gitCommitEvent, insideLocalOnly, maskPrivate, pdkHit, privacyRules, type DeviceCommit, type PrivacyRules
} from "@crossline/core";
import type { CrosslineStore } from "@crossline/db";

/**
 * Git commits as evidence (docs/plans/execution-gates-1124.md J1 「git 提交」, 2026-11-24). For each repository the person authorized on
 * this computer (`git.repos`), `git log` — run without a shell — gives what is new since the last pass: the commit id, author time,
 * subject line and changed file names, and whether the commit is on the default branch. Diffs are never read. Every file name and subject
 * passes `maskPrivate` here, before anything is kept or sent: a repository inside a 「仅本地」 folder, or one whose path hits a PDK term,
 * sends nothing but `[仅本地]`, the id and the time.
 *
 * Used by a linked device (sent to `POST /api/device/commits`) and by a local install's own worker (`commitEvents` straight into the
 * ledger). Imports no model code: a device runs it (`device-mode.test.ts`).
 */
export type GitPrivacy = PrivacyRules;
/** Per repository path: the newest author time seen, and the ids seen since a day before it (so a pass never sends a commit twice). */
export type GitSeen = Record<string, { at: string; shas: string[] }>;

/** The first look at a repository goes back this far. */
const FIRST_DAYS = 14;
/** Ids remembered per repository. */
const SEEN_KEEP = 500;
const RECORD = "\x1e", FIELD = "\x1f";

const read = <T>(raw: string | undefined, fallback: T): T => { try { return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; } };

export function gitRepos(store: CrosslineStore, workspaceId: string): string[] {
  const raw = read<unknown>(store.getSetting(workspaceId, GIT_REPOS_SETTING), []);
  return Array.isArray(raw) ? [...new Set(raw.filter((item): item is string => typeof item === "string" && path.isAbsolute(item)))] : [];
}
/** The workspace's privacy rules (PDK terms, 「仅本地」 folders): the one reader every masking path uses. */
export const privacyOf = (store: CrosslineStore, workspaceId: string): PrivacyRules => privacyRules((key) => store.getSetting(workspaceId, key));
export const readGitSeen = (store: CrosslineStore, workspaceId: string): GitSeen => read<GitSeen>(store.getSetting(workspaceId, GIT_SEEN_SETTING), {});
export const saveGitSeen = (store: CrosslineStore, workspaceId: string, seen: GitSeen) => store.setSetting(workspaceId, GIT_SEEN_SETTING, JSON.stringify(seen));

export type GitRunner = (cwd: string, args: string[]) => Promise<string>;
/** Git's repository-local variables, as `git rev-parse --local-env-vars` lists them. */
const GIT_LOCAL_ENV = new Set(["GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_OBJECT_DIRECTORY",
  "GIT_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE", "GIT_INDEX_FILE", "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_PREFIX",
  "GIT_SHALLOW_FILE", "GIT_COMMON_DIR"]);
/**
 * This process's environment without git's repository-local variables: set when it runs inside a git hook, they would point every `git`
 * call at that repository instead of the one in `cwd`.
 */
export const envWithoutGit = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([key]) => !GIT_LOCAL_ENV.has(key.toUpperCase())));
/** `git` from PATH, no shell, no window, quoting of unusual file names off so they come back as written. */
export const runGit: GitRunner = (cwd, args) => new Promise((resolve, reject) => {
  execFile("git", ["-c", "core.quotepath=off", "--no-pager", ...args], { cwd, env: envWithoutGit(), windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
    (error, stdout) => error ? reject(error) : resolve(stdout));
});

/** The repository's default branch: the local `main`, else `master`, else what `origin/HEAD` points at; undefined when none exists. */
async function defaultBranch(repo: string, git: GitRunner): Promise<string | undefined> {
  for (const name of ["refs/heads/main", "refs/heads/master"]) {
    if (await git(repo, ["rev-parse", "--verify", "--quiet", name]).then(() => true).catch(() => false)) return name;
  }
  return await git(repo, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]).then((out) => out.trim() || undefined).catch(() => undefined);
}

/**
 * New commits on any local branch of each repository since the last pass, oldest first, masked; and the seen state to keep afterwards
 * (the caller saves it once what was read is safely queued or written). A repository that cannot be read is skipped this time.
 */
export async function readNewCommits(repos: readonly string[], seen: Readonly<GitSeen>, privacy: GitPrivacy,
  options: { git?: GitRunner; now?: Date; maxPerRepo?: number } = {}): Promise<{ commits: DeviceCommit[]; seen: GitSeen }> {
  const git = options.git ?? runGit;
  const now = options.now ?? new Date();
  const next: GitSeen = { ...seen };
  const commits: DeviceCommit[] = [];
  for (const repo of repos) {
    const before = seen[repo];
    // A day before the newest seen: a commit made on another branch with an older author time still turns up, and the ids stop repeats.
    const since = before ? new Date(Date.parse(before.at) - 86_400_000) : new Date(now.getTime() - FIRST_DAYS * 86_400_000);
    const sinceArg = `--since=${since.toISOString()}`;
    let log: string;
    try { log = await git(repo, ["log", "--branches", sinceArg, `--max-count=${options.maxPerRepo ?? 200}`, "--name-only", `--format=${RECORD}%H${FIELD}%aI${FIELD}%s`]); }
    catch { continue; }
    const branch = await defaultBranch(repo, git);
    const onDefault = new Set(branch ? (await git(repo, ["rev-list", sinceArg, branch]).catch(() => "")).split("\n").map((line) => line.trim()).filter(Boolean) : []);
    const known = new Set(before?.shas ?? []);
    const privateRepo = pdkHit(repo, privacy.terms) || insideLocalOnly(repo, privacy.localOnlyPaths);
    const label = privateRepo ? LOCAL_ONLY_MASK : maskPrivate(path.basename(repo), privacy.terms, privacy.localOnlyPaths);
    const fresh: DeviceCommit[] = [];
    for (const record of log.split(RECORD).slice(1)) {
      const [head = "", ...rest] = record.split("\n");
      const [sha = "", at = "", subject = ""] = head.split(FIELD);
      if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sha) || known.has(sha) || Number.isNaN(Date.parse(at))) continue;
      // Judged by its full path, so a 「仅本地」 folder inside the repository masks its files too.
      const files = rest.map((line) => line.trim()).filter(Boolean).slice(0, 30)
        .map((file) => privateRepo || maskPrivate(path.join(repo, file), privacy.terms, privacy.localOnlyPaths) === LOCAL_ONLY_MASK ? LOCAL_ONLY_MASK : file);
      fresh.push({ repo: label, sha, at: new Date(at).toISOString(), subject: privateRepo ? LOCAL_ONLY_MASK : maskPrivate(subject.trim().slice(0, 300), privacy.terms, privacy.localOnlyPaths),
        files, onDefaultBranch: onDefault.has(sha) });
    }
    fresh.reverse();
    commits.push(...fresh);
    const newest = [before?.at, ...fresh.map((commit) => commit.at)].filter((item): item is string => Boolean(item)).sort().at(-1);
    next[repo] = { at: newest ?? now.toISOString(), shas: [...(before?.shas ?? []), ...fresh.map((commit) => commit.sha)].slice(-SEEN_KEEP) };
  }
  return { commits, seen: next };
}

/** One `git.commit_seen` event per commit, idempotent by repository and id; answers how many were new. */
export function commitEvents(store: CrosslineStore, workspaceId: string, commits: readonly DeviceCommit[]): number {
  const ownerId = store.getWorkspaceOwnerId(workspaceId) ?? "system";
  let added = 0;
  for (const commit of commits) if (store.appendEvent({ ownerId, workspaceId, ...gitCommitEvent(commit) }).inserted) added += 1;
  return added;
}

/**
 * A local install's whole pass (not a device): read what is new, write the events, keep the seen state. Answers how many events were new.
 */
export async function localCommitPass(store: CrosslineStore, workspaceId: string, options: { git?: GitRunner; now?: Date } = {}): Promise<number> {
  const repos = gitRepos(store, workspaceId);
  if (!repos.length) return 0;
  const { commits, seen } = await readNewCommits(repos, readGitSeen(store, workspaceId), privacyOf(store, workspaceId), options);
  const added = commitEvents(store, workspaceId, commits);
  saveGitSeen(store, workspaceId, seen);
  return added;
}
