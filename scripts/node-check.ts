/**
 * The compute node against the real Codex runtime on this machine (docs/compute-node.md), without the hosted site and without the
 * person's login: a hub and a node agent in one process, the node's app-server in a throwaway CODEX_HOME. It checks what the unit tests
 * fake: that the Crossline plugin installs from the mirrored directory and its skills are found, and that a thread opens with the
 * server's paths mapped. No model is called (no turn is sent), so no quota is spent.
 *
 *   pnpm exec tsx scripts/node-check.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { installLocalPlugin, spawnAppServerLines } from "../packages/codex/src/index";
import { startNodeAgent } from "../apps/worker/src/node/agent";
import { createNodeHub, readDirectory } from "../apps/worker/src/node/hub";
import { REQUIRED_SKILLS } from "../apps/worker/src/required-skills";

const repo = path.resolve(import.meta.dirname, "..");
const SERVER_ROOT = "/repo/skills/marketplace";
const work = mkdtempSync(path.join(tmpdir(), "crossline-node-check-"));
const home = path.join(work, "codex-home");
const started = Date.now();
const say = (step: string, detail: unknown = "") => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${step}`, detail);

const version = await new Promise<string>((resolve) => {
  const probe = spawnAppServerLines(home);
  probe.onLine((line) => { const message = JSON.parse(line) as { id?: unknown; result?: { userAgent?: string } }; if (message.id === 1) { resolve(message.result?.userAgent ?? ""); probe.stop(); } });
  probe.write(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "crossline", title: "Crossline", version: "0.1.0" }, capabilities: { experimentalApi: true } } }));
});
say("runtime", version);

let installed: string[] = [];
const hub = await createNodeHub({
  port: 0,
  authenticate: () => "ws-check",
  allowed: () => true,
  roots: () => [SERVER_ROOT],
  gateway: () => undefined,
  serverCodex: () => version,
  readTree: (dir) => dir === SERVER_ROOT ? readDirectory(path.join(repo, "skills", "marketplace")) : [],
  prepare: async (client) => {
    installed = await installLocalPlugin(client, { name: "crossline", marketplacePath: `${SERVER_ROOT}/.agents/plugins/marketplace.json`, cwd: "/repo", requiredSkills: REQUIRED_SKILLS });
  },
  log: (event) => say(String(event.type), event)
});
const agent = startNodeAgent({ url: `http://127.0.0.1:${hub.port}`, token: "x".repeat(24), dir: path.join(work, "node"), spawn: () => spawnAppServerLines(home) });

let failed = false;
try {
  const deadline = Date.now() + 120_000;
  while (!hub.clientFor("ws-check")) {
    if (Date.now() > deadline) throw new Error(`node never became ready: ${JSON.stringify(hub.status("ws-check"))}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const missing = REQUIRED_SKILLS.filter((name) => !installed.includes(name));
  say("plugin installed through the mirror", { skills: installed.length, missing });
  if (missing.length) failed = true;
  const client = hub.clientFor("ws-check")!;
  const thread = await client.request("thread/start", { cwd: "/repo", sandbox: "read-only", approvalPolicy: "untrusted", ephemeral: true, experimentalRawEvents: false }) as { thread?: { id?: string; cwd?: string } };
  say("thread opened on the node", { id: thread.thread?.id, cwd: (thread as { cwd?: string }).cwd ?? thread.thread?.cwd });
  if (!thread.thread?.id) failed = true;
  const refused = await client.request("thread/start", { cwd: "/repo", sandbox: "danger-full-access" }).then(() => "accepted", (error: Error) => error.message);
  say("full access refused by the node", refused);
  if (!/NODE_SHELL_REFUSED/.test(refused)) failed = true;
} catch (error) {
  failed = true;
  say("failed", error instanceof Error ? error.message : error);
} finally {
  agent.stop();
  await hub.close();
  await new Promise((resolve) => setTimeout(resolve, 500));
  rmSync(work, { recursive: true, force: true });
}
say(failed ? "FAILED" : "ok");
process.exit(failed ? 1 : 0);
