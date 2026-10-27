import { afterEach, expect, test } from "vitest";
import * as codex from "./index";
import type { ProviderConfig, ProviderRouting } from "./providers";

/**
 * Optional lookups (docs/context-selection.md): the step planner's `search_material`/`read_chunk` are offered where the model calls
 * functions — the account's own Codex, or a provider whose conformance record shows it calling one — and elsewhere left out, with the
 * input replaced by the passages code picked.
 */
function runtime() {
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

const tools: codex.SkillTools = { specs: [{ name: "search_material", description: "Search the files.", inputSchema: { type: "object", properties: {} } }], call: () => "c1" };

async function run(client: codex.CodexRpcBoundary) {
  const modes: string[] = [];
  const result = await codex.runCodexSkill(client, { materials: { passages: ["top"], candidates: ["c2"] } }, {
    skillName: "crossline:crossline-step-planner", cwd: "C:\\repo", developerInstructions: "Plan.", outputSchema: { type: "object" },
    prepareInput: (value) => value, validateOutput: (output) => output, onAudit: () => {},
    optionalTools: { tools, instructions: "Read candidates with read_chunk.", onMode: (mode) => modes.push(mode),
      withoutTools: (value) => ({ ...(value as object), materials: { passages: ["picked in full"] } }) } });
  return { result, modes };
}

const provider: ProviderConfig = { id: "sf", kind: "chat", label: "SiliconFlow", baseUrl: "https://api.siliconflow.cn/v1", model: "glm", keyLast4: "abcd",
  updatedAt: "2026-10-20T00:00:00.000Z" };
const routing = (functionCalls: boolean): ProviderRouting => ({ provider, gatewayUrl: "http://127.0.0.1:5555/x", admitted: new Set(["crossline-step-planner"]),
  codexSignedIn: false, functionCalls });
afterEach(() => codex.setProviderResolver(undefined));

test("on the account's own Codex the lookups are declared and the candidate list is sent as it is", async () => {
  const fake = runtime();
  const { result, modes } = await run(fake.client);
  expect(result.ok).toBe(true);
  expect(modes).toEqual(["tools"]);
  const start = fake.requests.find((request) => request.method === "thread/start")!.params;
  expect((start.dynamicTools as Array<{ name: string }>).map((tool) => tool.name)).toEqual(["search_material"]);
  expect(String(start.developerInstructions)).toContain("Read candidates with read_chunk.");
  expect(JSON.stringify(fake.requests.find((request) => request.method === "turn/start")!.params.input)).toContain("candidates");
});

test("a provider that has not shown it calls functions gets no lookups and the passages code picked, in full", async () => {
  codex.setProviderResolver(() => routing(false));
  const fake = runtime();
  const { modes } = await run(fake.client);
  expect(modes).toEqual(["fallback"]);
  const start = fake.requests.find((request) => request.method === "thread/start")!.params;
  expect(start.dynamicTools).toEqual([]);
  expect(String(start.developerInstructions)).not.toContain("read_chunk");
  const input = JSON.stringify(fake.requests.find((request) => request.method === "turn/start")!.params.input);
  expect(input).toContain("picked in full");
  expect(input).not.toContain("candidates");
});

test("a provider whose record shows function calls gets the lookups", async () => {
  codex.setProviderResolver(() => routing(true));
  const fake = runtime();
  const { modes } = await run(fake.client);
  expect(modes).toEqual(["tools"]);
  expect((fake.requests.find((request) => request.method === "thread/start")!.params.dynamicTools as unknown[]).length).toBe(1);
});
