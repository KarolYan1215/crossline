import { CHARACTER_EXPRESSIONS, CHARACTER_POSES } from "./portrait-character";

/**
 * Fixed dimensions (decided 2026-10-12) so two people's portraits can be compared: Schwartz's ten basic values in their circular order
 * (also the radar's drawing order), six energy categories every activity is filed under, and five say–do dimensions whose "does" side
 * is computed from the ledger (`sayDoReadings`), never written by the model.
 */
export const SCHWARTZ_VALUES = [
  { name: "自主", means: "独立思考与选择" },
  { name: "刺激", means: "新奇与挑战" },
  { name: "享乐", means: "愉悦与享受" },
  { name: "成就", means: "按社会标准证明能力" },
  { name: "权力", means: "地位与对资源的支配" },
  { name: "安全", means: "稳定与秩序" },
  { name: "遵从", means: "克制、不违背规范" },
  { name: "传统", means: "尊重文化与宗教习俗" },
  { name: "仁慈", means: "关心身边的人" },
  { name: "普世", means: "理解、宽容与保护所有人和自然" }
] as const;
export const ENERGY_CATEGORIES = ["深度工作", "学习输入", "创造产出", "沟通协作", "行政事务", "休息恢复"] as const;
export type SayDoId = "plan" | "on_time" | "follow_through" | "acceptance" | "waiting";
export const SAY_DO_DIMENSIONS = [
  { id: "plan", label: "按计划投入" },
  { id: "on_time", label: "按时完成" },
  { id: "follow_through", label: "收尾" },
  { id: "acceptance", label: "外部验收" },
  { id: "waiting", label: "回应等待" }
] as const satisfies ReadonlyArray<{ id: SayDoId; label: string }>;
/**
 * Stored beside each report; a report below this is rewritten once. 3 → 4 (2026-10-17): the type moved from the first version's four axes
 * (scope/basis/output/rhythm) to the four research dimensions in `TYPE_AXES`.
 */
export const PORTRAIT_SCHEMA_VERSION = 4;
/**
 * The portrait report written when the interview ends (decided 2026-10-08), by Skill `crossline-portrait-writer`, as structured data so the
 * page can draw it: the first half is the person's portrait and insight, meant to be shared (cover, the real problem, compass and energy,
 * the lines as a flywheel with their long-term goals, the say–do gap and the anchor); the second half is specific guidance, kept private
 * (insights with advice, and what the app does next). `sensitive` lists spans to hide in the shared version (names, institutions, course
 * codes, amounts).
 */
export type PortraitReport = {
  /** `tagline`: who they are now in one line (≤ 40 characters) — under the type name on the share card. `archetype` only on older reports. */
  cover: { portrait: string; coreConflict: string; keywords: string[]; archetype?: string; tagline?: string; coreWord?: string };
  problem: { statement: string; gravity: string[]; designable: string[]; reframes: Array<{ fallacy: string; reframe: string }> };
  /** `values`: Schwartz's ten values (`SCHWARTZ_VALUES`), each scored 0–100 from the evidence (drawn as a radar); older reports carry free names. */
  compass: { workView: string; lifeView: string; consistency: string; trueNorth: string; values?: Array<{ name: string; score: number; evidence: string }> };
  /** `skillScore`/`loveScore` 0–100 place an activity on the energy plane; `skill`/`love` are the same reading as high or low. */
  energy: { summary: string; map: Array<{ activity: string; skill: "high" | "low"; love: "high" | "low"; charge: "charge" | "drain"; skillScore?: number; loveScore?: number; category?: string }>; flow: string[] };
  /** `share` — of their attention now; `targetShare` — what the portrait suggests; both percentages, each set summing to about 100. */
  lines: { allocation: string; items: Array<{ lineId: string; description: string; goals: string[]; feeds: Array<{ toLineId: string; how: string }>; share?: number; targetShare?: number }> };
  /**
   * `pairs`: the five `SAY_DO_DIMENSIONS`, each with how much the person says it matters (0–100); what they do is computed from the
   * ledger. `does` is only on older reports and is no longer drawn.
   */
  gap: { says: string; does: string; reading: string; anchor: string; realWant: string; reframe: string; pairs?: Array<{ dimension: string; says: number; evidence?: string; does?: number }> };
  /** `impact`/`effort` 1–5 place each piece of advice on the matrix. */
  insights: Array<{ insight: string; advice: string; solves: string; priority: "high" | "medium" | "low"; impact?: number; effort?: number }>;
  /**
   * Where the person stands on each typing axis (`TYPE_AXES`, 0 = left pole, 100 = right pole), with the evidence for each: read into
   * their four-letter type by `portraitType`; the names are fixed in code, not written here. `summary` (schema 3, 2026-10-14): one paragraph
   * to the person — strengths and costs of how they work now, on balance positive — that the page ends with 「你是 <code> <name>。」.
   */
  type?: { concentration: number; orientation: number; boundary: number; pacing: number;
    evidence: { concentration: string; orientation: string; boundary: string; pacing: string }; summary?: string };
  /**
   * What varies in their cartoon figure (`CHARACTER_STANDARD` fixes the rest): outfit, up to three props, a pose and an expression, and
   * `appearance` — how the person says they look (gender presentation, hair, the clothes they wear), only from their own words, "" when
   * they said nothing. Older reports have no `appearance`.
   */
  character?: { outfit: string; props: string[]; pose: string; expression: string; appearance?: string };
  sensitive: string[];
};

const text = (max: number) => ({ type: "string", minLength: 0, maxLength: max }) as const;
const list = (max: number, length: number) => ({ type: "array", maxItems: max, items: { type: "string", minLength: 1, maxLength: length } }) as const;
const object = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

const score = (min: number, max: number) => ({ type: "integer", minimum: min, maximum: max }) as const;
const GAP = object({ says: text(300), does: text(300), reading: text(400), anchor: text(300), realWant: text(300), reframe: text(300),
  pairs: { type: "array", maxItems: 5, items: object({ dimension: { type: "string", enum: SAY_DO_DIMENSIONS.map((dimension) => dimension.label) }, says: score(0, 100), evidence: text(80) }) } });
export const PORTRAIT_SCHEMA = object({
  cover: object({ portrait: text(200), coreConflict: text(300), keywords: list(6, 12), tagline: text(40), coreWord: text(6) }),
  problem: object({ statement: text(500), gravity: list(6, 200), designable: list(6, 200),
    reframes: { type: "array", maxItems: 4, items: object({ fallacy: text(200), reframe: text(300) }) } }),
  compass: object({ workView: text(500), lifeView: text(500), consistency: text(500), trueNorth: text(200),
    values: { type: "array", maxItems: 10, items: object({ name: { type: "string", enum: SCHWARTZ_VALUES.map((value) => value.name) }, score: score(0, 100), evidence: text(80) }) } }),
  energy: object({ summary: text(400), flow: list(6, 200), map: { type: "array", maxItems: 12, items: object({ activity: text(60),
    skill: { type: "string", enum: ["high", "low"] }, love: { type: "string", enum: ["high", "low"] }, charge: { type: "string", enum: ["charge", "drain"] },
    skillScore: score(0, 100), loveScore: score(0, 100), category: { type: "string", enum: [...ENERGY_CATEGORIES] } }) } }),
  lines: object({ allocation: text(500), items: { type: "array", maxItems: 8, items: object({ lineId: text(60), description: text(500), goals: list(6, 120),
    feeds: { type: "array", maxItems: 6, items: object({ toLineId: text(60), how: text(200) }) }, share: score(0, 100), targetShare: score(0, 100) }) } }),
  gap: GAP,
  insights: { type: "array", maxItems: 6, items: object({ insight: text(300), advice: text(400), solves: text(200), priority: { type: "string", enum: ["high", "medium", "low"] },
    impact: score(1, 5), effort: score(1, 5) }) },
  type: object({ concentration: score(0, 100), orientation: score(0, 100), boundary: score(0, 100), pacing: score(0, 100),
    evidence: object({ concentration: text(80), orientation: text(80), boundary: text(80), pacing: text(80) }), summary: text(160) }),
  character: object({ outfit: text(80), props: list(3, 40), pose: { type: "string", enum: [...CHARACTER_POSES] }, expression: { type: "string", enum: [...CHARACTER_EXPRESSIONS] },
    appearance: text(160) }),
  sensitive: list(30, 60)
});

/** The monthly say–do rewrite answers this alone: the rest of the report stays as it was. */
export const PORTRAIT_GAP_SCHEMA = object({ gap: GAP });

const refuse = (code: string, detail: string) => Object.assign(new Error(code), { detail });

/** Puts named items in the fixed order; unless lenient, refuses a set that misses or repeats one (the detail names which). */
function inFixedOrder<T>(items: T[] | undefined, names: readonly string[], nameOf: (item: T) => string, code: string, lenient: boolean): T[] | undefined {
  if (!items) return items;
  const seen = items.map(nameOf);
  const repeated = seen.filter((name, index) => seen.indexOf(name) !== index);
  const missing = names.filter((name) => !seen.includes(name));
  if (!lenient && (repeated.length || missing.length)) {
    throw refuse(code, [missing.length ? `缺少：${missing.join("、")}` : "", repeated.length ? `重复：${[...new Set(repeated)].join("、")}` : ""].filter(Boolean).join("；") + `；需恰好一次：${names.join("、")}`);
  }
  const rank = (item: T) => { const index = names.indexOf(nameOf(item)); return index < 0 ? names.length : index; };
  return [...items].sort((a, b) => rank(a) - rank(b));
}

/**
 * Keeps what can be drawn: lines and their feeds must be the person's lines; sensitive spans must occur in the text they would hide;
 * values and say–do pairs, when present, are the fixed sets in their fixed order. `lenient` only orders them — the answer kept once
 * repairs have run out, which the page then draws without the radar.
 */
export function validatePortrait(value: unknown, lineIds: string[], options: { lenient?: boolean } = {}): PortraitReport {
  const report = value as PortraitReport | undefined;
  if (!report?.cover || !report.problem || !report.compass || !report.energy || !report.lines || !report.gap || !Array.isArray(report.insights)) throw new Error("PORTRAIT_SCHEMA_INVALID");
  if (!report.cover.portrait.trim()) throw new Error("PORTRAIT_EMPTY");
  const known = new Set(lineIds);
  const unknown = report.lines.items.find((item) => !known.has(item.lineId));
  if (unknown) {
    throw refuse("PORTRAIT_LINE_UNKNOWN", `主线「${unknown.lineId}」不存在；可用：${lineIds.join("、")}`);
  }
  const lenient = options.lenient ?? false;
  const values = inFixedOrder(report.compass.values, SCHWARTZ_VALUES.map((item) => item.name), (item) => item.name, "PORTRAIT_VALUES_INCOMPLETE", lenient);
  const pairs = inFixedOrder(report.gap.pairs, SAY_DO_DIMENSIONS.map((item) => item.label), (item) => item.dimension, "PORTRAIT_SAY_DO_INCOMPLETE", lenient);
  const items = report.lines.items.map((item) => ({ ...item, feeds: item.feeds.filter((feed) => known.has(feed.toLineId) && feed.toLineId !== item.lineId) }));
  // Shares are read as parts of a whole: two sets that do not add up to about 100 are scaled to it, rather than refused over arithmetic.
  for (const key of ["share", "targetShare"] as const) {
    const total = items.reduce((sum, item) => sum + (item[key] ?? 0), 0);
    if (total > 0 && Math.abs(total - 100) > 5) for (const item of items) item[key] = Math.round(((item[key] ?? 0) / total) * 100);
  }
  const body = JSON.stringify({ ...report, sensitive: [] });
  return { ...report, compass: { ...report.compass, ...(values ? { values } : {}) }, gap: { ...report.gap, ...(pairs ? { pairs } : {}) },
    lines: { ...report.lines, items }, sensitive: [...new Set(report.sensitive.map((span) => span.trim()).filter((span) => span.length >= 2 && body.includes(span)))] };
}

/** The shared version: every sensitive span replaced with a block, the private second half left out by the page. */
export function redactPortrait(report: PortraitReport): PortraitReport {
  const spans = [...report.sensitive].sort((a, b) => b.length - a.length);
  const hide = (text: string) => spans.reduce((out, span) => out.split(span).join("▇".repeat(Math.min(6, Math.max(2, span.length)))), text);
  const walk = (value: unknown): unknown => typeof value === "string" ? hide(value) : Array.isArray(value) ? value.map(walk)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === "lineId" || key === "toLineId" ? item : walk(item)])) : value;
  return { ...(walk({ ...report, sensitive: [] }) as PortraitReport), sensitive: report.sensitive };
}
