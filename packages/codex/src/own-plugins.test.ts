import { expect, test } from "vitest";
import * as codex from "./index";

/**
 * Plugins on a structured run's thread (found on the hosted beta, 2026-10-21): every plugin's MCP servers start per thread, so a run
 * keeps only Crossline's own plugins, by the ids in the runtime's own settings, and changes nothing when the settings hold none of ours.
 */
function runtime(plugins: Record<string, unknown> | undefined) {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  let enabled = false;
  const client = new codex.JsonLineRpcClient((line) => {
    const req = JSON.parse(line);
    requests.push(req);
    let result: unknown = {};
    if (req.method === "skills/list") result = { data: [{ cwd: "C:\\repo", errors: [], skills: [{ name: "crossline:crossline-step-planner", path: "C:\\skill\\SKILL.md", enabled }] }] };
    if (req.method === "skills/config/write") { enabled = req.params.enabled; result = { effectiveEnabled: enabled }; }
    if (req.method === "account/read") result = { account: { type: "chatgpt" }, requiresOpenaiAuth: false };
    if (req.method === "model/list") result = { data: [] };
    if (req.method === "config/read") result = { config: plugins ? { plugins } : {} };
    if (req.method === "thread/start") result = { thread: { id: "thread-1" }, approvalPolicy: "untrusted", sandbox: { type: "readOnly" }, instructionSources: [] };
    if (req.method === "turn/start") {
      result = { turn: { id: "turn-1", status: "inProgress" } };
      setTimeout(() => {
        client.receiveLine(JSON.stringify({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", id: "m", text: "{\"ok\":true}", phase: "final_answer" } } }));
        client.receiveLine(JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [], error: null } } }));
      }, 0);
    }
    queueMicrotask(() => client.receiveLine(JSON.stringify({ id: req.id, result })));
  });
  return { client, requests };
}

const run = (client: codex.CodexRpcBoundary, extra: Partial<codex.SkillRunOptions<unknown>> = {}) => codex.runCodexSkill(client, { task: "x" }, {
  skillName: "crossline:crossline-step-planner", cwd: "C:\\repo", developerInstructions: "Plan.", outputSchema: { type: "object" },
  prepareInput: (value) => value, validateOutput: (output) => output, onAudit: () => {}, ...extra });
const pluginKeys = (requests: Array<{ method: string; params: Record<string, unknown> }>) =>
  Object.keys(requests.find((request) => request.method === "thread/start")!.params.config as Record<string, unknown>).filter((key) => key.startsWith("plugins."));

// As the hosted owner's runtime has them (2026-10-21): installing a plugin writes it enabled; OpenAI's remote plugins are not listed here.
const configured = { "crossline@crossline-local": { enabled: true }, "crossline-mine@crossline-library": { enabled: true },
  "crossline-public@crossline-library": { enabled: false }, "someone-else@elsewhere": { enabled: true } };

test("a structured run turns every plugin off but Crossline's own that the runtime's settings switch on", async () => {
  const fake = runtime(configured);
  expect((await run(fake.client)).ok).toBe(true);
  const config = fake.requests.find((request) => request.method === "thread/start")!.params.config as Record<string, unknown>;
  expect(config["plugins._default.enabled"]).toBe(false);
  expect(config["plugins.crossline@crossline-local.enabled"]).toBe(true);
  expect(config["plugins.crossline-mine@crossline-library.enabled"]).toBe(true);
  // Switched off, or not ours: no line of its own, so the default keeps it off.
  expect(pluginKeys(fake.requests)).toEqual(["plugins._default.enabled", "plugins.crossline-mine@crossline-library.enabled", "plugins.crossline@crossline-local.enabled"]);
  expect(codex.ownPluginsIn({ plugins: configured })).toEqual(["crossline-mine@crossline-library", "crossline@crossline-local"]);
});

test("nothing is changed when the settings hold none of ours, a named library plugin is missing, or the run uses connectors or images", async () => {
  for (const plugins of [undefined, { "someone-else@elsewhere": { enabled: true } }, { "crossline@crossline-local": { enabled: false } }]) {
    const fake = runtime(plugins);
    expect((await run(fake.client)).ok).toBe(true);
    expect(pluginKeys(fake.requests)).toEqual([]);
  }
  // A library skill whose plugin is not switched on would be turned off with the rest: the run keeps every plugin.
  expect(codex.onlyOwnPlugins(["crossline@crossline-local"], ["crossline:crossline-step-planner", "crossline-public:deck"])).toEqual({});
  expect(codex.onlyOwnPlugins(["crossline@crossline-local", "crossline-public@crossline-library"], ["crossline:crossline-step-planner", "crossline-public:deck"]))
    .toEqual({ "plugins._default.enabled": false, "plugins.crossline@crossline-local.enabled": true, "plugins.crossline-public@crossline-library.enabled": true });
  const images = runtime(configured);
  await run(images.client, { allowImageGeneration: true, onImage: () => {} });
  expect(pluginKeys(images.requests)).toEqual([]);
});
