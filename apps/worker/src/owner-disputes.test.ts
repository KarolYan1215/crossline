import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { recordOwnerDisputes } from "./owner-disputes";

let dir = "";
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; });

// docs/plans/harness-1125.md §1: the model's `external: false` stands over the words; only that disagreement is written, never to the ledger.
test("writes one JSON line per item the model called not external while the words say it is, and nothing for the rest", () => {
  dir = mkdtempSync(path.join(tmpdir(), "owner-disputes-"));
  const count = recordOwnerDisputes("ws-1", "crossline:crossline-goal-backplanner:backplan", [
    { id: "a", title: "发送周报给导师", external: false },
    { id: "b", title: "整理复习提纲", external: false },
    { id: "c", title: "发送周报给导师", external: true },
    { id: "d", title: "提交报名表" }], dir);
  expect(count).toBe(1);
  const file = path.join(dir, "telemetry", "owner-disputes.jsonl");
  const lines = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(lines).toEqual([expect.objectContaining({ type: "owner.disputed", workspaceId: "ws-1", skill: "crossline:crossline-goal-backplanner:backplan", itemId: "a", title: "发送周报给导师" })]);
  expect(recordOwnerDisputes("ws-1", "s", [{ id: "e", title: "整理提纲", external: false }], dir)).toBe(0);
  expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(1);
});

test("writes nothing when nothing is disputed", () => {
  dir = mkdtempSync(path.join(tmpdir(), "owner-disputes-"));
  expect(recordOwnerDisputes("ws-1", "s", [{ id: "a", title: "整理提纲", external: false }], dir)).toBe(0);
  expect(existsSync(path.join(dir, "telemetry", "owner-disputes.jsonl"))).toBe(false);
});
