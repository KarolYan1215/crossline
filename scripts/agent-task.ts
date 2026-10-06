/**
 * Runs one assistant task for real, against a throwaway ledger, and prints what happened.
 *
 *   pnpm exec tsx scripts/agent-task.ts "<title>" "<what to do>" <category> "<the part the person does>" [input path ...]
 *
 * The first run of a kind of work needs the person's approval; this script gives it (`--approve`) because it exists to test the
 * runtime, not to stand in for the person. The worker must be stopped first (the two would share one Codex home).
 *
 * Checks printed at the end are the ones that matter for trust: the thread really had a shell and the approval hook, the guard
 * answered what the runtime asked, the assistant's artifacts exist, and the originals were not touched.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startCodexSupervisor } from "../packages/codex/src/index";
import { CrosslineStore } from "../packages/db/src/index";
import { AGENT_CATEGORIES, AGENT_SKILL, approveCategory, createAgentRunner, type AgentCategory } from "../apps/worker/src/agent-task";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2).filter((arg) => arg !== "--approve");
const [title, what, category, humanPart, ...inputs] = args;
if (!title || !what || !category || !humanPart || !(category in AGENT_CATEGORIES)) {
  console.error(`usage: agent-task.ts "<title>" "<what>" <${Object.keys(AGENT_CATEGORIES).join("|")}> "<human part>" [inputs...]`);
  process.exit(2);
}

const store = new CrosslineStore(path.join(mkdtempSync(path.join(tmpdir(), "crossline-agent-ledger-")), "crossline.db"));
const workspaceId = store.createPrincipalWithWorkspace("agent-check", "agent check").workspace.id;
approveCategory(store, workspaceId, category as AgentCategory);

const supervisor = await startCodexSupervisor({
  port: Number(process.env.CROSSLINE_CODEX_SUPERVISOR_PORT ?? 3399),
  plugin: {
    name: "crossline",
    marketplacePath: path.join(repoRoot, "skills", "marketplace", ".agents", "plugins", "marketplace.json"),
    cwd: repoRoot,
    requiredSkills: [AGENT_SKILL]
  }
});
const outputRoot = process.env.CROSSLINE_AI_OUTPUT_DIR ?? path.join(tmpdir(), "crossline-ai-output");
const asked: string[] = [];
try {
  const run = createAgentRunner(store, workspaceId, repoRoot, () => supervisor.client, {
    outputRoot, ask: async (request) => { asked.push(`${request.rule}: ${request.subject.slice(0, 120)}`); return false; }
  });
  const started = Date.now();
  const outcome = await run({ title, what, category: category as AgentCategory, humanPart, inputs });
  console.info(JSON.stringify({ seconds: Math.round((Date.now() - started) / 1000), outputRoot, outcome: outcome.state === "done" ? {
    state: outcome.state, directory: outcome.directory, summary: outcome.summary, artifacts: outcome.artifacts.map((a) => `${a.path} (${a.bytes} B)`),
    commands: outcome.audit.commands.length, filesChanged: outcome.audit.filesChanged.length, searches: outcome.audit.searches.length,
    declined: outcome.audit.decisions.map((d) => `${d.rule}: ${d.subject.slice(0, 100)}`), askedPerson: asked,
    inputsModified: outcome.inputsModified, checksPassed: outcome.checksPassed, reviewRequired: outcome.reviewRequired
  } : outcome }, null, 2));
  if (outcome.state === "done") {
    console.info(JSON.stringify({ firstCommands: outcome.audit.commands.slice(0, 12).map((c) => `${c.exitCode}  ${c.command.slice(0, 140)}`) }, null, 2));
  }
} finally {
  await supervisor.stop();
  store.close();
}
