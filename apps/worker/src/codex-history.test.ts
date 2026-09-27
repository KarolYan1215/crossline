import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { scanPersonalCodexHistory, defaultPersonalCodexHome } from "./codex-history";

// This repo's own sandbox has no real personal Codex CLI history to read (that is the whole point of the
// `CROSSLINE_PERSONAL_CODEX_HOME` override this app-server never uses for its own isolated sandbox) — so
// every case here builds a synthetic `<home>/sessions/YYYY/MM/DD/rollout-*.jsonl` fixture matching the
// format confirmed against `vendor/codex/codex-rs/thread-store/src/local/*.rs` instead.
let home: string | undefined;
afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }); home = undefined; });

function writeSession(dayDir: string, id: string, lines: unknown[]): void {
  mkdirSync(dayDir, { recursive: true });
  writeFileSync(path.join(dayDir, `rollout-2026-01-15T12-00-00-${id}.jsonl`),
    lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
}

describe("scanPersonalCodexHistory", () => {
  test("defaults to ~/.codex, overridable via CROSSLINE_PERSONAL_CODEX_HOME", () => {
    delete process.env.CROSSLINE_PERSONAL_CODEX_HOME;
    expect(defaultPersonalCodexHome().endsWith(".codex")).toBe(true);
    process.env.CROSSLINE_PERSONAL_CODEX_HOME = "/custom/path";
    expect(defaultPersonalCodexHome()).toBe("/custom/path");
    delete process.env.CROSSLINE_PERSONAL_CODEX_HOME;
  });

  test("an empty or missing sessions directory returns zero sources, not an error", async () => {
    home = mkdtempSync(path.join(tmpdir(), "codex-history-"));
    const result = await scanPersonalCodexHistory(home);
    expect(result).toEqual({ sessionCount: 0, keptCount: 0, sources: [] });
  });

  test("a real session's first user message becomes a short excerpt, never the full transcript", async () => {
    home = mkdtempSync(path.join(tmpdir(), "codex-history-"));
    const dayDir = path.join(home, "sessions", "2026", "01", "15");
    const longMessage = "帮我重构一下认证模块，" + "细节细节".repeat(200);
    writeSession(dayDir, "real-session", [
      { type: "session_meta", payload: { id: "real-session", timestamp: "2026-01-15T12:00:00Z" } },
      { type: "response_item", payload: { role: "user", content: [{ type: "input_text", text: longMessage }] } },
      { type: "response_item", payload: { role: "assistant", content: [{ type: "output_text", text: "好的，我看看" }] } },
      { type: "turn_context", payload: { cwd: "/home/user/project" } }
    ]);
    const result = await scanPersonalCodexHistory(home);
    expect(result.sessionCount).toBe(1);
    expect(result.keptCount).toBe(1);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]!.excerpt.length).toBeLessThanOrEqual(500);
    expect(result.sources[0]!.excerpt.startsWith("帮我重构一下认证模块")).toBe(true);
    expect(result.sources[0]!.label).toContain("2026-01-15");
  });

  test("a trivial session (too short) is dropped before it ever reaches an excerpt", async () => {
    home = mkdtempSync(path.join(tmpdir(), "codex-history-"));
    const dayDir = path.join(home, "sessions", "2026", "01", "15");
    writeSession(dayDir, "trivial-session", [
      { type: "session_meta", payload: { id: "trivial-session" } },
      { type: "response_item", payload: { role: "user", content: [{ type: "input_text", text: "ls" }] } }
    ]);
    const result = await scanPersonalCodexHistory(home);
    expect(result.sessionCount).toBe(1);
    expect(result.keptCount).toBe(0);
    expect(result.sources).toEqual([]);
  });

  test("a line this reader cannot parse is skipped rather than thrown over the whole session", async () => {
    home = mkdtempSync(path.join(tmpdir(), "codex-history-"));
    const dayDir = path.join(home, "sessions", "2026", "01", "15");
    mkdirSync(dayDir, { recursive: true });
    const longMessage = "讨论一下这个产品的商业模式，" + "细节".repeat(100);
    writeFileSync(path.join(dayDir, "rollout-2026-01-15T12-00-00-mixed.jsonl"),
      ["not valid json {{{", JSON.stringify({ type: "response_item", payload: { role: "user", content: [{ type: "input_text", text: longMessage }] } })].join("\n"), "utf8");
    const result = await scanPersonalCodexHistory(home);
    expect(result.keptCount).toBe(1);
    expect(result.sources[0]!.excerpt).toContain("讨论一下这个产品的商业模式");
  });

  test("caps how many sources it returns even when many sessions qualify", async () => {
    home = mkdtempSync(path.join(tmpdir(), "codex-history-"));
    const dayDir = path.join(home, "sessions", "2026", "01", "15");
    for (let i = 0; i < 5; i += 1) {
      const longMessage = `第${i}个会话的正文内容，` + "细节".repeat(50);
      writeSession(dayDir, `session-${i}`, [
        { type: "response_item", payload: { role: "user", content: [{ type: "input_text", text: longMessage }] } }
      ]);
    }
    const result = await scanPersonalCodexHistory(home, { maxSources: 2 });
    expect(result.sessionCount).toBe(5);
    expect(result.keptCount).toBe(2);
    expect(result.sources).toHaveLength(2);
  });
});
