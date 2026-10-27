import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { containedPath } from "./contained-path";

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "contained-"));
  mkdirSync(path.join(root, "task", "out"), { recursive: true });
  mkdirSync(path.join(root, "outside"));
  writeFileSync(path.join(root, "task", "out", "note.md"), "mine");
  writeFileSync(path.join(root, "outside", "crossline.db"), "ledger");
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

test("a link a run left in its own directory is not followed out of it", () => {
  const task = path.join(root, "task");
  expect(containedPath(task, "out/note.md")).toBe(realpathSync(path.join(task, "out", "note.md")));
  // A junction on Windows (no admin rights needed), a directory symlink elsewhere.
  symlinkSync(path.join(root, "outside"), path.join(task, "escape"), "junction");
  expect(containedPath(task, "escape/crossline.db")).toBeUndefined();
  expect(containedPath(task, "../outside/crossline.db")).toBeUndefined();
  expect(containedPath(task, path.join(root, "outside", "crossline.db"))).toBeUndefined();
  expect(containedPath(task, "missing.md")).toBeUndefined();
  expect(containedPath(task, "")).toBeUndefined();
});
