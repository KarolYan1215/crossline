import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { AGENT_HISTORY_CONSENT, AGENT_HISTORY_SUMMARY, agentHistoryLines, type AgentHistorySummary } from "@crossline/core";
import { CrosslineStore } from "@crossline/db";
import { agentHistoryPass } from "./agent-history";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); delete process.env.CROSSLINE_CODEX_SESSIONS; delete process.env.CROSSLINE_CLAUDE_PROJECTS; });

test("only when and where: two tools' logs become hours per folder, overlapping sessions counted once, nothing of their content kept", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-history-")); dirs.push(root);
  const codex = join(root, "codex", "2026", "10", "08"), claude = join(root, "claude", "C--repo");
  mkdirSync(codex, { recursive: true }); mkdirSync(claude, { recursive: true });
  process.env.CROSSLINE_CODEX_SESSIONS = join(root, "codex"); process.env.CROSSLINE_CLAUDE_PROJECTS = join(root, "claude");
  // Codex: the folder comes from session_meta; events 5 minutes apart join into one 20-minute stretch.
  writeFileSync(join(codex, "rollout-a.jsonl"), [
    `{"timestamp":"2026-10-08T15:00:00.000Z","type":"session_meta","payload":{"cwd":"C:\\\\Users\\\\k\\\\Multi-ID","secret":"SECRET-PROMPT"}}`,
    ...[5, 10, 15, 20].map((minute) => `{"timestamp":"2026-10-08T15:${String(minute).padStart(2, "0")}:00.000Z","type":"event_msg","payload":{"text":"SECRET-PROMPT"}}`)].join("\n"));
  // Claude Code in the same folder at the same time: the person worked those minutes once, not twice.
  writeFileSync(join(claude, "s.jsonl"), [`{"type":"user","cwd":"C:\\\\Users\\\\k\\\\Multi-ID","timestamp":"2026-10-08T15:10:00.000Z","message":{"content":"SECRET-PROMPT"}}`,
    `{"type":"assistant","cwd":"C:\\\\Users\\\\k\\\\Multi-ID","timestamp":"2026-10-08T15:30:00.000Z"}`].join("\n"));
  const store = new CrosslineStore(":memory:");
  store.setSetting("ws-yes", AGENT_HISTORY_CONSENT, "on");
  expect(await agentHistoryPass(store, ["ws-yes", "ws-no"], root, () => "America/Chicago", new Date("2026-10-09T00:00:00Z"))).toBeGreaterThan(0);
  expect(store.getSetting("ws-no", AGENT_HISTORY_SUMMARY)).toBeFalsy();
  const raw = store.getSetting("ws-yes", AGENT_HISTORY_SUMMARY)!;
  expect(raw).not.toContain("SECRET");
  const summary = JSON.parse(raw) as AgentHistorySummary;
  // 15:00–15:20 (codex) ∪ 15:10–15:11 and 15:30–15:31 (claude, 20 minutes apart: two stretches) = 21 minutes.
  expect(summary.folders).toEqual([{ folder: "Multi-ID", minutes: 21, codex: 20, claude: 2, activeDays: 1, lastActive: "2026-10-08" }]);
  expect(summary.byHour[10]).toBe(21);
  expect(agentHistoryLines(summary)[0]).toContain("不用于排程");
  store.close();
});
