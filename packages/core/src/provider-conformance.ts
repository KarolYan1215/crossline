import { dropEnumSlips, jsonSchemaProblems as jsonSchemaCheck } from "./json-schema-check";
import { AGENT_SUMMARY_SCHEMA } from "./agent-summary";
import { ANALYSIS_OUTPUT_SCHEMA } from "./analysis";
import { ARCHETYPE_CURATION_SCHEMA } from "./archetypes";
import { ARTIFACT_PLAN_SCHEMA } from "./artifact-plan";
import { BACKGROUND_FACTS_OUTPUT_SCHEMA } from "./background-facts-schema";
import { BACKPLAN_SCHEMA } from "./backplan-schema";
import { CALENDAR_CLASSIFICATION_SCHEMA } from "./calendar-lines";
import { FOLDER_LINES_SCHEMA } from "./source-folders";
import { RECORDING_DIGEST_SCHEMA } from "./recording-digest";
import { MEDIA_DESCRIPTION_SCHEMA } from "./xhs-notes";
import { CONCIERGE_SCHEMA } from "./concierge";
import { MAIL_REPLY_DRAFT_SCHEMA, MAIL_TRIAGE_SCHEMA } from "./mail";
import { AUTOMATION_PLAN_SCHEMA } from "./automations";
import { DATE_EXTRACTION_SCHEMA } from "./date-schema";
import { DILIGENCE_OUTPUT_SCHEMA } from "./diligence-schema";
import { ENERGY_ADVICE_REVIEW_SCHEMA } from "./energy-advice";
import { FLYWHEEL_OUTPUT_SCHEMA } from "./flywheel-schema";
import { GOAL_SPLIT_SCHEMA } from "./line-attributes";
import { MANUAL_DESIGN_SCHEMA, MATERIAL_SEARCH_SCHEMA, NODE_WRITEUP_SCHEMA } from "./manualbook-schema";
import { MILESTONE_GATE_OUTPUT_SCHEMA, MILESTONE_PROPOSAL_SCHEMA } from "./milestone-gate-schema";
import { MILESTONE_PLAN_SCHEMA } from "./milestone-plan";
import { MILESTONE_RISK_SCHEMA } from "./milestone-risk";
import { MINE_SKILL_SCHEMA } from "./mine-skill";
import { PUBLIC_SKILL_BATCH_REVIEW_SCHEMA, PUBLIC_SKILL_REVIEW_SCHEMA, SKILL_SCOUT_SCHEMA } from "./public-skills";
import { ONBOARDING_DIALOGUE_SCHEMA, ONBOARDING_EXTRACT_SCHEMA } from "./onboarding-turn-schema";
import { PLAN_EXPLAINER_OUTPUT_SCHEMA } from "./plan-explainer-schema";
import { PORTRAIT_GAP_SCHEMA, PORTRAIT_SCHEMA } from "./portrait";
import { PROGRESS_ASSESSMENT_SCHEMA, STEP_PLAN_SCHEMA, VALIDATION_REVIEW_SCHEMA } from "./steps";
import { TASK_TITLES_SCHEMA } from "./task-title";
import { TASK_MERGE_REVIEW_SCHEMA } from "./task-merge";
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
  /** Reads pictures the run is given. No provider's chat bridge has been measured passing images, so only Codex itself runs it. */
  vision?: true;
  /** The shell assistant: only the machine owner's own Codex. */
  shell?: true;
  /** Test-only Skills are never routed for real work. */
  testOnly?: true;
};

export const SKILL_NEEDS: Record<string, SkillNeeds> = {
  "crossline-onboarding": { label: "访谈", schemas: ["ONBOARDING_DIALOGUE_SCHEMA"] },
  // Reads earlier sentences through its lookups (`search_evidence`, `read_sentences`).
  "crossline-onboarding-extract": { label: "访谈整理", schemas: ["ONBOARDING_EXTRACT_SCHEMA"], tools: true },
  "crossline-milestone-architect": { label: "里程碑设计", schemas: ["MILESTONE_PROPOSAL_SCHEMA"] },
  "crossline-milestone-risk-reviewer": { label: "里程碑风险审查", schemas: ["MILESTONE_RISK_SCHEMA"] },
  "crossline-artifact-planner": { label: "跨主线产出规划", schemas: ["ARTIFACT_PLAN_SCHEMA"] },
  "crossline-goal-backplanner": { label: "任务倒推", schemas: ["BACKPLAN_SCHEMA"] },
  "crossline-flywheel-scout": { label: "跨主线扩展", schemas: ["FLYWHEEL_OUTPUT_SCHEMA"], webSearch: true },
  "crossline-automation-stripper": { label: "收集分析", schemas: ["ANALYSIS_OUTPUT_SCHEMA"], critical: true },
  "crossline-manualbook-designer": { label: "教程设计", schemas: ["MANUAL_DESIGN_SCHEMA"] },
  "crossline-material-researcher": { label: "资料检索", schemas: ["MATERIAL_SEARCH_SCHEMA"], webSearch: true },
  "crossline-material-writer": { label: "教程写作", schemas: ["NODE_WRITEUP_SCHEMA"] },
  "crossline-step-planner": { label: "步骤拆分", schemas: ["STEP_PLAN_SCHEMA"] },
  "crossline-archetype-curator": { label: "任务类型整理", schemas: ["ARCHETYPE_CURATION_SCHEMA"], webSearch: true },
  "crossline-validation-reviewer": { label: "复核", schemas: ["VALIDATION_REVIEW_SCHEMA", "PUBLIC_SKILL_REVIEW_SCHEMA", "PUBLIC_SKILL_BATCH_REVIEW_SCHEMA", "TASK_MERGE_REVIEW_SCHEMA"] },
  "crossline-progress-judge": { label: "进度判断", schemas: ["PROGRESS_ASSESSMENT_SCHEMA"] },
  "crossline-concierge": { label: "输入框", schemas: ["CONCIERGE_SCHEMA"], tools: true },
  "crossline-task-titler": { label: "任务命名", schemas: ["TASK_TITLES_SCHEMA"] },
  "crossline-calendar-classifier": { label: "日历归类", schemas: ["CALENDAR_CLASSIFICATION_SCHEMA"] },
  "crossline-folder-classifier": { label: "文件夹归类", schemas: ["FOLDER_LINES_SCHEMA"] },
  "crossline-recording-digest": { label: "录音整理", schemas: ["RECORDING_DIGEST_SCHEMA"] },
  "crossline-media-describer": { label: "图片读取", schemas: ["MEDIA_DESCRIPTION_SCHEMA"], vision: true },
  "crossline-goal-splitter": { label: "目标拆分", schemas: ["GOAL_SPLIT_SCHEMA"] },
  "crossline-insight-compiler": { label: "主线 skill 整理", schemas: ["MINE_SKILL_SCHEMA"], webSearch: true },
  "crossline-skill-scout": { label: "公开 skill 检索", schemas: ["SKILL_SCOUT_SCHEMA"], webSearch: true },
  "crossline-portrait-writer": { label: "画像", schemas: ["PORTRAIT_SCHEMA", "PORTRAIT_GAP_SCHEMA"] },
  "crossline-portrait-illustrator": { label: "画像插图", schemas: [], image: true },
  "crossline-eval-persona": { label: "访谈评测", schemas: [], testOnly: true },
  "crossline-conformance": { label: "模型检验", schemas: [], testOnly: true },
  "crossline-milestone-gate": { label: "验收判定", schemas: ["MILESTONE_GATE_OUTPUT_SCHEMA"], critical: true },
  "crossline-weekly-insight": { label: "每周洞察", schemas: ["WEEKLY_INSIGHT_OUTPUT_SCHEMA"] },
  "crossline-due-diligence": { label: "网上查证", schemas: ["DILIGENCE_OUTPUT_SCHEMA"], webSearch: true },
  "crossline-energy-advisor": { label: "精力时段复核", schemas: ["ENERGY_ADVICE_REVIEW_SCHEMA"], webSearch: true },
  "crossline-background-facts": { label: "背景整理", schemas: ["BACKGROUND_FACTS_OUTPUT_SCHEMA"] },
  "crossline-plan-explainer": { label: "排程说明", schemas: ["PLAN_EXPLAINER_OUTPUT_SCHEMA"] },
  "crossline-agent": { label: "电脑上的助手", schemas: ["AGENT_SUMMARY_SCHEMA"], shell: true },
  // The assistant without a shell (docs/personal-agent.md): Crossline's own functions, on any model that can call them.
  "crossline-agent-tools": { label: "助手", schemas: ["AGENT_SUMMARY_SCHEMA"], tools: true },
  "crossline-mail-triage": { label: "邮件整理", schemas: ["MAIL_TRIAGE_SCHEMA"] },
  "crossline-mail-reply-drafter": { label: "邮件回复草稿", schemas: ["MAIL_REPLY_DRAFT_SCHEMA"] },
  "crossline-automation-designer": { label: "自动化设计", schemas: ["AUTOMATION_PLAN_SCHEMA"] }
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
  if (needs.vision) return `${needs.label}要看图片，这个模型连接还没有检验过看图；需要 ChatGPT 登录。`;
  if (needs.tools && !capabilities.tools) return `${needs.label}要在回答中途查资料，这个模型连接不支持。`;
  return undefined;
}

/**
 * What a third-party connection can and cannot do on this install, as the settings card's sentence (2026-10-16: it used to say web
 * search, the figure, calendars and memory were all ChatGPT-only, which stopped being true once Crossline searched and drew itself).
 * Calendars come in by subscription link on any model, and what the person said is kept in the ledger whichever model runs; only the
 * shell assistant stays with the machine owner's own Codex.
 */
export function unavailableOnThirdParty(capabilities: Pick<ProviderCapabilities, "webSearch" | "image">): string {
  const missing = [capabilities.webSearch ? "" : "联网查证", capabilities.image ? "" : "画像插图"].filter(Boolean);
  return [missing.length ? `${missing.join("和")}在这台服务器上只在 ChatGPT 登录（或 OpenAI API key）下可用` : "联网查证和画像插图由 Crossline 自己完成，用哪个模型都可以",
    "日历用订阅链接接入，主线、事实和偏好记在 Crossline 自己的账本里，都和模型无关",
    "助手在这里通过 Crossline 自己的功能读写文件、查网页和邮箱、跑自动化（不运行脚本；能运行脚本的助手只在电脑主人自己的 Codex 上）",
    "其余功能按检验结果开放。"].join("；");
}

// ── Conformance ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** `tool`: the case offers one function and passes only when the model called it and answered with what it returned. */
export type ConformanceCase = { id: string; schema: Record<string, unknown>; prompt: string; runs: number; skills: string[];
  tool?: { name: string; description: string; inputSchema: Record<string, unknown>; reply: string } };
/**
 * Whether a model calls a function before answering (2026-10-19): every schema case passed on SiliconFlow's DeepSeek while, in use, the
 * tools assistant and the interview's lookups never made a call. A Skill that needs functions is admitted only when this case passed;
 * a record from before the case existed is read as it was.
 */
export const TOOLS_CASE_ID = "ADVERSARIAL_TOOLS";
const TOOLS_CASE_SCHEMA = { type: "object", additionalProperties: false, required: ["code"], properties: { code: { type: "string", minLength: 1, maxLength: 40 } } } as const;

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
  AGENT_SUMMARY_SCHEMA, ANALYSIS_OUTPUT_SCHEMA, AUTOMATION_PLAN_SCHEMA, ARCHETYPE_CURATION_SCHEMA, ARTIFACT_PLAN_SCHEMA, BACKGROUND_FACTS_OUTPUT_SCHEMA, BACKPLAN_SCHEMA,
  CALENDAR_CLASSIFICATION_SCHEMA, CONCIERGE_SCHEMA, MAIL_TRIAGE_SCHEMA, MAIL_REPLY_DRAFT_SCHEMA, DATE_EXTRACTION_SCHEMA, DILIGENCE_OUTPUT_SCHEMA, ENERGY_ADVICE_REVIEW_SCHEMA, FLYWHEEL_OUTPUT_SCHEMA, FOLDER_LINES_SCHEMA, RECORDING_DIGEST_SCHEMA, MEDIA_DESCRIPTION_SCHEMA, GOAL_SPLIT_SCHEMA,
  MANUAL_DESIGN_SCHEMA, MATERIAL_SEARCH_SCHEMA, NODE_WRITEUP_SCHEMA, MILESTONE_GATE_OUTPUT_SCHEMA, MILESTONE_PROPOSAL_SCHEMA, MILESTONE_PLAN_SCHEMA, MILESTONE_RISK_SCHEMA, MINE_SKILL_SCHEMA,
  ONBOARDING_DIALOGUE_SCHEMA, ONBOARDING_EXTRACT_SCHEMA, PLAN_EXPLAINER_OUTPUT_SCHEMA, PORTRAIT_SCHEMA, PORTRAIT_GAP_SCHEMA, STEP_PLAN_SCHEMA,
  VALIDATION_REVIEW_SCHEMA, PROGRESS_ASSESSMENT_SCHEMA, TASK_TITLES_SCHEMA, WEEKLY_INSIGHT_OUTPUT_SCHEMA, PUBLIC_SKILL_REVIEW_SCHEMA, PUBLIC_SKILL_BATCH_REVIEW_SCHEMA, SKILL_SCOUT_SCHEMA, TASK_MERGE_REVIEW_SCHEMA
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
      prompt: "Describe one research line with one milestone, two tasks under it and two steps under each task." },
    { id: TOOLS_CASE_ID, schema: TOOLS_CASE_SCHEMA as unknown as Record<string, unknown>, runs: 1,
      skills: Object.entries(SKILL_NEEDS).filter(([, needs]) => needs.tools).map(([skill]) => skill),
      prompt: "The project's access code is not in this message: call the function `lookup_code` with key \"stat610\" to get it, then answer with that code in `code`.",
      tool: { name: "lookup_code", description: "Returns the access code stored for a key.", reply: "QX-4417-PL",
        inputSchema: { type: "object", additionalProperties: false, required: ["key"], properties: { key: { type: "string" } } } } });
  return cases;
}
export const exportedSchemaNames = () => Object.keys(CONFORMANCE_SCHEMAS);

export { jsonSchemaProblems } from "./json-schema-check";

/**
 * Schemas whose validator in production forgives an enum slip in one list item (`dropEnumSlips`, the interview's extraction since
 * 2026-10-19): the conformance case measures what production accepts, so a model is not shut out of a Skill for a slip that Skill keeps
 * running through.
 */
export const ENUM_TOLERANT_SCHEMAS: ReadonlySet<string> = new Set(["ONBOARDING_EXTRACT_SCHEMA"]);
/** A conformance answer's problems as the Skill that uses the schema would see them. */
export const conformanceProblems = (caseId: string, output: unknown, schema: unknown) =>
  jsonSchemaCheck(ENUM_TOLERANT_SCHEMAS.has(caseId) ? dropEnumSlips(output, schema) : output, schema);

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
/**
 * Cases a record made before a schema was split still answers for: the interview's whole-turn schema held every field the dialogue and
 * the extraction now write apart (2026-10-19), so a provider that passed it is not shut out of the interview until it is tested again.
 */
const LEGACY_CASES: Record<string, string> = { ONBOARDING_TURN_SCHEMA: "ONBOARDING_DIALOGUE_SCHEMA|ONBOARDING_EXTRACT_SCHEMA" };
/**
 * A schema added after a model was measured, and the measured schema of the same shape that stands for it until the next measurement
 * runs it for real (mail sorting: a flat list of small objects with an enum and short strings, like calendar filing; an automation plan: nested objects and a list of them, like the input box's answer): a new Skill is not withheld from every provider for
 * weeks because its record is older than the Skill. A record that ran the new schema itself is judged on those runs only.
 */
export const SCHEMA_PROXIES: Record<string, string> = { MAIL_TRIAGE_SCHEMA: "CALENDAR_CLASSIFICATION_SCHEMA", AUTOMATION_PLAN_SCHEMA: "CONCIERGE_SCHEMA",
  // A reply draft: a few short strings, a long text and a short list of strings, like a tutorial step's write-up.
  MAIL_REPLY_DRAFT_SCHEMA: "NODE_WRITEUP_SCHEMA",
  // Several public-skill reviews in one answer (2026-10-21): the single review's object, in a list keyed by id.
  PUBLIC_SKILL_BATCH_REVIEW_SCHEMA: "PUBLIC_SKILL_REVIEW_SCHEMA" };
const caseRuns = (record: ConformanceRecord) => {
  const runs = record.runs.flatMap((run) => LEGACY_CASES[run.caseId] ? LEGACY_CASES[run.caseId]!.split("|").map((caseId) => ({ ...run, caseId })) : [run]);
  const proxied = Object.entries(SCHEMA_PROXIES).filter(([schema]) => !runs.some((run) => run.caseId === schema))
    .flatMap(([schema, proxy]) => runs.filter((run) => run.caseId === proxy).map((run) => ({ ...run, caseId: schema })));
  return [...runs, ...proxied];
};

/** The share of this Skill's schema runs that needed a repair, on this record; undefined when none of its schemas ran. */
export function skillRepairRate(record: ConformanceRecord, skill: string): number | undefined {
  const schemas = SKILL_NEEDS[skill]?.schemas ?? [];
  const runs = caseRuns(record).filter((run) => schemas.includes(run.caseId));
  return runs.length ? runs.filter((run) => run.repairs > 0).length / runs.length : undefined;
}

/**
 * Whether this record shows the model calling a function when asked to (the tools case ran and passed). A Skill that is better with
 * lookups but can do without them (the step planner's `search_material`/`read_chunk`, docs/context-selection.md) gets them only then,
 * and otherwise the passages code picked in full. A record from before the case existed has not shown it.
 */
export function callsFunctions(record: ConformanceRecord): boolean {
  const runs = record.runs.filter((run) => run.caseId === TOOLS_CASE_ID);
  return runs.length > 0 && runs.every((run) => run.ok);
}

export function admittedSkills(record: ConformanceRecord, capabilities: ProviderCapabilities = THIRD_PARTY_CAPABILITIES): string[] {
  const all = caseRuns(record);
  return Object.entries(SKILL_NEEDS).filter(([skill, needs]) => {
    if (capabilityGap(skill, capabilities) || !needs.schemas.length) return false;
    const runs = all.filter((run) => needs.schemas.includes(run.caseId));
    if (!needs.schemas.every((schema) => runs.some((run) => run.caseId === schema)) || runs.some((run) => !run.ok)) return false;
    if (needs.tools && all.some((run) => run.caseId === TOOLS_CASE_ID && !run.ok)) return false;
    if (needs.critical) return runs.filter((run) => run.repairs > 0).length / runs.length <= 0.05;
    return record.passRate >= 0.9;
  }).map(([skill]) => skill);
}
