import { expect, test } from "vitest";
import * as codex from "./index";
import { repairJsonBrackets } from "./json-repair";

// The shape of the portrait writer's answer, cut down: nested objects, arrays of objects, keys that recur at different depths.
const obj = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const SCHEMA = obj({
  cover: obj({ portrait: { type: "string" } }),
  insights: { type: "array", items: obj({ insight: { type: "string" }, impact: { type: "integer" } }) },
  type: obj({ lines: { type: "integer" }, evidence: obj({ lines: { type: "string" } }), summary: { type: "string" } }),
  formulation: obj({ summary: { type: "string" }, drivers: { type: "array", items: { type: "string" } } }),
  careers: { type: "array", items: obj({ title: { type: "string" } }) },
  sensitive: { type: "array", items: { type: "string" } }
});
const WHOLE = { cover: { portrait: "她{先}做研究]" }, insights: [{ insight: "看\"见\"", impact: 3 }], type: { lines: 60, evidence: { lines: "两条线" }, summary: "你" },
  formulation: { summary: "s", drivers: ["a", "b"] }, careers: [{ title: "研究员" }], sensitive: ["x"] };

test("a stray closer that would end the answer early is dropped (the first recorded failure: insights closed, then the root)", () => {
  const broken = JSON.stringify(WHOLE).replace("\"impact\":3}]", "\"impact\":3}]}");
  expect(() => JSON.parse(broken)).toThrow();
  expect(JSON.parse(repairJsonBrackets(broken, SCHEMA)!)).toEqual(WHOLE);
});

test("a key the open object lacks but an enclosing one has closes the object left open (the second: one brace missing)", () => {
  const broken = JSON.stringify(WHOLE).replace("\"drivers\":[\"a\",\"b\"]}", "\"drivers\":[\"a\",\"b\"]");
  expect(() => JSON.parse(broken)).toThrow();
  expect(JSON.parse(repairJsonBrackets(broken, SCHEMA)!)).toEqual(WHOLE);
  // A key that recurs deeper is not mistaken for one further out: `lines` inside `type.evidence` stays there.
  const deep = JSON.stringify(WHOLE).replace("\"lines\":\"两条线\"}", "\"lines\":\"两条线\"");
  expect(JSON.parse(repairJsonBrackets(deep, SCHEMA)!)).toEqual(WHOLE);
});

test("the root's own last brace missing is added; a closer of the wrong kind closes what it skipped", () => {
  const whole = JSON.stringify(WHOLE);
  expect(JSON.parse(repairJsonBrackets(whole.slice(0, -1), SCHEMA)!)).toEqual(WHOLE);
  const wrongKind = whole.replace("\"title\":\"研究员\"}]", "\"title\":\"研究员\"]");
  expect(JSON.parse(repairJsonBrackets(wrongKind, SCHEMA)!)).toEqual(WHOLE);
});

test("nothing is mended that is whole, cut off, or more than a few brackets wrong; brackets inside strings are text", () => {
  const whole = JSON.stringify(WHOLE);
  expect(repairJsonBrackets(whole, SCHEMA)).toBeUndefined();
  // Cut off mid-string, after a comma, or with several levels open: a partial answer is not passed off as whole.
  expect(repairJsonBrackets(whole.slice(0, whole.indexOf("研究员") + 1), SCHEMA)).toBeUndefined();
  expect(repairJsonBrackets(whole.slice(0, whole.indexOf(",\"sensitive\"") + 1), SCHEMA)).toBeUndefined();
  expect(repairJsonBrackets(whole.slice(0, whole.indexOf("\"title\":\"研究员\"}") + 14), SCHEMA)).toBeUndefined();
  // A second answer after the first is not glued on.
  expect(repairJsonBrackets(`${whole}${whole}`, SCHEMA)).toBeUndefined();
  expect(repairJsonBrackets(`${whole.slice(0, -1)}}}}}}}}`, SCHEMA)).toBeUndefined();
});

function runtime(answer: string) {
  const turns: number[] = [];
  const client = new codex.JsonLineRpcClient((line) => {
    const req = JSON.parse(line);
    let result: unknown = {};
    if (req.method === "skills/list") result = { data: [{ cwd: "C:\\repo", errors: [], skills: [{ name: "crossline:crossline-portrait-writer", path: "C:\\skill\\SKILL.md", enabled: true }] }] };
    if (req.method === "account/read") result = { account: { type: "chatgpt" }, requiresOpenaiAuth: false };
    if (req.method === "model/list") result = { data: [] };
    if (req.method === "config/read") result = { config: {} };
    if (req.method === "thread/start") result = { thread: { id: "thread-1" }, approvalPolicy: "untrusted", sandbox: { type: "readOnly" }, instructionSources: [] };
    if (req.method === "turn/start") {
      turns.push(1);
      const id = `turn-${turns.length}`;
      result = { turn: { id, status: "inProgress" } };
      setTimeout(() => {
        client.receiveLine(JSON.stringify({ method: "item/completed", params: { threadId: "thread-1", turnId: id, item: { type: "agentMessage", id: "m", text: answer, phase: "final_answer" } } }));
        client.receiveLine(JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id, status: "completed", items: [], error: null } } }));
      }, 0);
    }
    queueMicrotask(() => client.receiveLine(JSON.stringify({ id: req.id, result })));
  });
  return { client, turns };
}

test("the runner takes a mended answer in the same turn and still validates it; an answer past mending is refused as before", async () => {
  const run = (answer: string, validate: (output: unknown) => unknown = (output) => output) => {
    const fake = runtime(answer);
    return codex.runCodexSkill(fake.client, { task: "x" }, { skillName: "crossline:crossline-portrait-writer", cwd: "C:\\repo", developerInstructions: "Write.",
      outputSchema: SCHEMA, prepareInput: (value) => value, validateOutput: validate, onAudit: () => {} }).then((result) => ({ result, turns: fake.turns.length }));
  };
  const mended = await run(JSON.stringify(WHOLE).replace("\"impact\":3}]", "\"impact\":3}]}"));
  expect(mended.result.ok && mended.result.output).toEqual(WHOLE);
  expect(mended.turns).toBe(1);
  const refused = await run(JSON.stringify(WHOLE).replace("\"impact\":3}]", "\"impact\":3}]}"), () => { throw new Error("PORTRAIT_EMPTY"); });
  expect(refused.result.ok).toBe(false);
  const cut = await run(JSON.stringify(WHOLE).slice(0, 40));
  expect(!cut.result.ok && cut.result.blocker.code).toBe("SKILL_SCHEMA_INVALID");
});
