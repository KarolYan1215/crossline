import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DEFAULT_PDK_TERMS, GIT_COMMIT_SEEN_EVENT, GIT_REPOS_SETTING, SOURCE_FOLDERS_SETTING } from "@crossline/core";
import { CrosslineStore } from "@crossline/db";
import { commitEvents, envWithoutGit, localCommitPass, readNewCommits } from "./git-commits";
import { commitItems } from "./device/payloads";

/** Git commits as evidence (docs/plans/execution-gates-1124.md J1): a throwaway repository in the temp folder, never the person's. */
let root: string;
let repo: string;
const git = (...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=", ...args], { cwd: repo, env: envWithoutGit(), encoding: "utf8", windowsHide: true });
const commit = (files: Record<string, string>, message: string) => {
  for (const [name, content] of Object.entries(files)) { mkdirSync(path.dirname(path.join(repo, name)), { recursive: true }); writeFileSync(path.join(repo, name), content); }
  git("add", "-A");
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD").trim();
};

beforeEach(() => {
  for (const [key, value] of Object.entries({ GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(tmpdir(), "crossline-no-gitconfig") })) vi.stubEnv(key, value);
  root = mkdtempSync(path.join(tmpdir(), "crossline-git-"));
  repo = path.join(root, "thesis");
  mkdirSync(repo);
  git("init", "-q", "-b", "main");
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

test("new commits come with id, time, subject and file names, masked, and with whether they are on the default branch", async () => {
  const privacy = { terms: [...DEFAULT_PDK_TERMS, "sky130"], localOnlyPaths: [path.join(repo, "unpublished-data")] };
  const first = commit({ "paper/intro.tex": "intro", "cells/sky130_fd.lib": "lib", "unpublished-data/run1.csv": "1,2" }, "Draft intro\n\nlong body never read");
  git("checkout", "-q", "-b", "feature");
  const side = commit({ "notes.md": "x" }, "Tune sky130 corners");

  const read = await readNewCommits([repo], {}, privacy);
  expect(read.commits.map((item) => item.sha)).toEqual([first, side]);
  expect(read.commits[0]).toMatchObject({ repo: "thesis", subject: "Draft intro", onDefaultBranch: true });
  expect(read.commits[0]!.files.sort()).toEqual(["[仅本地]", "[仅本地]", "paper/intro.tex"]);
  expect(read.commits[1]).toMatchObject({ subject: "[仅本地]", files: ["notes.md"], onDefaultBranch: false });
  expect(Date.parse(read.commits[0]!.at)).not.toBeNaN();
  expect(JSON.stringify(read.commits)).not.toMatch(/long body|sky130|unpublished|run1/);

  // The next pass sees only what is new.
  const again = await readNewCommits([repo], read.seen, privacy);
  expect(again.commits).toEqual([]);
  const third = commit({ "paper/method.tex": "m" }, "Method");
  expect((await readNewCommits([repo], again.seen, privacy)).commits.map((item) => item.sha)).toEqual([third]);

  // A repository inside a 「仅本地」 folder sends nothing but the mask, the id and the time.
  const hidden = await readNewCommits([repo], {}, { terms: DEFAULT_PDK_TERMS, localOnlyPaths: [root] });
  expect(hidden.commits.every((item) => item.repo === "[仅本地]" && item.subject === "[仅本地]" && item.files.every((file) => file === "[仅本地]"))).toBe(true);

  // As device outbox items: one batch to the new route.
  expect(commitItems(read.commits)).toMatchObject([{ route: "/api/device/commits", body: { commits: read.commits } }]);
});

test("a local install writes one git.commit_seen event per commit, once", async () => {
  const store = new CrosslineStore(":memory:");
  try {
    const ws = store.createPrincipalWithWorkspace("user-1", "个人").workspace.id;
    store.setSetting(ws, GIT_REPOS_SETTING, JSON.stringify([repo]));
    store.setSetting(ws, SOURCE_FOLDERS_SETTING, "[]");
    const sha = commit({ "a.txt": "a" }, "First");
    expect(await localCommitPass(store, ws)).toBe(1);
    expect(await localCommitPass(store, ws)).toBe(0);
    const events = store.listEvents(ws, { type: GIT_COMMIT_SEEN_EVENT });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ entityId: sha, idempotencyKey: `${GIT_COMMIT_SEEN_EVENT}:thesis:${sha}`,
      payload: { repo: "thesis", sha, subject: "First", files: ["a.txt"], onDefaultBranch: true } });
    // The same commits given again (a resend) add nothing.
    expect(commitEvents(store, ws, [events[0]!.payload as never])).toBe(0);
  } finally { store.close(); }
});
