import { expect, test } from "vitest";
import * as core from "./index";
import {
  admittedSkills, capabilityGap, conformanceCases, conformanceCurrent, exportedSchemaNames, jsonSchemaProblems, SKILL_NEEDS, summarizeConformance, THIRD_PARTY_CAPABILITIES, unavailableOnThirdParty,
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
  expect(admitted).toEqual(expect.arrayContaining(["crossline-evidence-judge:milestone", "crossline-automation-stripper", "crossline-concierge", "crossline-onboarding"]));
  expect(admitted).not.toEqual(expect.arrayContaining(["crossline-research:diligence"]));
  for (const skill of ["crossline-research:diligence", "crossline-portrait:figure", "crossline-agent:shell", "crossline-cross-line-planner:flywheel", "crossline-conformance"])
    expect(admitted).not.toContain(skill);
  expect(capabilityGap("crossline-portrait:figure")).toContain("图片");
  // The interview's research thread is nothing but web lookups; the interview itself only may search, so it stays on a model without search.
  expect(admitted).not.toContain("crossline-research:onboarding");
  expect(admittedSkills(summarizeConformance(base, allPassing()), { ...THIRD_PARTY_CAPABILITIES, webSearch: true })).toEqual(
    expect.arrayContaining(["crossline-onboarding", "crossline-onboarding-extract", "crossline-research:onboarding", "crossline-portrait:report"]));
});

test("admission: a model that never calls the offered function keeps the Skills that need functions out; a record from before the case is read as before", () => {
  const runs = allPassing().map((item) => item.caseId === "ADVERSARIAL_TOOLS" ? run("ADVERSARIAL_TOOLS", false) : item);
  const admitted = admittedSkills(summarizeConformance(base, runs));
  for (const skill of ["crossline-agent:functions", "crossline-concierge", "crossline-onboarding-extract"]) expect(admitted).not.toContain(skill);
  expect(admitted).toContain("crossline-goal-backplanner:title");
  const older = admittedSkills(summarizeConformance(base, allPassing().filter((item) => item.caseId !== "ADVERSARIAL_TOOLS")));
  expect(older).toContain("crossline-agent:functions");
});

test("admission: one repair on a critical schema keeps that Skill out; a failure elsewhere keeps only its own Skill out", () => {
  const runs = allPassing();
  runs[runs.findIndex((item) => item.caseId === "MILESTONE_GATE_OUTPUT_SCHEMA")] = run("MILESTONE_GATE_OUTPUT_SCHEMA", true, 1);
  runs[runs.findIndex((item) => item.caseId === "TASK_TITLES_SCHEMA")] = run("TASK_TITLES_SCHEMA", false);
  const admitted = admittedSkills(summarizeConformance(base, runs));
  expect(admitted).not.toContain("crossline-evidence-judge:milestone");
  expect(admitted).not.toContain("crossline-goal-backplanner:title");
  expect(admitted).toContain("crossline-automation-stripper");
  expect(admitted).toContain("crossline-milestone-architect:split");
});

test("admission: under 90% overall, only critical Skills that passed every run remain", () => {
  // Every fifth run fails, and every other critical schema too, so the result does not hang on where a schema sits in the list.
  const runs = allPassing().map((item, index) => (index % 5 === 0 || item.caseId === "FORM_CHECK_SCHEMA") && !["MILESTONE_GATE_OUTPUT_SCHEMA", "ANALYSIS_OUTPUT_SCHEMA"].includes(item.caseId) ? { ...item, ok: false } : item);
  const record = summarizeConformance(base, runs);
  expect(record.passRate).toBeLessThan(0.9);
  expect(admittedSkills(record).sort()).toEqual(["crossline-automation-stripper", "crossline-evidence-judge:milestone"]);
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
  expect(unavailableOnThirdParty({ webSearch: true, image: true })).toContain("不运行脚本");
  expect(unavailableOnThirdParty({ webSearch: true, image: true, shell: true })).toContain("沙箱里运行命令和脚本");
});

test("a record made before the interview was split into two schemas still admits both layers", async () => {
  const { admittedSkills, summarizeConformance, conformanceCases } = await import("./provider-conformance");
  const runs = conformanceCases().filter((item) => !item.id.startsWith("ONBOARDING_")).flatMap((item) => Array.from({ length: item.runs }, () => ({ caseId: item.id, ok: true, repairs: 0, ms: 1 })));
  const record = summarizeConformance({ providerId: "p", model: "m", runtimeVersion: "r", ranAt: "2026-10-18T00:00:00Z" },
    [...runs, { caseId: "ONBOARDING_TURN_SCHEMA", ok: true, repairs: 0, ms: 1 }]);
  expect(admittedSkills(record)).toEqual(expect.arrayContaining(["crossline-onboarding", "crossline-onboarding-extract"]));
});

test("interview parity (2026-11-26): the portrait's narrative is admitted on the long-text case, not without it", async () => {
  const { LONG_TEXT_CASE_ID } = await import("./provider-conformance");
  expect(admittedSkills(summarizeConformance(base, allPassing()))).toContain("crossline-portrait:narrative");
  const failed = allPassing().map((item) => item.caseId === LONG_TEXT_CASE_ID ? run(LONG_TEXT_CASE_ID, false) : item);
  expect(admittedSkills(summarizeConformance(base, failed))).not.toContain("crossline-portrait:narrative");
  // A free-text Skill is not admitted by default: only one marked `freeText` is.
  expect(Object.entries(SKILL_NEEDS).filter(([, needs]) => !needs.schemas.length && needs.freeText).map(([skill]) => skill)).toEqual(["crossline-portrait:narrative"]);
});

test("interview parity: a record from before the scout, the query review and the scale reading still admits the interview and its research", async () => {
  const { conformanceCases: cases } = await import("./provider-conformance");
  const later = new Set(["WEB_SCOUT_SCHEMA", "QUERY_REVIEW_SCHEMA", "SCALE_ANALYSIS_SCHEMA", "INTERVIEW_CARD_TOOLS"]);
  const older = cases().filter((item) => !later.has(item.id)).flatMap((item) => Array.from({ length: item.runs }, () => run(item.id)));
  expect(admittedSkills(summarizeConformance(base, older), { ...THIRD_PARTY_CAPABILITIES, webSearch: true })).toEqual(expect.arrayContaining([
    "crossline-onboarding", "crossline-onboarding-extract", "crossline-research:onboarding", "crossline-web-scout"]));
});

test("a record from before 2026-11-18 admits the Skills whose new schemas have a stand-in, and not method research, which has none", () => {
  const later = new Set(["FOLDER_SCREEN_SCHEMA", "SOURCE_VERSIONS_SCHEMA", "FILE_PROJECTS_SCHEMA", "CHAT_DIGEST_SCHEMA", "DELIVERABLE_CHECK_SCHEMA",
    "METHOD_RESEARCH_SCHEMA", "WEB_SCOUT_SCHEMA", "QUERY_REVIEW_SCHEMA", "SCALE_ANALYSIS_SCHEMA", "SKILL_INJECTION_CHECK_SCHEMA", "INTERVIEW_CARD_TOOLS"]);
  const capabilities = { ...THIRD_PARTY_CAPABILITIES, webSearch: true };
  const proxied = ["crossline-line-filer:folder", "crossline-capture-digest:source", "crossline-evidence-judge:deliverable"];
  expect(admittedSkills(summarizeConformance(base, allPassing()), capabilities)).toEqual(expect.arrayContaining([...proxied, "crossline-line-method:research"]));
  const older = conformanceCases().filter((item) => !later.has(item.id)).flatMap((item) => Array.from({ length: item.runs }, () => run(item.id)));
  const admitted = admittedSkills(summarizeConformance(base, older), capabilities);
  expect(admitted).toEqual(expect.arrayContaining(proxied));
  expect(admitted).not.toContain("crossline-line-method:research");
  // The stand-in's failure withholds the Skill as its own would.
  const gateFailed = older.map((item) => item.caseId === "MILESTONE_GATE_OUTPUT_SCHEMA" ? run(item.caseId, false) : item);
  expect(admittedSkills(summarizeConformance(base, gateFailed), capabilities)).not.toContain("crossline-evidence-judge:deliverable");
  // A record that ran the schema itself is judged on that run, not the stand-in's.
  const ownFailed = [...older, run("CHAT_DIGEST_SCHEMA", false)];
  expect(admittedSkills(summarizeConformance(base, ownFailed), capabilities)).not.toContain("crossline-capture-digest:source");
});

test("interview parity: the card-tools case checks a question card's real schema, and its failure keeps only the interview off functions", async () => {
  const { INTERVIEW_TOOLS_CASE_ID, callsFunctions, callsFunctionsFor, ONBOARDING_DIALOGUE_SCHEMA } = await import("./index");
  const item = conformanceCases().find((entry) => entry.id === INTERVIEW_TOOLS_CASE_ID)!;
  expect(item.tool?.checkArgs).toBe(true);
  expect(item.tool?.inputSchema).toEqual((ONBOARDING_DIALOGUE_SCHEMA as unknown as { properties: { questions: { items: unknown } } }).properties.questions.items);
  expect(jsonSchemaProblems({ id: "q1", text: "哪几个晚上空着？" }, item.tool!.inputSchema).length).toBeGreaterThan(0);
  const passing = summarizeConformance(base, allPassing());
  expect(callsFunctionsFor(passing, "crossline-onboarding")).toBe(true);
  const failed = summarizeConformance(base, allPassing().map((entry) => entry.caseId === INTERVIEW_TOOLS_CASE_ID ? run(INTERVIEW_TOOLS_CASE_ID, false) : entry));
  expect(callsFunctions(failed)).toBe(true);
  expect(callsFunctionsFor(failed, "crossline:crossline-onboarding")).toBe(false);
  expect(callsFunctionsFor(failed, "crossline-onboarding-extract")).toBe(true);
  // Still admitted: the dialogue runs in its one-JSON mode, which its schema case measured.
  expect(admittedSkills(failed)).toContain("crossline-onboarding");
  // A record from before the case: as the generic tools case says.
  const older = summarizeConformance(base, allPassing().filter((entry) => entry.caseId !== INTERVIEW_TOOLS_CASE_ID));
  expect(callsFunctionsFor(older, "crossline-onboarding")).toBe(true);
  const noTools = summarizeConformance(base, allPassing().map((entry) => entry.caseId === "ADVERSARIAL_TOOLS" ? run("ADVERSARIAL_TOOLS", false) : entry));
  expect(callsFunctionsFor(noTools, "crossline-onboarding")).toBe(false);
});

test("interview parity: a provider serves the interview only when both the dialogue and its extraction are served", async () => {
  const { interviewServed } = await import("./index");
  expect(interviewServed(undefined)).toBe(false);
  expect(interviewServed([{ skill: "crossline-onboarding", served: true }])).toBe(false);
  expect(interviewServed([{ skill: "crossline-onboarding", served: true }, { skill: "crossline-onboarding-extract", served: false }])).toBe(false);
  expect(interviewServed([{ skill: "crossline:crossline-onboarding", served: true }, { skill: "crossline-onboarding-extract", served: true }])).toBe(true);
});
