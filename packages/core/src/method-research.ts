import { backedDrillForms, stripDrillForms } from "./drill-forms";

/**
 * After the interview (the owner, 2026-11-18): the system puts together how the person works, in their own words, and researches the
 * current best way to do the kinds of work their lines hold — AI tools included — with sources. Both then guide every later plan: the
 * person's habits first, the research as how to do the work well within them (`methodGuidanceLines`). Stored as setting
 * `method.research`; one `method.researched` event per run.
 */
export const METHOD_RESEARCH_SETTING = "method.research";
export const METHOD_RESEARCH_SKILL = "crossline:crossline-method-research";

const ID = { type: "string", pattern: "^[a-z][a-z0-9_-]{0,23}$" } as const;
export const METHOD_RESEARCH_SCHEMA = { type: "object", additionalProperties: false, required: ["habits", "methods", "sources"], properties: {
  habits: { type: "array", maxItems: 10, items: { type: "object", additionalProperties: false, required: ["text", "factIds"], properties: {
    text: { type: "string", minLength: 4, maxLength: 160 }, factIds: { type: "array", minItems: 1, maxItems: 4, items: ID } } } },
  methods: { type: "array", maxItems: 8, items: { type: "object", additionalProperties: false,
    required: ["kind", "lineId", "approach", "fitsHabit", "aiTools", "sourceIds"], properties: {
      kind: { type: "string", minLength: 2, maxLength: 40 }, lineId: { type: "string", maxLength: 40 },
      approach: { type: "string", minLength: 10, maxLength: 320 }, fitsHabit: { type: "string", maxLength: 200 },
      aiTools: { type: "array", maxItems: 3, items: { type: "object", additionalProperties: false, required: ["tool", "use"], properties: {
        tool: { type: "string", minLength: 2, maxLength: 60 }, use: { type: "string", minLength: 4, maxLength: 160 } } } },
      sourceIds: { type: "array", minItems: 1, maxItems: 3, items: ID } } } },
  sources: { type: "array", maxItems: 12, items: { type: "object", additionalProperties: false, required: ["id", "url", "title", "local"], properties: {
    id: ID, url: { type: "string", maxLength: 400 }, title: { type: "string", minLength: 2, maxLength: 200 },
    local: { type: "boolean", description: "true for one of the person's own files (url = its passage id, c123), false for a web page" } } } }
} } as const;

export type MethodSource = { id: string; url: string; title: string; local: boolean };
export type MethodHabit = { text: string; factIds: string[] };
export type ResearchedMethod = { kind: string; lineId: string; approach: string; fitsHabit: string; aiTools: Array<{ tool: string; use: string }>; sourceIds: string[] };
export type MethodResearch = { habits: MethodHabit[]; methods: ResearchedMethod[]; sources: MethodSource[] };
export type StoredMethodResearch = MethodResearch & { at: string; droppedSources: number };

/** Refuses what cannot be used; each message names the problem for the repair turn. */
export function validateMethodResearch(value: unknown, input: { factIds: readonly string[]; lineIds: readonly string[] }): MethodResearch {
  const answer = value as MethodResearch | undefined;
  if (!answer || !Array.isArray(answer.habits) || !Array.isArray(answer.methods) || !Array.isArray(answer.sources)) throw new Error("METHOD_RESEARCH_SCHEMA_INVALID");
  const ids = new Set(answer.sources.map((source) => source.id));
  if (ids.size !== answer.sources.length) throw new Error("METHOD_RESEARCH_SOURCE_DUPLICATE: each source needs its own id");
  for (const source of answer.sources) {
    if (source.local ? !/^c\d+$/.test(source.url) : !/^https:\/\//.test(source.url))
      throw new Error(`METHOD_RESEARCH_SOURCE_INVALID: ${source.id} must be a public https page, or one of the person's passages (c123) with local true`);
  }
  const facts = new Set(input.factIds);
  answer.habits.forEach((habit, index) => {
    const unknown = habit.factIds.filter((id) => !facts.has(id));
    if (unknown.length) throw new Error(`METHOD_RESEARCH_UNKNOWN_FACT: habit ${index + 1} cites ${unknown.join(", ")}, not in facts; a habit rests only on the person's words`);
  });
  const lines = new Set(input.lineIds);
  answer.methods.forEach((method, index) => {
    if (method.lineId && !lines.has(method.lineId)) throw new Error(`METHOD_RESEARCH_UNKNOWN_LINE: method ${index + 1} names line ${method.lineId}; use an id from lines or ""`);
    const missing = method.sourceIds.filter((id) => !ids.has(id));
    if (missing.length) throw new Error(`METHOD_RESEARCH_UNKNOWN_SOURCE: method ${index + 1} cites ${missing.join(", ")}, not in sources`);
  });
  return answer;
}

/**
 * The research with the drill forms the person's words do not back taken out (the owner's rule of 2026-11-10, `drill-forms.ts`): a
 * published method that prescribes 错题本 or 打卡 is still not this person's way unless they said so. A method left empty is dropped.
 */
export function screenMethodResearch(research: MethodResearch, backing: readonly string[]): MethodResearch {
  const backed = backedDrillForms(backing);
  const methods = research.methods.flatMap((method) => {
    const approach = stripDrillForms(method.approach, backed);
    return approach ? [{ ...method, approach, fitsHabit: stripDrillForms(method.fitsHabit, backed),
      aiTools: method.aiTools.flatMap((tool) => { const use = stripDrillForms(tool.use, backed); return use ? [{ ...tool, use }] : []; }) }] : [];
  });
  return { ...research, methods };
}

export function readMethodResearch(raw: string | undefined | null): StoredMethodResearch | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as StoredMethodResearch;
    return Array.isArray(value?.methods) && Array.isArray(value?.habits) ? value : undefined;
  } catch { return undefined; }
}

/**
 * What every planner is told (beside the interview's profile): the person's habits as they said them, then the researched way of doing
 * each kind of work, marked as research so it never reads as something the person said. For one line, its own methods and the general ones.
 */
export function methodGuidanceLines(research: StoredMethodResearch | undefined, lineId?: string): string[] {
  if (!research) return [];
  // i18n-ignore-start: model-facing lines
  // At most six lines: the planners' profile inputs hold 20, and the interview's own profile takes up to 14 (`planningProfile`).
  const habits = research.habits.length ? [`做事习惯（本人原话整理）：${research.habits.map((habit) => habit.text).join("；")}`.slice(0, 1200)] : [];
  const methods = research.methods.filter((method) => !lineId || !method.lineId || method.lineId === lineId).slice(0, 5).map((method) => {
    const tools = method.aiTools.map((tool) => `${tool.tool}（${tool.use}）`).join("；");
    return `做法参考（联网研究，非本人原话；与习惯冲突时以习惯为准）·${method.kind}：${method.approach}${method.fitsHabit ? ` 结合习惯：${method.fitsHabit}` : ""}${tools ? ` 可用 AI 工具：${tools}` : ""}`;
  });
  // i18n-ignore-end
  return [...habits, ...methods.map((line) => line.slice(0, 900))];
}
