import { AGENT_SUMMARY_SCHEMA } from "./agent-summary";
import { ANALYSIS_OUTPUT_SCHEMA } from "./analysis";
import { ARCHETYPE_CURATION_SCHEMA } from "./archetypes";
import { ARTIFACT_PLAN_SCHEMA } from "./artifact-plan";
import { BACKGROUND_FACTS_OUTPUT_SCHEMA } from "./background-facts-schema";
import { BACKPLAN_SCHEMA } from "./backplan-schema";
import { CALENDAR_CLASSIFICATION_SCHEMA } from "./calendar-lines";
import { CONCIERGE_SCHEMA } from "./concierge";
import { DATE_EXTRACTION_SCHEMA } from "./date-schema";
import { DILIGENCE_OUTPUT_SCHEMA } from "./diligence-schema";
import { FLYWHEEL_OUTPUT_SCHEMA } from "./flywheel-schema";
import { GOAL_SPLIT_SCHEMA } from "./line-attributes";
import { MANUAL_DESIGN_SCHEMA, MATERIAL_SEARCH_SCHEMA, NODE_WRITEUP_SCHEMA } from "./manualbook-schema";
import { MILESTONE_GATE_OUTPUT_SCHEMA, MILESTONE_PROPOSAL_SCHEMA } from "./milestone-gate-schema";
import { MILESTONE_PLAN_SCHEMA } from "./milestone-plan";
import { MINE_SKILL_SCHEMA } from "./mine-skill";
import { ONBOARDING_TURN_SCHEMA } from "./onboarding-turn-schema";
import { PLAN_EXPLAINER_OUTPUT_SCHEMA } from "./plan-explainer-schema";
import { PORTRAIT_GAP_SCHEMA, PORTRAIT_SCHEMA } from "./portrait";
import { PROGRESS_ASSESSMENT_SCHEMA, STEP_PLAN_SCHEMA, VALIDATION_REVIEW_SCHEMA } from "./steps";
import { TASK_TITLES_SCHEMA } from "./task-title";
import { WEEKLY_INSIGHT_OUTPUT_SCHEMA } from "./weekly-insight-schema";

/**
 * What a model provider other than the person's own Codex sign-in may be trusted with (R7, docs/review-2026-10-13.md §7, decided
 * 2026-10-13). Every provider runs through the same Codex path; what differs is what the provider can do and how well it keeps to a
 * schema. The first is fixed by what the provider is (no OpenAI-hosted web search, image tool, connectors or memories elsewhere); the
 * second is measured — never taken from the provider's own claims — by a conformance run over every exported `*_SCHEMA`.
 */
export type SkillNeeds = {
  /** The person-facing name of what this Skill does (no model or Skill names on screen). */
  label: string;
  /** The exported schemas this Skill answers in; every one must pass for the Skill to be admitted. */
  schemas: string[];
  /** A weaker reading is a wrong answer, not a cheaper one: 100% pass and at most 5% repairs. */
  critical?: true;
  /** Calls tools mid-turn (Codex dynamic tools → function calling). */
  tools?: true;
  /** OpenAI-hosted capabilities: only on a ChatGPT sign-in or OpenAI API key through Codex itself. */
  webSearch?: true;
  image?: true;
  /** The shell assistant: only the machine owner's own Codex. */
  shell?: true;
  /** Test-only Skills are never routed for real work. */
  testOnly?: true;
};

export const SKILL_NEEDS: Record<string, SkillNeeds> = {
  "crossline-onboarding": { label: "访谈", schemas: ["ONBOARDING_TURN_SCHEMA"] },
  "crossline-milestone-architect": { label: "里程碑设计", schemas: ["MILESTONE_PROPOSAL_SCHEMA"] },
  "crossline-artifact-planner": { label: "跨主线产出规划", schemas: ["ARTIFACT_PLAN_SCHEMA"] },
  "crossline-goal-backplanner": { label: "任务倒推", schemas: ["BACKPLAN_SCHEMA"] },
  "crossline-flywheel-scout": { label: "跨主线扩展", schemas: ["FLYWHEEL_OUTPUT_SCHEMA"], webSearch: true },
  "crossline-automation-stripper": { label: "收集分析", schemas: ["ANALYSIS_OUTPUT_SCHEMA"], critical: true },
  "crossline-manualbook-designer": { label: "教程设计", schemas: ["MANUAL_DESIGN_SCHEMA"] },
  "crossline-material-researcher": { label: "资料检索", schemas: ["MATERIAL_SEARCH_SCHEMA"], webSearch: true },
  "crossline-material-writer": { label: "教程写作", schemas: ["NODE_WRITEUP_SCHEMA"] },
  "crossline-step-planner": { label: "步骤拆分", schemas: ["STEP_PLAN_SCHEMA"] },
  "crossline-archetype-curator": { label: "任务类型整理", schemas: ["ARCHETYPE_CURATION_SCHEMA"], webSearch: true },
  "crossline-validation-reviewer": { label: "复核", schemas: ["VALIDATION_REVIEW_SCHEMA"] },
  "crossline-progress-judge": { label: "进度判断", schemas: ["PROGRESS_ASSESSMENT_SCHEMA"] },
  "crossline-concierge": { label: "输入框", schemas: ["CONCIERGE_SCHEMA"], tools: true },
  "crossline-task-titler": { label: "任务命名", schemas: ["TASK_TITLES_SCHEMA"] },
  "crossline-calendar-classifier": { label: "日历归类", schemas: ["CALENDAR_CLASSIFICATION_SCHEMA"] },
  "crossline-goal-splitter": { label: "目标拆分", schemas: ["GOAL_SPLIT_SCHEMA"] },
  "crossline-insight-compiler": { label: "主线 skill 整理", schemas: ["MINE_SKILL_SCHEMA"], webSearch: true },
  "crossline-portrait-writer": { label: "画像", schemas: ["PORTRAIT_SCHEMA", "PORTRAIT_GAP_SCHEMA"] },
  "crossline-portrait-illustrator": { label: "画像插图", schemas: [], image: true },
  "crossline-eval-persona": { label: "访谈评测", schemas: [], testOnly: true },
  "crossline-conformance": { label: "模型检验", schemas: [], testOnly: true },
  "crossline-milestone-gate": { label: "验收判定", schemas: ["MILESTONE_GATE_OUTPUT_SCHEMA"], critical: true },
  "crossline-weekly-insight": { label: "每周洞察", schemas: ["WEEKLY_INSIGHT_OUTPUT_SCHEMA"] },
  "crossline-due-diligence": { label: "网上查证", schemas: ["DILIGENCE_OUTPUT_SCHEMA"], webSearch: true },
  "crossline-background-facts": { label: "背景整理", schemas: ["BACKGROUND_FACTS_OUTPUT_SCHEMA"] },
  "crossline-plan-explainer": { label: "排程说明", schemas: ["PLAN_EXPLAINER_OUTPUT_SCHEMA"] },
  "crossline-agent": { label: "电脑上的助手", schemas: ["AGENT_SUMMARY_SCHEMA"], shell: true }
};

export const skillKey = (skill: string) => skill.replace(/^crossline:/, "");

/** What a provider outside the person's own Codex sign-in can do. Fixed by what it is, not measured. */
export type ProviderCapabilities = { webSearch: boolean; image: boolean; shell: boolean; connectors: boolean; memories: boolean; tools: boolean };
export const THIRD_PARTY_CAPABILITIES: ProviderCapabilities = { webSearch: false, image: false, shell: false, connectors: false, memories: false, tools: true };

/** Why a provider cannot serve a Skill whatever its conformance, in words the person reads; undefined when it can. */
export function capabilityGap(skill: string, capabilities: ProviderCapabilities = THIRD_PARTY_CAPABILITIES): string | undefined {
  const needs = SKILL_NEEDS[skillKey(skill)];
  if (!needs) return "这项功能还没有登记它需要什么，暂不交给其他模型。";
  if (needs.testOnly) return "测试用功能，不交给其他模型。";
  if (needs.shell && !capabilities.shell) return `${needs.label}只在电脑主人自己的 Codex 上运行。`;
  if (needs.webSearch && !capabilities.webSearch) return `${needs.label}要联网搜索，这个模型连接没有；需要 ChatGPT 登录或 OpenAI API key。`;
  if (needs.image && !capabilities.image) return `${needs.label}要生成图片，这个模型连接没有；需要 ChatGPT 登录或 OpenAI API key。`;
  if (needs.tools && !capabilities.tools) return `${needs.label}要在回答中途查资料，这个模型连接不支持。`;
  return undefined;
}

/** The capabilities a third-party connection lacks, as one sentence for the settings card. */
export const UNAVAILABLE_ON_THIRD_PARTY = "联网查证、画像插图、电脑上的助手、日历应用读取和跨次记忆只在 ChatGPT 登录（或 OpenAI API key）下可用；其余功能按检验结果开放。";

// ── Conformance ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type ConformanceCase = { id: string; schema: Record<string, unknown>; prompt: string; runs: number; skills: string[] };

const LONG_TEXT_SCHEMA = { type: "object", additionalProperties: false, required: ["title", "report"], properties: {
  title: { type: "string", minLength: 1, maxLength: 60 }, report: { type: "string", minLength: 1500, maxLength: 6000 } } } as const;
const UNION_SCHEMA = { type: "object", additionalProperties: false, required: ["items", "note"], properties: {
  items: { type: "array", minItems: 3, maxItems: 6, items: { anyOf: [
    { type: "object", additionalProperties: false, required: ["kind", "title", "minutes"], properties: {
      kind: { type: "string", enum: ["task"] }, title: { type: "string", minLength: 1, maxLength: 60 }, minutes: { type: "integer", minimum: 5, maximum: 480 } } },
    { type: "object", additionalProperties: false, required: ["kind", "text"], properties: {
      kind: { type: "string", enum: ["note"] }, text: { type: "string", minLength: 1, maxLength: 200 } } }] } },
  note: { anyOf: [{ type: "string", maxLength: 200 }, { type: "null" }] } } } as const;
const level = (inner: Record<string, unknown>, name: string): Record<string, unknown> => ({ type: "object", additionalProperties: false,
  required: ["name", name], properties: { name: { type: "string", minLength: 1, maxLength: 40 }, [name]: { type: "array", minItems: 1, maxItems: 2, items: inner } } });
const DEEP_SCHEMA = level(level(level({ type: "object", additionalProperties: false, required: ["leaf", "done"],
  properties: { leaf: { type: "string", minLength: 1, maxLength: 80 }, done: { type: "boolean" } } }, "steps"), "tasks"), "milestones");

const CONFORMANCE_SCHEMAS: Record<string, Record<string, unknown>> = {
  AGENT_SUMMARY_SCHEMA, ANALYSIS_OUTPUT_SCHEMA, ARCHETYPE_CURATION_SCHEMA, ARTIFACT_PLAN_SCHEMA, BACKGROUND_FACTS_OUTPUT_SCHEMA, BACKPLAN_SCHEMA,
  CALENDAR_CLASSIFICATION_SCHEMA, CONCIERGE_SCHEMA, DATE_EXTRACTION_SCHEMA, DILIGENCE_OUTPUT_SCHEMA, FLYWHEEL_OUTPUT_SCHEMA, GOAL_SPLIT_SCHEMA,
  MANUAL_DESIGN_SCHEMA, MATERIAL_SEARCH_SCHEMA, NODE_WRITEUP_SCHEMA, MILESTONE_GATE_OUTPUT_SCHEMA, MILESTONE_PROPOSAL_SCHEMA, MILESTONE_PLAN_SCHEMA, MINE_SKILL_SCHEMA,
  ONBOARDING_TURN_SCHEMA, PLAN_EXPLAINER_OUTPUT_SCHEMA, PORTRAIT_SCHEMA, PORTRAIT_GAP_SCHEMA, STEP_PLAN_SCHEMA,
  VALIDATION_REVIEW_SCHEMA, PROGRESS_ASSESSMENT_SCHEMA, TASK_TITLES_SCHEMA, WEEKLY_INSIGHT_OUTPUT_SCHEMA
} as unknown as Record<string, Record<string, unknown>>;

/** How many times a critical Skill's schema is run: at 3 runs, "repair rate ≤ 5%" means no repair at all. */
export const CRITICAL_RUNS = 3;

/**
 * Every exported Skill schema with a minimal real prompt, plus three adversarial cases (a long text field, an `anyOf` union with a
 * null, nesting four objects deep). `exportedSchemaNames` is how a test proves none was left out.
 */
export function conformanceCases(): ConformanceCase[] {
  const skillsOf = (schemaName: string) => Object.entries(SKILL_NEEDS).filter(([, needs]) => needs.schemas.includes(schemaName)).map(([skill]) => skill);
  const cases: ConformanceCase[] = Object.entries(CONFORMANCE_SCHEMAS).map(([name, schema]) => {
    const skills = skillsOf(name);
    return { id: name, schema, skills, runs: skills.some((skill) => SKILL_NEEDS[skill]?.critical) ? CRITICAL_RUNS : 1,
      prompt: `Write one small but realistic answer in this output schema (${name}) for a Chinese graduate student who studies ECE and runs a side project. `
        + "Use short Chinese text, one or two items in each array unless the schema asks for more, ids as plain slugs, dates as YYYY-MM-DD in late 2026." };
  });
  cases.push(
    { id: "ADVERSARIAL_LONG_TEXT", schema: LONG_TEXT_SCHEMA as unknown as Record<string, unknown>, runs: 1, skills: [],
      prompt: "Write a Chinese study report of at least 1,600 characters (not words) on how to prepare for a VLSI final exam, in the field `report`." },
    { id: "ADVERSARIAL_UNION", schema: UNION_SCHEMA as unknown as Record<string, unknown>, runs: 1, skills: [],
      prompt: "List four items for tomorrow: two tasks (with minutes) and two notes, mixed in order. Set `note` to null." },
    { id: "ADVERSARIAL_DEEP", schema: DEEP_SCHEMA, runs: 1, skills: [],
      prompt: "Describe one research line with one milestone, two tasks under it and two steps under each task." });
  return cases;
}
export const exportedSchemaNames = () => Object.keys(CONFORMANCE_SCHEMAS);

const typeOf = (value: unknown): string => value === null ? "null" : Array.isArray(value) ? "array"
  : typeof value === "number" ? (Number.isInteger(value) ? "integer" : "number") : typeof value;

/**
 * Whether a value keeps to a schema, for the subset of JSON Schema our schemas use (type, properties/required/additionalProperties,
 * items, enum, const, anyOf, string and array lengths, numeric bounds, pattern). Lengths count characters, as the validators do.
 */
export function jsonSchemaProblems(value: unknown, schema: unknown, path = "$"): string[] {
  const node = schema as Record<string, unknown> | null;
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node.anyOf)) {
    const branches = node.anyOf.map((branch) => jsonSchemaProblems(value, branch, path));
    return branches.some((problems) => !problems.length) ? [] : [`${path}: matches no anyOf branch (${branches.map((problems) => problems[0]).join(" | ")})`];
  }
  const actual = typeOf(value);
  if (node.type !== undefined) {
    const allowed = Array.isArray(node.type) ? node.type as string[] : [node.type as string];
    if (!allowed.includes(actual) && !(actual === "integer" && allowed.includes("number"))) return [`${path}: expected ${allowed.join("|")}, got ${actual}`];
  }
  const problems: string[] = [];
  if (Array.isArray(node.enum) && !node.enum.includes(value as never)) problems.push(`${path}: not one of ${JSON.stringify(node.enum).slice(0, 120)}`);
  if ("const" in node && node.const !== value) problems.push(`${path}: must be ${JSON.stringify(node.const)}`);
  if (typeof value === "string") {
    const length = [...value].length;
    if (typeof node.minLength === "number" && length < node.minLength) problems.push(`${path}: ${length} characters, at least ${node.minLength}`);
    if (typeof node.maxLength === "number" && length > node.maxLength) problems.push(`${path}: ${length} characters, at most ${node.maxLength}`);
    if (typeof node.pattern === "string" && !new RegExp(node.pattern, "u").test(value)) problems.push(`${path}: does not match ${node.pattern}`);
  }
  if (typeof value === "number") {
    if (typeof node.minimum === "number" && value < node.minimum) problems.push(`${path}: below ${node.minimum}`);
    if (typeof node.maximum === "number" && value > node.maximum) problems.push(`${path}: above ${node.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof node.minItems === "number" && value.length < node.minItems) problems.push(`${path}: ${value.length} items, at least ${node.minItems}`);
    if (typeof node.maxItems === "number" && value.length > node.maxItems) problems.push(`${path}: ${value.length} items, at most ${node.maxItems}`);
    value.forEach((item, index) => problems.push(...jsonSchemaProblems(item, node.items, `${path}[${index}]`)));
  }
  if (actual === "object" && node.properties && typeof node.properties === "object") {
    const props = node.properties as Record<string, unknown>;
    const object = value as Record<string, unknown>;
    for (const key of Array.isArray(node.required) ? node.required as string[] : []) if (!(key in object)) problems.push(`${path}.${key}: missing`);
    if (node.additionalProperties === false) for (const key of Object.keys(object)) if (!(key in props)) problems.push(`${path}.${key}: not allowed`);
    for (const [key, child] of Object.entries(props)) if (key in object) problems.push(...jsonSchemaProblems(object[key], child, `${path}.${key}`));
  }
  return problems;
}

export type ConformanceRun = { caseId: string; ok: boolean; repairs: number; ms: number; code?: string };
/** Written as a `model.provider.conformance` event; the latest one for a provider and model is the one that counts. */
export type ConformanceRecord = {
  providerId: string; model: string; runtimeVersion: string; ranAt: string;
  passRate: number; repairRate: number; p95Ms: number;
  runs: ConformanceRun[];
  failures: Array<{ case: string; code: string }>;
};

export function summarizeConformance(base: Pick<ConformanceRecord, "providerId" | "model" | "runtimeVersion" | "ranAt">, runs: ConformanceRun[]): ConformanceRecord {
  const passed = runs.filter((run) => run.ok).length;
  const times = runs.map((run) => run.ms).sort((a, b) => a - b);
  return { ...base, runs,
    passRate: runs.length ? passed / runs.length : 0,
    repairRate: runs.length ? runs.filter((run) => run.repairs > 0).length / runs.length : 0,
    p95Ms: times.length ? times[Math.min(times.length - 1, Math.ceil(times.length * 0.95) - 1)]! : 0,
    failures: runs.filter((run) => !run.ok).map((run) => ({ case: run.caseId, code: run.code ?? "FAILED" })) };
}

/** A conformance result goes stale with the model, the runtime version, or thirty days. */
export const CONFORMANCE_MAX_AGE_DAYS = 30;
export function conformanceCurrent(record: ConformanceRecord | undefined, model: string, runtimeVersion: string, now = new Date()): record is ConformanceRecord {
  return Boolean(record && record.model === model && record.runtimeVersion === runtimeVersion
    && now.getTime() - Date.parse(record.ranAt) < CONFORMANCE_MAX_AGE_DAYS * 86_400_000);
}

/**
 * Which Skills a provider may serve on this record. A critical Skill needs every run of its schemas to pass with at most 5% of runs
 * repaired; any other Skill needs its own schemas to pass and the whole run to pass at least 90%. A Skill the provider cannot serve
 * at all (`capabilityGap`) is never admitted, however the schemas went.
 */
export function admittedSkills(record: ConformanceRecord, capabilities: ProviderCapabilities = THIRD_PARTY_CAPABILITIES): string[] {
  return Object.entries(SKILL_NEEDS).filter(([skill, needs]) => {
    if (capabilityGap(skill, capabilities) || !needs.schemas.length) return false;
    const runs = record.runs.filter((run) => needs.schemas.includes(run.caseId));
    if (!needs.schemas.every((schema) => runs.some((run) => run.caseId === schema)) || runs.some((run) => !run.ok)) return false;
    if (needs.critical) return runs.filter((run) => run.repairs > 0).length / runs.length <= 0.05;
    return record.passRate >= 0.9;
  }).map(([skill]) => skill);
}
