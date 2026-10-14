/**
 * Probes for R7 (docs/review-2026-10-13.md §7.5): can a provider other than ChatGPT drive a real structured Skill turn through the same
 * Codex app-server path the app uses?
 *
 *   pnpm exec tsx scripts/provider-probe.ts [chat|responses|thread-config|all]
 *
 * Real runs, no fakes: a throwaway CODEX_HOME per probe, the pinned Codex binary (`CROSSLINE_CODEX_PATH`, else the fork in vendor/),
 * the Crossline plugin installed, and the real `crossline-task-titler` Skill with its real schema and validator.
 *
 *  - chat:          a Chat-Completions-only endpoint behind the local bridge (`chat-bridge.ts`). Default upstream is the local Ollama's
 *                   `/v1/chat/completions`; set PROBE_CHAT_BASE_URL (+ PROBE_CHAT_KEY_ENV naming the env var that holds the key) for
 *                   another one. The key is never read by this script, only handed to Codex by name.
 *  - responses:     a native Responses endpoint with no bridge. Default is the local Ollama's `/v1/responses`; PROBE_RESPONSES_BASE_URL
 *                   and PROBE_RESPONSES_KEY_ENV for another.
 *  - thread-config: whether `model_providers.<id>` given in `thread/start.config` (not in config.toml) takes effect.
 *
 * Model: PROBE_MODEL (default `qwen3:8b`).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TASK_TITLES_SCHEMA, validateTaskTitles, type TaskTitles } from "../packages/core/src/index";
import { runCodexSkill, setUsageSink, startCodexAppServer, startCodexSupervisor, type CodexRpcBoundary, type SkillUsage } from "../packages/codex/src/index";
import { startChatBridge } from "../packages/codex/src/chat-bridge";

const repoRoot = path.resolve(import.meta.dirname, "..");
const which = process.argv[2] ?? "all";
const model = process.env.PROBE_MODEL ?? "qwen3:8b";
process.env.CROSSLINE_CODEX_PATH ??= path.resolve(repoRoot, "../../../vendor/codex/codex-rs/target/debug/codex.exe");
for (const tier of ["TOP", "MID", "LOW"]) process.env[`CROSSLINE_MODEL_${tier}`] = model;

const usage: SkillUsage[] = [];
setUsageSink((item) => { usage.push(item); });

const tasks = [
  { id: "t1", intent: "把 ECE 555 第 6 讲的讲义读完，整理成一页笔记，周四组会前带去", project: "ECE 555" },
  { id: "t2", intent: "给西湖合作的师兄发邮件确认 10 月 8 日的数据能不能按时到", project: "NeuroSim 合作" }
];

/** Codex's background memory runs default to an OpenAI model; on another provider they must use that provider's model. */
const memoryToml = `[memories]
extract_model = "${model}"
consolidation_model = "${model}"

`;
function providerToml(id: string, baseUrl: string, envKey?: string): string {
  return [memoryToml + `[model_providers.${id}]`, `name = "${id}"`, `base_url = "${baseUrl}"`, `wire_api = "responses"`,
    `requires_openai_auth = false`, `supports_websockets = false`, ...(envKey ? [`env_key = "${envKey}"`] : []), ""].join("\n");
}

async function withRuntime<T>(label: string, configToml: string, work: (client: CodexRpcBoundary) => Promise<T>): Promise<T> {
  const home = mkdtempSync(path.join(tmpdir(), `crossline-probe-${label}-`));
  writeFileSync(path.join(home, "config.toml"), configToml, "utf8");
  const supervisor = await startCodexSupervisor({
    port: 3390 + Math.floor(Math.random() * 8),
    sidecarFactory: () => startCodexAppServer(home),
    plugin: { name: "crossline", marketplacePath: path.join(repoRoot, "skills", "marketplace", ".agents", "plugins", "marketplace.json"),
      cwd: repoRoot, requiredSkills: ["crossline:crossline-task-titler"] }
  });
  try { return await work(supervisor.client); } finally { await supervisor.stop(); }
}

async function titlerTurn(client: CodexRpcBoundary): Promise<unknown> {
  const context = { version: "crossline.task-titles.v1", tasks };
  const started = Date.now();
  const result = await runCodexSkill<TaskTitles>(client, context, { skillName: "crossline:crossline-task-titler", cwd: repoRoot,
    developerInstructions: "Name each task as the Skill describes. Return raw JSON only.", outputSchema: TASK_TITLES_SCHEMA, prepareInput: () => context,
    validateOutput: (output) => validateTaskTitles(output, tasks.map((task) => task.id)), onAudit: () => {}, timeoutMs: 15 * 60_000 });
  return { seconds: Math.round((Date.now() - started) / 1000), ...result, usage: usage.at(-1) };
}

const results: Record<string, unknown> = {};

if (which === "chat" || which === "all") {
  const upstreamBase = process.env.PROBE_CHAT_BASE_URL ?? "http://127.0.0.1:11434/v1";
  const seen: string[][] = [];
  const bridge = await startChatBridge({ upstreams: (id) => id === "probe" ? { baseUrl: upstreamBase,
    responseFormat: process.env.PROBE_CHAT_FORMAT === "json_object" ? "json_object" : "json_schema" } : undefined,
    onDropped: (_, dropped) => seen.push(dropped) });
  try {
    results.chat = await withRuntime("chat", `model_provider = "probe"\nmodel = "${model}"\n\n${providerToml("probe", bridge.url("probe"), process.env.PROBE_CHAT_KEY_ENV)}`, titlerTurn);
    (results.chat as Record<string, unknown>).droppedByBridge = [...new Set(seen.flat())];
  } finally { await bridge.close(); }
  console.info(JSON.stringify({ probe: "chat", upstreamBase, result: results.chat }, null, 2));
}

if (which === "responses" || which === "all") {
  const base = process.env.PROBE_RESPONSES_BASE_URL ?? "http://127.0.0.1:11434/v1";
  results.responses = await withRuntime("responses", `model_provider = "probe"\nmodel = "${model}"\n\n${providerToml("probe", base, process.env.PROBE_RESPONSES_KEY_ENV)}`, titlerTurn);
  console.info(JSON.stringify({ probe: "responses", base, result: results.responses }, null, 2));
}

if (which === "thread-config" || which === "all") {
  // config.toml names no custom provider; thread/start brings it. A request reaching the bridge proves the per-thread definition took effect.
  let hits = 0;
  const bridge = await startChatBridge({ upstreams: (id) => { if (id === "perthread") { hits += 1; return { baseUrl: "http://127.0.0.1:11434/v1" }; } return undefined; } });
  try {
    results.threadConfig = await withRuntime("thread-config", "", async (client) => {
      const answer: Record<string, unknown> = {};
      try {
        const started = await client.request("thread/start", { ephemeral: true, sandbox: "read-only", approvalPolicy: "never", model, modelProvider: "perthread",
          config: { "model_providers.perthread": { name: "perthread", base_url: bridge.url("perthread"), wire_api: "responses", requires_openai_auth: false, supports_websockets: false } } }) as Record<string, unknown>;
        answer.threadStart = { modelProvider: started.modelProvider, model: started.model };
        const threadId = (started.thread as { id: string }).id;
        const done = new Promise<unknown>((resolve) => client.onNotification((message) => {
          const params = message.params as Record<string, unknown> | undefined;
          if (message.method === "turn/completed" && params?.threadId === threadId) resolve((params.turn as Record<string, unknown>)?.status);
        }));
        await client.request("turn/start", { threadId, input: [{ type: "text", text: "Reply with the single word ok.", text_elements: [] }] });
        answer.turnStatus = await Promise.race([done, new Promise((resolve) => setTimeout(() => resolve("timeout"), 5 * 60_000))]);
      } catch (error) { answer.error = error instanceof Error ? error.message : JSON.stringify(error); }
      answer.bridgeRequests = hits;
      return answer;
    });
  } finally { await bridge.close(); }
  console.info(JSON.stringify({ probe: "thread-config", result: results.threadConfig }, null, 2));
}
process.exit(0);
