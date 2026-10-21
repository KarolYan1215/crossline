import { expect, test } from "vitest";
import * as codex from "./index";

/**
 * Plugins on a structured run's thread (found on the hosted beta, 2026-10-21): every plugin's MCP servers start per thread, so a run
 * keeps only Crossline's own plugins, by the ids the runtime lists, and changes nothing when the runtime cannot list them.
 */
function runtime(installed: unknown | Error) {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  let enabled = false;
  const client = new codex.JsonLineRpcClient((line) => {
    const req = JSON.parse(line);
    requests.push(req);
    let result: unknown = {};
    if (req.method === "plugin/installed" && installed instanceof Error) {
      queueMicrotask(() => client.receiveLine(JSON.stringify({ id: req.id, error: { code: -32601, message: installed.message } })));
      return;
    }
    if (req.method === "plugin/installed") result = installed;
    if (req.method === "skills/list") result = { data: [{ cwd: "C:\\repo", errors: [], skills: [{ name: "crossline:crossline-step-planner", path: "C:\\skill\\SKILL.md", enabled }] }] };
    if (req.method === "skills/config/write") { enabled = req.params.enabled; result = { effectiveEnabled: enabled }; }
    if (req.method === "account/read") result = { account: { type: "chatgpt" }, requiresOpenaiAuth: false };
    if (req.method === "model/list") result = { data: [] };
    if (req.method === "config/read") result = { config: {} };
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
const threadConfig = (requests: Array<{ method: string; params: Record<string, unknown> }>) =>
  requests.find((request) => request.method === "thread/start")!.params.config as Record<string, unknown>;

const listed = { marketplaces: [
  { name: "crossline-local", plugins: [{ id: "crossline@crossline-local", installed: true, enabled: true }] },
  { name: "crossline-library", plugins: [{ id: "crossline-mine@crossline-library", installed: true, enabled: true }, { id: "crossline-public@crossline-library", installed: false, enabled: false }] },
  { name: "openai-curated-remote", plugins: [{ id: "codex-security@openai-curated-remote", installed: true, enabled: true }] }
] };

test("a structured run turns every plugin off but Crossline's own, by the ids the runtime lists", async () => {
  const fake = runtime(listed);
  expect((await run(fake.client)).ok).toBe(true);
  const config = threadConfig(fake.requests);
  expect(config["plugins._default.enabled"]).toBe(false);
  expect(config["plugins.crossline@crossline-local.enabled"]).toBe(true);
  expect(config["plugins.crossline-mine@crossline-library.enabled"]).toBe(true);
  // Not installed, or not ours: no line of its own, so the default keeps it off.
  expect(Object.keys(config).filter((key) => key.startsWith("plugins."))).toEqual(["plugins._default.enabled",
    "plugins.crossline-mine@crossline-library.enabled", "plugins.crossline@crossline-local.enabled"]);
  // Asked with the run's folder, where a marketplace may be found by its location.
  expect(fake.requests.find((request) => request.method === "plugin/installed")!.params).toEqual({ cwds: ["C:\\repo"] });
  // The list is kept: a second run does not ask again.
  expect((await run(fake.client)).ok).toBe(true);
  expect(fake.requests.filter((request) => request.method === "plugin/installed")).toHaveLength(1);
  // An install makes the next run list them again.
  codex.forgetOwnPlugins(fake.client);
  await run(fake.client);
  expect(fake.requests.filter((request) => request.method === "plugin/installed")).toHaveLength(2);
});

test("nothing is changed when the runtime cannot list its plugins, lists none of ours, or the run uses connectors or images", async () => {
  for (const installed of [new Error("Method not found"), { marketplaces: [listed.marketplaces[2]] }, {}]) {
    const fake = runtime(installed);
    expect((await run(fake.client)).ok).toBe(true);
    expect(Object.keys(threadConfig(fake.requests)).some((key) => key.startsWith("plugins."))).toBe(false);
  }
  // A library skill whose plugin the list does not hold would be turned off with the rest: the run keeps every plugin.
  expect(codex.onlyOwnPlugins(["crossline@crossline-local"], ["crossline:crossline-step-planner", "crossline-public:deck"])).toEqual({});
  expect(codex.onlyOwnPlugins(["crossline@crossline-local", "crossline-public@crossline-library"], ["crossline:crossline-step-planner", "crossline-public:deck"]))
    .toEqual({ "plugins._default.enabled": false, "plugins.crossline@crossline-local.enabled": true, "plugins.crossline-public@crossline-library.enabled": true });
  const images = runtime(listed);
  await run(images.client, { allowImageGeneration: true, onImage: () => {} });
  expect(images.requests.some((request) => request.method === "plugin/installed")).toBe(false);
  expect(Object.keys(threadConfig(images.requests)).some((key) => key.startsWith("plugins."))).toBe(false);
});
