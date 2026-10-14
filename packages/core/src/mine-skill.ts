/**
 * The person's own line skill (`crossline-mine:<line>`, docs/skills-library.md §1): how this person does this line's work — their plays,
 * preferences and hard red lines — compiled by `crossline-insight-compiler` from what they said and decided, one SKILL.md per line.
 *
 * Why it exists: on 2026-10-14 the assistant wrote the person's first Xiaohongshu note as a research report, because their content
 * play (「制造冲突、贩卖焦虑，再卖 solution」) had never been recorded anywhere a run could read, and the gate passed it on the task's
 * contract alone. The model only proposes rules; this module decides which survive (every rule cites the person's material, or — a
 * platform red line only — a public page the worker opens) and renders the SKILL.md itself, so a source mark cannot be left off.
 */

/** Where a line's versions live: `skills.mine.<line>` (`StoredMineSkill`). In the ledger, so a backup carries them; never deleted by the system. */
export const mineSkillSettingKey = (lineId: string) => `skills.mine.${lineId}`;
/** The runtime plugin the person's line skills are installed under, apart from the repo's own `crossline` plugin. */
export const MINE_PLUGIN = "crossline-mine";
/** A line id as a skill directory and frontmatter name: the runtime wants plain lowercase names. */
export const mineSkillDirName = (lineId: string) => lineId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "line";
export const mineSkillName = (lineId: string) => `${MINE_PLUGIN}:${mineSkillDirName(lineId)}`;

export type MineMaterialKind = "fact" | "preference" | "review" | "gate" | "retrospective" | "edit";
/** One thing the person said or decided, as the compiler is shown it. `label` is written by code and is what the SKILL.md cites. */
export type MineMaterial = { id: string; kind: MineMaterialKind; text: string; label: string; at: string };

export type MineSkillContext = {
  version: "crossline.mine-skill.v1";
  today: string;
  line: { id: string; label: string; goals: string[] };
  materials: MineMaterial[];
  /** The rules of the version in use, so a rewrite keeps what still holds instead of starting over. */
  previousRules: Array<{ kind: MineRuleKind; text: string }>;
};

export type MineRuleKind = "play" | "preference" | "redline";
export type MineRule = {
  kind: MineRuleKind;
  /** The rule, as an instruction (「开头先抛冲突……」). */
  text: string;
  /** Material ids it rests on. Empty only for a platform red line resting on `url`. */
  sources: string[];
  /** Verbatim from one of `sources` (or, for a url-only red line, from that page). */
  quote: string;
  /** A public https page, only for a platform red line; otherwise "". */
  url: string;
};
export type MineSkillCompilation = { summary: string; rules: MineRule[]; blockers: Array<{ code: string; message: string }> };

const str = (max: number) => ({ type: "string", minLength: 1, maxLength: max }) as const;
const object = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

export const MINE_SKILL_SCHEMA = object({
  summary: { type: "string", maxLength: 400 },
  rules: { type: "array", maxItems: 30, items: object({
    kind: { type: "string", enum: ["play", "preference", "redline"] },
    text: str(300),
    sources: { type: "array", maxItems: 6, items: str(80) },
    quote: { type: "string", maxLength: 300 },
    url: { type: "string", maxLength: 500 }
  }) },
  blockers: { type: "array", maxItems: 4, items: object({ code: str(80), message: str(400) }) }
});

/** Letters and digits only: a quote copied without its punctuation or line breaks is still the person's words. */
const squash = (value: string) => value.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
const isPublicHttps = (value: string) => /^https:\/\/[^\s/]+\.[^\s/]+(\/\S*)?$/i.test(value.trim());

/** Why one rule cannot be kept, or "" when it can. */
export function mineRuleProblem(rule: MineRule, context: MineSkillContext): string {
  const known = new Map(context.materials.map((material) => [material.id, material]));
  if (rule.text.trim().length < 4) return "规则太短";
  const unknown = rule.sources.filter((id) => !known.has(id));
  if (unknown.length) return `来源 ${unknown.join("、")} 不在 materials 里`;
  if (!rule.sources.length) {
    if (rule.kind !== "redline" || !isPublicHttps(rule.url)) return "没有来源：规则须引用 materials 的 id；只有平台红线可以只引一个公开 https 页面";
    return squash(rule.quote).length >= 4 ? "" : "平台红线须摘一句页面原文";
  }
  if (rule.url && !isPublicHttps(rule.url)) return "url 须为公开 https 页面，或留空";
  const quote = squash(rule.quote);
  if (quote.length < 4) return "quote 须逐字摘自所引来源（至少几个字）";
  return rule.sources.some((id) => squash(known.get(id)!.text).includes(quote)) ? "" : `quote「${rule.quote.slice(0, 60)}」在所引来源里找不到逐字原文`;
}

export function validateMineSkill(value: unknown, context: MineSkillContext): MineSkillCompilation {
  const answer = value as MineSkillCompilation;
  if (!answer || typeof answer !== "object" || !Array.isArray(answer.rules) || !Array.isArray(answer.blockers)) throw new Error("MINE_SKILL_SHAPE_INVALID");
  if (!answer.rules.length && answer.blockers.length) {
    throw Object.assign(new Error("MINE_SKILL_BLOCKED"), { detail: answer.blockers.map((blocker) => blocker.message).join("；").slice(0, 400) });
  }
  const problems = answer.rules.map((rule, index) => [index, mineRuleProblem(rule, context)] as const).filter(([, problem]) => problem);
  if (problems.length) {
    throw Object.assign(new Error("MINE_SKILL_RULE_UNSOURCED"), { detail: problems.slice(0, 6)
      .map(([index, problem]) => `第 ${index + 1} 条「${answer.rules[index]!.text.slice(0, 40)}」：${problem}`).join("；") });
  }
  const seen = new Set<string>();
  const repeated = answer.rules.find((rule) => { const key = squash(rule.text); if (seen.has(key)) return true; seen.add(key); return false; });
  if (repeated) throw Object.assign(new Error("MINE_SKILL_RULE_REPEATED"), { detail: `规则重复：「${repeated.text.slice(0, 60)}」` });
  return answer;
}

/** Repairs spent: keep the rules that stand on their own, drop the rest. Nothing kept means nothing is written. */
export function keepMineSkill(value: unknown, context: MineSkillContext): MineSkillCompilation | undefined {
  const answer = value as MineSkillCompilation;
  if (!answer || !Array.isArray(answer.rules)) return undefined;
  const seen = new Set<string>();
  const rules = answer.rules.filter((rule) => {
    if (!rule || typeof rule.text !== "string" || !Array.isArray(rule.sources) || mineRuleProblem(rule, context)) return false;
    const key = squash(rule.text);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return rules.length ? { summary: typeof answer.summary === "string" ? answer.summary : "", rules, blockers: [] } : undefined;
}

/** A rule as stored: what it rests on, spelled out, so the settings page shows it without re-reading the ledger. */
export type StoredMineRule = MineRule & { sourceLabels: string[] };
export type MineSkillVersion = {
  version: number; at: string;
  /** `compiler`: written by the insight compiler; `person`: typed or restored by the person on the settings page. */
  by: "compiler" | "person";
  markdown: string;
  rules?: StoredMineRule[];
  /** The materials it was compiled from (`mineMaterialsFingerprint`); a rewrite runs only when this moves. */
  fingerprint?: string;
  /** For a restored version: which one it brought back. */
  restoredFrom?: number;
};
export type StoredMineSkill = { lineId: string; current: number; versions: MineSkillVersion[] };

export function readMineSkill(raw: string | undefined): StoredMineSkill | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as StoredMineSkill;
    return parsed && Array.isArray(parsed.versions) && parsed.versions.length ? parsed : undefined;
  } catch { return undefined; }
}
export const currentMineVersion = (stored: StoredMineSkill | undefined): MineSkillVersion | undefined =>
  stored?.versions.find((version) => version.version === stored.current) ?? stored?.versions.at(-1);

const KIND_HEADING: Record<MineRuleKind, string> = { play: "打法", preference: "偏好", redline: "红线" };

/**
 * The SKILL.md, written by code from the kept rules: every rule carries where it came from (the material's label and the quote, or the
 * page for a platform red line). The frontmatter is what the runtime lists; JSON strings are valid YAML scalars, so a label with quotes
 * or colons cannot break it.
 */
export function renderMineSkill(input: { line: { id: string; label: string }; version: number; at: string; summary: string;
  rules: MineRule[]; materials: MineMaterial[] }): { markdown: string; rules: StoredMineRule[] } {
  const labels = new Map(input.materials.map((material) => [material.id, material.label]));
  const stored: StoredMineRule[] = input.rules.map((rule) => ({ ...rule, sourceLabels: rule.sources.map((id) => labels.get(id) ?? id) }));
  const description = `本人在「${input.line.label}」主线上的打法、偏好与红线（第 ${input.version} 版）。为这条主线做任务、规划步骤、写教程或验收时读取并照做。`;
  const lines = [
    "---",
    `name: ${mineSkillDirName(input.line.id)}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    `# ${input.line.label}：本人的做法`,
    "",
    ...(input.summary.trim() ? [input.summary.trim(), ""] : []),
    "以下每条都来自本人说过或定过的话。与平台惯例、通用方法论或其他 Skill 冲突时，以这里的打法与偏好为准；只有「红线」必须避开。",
    "做完后逐条自查：产物是否照这些打法写成，是否越过任何一条红线。",
    ""
  ];
  for (const kind of ["play", "preference", "redline"] as const) {
    const ofKind = stored.filter((rule) => rule.kind === kind);
    if (!ofKind.length) continue;
    lines.push(`## ${KIND_HEADING[kind]}`, "");
    ofKind.forEach((rule, index) => {
      const where = rule.sources.length
        ? rule.sourceLabels.join("；") + (rule.quote.trim() ? `：「${rule.quote.trim()}」` : "")
        : `${rule.url}${rule.quote.trim() ? `：「${rule.quote.trim()}」` : ""}`;
      lines.push(`${index + 1}. ${rule.text.trim()}`, `   - 来源：${where}`);
    });
    lines.push("");
  }
  lines.push(`<!-- crossline-mine ${input.line.id} v${input.version} ${input.at} -->`, "");
  return { markdown: lines.join("\n"), rules: stored };
}
