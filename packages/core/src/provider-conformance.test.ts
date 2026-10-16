import { expect, test } from "vitest";
import * as core from "./index";
import {
  admittedSkills, capabilityGap, conformanceCases, conformanceCurrent, exportedSchemaNames, jsonSchemaProblems, SKILL_NEEDS, summarizeConformance, unavailableOnThirdParty,
  type ConformanceRun
} from "./provider-conformance";
import { structuredOutputProblems } from "./structured-output";

test("discovery: every exported Skill schema is a conformance case, and every case is a strict schema", () => {
  const exported = Object.entries(core).filter(([name, value]) => /_SCHEMA$/.test(name) && typeof value === "object" && value !== null && "properties" in (value as object))
    .map(([name]) => name).sort();
  expect(exportedSchemaNames().sort()).toEqual(exported);
  for (const item of conformanceCases()) expect([item.id, structuredOutputProblems(item.schema)]).toEqual([item.id, []]);
  expect(conformanceCases().map((item) => item.id)).toEqual(expect.arrayContaining(["ADVERSARIAL_LONG_TEXT", "ADVERSARIAL_UNION", "ADVERSARIAL_DEEP"]));
});

test("every schema a Skill names is one the conformance run covers", () => {
  const names = new Set(exportedSchemaNames());
  for (const [skill, needs] of Object.entries(SKILL_NEEDS)) expect([skill, needs.schemas.filter((name) => !names.has(name))]).toEqual([skill, []]);
});

test("critical Skills are tried three times; the rest once", () => {
  const runs = Object.fromEntries(conformanceCases().map((item) => [item.id, item.runs]));
  expect(runs.MILESTONE_GATE_OUTPUT_SCHEMA).toBe(3);
  expect(runs.ANALYSIS_OUTPUT_SCHEMA).toBe(3);
  expect(runs.TASK_TITLES_SCHEMA).toBe(1);
});

test("the schema checker: types, required and extra fields, anyOf with null, lengths in characters, patterns and bounds", () => {
  const schema = { type: "object", additionalProperties: false, required: ["title", "minutes", "note", "tags"], properties: {
    title: { type: "string", minLength: 2, maxLength: 4 }, minutes: { type: "integer", minimum: 5 },
    note: { anyOf: [{ type: "string" }, { type: "null" }] }, tags: { type: "array", maxItems: 1, items: { type: "string", pattern: "^[a-z]+$" } } } };
  expect(jsonSchemaProblems({ title: "整理笔记", minutes: 30, note: null, tags: ["vlsi"] }, schema)).toEqual([]);
  const problems = jsonSchemaProblems({ title: "整", minutes: 2.5, note: 3, tags: ["A", "b"], extra: 1 }, schema);
  expect(problems).toEqual(expect.arrayContaining(["$.title: 1 characters, at least 2", "$.minutes: expected integer, got number",
    "$.tags: 2 items, at most 1", "$.tags[0]: does not match ^[a-z]+$", "$.extra: not allowed"]));
  expect(problems.some((problem) => problem.startsWith("$.note: matches no anyOf branch"))).toBe(true);
  expect(jsonSchemaProblems({ title: "ok" }, schema)).toEqual(expect.arrayContaining(["$.minutes: missing", "$.note: missing", "$.tags: missing"]));
});

const run = (caseId: string, ok = true, repairs = 0): ConformanceRun => ({ caseId, ok, repairs, ms: 1000 });
const allPassing = () => conformanceCases().flatMap((item) => Array.from({ length: item.runs }, () => run(item.id)));
const base = { providerId: "p", model: "m", runtimeVersion: "v", ranAt: "2026-10-13T00:00:00.000Z" };

test("admission: everything structured passes → served; what needs web, images or a shell never is", () => {
  const admitted = admittedSkills(summarizeConformance(base, allPassing()));
  expect(admitted).toEqual(expect.arrayContaining(["crossline-milestone-gate", "crossline-automation-stripper", "crossline-concierge", "crossline-onboarding"]));
  expect(admitted).not.toEqual(expect.arrayContaining(["crossline-due-diligence"]));
  for (const skill of ["crossline-due-diligence", "crossline-portrait-illustrator", "crossline-agent", "crossline-flywheel-scout", "crossline-conformance"])
    expect(admitted).not.toContain(skill);
  expect(capabilityGap("crossline-portrait-illustrator")).toContain("图片");
});

test("admission: one repair on a critical schema keeps that Skill out; a failure elsewhere keeps only its own Skill out", () => {
  const runs = allPassing();
  runs[runs.findIndex((item) => item.caseId === "MILESTONE_GATE_OUTPUT_SCHEMA")] = run("MILESTONE_GATE_OUTPUT_SCHEMA", true, 1);
  runs[runs.findIndex((item) => item.caseId === "TASK_TITLES_SCHEMA")] = run("TASK_TITLES_SCHEMA", false);
  const admitted = admittedSkills(summarizeConformance(base, runs));
  expect(admitted).not.toContain("crossline-milestone-gate");
  expect(admitted).not.toContain("crossline-task-titler");
  expect(admitted).toContain("crossline-automation-stripper");
  expect(admitted).toContain("crossline-goal-splitter");
});

test("admission: under 90% overall, only critical Skills that passed every run remain", () => {
  const runs = allPassing().map((item, index) => index % 5 === 0 && !["MILESTONE_GATE_OUTPUT_SCHEMA", "ANALYSIS_OUTPUT_SCHEMA"].includes(item.caseId) ? { ...item, ok: false } : item);
  const record = summarizeConformance(base, runs);
  expect(record.passRate).toBeLessThan(0.9);
  expect(admittedSkills(record).sort()).toEqual(["crossline-automation-stripper", "crossline-milestone-gate"]);
});

test("a record goes stale with another model, another runtime, or after thirty days", () => {
  const record = summarizeConformance(base, [run("TASK_TITLES_SCHEMA")]);
  const now = new Date("2026-10-20T00:00:00.000Z");
  expect(conformanceCurrent(record, "m", "v", now)).toBe(true);
  expect(conformanceCurrent(record, "other", "v", now)).toBe(false);
  expect(conformanceCurrent(record, "m", "v2", now)).toBe(false);
  expect(conformanceCurrent(record, "m", "v", new Date("2026-11-13T00:00:00.000Z"))).toBe(false);
  expect(conformanceCurrent(undefined, "m", "v", now)).toBe(false);
});

test("the third-party note says what this install actually adds: search and the figure only when configured", () => {
  expect(unavailableOnThirdParty({ webSearch: false, image: false })).toContain("联网查证和画像插图在这台服务器上只在 ChatGPT 登录");
  expect(unavailableOnThirdParty({ webSearch: false, image: true })).toContain("联网查证在这台服务器上只在");
  expect(unavailableOnThirdParty({ webSearch: true, image: true })).toContain("由 Crossline 自己完成");
  expect(unavailableOnThirdParty({ webSearch: true, image: true })).toContain("日历用订阅链接接入");
});
