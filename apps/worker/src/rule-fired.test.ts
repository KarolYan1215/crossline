import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ruleFired } from "./rule-fired";

let dir = "";
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; vi.restoreAllMocks(); });

// 2026-11-25: telemetry, never the ledger (CLAUDE.md 「Telemetry is not the ledger」): a line per firing next to the data, for the replays.
test("a record-only rule that fired is one JSON line in the data dir's telemetry, or on stdout without a data dir", () => {
  dir = mkdtempSync(path.join(tmpdir(), "rule-fired-"));
  const at = new Date("2026-11-25T10:00:00Z");
  ruleFired({ rule: "IR-006", workspaceId: "w", sessionId: "s", replyId: "reply-3", detail: "x".repeat(400) }, dir, at);
  ruleFired({ rule: "IR-047", workspaceId: "w" }, dir, at);
  const lines = readFileSync(path.join(dir, "telemetry", "rule-fired.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, string>);
  expect(lines).toEqual([{ type: "rule.fired", at: at.toISOString(), rule: "IR-006", workspaceId: "w", sessionId: "s", replyId: "reply-3", detail: "x".repeat(300) },
    { type: "rule.fired", at: at.toISOString(), rule: "IR-047", workspaceId: "w" }]);
  const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
  ruleFired({ rule: "IR-014", workspaceId: "w" }, "", at);
  expect(JSON.parse(String(info.mock.calls[0]![0]))).toMatchObject({ type: "rule.fired", rule: "IR-014" });
});
