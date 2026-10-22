import { expect, test } from "vitest";
import * as codex from "./index";

/**
 * Codex memory off for every run, and a fresh run's first message ordered for the prompt cache (docs/token-economy.md §1–2, the owner's
 * decisions of 2026-10-21).
 */
function runtime() {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  let enabled = false;
  const client = new codex.JsonLineRpcClient((line) => {
    const req = JSON.parse(line);
    requests.push(req);
    let result: unknown = {};
    if (req.method === "skills/list") result = { data: [{ cwd: "C:\\repo", errors: [], skills: [
      { name: "crossline:crossline-step-planner", path: "C:\\skill\\SKILL.md", enabled },
      { name: "crossline-mine:research", path: "C:\\mine\\SKILL.md", enabled: false }] }] };
    if (req.method === "skills/config/write") { if (req.params.path === "C:\\skill\\SKILL.md") enabled = req.params.enabled; result = { effectiveEnabled: req.params.enabled }; }
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

test("a structured run's thread neither generates nor uses Codex memory", async () => {
  const fake = runtime();
  const result = await codex.runCodexSkill(fake.client, { task: "x" }, { skillName: "crossline:crossline-step-planner", cwd: "C:\\repo",
    developerInstructions: "Plan.", outputSchema: { type: "object" }, prepareInput: (value) => value, validateOutput: (output) => output, onAudit: () => {} });
  expect(result.ok).toBe(true);
  const config = fake.requests.find((request) => request.method === "thread/start")!.params.config as Record<string, unknown>;
  expect(config).toMatchObject({ "memories.use_memories": false, "memories.generate_memories": false, "features.memories": false });
});

test("the first message carries the Skill and the input with its stable keys first, then the library skills and the run note", async () => {
  const fake = runtime();
  const input = { version: "v1", today: "2026-10-21", task: { title: "作业 2" }, profile: ["上午精力最好"], archetypes: ["problem_set"] };
  await codex.runCodexSkill(fake.client, input, { skillName: "crossline:crossline-step-planner", cwd: "C:\\repo", developerInstructions: "Plan.",
    stableKeys: ["version", "archetypes", "profile", "missing"], runNote: " Apply the feedback. ", extraSkills: ["crossline-mine:research"],
    outputSchema: { type: "object" }, prepareInput: (value) => value, validateOutput: (output) => output, onAudit: () => {} });
  const start = fake.requests.find((request) => request.method === "thread/start")!.params;
  // The developer instructions are the same for every run of the Skill: the note is not in them.
  expect(String(start.developerInstructions)).toBe(`Plan.\n\n${codex.STYLE_INSTRUCTIONS}`);
  const parts = (fake.requests.find((request) => request.method === "turn/start")!.params.input as Array<{ text: string }>).map((item) => item.text);
  expect(parts).toEqual([
    `$crossline:crossline-step-planner\n\n${JSON.stringify({ version: "v1", archetypes: ["problem_set"], profile: ["上午精力最好"], today: "2026-10-21", task: { title: "作业 2" } })}`,
    "$crossline-mine:research",
    `${codex.RUN_NOTE_LEAD}\nApply the feedback.`]);
  // Nothing is added or left out, only moved; with no stable keys and no note the message is as it was.
  expect(codex.cacheOrderedInput(input, ["archetypes"])).toEqual(input);
  expect(codex.firstPromptTexts("s", [], [1, 2], { stableKeys: ["x"] })).toEqual(["$s\n\n[1,2]"]);
});
