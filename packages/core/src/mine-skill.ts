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

/**
 * What the compiler is shown (incremental since 2026-10-22, token-economy.md §2): the materials new or changed since the version in use
 * (all of them when there is no compiled version to build on), and that version's rules with their ids and sources. Material ids are a
 * short hash of each material's stable key (`mineMaterialId`), so a rule's sources still name the same material on the next run.
 */
export type MineSkillContext = {
  version: "crossline.mine-skill.v2";
  today: string;
  line: { id: string; label: string; goals: string[] };
  materials: MineMaterial[];
  /** The rules of the version in use, so a rewrite keeps what still holds instead of starting over. */
  previousRules: PreviousMineRule[];
};
export type PreviousMineRule = { id: string; kind: MineRuleKind; text: string; sources: string[]; quote: string; url: string };

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
/**
 * One change to the rules: `add` a new rule, `revise` a previous one (`ruleId`) into the rule given, `drop` a previous one, or `keep` it
 * (the same as not naming it). The rule's fields are read only for `add` and `revise`. Answers written before the operations (no `op`)
 * are read as `add`.
 */
export type MineRuleChange = MineRule & { op: "keep" | "revise" | "add" | "drop"; ruleId: string };
export type MineSkillCompilation = { summary: string; rules: MineRuleChange[]; blockers: Array<{ code: string; message: string }> };

const str = (max: number) => ({ type: "string", minLength: 1, maxLength: max }) as const;
const object = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

export const MINE_SKILL_SCHEMA = object({
  summary: { type: "string", maxLength: 400 },
  rules: { type: "array", maxItems: 30, items: object({
    op: { type: "string", enum: ["keep", "revise", "add", "drop"] },
    ruleId: { type: "string", maxLength: 20 },
    kind: { type: "string", enum: ["play", "preference", "redline"] },
    text: { type: "string", maxLength: 300 },
    sources: { type: "array", maxItems: 6, items: str(80) },
    quote: { type: "string", maxLength: 300 },
    url: { type: "string", maxLength: 500 }
  }) },
  blockers: { type: "array", maxItems: 4, items: object({ code: str(80), message: str(400) }) }
});

/** 64 bits of FNV-1a (two 32-bit passes with different seeds) as hex: pure, so core stays free of node:crypto. Ids, not security. */
function hashHex(text: string): string {
  const pass = (seed: number) => {
    let hash = seed >>> 0;
    for (let index = 0; index < text.length; index += 1) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 0x01000193) >>> 0; }
    return hash.toString(16).padStart(8, "0");
  };
  return pass(0x811c9dc5) + pass(0x050c5d1f);
}

/** A material's id: `m` and a short hash of its stable key, the same on every run while the key exists. */
export function mineMaterialId(key: string, taken?: Set<string>): string {
  const hash = hashHex(key);
  for (let length = 6; length <= hash.length; length += 1) {
    const id = `m${hash.slice(0, length)}`;
    if (!taken || !taken.has(id)) { taken?.add(id); return id; }
  }
  return `m${hash}`;
}
/** What a material's text was when a version was compiled from it: a change makes it new material for the next run. */
export const mineTextHash = (text: string) => hashHex(text).slice(0, 12);

/** Letters and digits only: a quote copied without its punctuation or line breaks is still the person's words. */
const squash = (value: string) => value.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
const isPublicHttps = (value: string) => /^https:\/\/[^\s/]+\.[^\s/]+(\/\S*)?$/i.test(value.trim());

/**
 * Why one rule cannot be kept, or "" when it can. `citable` is every material a rule may cite: those shown and those the previous rules
 * cite (still on record, though not shown again); it defaults to the shown ones.
 */
export function mineRuleProblem(rule: MineRule, context: MineSkillContext, citable: MineMaterial[] = context.materials): string {
  const known = new Map(citable.map((material) => [material.id, material]));
  if (rule.text.trim().length < 4) return "规则太短";
  const unknown = rule.sources.filter((id) => !known.has(id));
  if (unknown.length) return `来源 ${unknown.join("、")} 不在 materials 里，也不是上一版规则的来源`;
  if (!rule.sources.length) {
    if (rule.kind !== "redline" || !isPublicHttps(rule.url)) return "没有来源：规则须引用 materials 的 id；只有平台红线可以只引一个公开 https 页面";
    return squash(rule.quote).length >= 4 ? "" : "平台红线须摘一句页面原文";
  }
  if (rule.url && !isPublicHttps(rule.url)) return "url 须为公开 https 页面，或留空";
  const quote = squash(rule.quote);
  if (quote.length < 4) return "quote 须逐字摘自所引来源（至少几个字）";
  return rule.sources.some((id) => squash(known.get(id)!.text).includes(quote)) ? "" : `quote「${rule.quote.slice(0, 60)}」在所引来源里找不到逐字原文`;
}

/** An answer's changes with an answer written before the operations (no `op`) read as additions. */
const changesOf = (answer: { rules: Array<Partial<MineRuleChange>> }): MineRuleChange[] =>
  answer.rules.map((rule) => ({ ...rule, op: rule.op ?? "add", ruleId: rule.ruleId ?? "" }) as MineRuleChange);

/**
 * The materials a stored rule rests on now: its own sources while they are on record and hold its quote; else (a version compiled when
 * ids were positions, m1 m2 …, which a new material renumbered) the materials whose text holds the quote, at most three; else none.
 */
export function resolveMineSources(rule: Pick<MineRule, "sources" | "quote">, materials: MineMaterial[]): string[] {
  const quote = squash(rule.quote);
  if (quote.length < 4) return [];
  const byId = new Map(materials.map((material) => [material.id, material]));
  const own = rule.sources.filter((id) => byId.has(id) && squash(byId.get(id)!.text).includes(quote));
  if (own.length) return own;
  return materials.filter((material) => squash(material.text).includes(quote)).slice(0, 3).map((material) => material.id);
}

/** Why one change cannot stand, or "". */
function changeProblem(change: MineRuleChange, context: MineSkillContext, citable: MineMaterial[]): string {
  const previous = new Set(context.previousRules.map((rule) => rule.id));
  if (change.op !== "add" && !previous.has(change.ruleId)) return `ruleId「${change.ruleId}」不是上一版规则的 id`;
  if (change.op === "keep" || change.op === "drop") return "";
  return mineRuleProblem(change, context, citable);
}

export function validateMineSkill(value: unknown, context: MineSkillContext, citable: MineMaterial[] = context.materials): MineSkillCompilation {
  const raw = value as MineSkillCompilation;
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.rules) || !Array.isArray(raw.blockers)) throw new Error("MINE_SKILL_SHAPE_INVALID");
  const answer = { ...raw, rules: changesOf(raw) };
  // With rules in force, no change is an answer (nothing new bears on the play); only a first compilation with nothing to say stops.
  if (!answer.rules.length && answer.blockers.length && !context.previousRules.length) {
    throw Object.assign(new Error("MINE_SKILL_BLOCKED"), { detail: answer.blockers.map((blocker) => blocker.message).join("；").slice(0, 400) });
  }
  const problems = answer.rules.map((rule, index) => [index, changeProblem(rule, context, citable)] as const).filter(([, problem]) => problem);
  if (problems.length) {
    throw Object.assign(new Error("MINE_SKILL_RULE_UNSOURCED"), { detail: problems.slice(0, 6)
      .map(([index, problem]) => `第 ${index + 1} 条「${(answer.rules[index]!.text || answer.rules[index]!.ruleId).slice(0, 40)}」：${problem}`).join("；") });
  }
  const named = answer.rules.filter((rule) => rule.op !== "add").map((rule) => rule.ruleId);
  const twice = named.find((id, index) => named.indexOf(id) !== index);
  if (twice) throw Object.assign(new Error("MINE_SKILL_RULE_REPEATED"), { detail: `上一版规则 ${twice} 被处理了两次：每条至多一个操作` });
  const seen = new Set<string>();
  const repeated = answer.rules.filter((rule) => rule.op === "add" || rule.op === "revise")
    .find((rule) => { const key = squash(rule.text); if (seen.has(key)) return true; seen.add(key); return false; });
  if (repeated) throw Object.assign(new Error("MINE_SKILL_RULE_REPEATED"), { detail: `规则重复：「${repeated.text.slice(0, 60)}」` });
  return answer;
}

/** Repairs spent: keep the changes that stand on their own, drop the rest. Nothing kept and no rules in force means nothing is written. */
export function keepMineSkill(value: unknown, context: MineSkillContext, citable: MineMaterial[] = context.materials): MineSkillCompilation | undefined {
  const raw = value as MineSkillCompilation;
  if (!raw || !Array.isArray(raw.rules)) return undefined;
  const seen = new Set<string>(), named = new Set<string>();
  const rules = changesOf(raw).filter((rule) => {
    if (!rule || typeof rule.text !== "string" || !Array.isArray(rule.sources) || changeProblem(rule, context, citable)) return false;
    if (rule.op !== "add") { if (named.has(rule.ruleId)) return false; named.add(rule.ruleId); }
    if (rule.op === "keep" || rule.op === "drop") return true;
    const key = squash(rule.text);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return rules.length || context.previousRules.length ? { summary: typeof raw.summary === "string" ? raw.summary : "", rules, blockers: [] } : undefined;
}

/**
 * The rules after an answer: the previous ones in order, each kept, revised or dropped, then the additions. A kept rule must still stand
 * on material on record (`citable`): one whose sources are all gone, or whose quote is no longer in them, is dropped and said so (the
 * person removed what it rested on). A url-only red line stands on its page. Two rules with the same wording are one.
 */
export function applyMineChanges(answer: MineSkillCompilation, context: MineSkillContext, citable: MineMaterial[]): { rules: MineRule[]; dropped: string[] } {
  const known = new Map(citable.map((material) => [material.id, material]));
  const changes = new Map(answer.rules.filter((rule) => rule.op !== "add").map((rule) => [rule.ruleId, rule]));
  const strip = (rule: MineRule): MineRule => ({ kind: rule.kind, text: rule.text, sources: rule.sources, quote: rule.quote, url: rule.url });
  const out: MineRule[] = [], dropped: string[] = [];
  for (const previous of context.previousRules) {
    const change = changes.get(previous.id);
    if (change?.op === "drop") continue;
    if (change?.op === "revise") { out.push(strip(change)); continue; }
    if (!previous.sources.length && previous.url) { out.push(strip(previous)); continue; }
    const sources = previous.sources.filter((id) => known.has(id));
    const quote = squash(previous.quote);
    if (!sources.length || quote.length < 4 || !sources.some((id) => squash(known.get(id)!.text).includes(quote))) {
      dropped.push(`${previous.text.slice(0, 40)}：所依据的材料已不在`);
      continue;
    }
    out.push({ ...strip(previous), sources });
  }
  for (const change of answer.rules) if (change.op === "add") out.push(strip(change));
  const seen = new Set<string>();
  return { rules: out.filter((rule) => { const key = squash(rule.text); if (seen.has(key)) return false; seen.add(key); return true; }), dropped };
}

/**
 * What an interview fact is called where a rule cites it. A fact's slot is the model's own key (`customer_data_gaps`, `long_term_goal`),
 * never shown as such (2026-10-17 walkthrough, W-19): a known slot gets its name, any other the opening of what was said.
 */
const FACT_SLOT_LABEL: Record<string, string> = {
  what: "在做什么", for_whom: "为谁", stage: "阶段", goal: "目标", long_term_goal: "长期目标", deadline: "截止", no_deadline: "截止",
  blockers: "卡点", collaborators: "合作者", evidence: "进展证据", progress_evidence: "进展证据", evaluation_evidence: "评估依据",
  local_assets: "已有资料", weekly_hours: "每周时间", tools: "工具", grading: "评分", target_grade: "目标成绩", meetings: "上课时间",
  meeting_times: "上课时间", priority: "优先级", constraint: "约束", line_constraint: "约束", positioning: "定位", description: "描述",
  work_view: "工作观", life_view: "人生观", true_north: "方向", values: "价值观", flow: "心流", energy: "精力", schedule: "作息",
  customer_data_gaps: "客户数据缺口", trial_users: "试用用户", audience: "受众", platform: "平台", style: "风格", strategy: "策略"
};
const isModelKey = (text: string) => /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(text);
export function mineFactLabel(slot: string, value: string): string {
  const known = FACT_SLOT_LABEL[slot];
  if (known) return `访谈中确认的「${known}」`;
  const opening = value.replace(/\s+/g, " ").trim();
  return opening ? `访谈中确认的「${opening.length > 12 ? `${opening.slice(0, 12)}…` : opening}」` : "访谈中确认的一条事实";
}
/** A label stored before `mineFactLabel` (「访谈中确认的「customer_data_gaps」」) or a bare key, made readable for the page. */
export function readableMineSourceLabel(label: string): string {
  const fact = /^访谈中确认的「([^」]+)」$/.exec(label);
  if (fact && isModelKey(fact[1]!)) return FACT_SLOT_LABEL[fact[1]!] ? `访谈中确认的「${FACT_SLOT_LABEL[fact[1]!]}」` : "访谈中确认的一条事实";
  if (isModelKey(label)) return FACT_SLOT_LABEL[label] ? `访谈中确认的「${FACT_SLOT_LABEL[label]}」` : "访谈中确认的一条事实";
  return label;
}

/** The same inside a stored SKILL.md, whose rules list their sources in running text. */
export const readableMineText = (markdown: string) =>
  markdown.replace(/访谈中确认的「([a-z][a-z0-9]*(?:_[a-z0-9]+)*)」/g, (whole) => readableMineSourceLabel(whole));

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
  /**
   * For a compiled version: each material it was compiled from (`mineMaterialId` → `mineTextHash` of its text). The next compilation is
   * shown only the materials not here or changed since; a version without it (compiled before 2026-10-22) is rebuilt from all of them.
   */
  materialHashes?: Record<string, string>;
  /** For a compiled version: its summary, kept when a later compilation changes the rules but not the summary. */
  summary?: string;
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

const mineDescription = (label: string, version?: number) =>
  `本人在「${label}」主线上的打法、偏好与红线${version ? `（第 ${version} 版）` : ""}。为这条主线做任务、规划步骤、写教程或验收时读取并照做。`;

/**
 * A text the person typed on the settings page, made loadable: the runtime lists a skill only by its frontmatter, so one that lost or never
 * had it (the person pasted their rules as plain text) gets the standard one back, with its name pinned to the line.
 */
export function ensureMineFrontmatter(markdown: string, line: { id: string; label: string }): string {
  const body = markdown.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trimStart();
  return [`---`, `name: ${mineSkillDirName(line.id)}`, `description: ${JSON.stringify(mineDescription(line.label))}`, `---`, "", body].join("\n");
}

/**
 * The SKILL.md, written by code from the kept rules: every rule carries where it came from (the material's label and the quote, or the
 * page for a platform red line). The frontmatter is what the runtime lists; JSON strings are valid YAML scalars, so a label with quotes
 * or colons cannot break it.
 */
export function renderMineSkill(input: { line: { id: string; label: string }; version: number; at: string; summary: string;
  rules: MineRule[]; materials: MineMaterial[] }): { markdown: string; rules: StoredMineRule[] } {
  const labels = new Map(input.materials.map((material) => [material.id, material.label]));
  const stored: StoredMineRule[] = input.rules.map((rule) => ({ ...rule, sourceLabels: rule.sources.map((id) => readableMineSourceLabel(labels.get(id) ?? "本人的材料")) }));
  const description = mineDescription(input.line.label, input.version);
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
