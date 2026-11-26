import { expect, test, vi } from "vitest";
import * as codex from "./index";
import { looksLooping, mergeSplitObjects, repairJsonBrackets } from "./json-repair";

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

test("a quote inside a text left unescaped is escaped; one the JSON can go on after still ends the text", () => {
  const whole = JSON.stringify(WHOLE);
  // 「他说"好"就走了」 written with bare quotes, in a value and next to a missing brace.
  const quoted = whole.replace("\"portrait\":\"她{先}做研究]\"", "\"portrait\":\"她说\"好\"就{先}做研究]\"");
  expect(() => JSON.parse(quoted)).toThrow();
  expect(JSON.parse(repairJsonBrackets(quoted, SCHEMA)!).cover.portrait).toBe("她说\"好\"就{先}做研究]");
  const both = quoted.replace("\"drivers\":[\"a\",\"b\"]}", "\"drivers\":[\"a\",\"b\"]");
  expect(JSON.parse(repairJsonBrackets(both, SCHEMA)!).formulation).toEqual(WHOLE.formulation);
  // A quote followed by a comma reads as the end of the text: not mended, refused as before.
  expect(repairJsonBrackets(whole.replace("\"insight\":\"看\\\"见\\\"\"", "\"insight\":\"看\"见\",了\""), SCHEMA)).toBeUndefined();
  // Escaped quotes are left as they came.
  expect(repairJsonBrackets(whole, SCHEMA)).toBeUndefined();
});

test("slips that change no word are mended: raw line breaks, stray backslashes, trailing commas, a sentence around the object", () => {
  const whole = JSON.stringify(WHOLE);
  const raw = whole.replace("\"summary\":\"s\"", "\"summary\":\"第一行\n第二行\t完\"");
  expect(JSON.parse(repairJsonBrackets(raw, SCHEMA)!).formulation.summary).toBe("第一行\n第二行\t完");
  const slash = whole.replace("\"summary\":\"s\"", "\"summary\":\"C:\\Users\\x 和 \\'引\\'\"");
  expect(JSON.parse(repairJsonBrackets(slash, SCHEMA)!).formulation.summary).toBe("C:\\Users\\x 和 \\'引\\'");
  const commas = whole.replace("\"drivers\":[\"a\",\"b\"]", "\"drivers\":[\"a\",\"b\",],").replace("\"sensitive\":[\"x\"]}", "\"sensitive\":[\"x\"],}");
  expect(JSON.parse(repairJsonBrackets(commas, SCHEMA)!)).toEqual(WHOLE);
  expect(JSON.parse(repairJsonBrackets(`以下是报告：\n\`\`\`json\n${whole}\n\`\`\`\n希望有帮助。`, SCHEMA)!)).toEqual(WHOLE);
  // A second object after the first, or one with a bracket in the sentence before it, is not taken.
  expect(repairJsonBrackets(`${whole}\n另一版：{"cover":{}}`, SCHEMA)).toBeUndefined();
  expect(repairJsonBrackets(`[草稿] ${whole}`, SCHEMA)).toBeUndefined();
});

test("an answer that goes round in a loop to the end is told apart from one broken once", () => {
  const passage = "\"insight\":\"她把研究当成安全感的来源，每次换方向都先问稳不稳\",";
  expect(looksLooping(`{"insights":[{${passage.repeat(80)}`)).toBe(true);
  expect(looksLooping(JSON.stringify({ ...WHOLE, sensitive: Array.from({ length: 200 }, (_, index) => `第 ${index} 条`) }))).toBe(false);
  expect(looksLooping(passage.repeat(3))).toBe(false);
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
  const logged: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => { logged.push(String(line)); });
  const cut = await run(JSON.stringify(WHOLE).slice(0, 40));
  log.mockRestore();
  expect(!cut.result.ok && cut.result.blocker.code).toBe("SKILL_SCHEMA_INVALID");
  // The same broken answer back byte for byte ends the repairs: a third turn would draw it again (replay 2026-11-26).
  expect(cut.turns).toBe(2);
  expect(logged.some((line) => line.includes("skill.repair_repeated"))).toBe(true);
  // What is logged says where it broke and how long it was, never the text of the answer.
  const unparsed = logged.map((line) => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return {}; } }).find((entry) => entry.type === "skill.json_unparsed");
  expect(unparsed).toMatchObject({ skill: "crossline:crossline-portrait-writer", length: 40, closed: false, looping: false });
  expect(logged.join("\n")).not.toContain("她");
});

// Replay 2026-11-26: the extraction's answer closed its root and wrote its last field as a second object on the next line.
test("an answer split into objects with no key in common is one answer; parts sharing a key are two attempts and stay refused", () => {
  const schema = { type: "object", properties: { profileSections: {}, flywheelCandidates: {}, pointChanges: {} } };
  const split = `{"profileSections":{"narrative":{"x":"a}b"}},"flywheelCandidates":[]}\n{"pointChanges":[{"op":"add"}]}`;
  expect(JSON.parse(mergeSplitObjects(split, schema)!)).toEqual({ profileSections: { narrative: { x: "a}b" } }, flywheelCandidates: [], pointChanges: [{ op: "add" }] });
  expect(mergeSplitObjects(`{"pointChanges":[]}\n{"pointChanges":[{"op":"add"}]}`, schema)).toBeUndefined();
  expect(mergeSplitObjects(`{"pointChanges":[]}\n{"other":1}`, schema)).toBeUndefined();
  expect(mergeSplitObjects(`{"pointChanges":[]}`, schema)).toBeUndefined();
  expect(mergeSplitObjects(`{"pointChanges":[]} and then {"flywheelCandidates":[]}`, schema)).toBeUndefined();
});
