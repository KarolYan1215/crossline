import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { readRunFile, readSkillDir } from "./workflow-smith";

// Security review of 2026-11-21: a sandboxed run could leave a link in its task folder, and the unsandboxed worker read the target
// (the worker's environment, the auth database, another account's files). Links are now never followed.

let root: string;
let task: string;
let outside: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "crossline-links-"));
  task = path.join(root, "task");
  outside = path.join(root, "outside");
  mkdirSync(path.join(task, "skill"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(outside, "secret.md"), "SECRET=1");
  writeFileSync(path.join(task, "skill", "SKILL.md"), "---\nname: x\ndescription: y\n---\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Symbolic links need a privilege on Windows without developer mode; the hard-link cases below run everywhere. */
function trySymlink(target: string, at: string, type: "file" | "dir"): boolean {
  try { symlinkSync(target, at, type); return true; } catch { return false; }
}

test("readSkillDir reads the run's own files", () => {
  expect(readSkillDir(path.join(task, "skill"))).toEqual({ files: [{ path: "SKILL.md", text: "---\nname: x\ndescription: y\n---\n" }] });
});

test("readSkillDir skips a hard link to a file outside the task", () => {
  linkSync(path.join(outside, "secret.md"), path.join(task, "skill", "notes.md"));
  expect(readSkillDir(path.join(task, "skill")).files.map((file) => file.path)).toEqual(["SKILL.md"]);
});

test("readSkillDir skips a symbolic link to a file outside the task", (ctx) => {
  if (!trySymlink(path.join(outside, "secret.md"), path.join(task, "skill", "environ"), "file")) return ctx.skip();
  expect(readSkillDir(path.join(task, "skill")).files.map((file) => file.path)).toEqual(["SKILL.md"]);
});

test("readSkillDir does not descend a linked folder, nor read skill/ when it is itself a link", (ctx) => {
  if (!trySymlink(outside, path.join(task, "skill", "refs"), "dir")) return ctx.skip();
  expect(readSkillDir(path.join(task, "skill")).files.map((file) => file.path)).toEqual(["SKILL.md"]);
  rmSync(path.join(task, "skill"), { recursive: true, force: true });
  trySymlink(outside, path.join(task, "skill"), "dir");
  expect(readSkillDir(path.join(task, "skill"))).toEqual({ files: [], problem: "没有写出 skill/ 文件夹" });
});

test("readRunFile reads a plain file and refuses links", (ctx) => {
  writeFileSync(path.join(task, "NO_CHANGE.md"), "already fine");
  expect(readRunFile(task, "NO_CHANGE.md")).toBe("already fine");
  rmSync(path.join(task, "NO_CHANGE.md"));
  linkSync(path.join(outside, "secret.md"), path.join(task, "NO_CHANGE.md"));
  expect(readRunFile(task, "NO_CHANGE.md")).toBeUndefined();
  rmSync(path.join(task, "NO_CHANGE.md"));
  expect(readRunFile(task, "NO_CHANGE.md")).toBeUndefined();
  if (!trySymlink(path.join(outside, "secret.md"), path.join(task, "NO_CHANGE.md"), "file")) return ctx.skip();
  expect(readRunFile(task, "NO_CHANGE.md")).toBeUndefined();
});
