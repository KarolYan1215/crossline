import { decideCommand, isSecretPath } from "./agent-guard";

/**
 * Public skills (`crossline-public:<id>`, docs/skills-library.md §2): skills other people published, found by `crossline-skill-scout`,
 * fetched as one directory from a public GitHub repository, scanned by code, reviewed by a model, and installed in the runtime's third
 * plugin. Everything decided about each one is recorded in `skills.library`; its files (the text fetched, never anything run) in
 * `skills.public.files.<id>`, so a backup can rebuild the plugin without fetching again.
 */
export const PUBLIC_PLUGIN = "crossline-public";
export const SKILL_LIBRARY_SETTING = "skills.library";
export const publicSkillFilesKey = (id: string) => `skills.public.files.${id}`;
export const publicSkillName = (id: string) => `${PUBLIC_PLUGIN}:${id}`;
/** Not called for this long, a public skill is removed (the person's own line skills never are). */
export const PUBLIC_SKILL_IDLE_DAYS = 30;
/** At most this many public skills are switched on for one run, the most relevant first. */
export const PUBLIC_SKILLS_PER_RUN = 3;

/** Broad kinds, not task types: one skill serves every line that does that kind of work. */
export const PUBLIC_SKILL_CATEGORIES = ["writing", "research", "coding", "data", "design", "study", "planning", "media", "finance", "other"] as const;
export type PublicSkillCategory = (typeof PUBLIC_SKILL_CATEGORIES)[number];
export const PUBLIC_SKILL_CATEGORY_LABEL: Record<PublicSkillCategory, string> = {
  writing: "写作", research: "调研", coding: "编程", data: "数据", design: "设计", study: "学习", planning: "规划", media: "内容运营", finance: "投资", other: "其他"
};

// ── License ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Licences that let anyone reuse the files (GitHub's SPDX ids). Missing, unknown, non-commercial or no-derivatives ones are not taken. */
const REUSABLE = new Set(["MIT", "MIT-0", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "ISC", "Unlicense", "CC0-1.0", "CC-BY-4.0",
  "CC-BY-SA-4.0", "MPL-2.0", "GPL-2.0", "GPL-3.0", "LGPL-2.1", "LGPL-3.0", "AGPL-3.0", "EPL-2.0", "BSL-1.0", "Zlib", "WTFPL"]);
export function licenseVerdict(spdx: string | null | undefined): { ok: true } | { ok: false; reason: string } {
  const id = (spdx ?? "").trim();
  if (!id || id === "NOASSERTION" || id === "NONE") return { ok: false, reason: "仓库没有可识别的许可证" };
  return REUSABLE.has(id) ? { ok: true } : { ok: false, reason: `许可证 ${id} 不允许复用或无法确认` };
}

/**
 * A licence read from a LICENSE file's own text, for a repository whose root names none (skill collections often license each skill in its
 * own folder). Only the standard texts are recognised; anything else — a proprietary notice included — is no licence to reuse.
 */
export function licenseFromText(text: string): string | undefined {
  if (/Apache License,?\s+Version 2\.0/i.test(text)) return "Apache-2.0";
  if (/Permission is hereby granted, free of charge/i.test(text)) return "MIT";
  if (/Mozilla Public License,?\s+(v\.|version)\s*2\.0/i.test(text)) return "MPL-2.0";
  if (/Redistribution and use in source and binary forms/i.test(text)) return /Neither the name/i.test(text) ? "BSD-3-Clause" : "BSD-2-Clause";
  if (/Permission to use, copy, modify, and\/or distribute this software for any purpose/i.test(text)) return "ISC";
  if (/This is free and unencumbered software released into the public domain/i.test(text)) return "Unlicense";
  if (/CC0 1\.0 Universal/i.test(text)) return "CC0-1.0";
  return undefined;
}

// ── Scan (code, not a model) ────────────────────────────────────────────────────────────────────────────────────────────

export type ScanFinding = { file: string; line: number; rule: string; excerpt: string };
export type SkillScan = {
  /** `high`: a script reaches the network, deletes, leaves its directory, touches secrets, changes the system, or downloads and runs code. */
  risk: "low" | "high";
  /** A SKILL.md or reference that tells the model to ignore its instructions, hide things, send data out or get round approvals. */
  injection: boolean;
  findings: ScanFinding[];
};

/**
 * Something that runs: a file with an executable extension anywhere, or a file without an extension under `scripts/`. A JSON, Markdown or
 * CSV file under `scripts/` is a script's test data, not a script — counting it as one flagged an `https://example.com` in a grown
 * workflow's fixture as network access and took away its (offline) checker (2026-10-14).
 */
const EXECUTABLE = /\.(sh|bash|zsh|ps1|psm1|bat|cmd|py|js|mjs|cjs|ts|rb|pl|php|lua|go|rs|exe|dll|so|dylib|bin|jar)$/i;
export const isScriptFile = (file: string) => EXECUTABLE.test(file) || /(^|\/)scripts\/(?:[^/]+\/)*[^/.]+$/i.test(file);

const SCRIPT_RULES: Array<{ rule: string; pattern: RegExp }> = [
  { rule: "net", pattern: /\b(curl|wget|invoke-webrequest|invoke-restmethod|iwr|irm|nc|ncat|telnet|ssh|scp|ftp)\b|requests\.(get|post|put|patch|delete|session)|urllib\.request|urlopen|urlretrieve|http\.client|httpx|aiohttp|\bfetch\s*\(|axios|xmlhttprequest|websocket|socket\.|net\.(connect|createconnection)|https?:\/\/(?!localhost|127\.0\.0\.1)/i },
  { rule: "delete", pattern: /\brm\s+-|\bremove-item\b|\bdel\s|\brmdir\b|\brd\s|shutil\.rmtree|os\.(remove|unlink|rmdir|removedirs)|\.unlink\(|fs\.(rm|rmdir|unlink)(sync)?\b|rmsync|unlinksync|\btruncate\b/i },
  { rule: "outside", pattern: /(^|[\s"'(=:,])([a-z]:[\\/]|\/(etc|usr|var|root|home|users|opt|system|library|private)\/|~[\\/]|\$home\b|%userprofile%|\$env:(userprofile|appdata|localappdata)|%appdata%|os\.path\.expanduser|homedir\(\)|\.\.[\\/])/i },
  { rule: "system", pattern: /\bsudo\b|\bsu\s|chmod\s+[0-7]*7[0-7]*\b|chown\b|systemctl|launchctl|\bsetx\b|crontab|\/etc\/(hosts|passwd|shadow|sudoers)|defaults\s+write|gsettings\s+set/i },
  { rule: "download.execute", pattern: /\bpip3?\s+install\b|\bnpm\s+(i|install|exec)\b|\bnpx\s|\bpnpm\s+(add|dlx)\b|\byarn\s+(add|dlx)\b|\bgo\s+(get|install)\b|\bcargo\s+install\b|\bgem\s+install\b|base64[^\n]{0,60}(exec|eval)|(exec|eval)\s*\([^)]*(b64|base64|decode)/i }
];
const INJECTION = /ignore\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier|system|developer)\s+(instructions|rules|messages|prompts)|disregard\s+(all\s+|the\s+)?(previous|prior|above|system|developer)|忽略(之前|以上|所有|前面|上述|系统)的?(指令|规则|要求|提示)|(do\s+not|don't|never)\s+(tell|inform|show|mention|reveal)\s+(this\s+to\s+)?(the\s+)?user|不要(告诉|告知|透露给)(用户|本人|使用者)|exfiltrat|(send|upload|post|transmit|forward)\s[^.\n]{0,60}(credential|secret|token|api[\s_-]?key|password|\.env|cookie|private key)|bypass\s+(the\s+)?(approval|guard|sandbox|safety|permission|review)|绕过(审批|审查|限制|安全|权限)|without\s+(asking|approval|permission|confirmation)|不经(本人|用户)?(同意|批准|确认)|reveal\s+(the\s+|your\s+)?(system|developer)\s+prompt|you\s+are\s+now\s+|jailbreak|\bDAN\b/i;
/** The system's own font folders: a script that reads a font to draw a title is not leaving its directory (the first grown vlog workflow did). */
const SYSTEM_FONTS = /([a-z]:[\\/]windows[\\/]fonts|\/usr\/(local\/)?share\/fonts|\/system\/library\/fonts|\/library\/fonts)[\\/][^\s"'`),;]*/gi;
const HIDDEN = /[\u200B-\u200F\u2060-\u2064\uFEFF\u202A-\u202E]/;
const GUARD_CONTEXT = { taskDir: "C:\\skill-scan\\task", homeDir: "C:\\Users\\skill-scan" };

/**
 * Reads every fetched file line by line. A script line the assistant's own guard would refuse or ask about, or one matching the patterns
 * above, makes the skill high risk; a SKILL.md or reference line asking the model to drop its rules, hide things from the person, send data
 * out or get round approvals — or text hidden with invisible characters — is an injection risk. Pattern matching misses what is written to
 * get round it (docs/skills-library.md §风险); it is the first of two checks, not a proof.
 */
export function scanSkillFiles(files: Array<{ path: string; text: string }>): SkillScan {
  const findings: ScanFinding[] = [];
  let injection = false;
  for (const file of files) {
    const lines = file.text.split(/\r?\n/);
    if (isScriptFile(file.path)) {
      lines.forEach((line, index) => {
        const text = line.trim();
        if (!text || /^(#|\/\/|--|rem\s)/i.test(text) && !/https?:|curl|wget|rm\s/i.test(text)) return;
        const add = (rule: string) => findings.push({ file: file.path, line: index + 1, rule, excerpt: text.slice(0, 160) });
        const guard = decideCommand(text, GUARD_CONTEXT);
        if (guard.decision !== "allow") add(guard.rule);
        else if (text.split(/[\s"'`(),;|&<>=]+/).some((token) => token && isSecretPath(token))) add("secret.path");
        const withoutFonts = text.replace(SYSTEM_FONTS, "font");
        for (const entry of SCRIPT_RULES) if (entry.pattern.test(entry.rule === "outside" ? withoutFonts : text)) add(entry.rule);
      });
    } else {
      lines.forEach((line, index) => {
        if (INJECTION.test(line)) { injection = true; findings.push({ file: file.path, line: index + 1, rule: "injection", excerpt: line.trim().slice(0, 160) }); }
        if (HIDDEN.test(line)) { injection = true; findings.push({ file: file.path, line: index + 1, rule: "hidden.text", excerpt: line.replace(HIDDEN, "␣").trim().slice(0, 160) }); }
      });
    }
  }
  return { risk: findings.some((finding) => finding.rule !== "injection" && finding.rule !== "hidden.text") ? "high" : "low", injection, findings: findings.slice(0, 60) };
}

// ── Scout (crossline-skill-scout) ────────────────────────────────────────────────────────────────────────────────────────

export type SkillScoutContext = {
  version: "crossline.skill-scout.v1";
  today: string;
  lines: Array<{ id: string; label: string; goals: string[]; recentTasks: string[] }>;
  /** What a task needed and the library did not have (the search done on demand). */
  wanted: Array<{ lineId: string; task: string }>;
  installed: Array<{ id: string; name: string; repo: string; path: string }>;
  categories: Array<{ id: PublicSkillCategory; label: string }>;
};
export type SkillCandidate = { name: string; repo: string; path: string; category: PublicSkillCategory; lines: string[]; why: string };
export type SkillScoutAnswer = { candidates: SkillCandidate[]; blockers: Array<{ code: string; message: string }> };

const str = (max: number) => ({ type: "string", minLength: 1, maxLength: max }) as const;
const object = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
export const SKILL_SCOUT_SCHEMA = object({
  candidates: { type: "array", maxItems: 8, items: object({
    name: str(80), repo: str(200), path: { type: "string", maxLength: 200 },
    category: { type: "string", enum: [...PUBLIC_SKILL_CATEGORIES] },
    lines: { type: "array", maxItems: 8, items: str(80) }, why: str(400)
  }) },
  blockers: { type: "array", maxItems: 4, items: object({ code: str(80), message: str(400) }) }
});

const GITHUB_REPO = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(\.git)?\/?$/;
export function parseGithubRepo(url: string): { owner: string; repo: string } | undefined {
  const match = GITHUB_REPO.exec(url.trim());
  return match && !match[2]!.startsWith(".") ? { owner: match[1]!, repo: match[2]! } : undefined;
}
/** A directory inside the repository, relative, with no way out of it. `""` is the repository root. */
export const safeRepoPath = (value: string): string | undefined => {
  const cleaned = value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return cleaned.split("/").some((part) => part === ".." || part === ".") || /[^A-Za-z0-9_.\-/ ]/.test(cleaned) ? undefined : cleaned;
};

export function validateSkillScout(value: unknown, context: SkillScoutContext): SkillScoutAnswer {
  const answer = value as SkillScoutAnswer;
  if (!answer || !Array.isArray(answer.candidates) || !Array.isArray(answer.blockers)) throw new Error("SKILL_SCOUT_SHAPE_INVALID");
  if (!answer.candidates.length && answer.blockers.length) {
    throw Object.assign(new Error("SKILL_SCOUT_BLOCKED"), { detail: answer.blockers.map((blocker) => blocker.message).join("；").slice(0, 400) });
  }
  const lineIds = new Set(context.lines.map((line) => line.id));
  const problems = answer.candidates.flatMap((candidate, index) => {
    const name = `第 ${index + 1} 个「${candidate.name}」`;
    return [
      ...(parseGithubRepo(candidate.repo) ? [] : [`${name}：repo 须为 https://github.com/<owner>/<repo>`]),
      ...(safeRepoPath(candidate.path) === undefined ? [`${name}：path 须为仓库内的相对目录`] : []),
      ...(candidate.lines.filter((id) => !lineIds.has(id)).length ? [`${name}：lines 只能是 ${[...lineIds].join("、")}`] : [])
    ];
  });
  if (problems.length) throw Object.assign(new Error("SKILL_SCOUT_CANDIDATE_INVALID"), { detail: problems.slice(0, 6).join("；") });
  return answer;
}
/** Repairs spent: the candidates that are well formed. */
export function keepSkillScout(value: unknown, context: SkillScoutContext): SkillScoutAnswer | undefined {
  const answer = value as SkillScoutAnswer;
  if (!answer || !Array.isArray(answer.candidates)) return undefined;
  const lineIds = new Set(context.lines.map((line) => line.id));
  const candidates = answer.candidates.filter((candidate) => parseGithubRepo(candidate.repo) && safeRepoPath(candidate.path) !== undefined)
    .map((candidate) => ({ ...candidate, lines: candidate.lines.filter((id) => lineIds.has(id)) }));
  return candidates.length ? { candidates, blockers: [] } : undefined;
}

// ── Review (crossline-validation-reviewer, subject public_skill) ─────────────────────────────────────────────────────────

export type PublicSkillVerdict = "usable" | "text_only" | "reject";
export type PublicSkillReview = { verdict: PublicSkillVerdict; reasons: string[] };
export const PUBLIC_SKILL_REVIEW_SCHEMA = object({
  verdict: { type: "string", enum: ["usable", "text_only", "reject"] },
  reasons: { type: "array", minItems: 1, maxItems: 8, items: str(300) }
});
export function validatePublicSkillReview(value: unknown): PublicSkillReview {
  const answer = value as PublicSkillReview;
  if (!answer || !["usable", "text_only", "reject"].includes(answer.verdict) || !Array.isArray(answer.reasons) || !answer.reasons.length) {
    throw Object.assign(new Error("SKILL_REVIEW_SHAPE_INVALID"), { detail: "verdict 为 usable、text_only 或 reject，reasons 至少一条" });
  }
  return answer;
}

/**
 * What is installed, from both checks: the model's verdict, capped by the scan. A risky script means at most text (scripts/ removed); an
 * injection statement means the text itself is not given to a model, so the skill is refused.
 */
export function finalVerdict(scan: SkillScan, review: PublicSkillReview): PublicSkillVerdict {
  if (review.verdict === "reject" || scan.injection) return "reject";
  if (scan.risk === "high") return "text_only";
  return review.verdict;
}

// ── The library record ──────────────────────────────────────────────────────────────────────────────────────────────────

export type PublicSkillRecord = {
  id: string; kind: "public"; name: string; description: string;
  lines: string[]; category: PublicSkillCategory;
  source: { repo: string; path: string; url: string };
  commit: string; license: string;
  files: Array<{ path: string; sha256: string; bytes: number }>;
  scan: SkillScan;
  review: PublicSkillReview & { final: PublicSkillVerdict };
  installedAt: string; updatedAt: string; lastUsedAt: string;
  why: string;
};

export function readSkillLibrary(raw: string | undefined): PublicSkillRecord[] {
  if (!raw) return [];
  try { const parsed = JSON.parse(raw) as PublicSkillRecord[]; return Array.isArray(parsed) ? parsed.filter((item) => item && item.kind === "public") : []; }
  catch { return []; }
}

/** A skill id from its name: lowercase, plain, unique among the ids already taken. */
export function publicSkillId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = `pub-${name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "skill"}`;
  let id = base, n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  return id;
}

/** Name and description from a SKILL.md's frontmatter; undefined when it has none (then it is not a skill). */
export function skillFrontmatter(text: string): { name: string; description: string } | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text.replace(/^\uFEFF/, ""));
  if (!match) return undefined;
  const field = (key: string) => {
    const line = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(match[1]!)?.[1]?.trim() ?? "";
    return line.replace(/^["']|["']$/g, "").trim();
  };
  const name = field("name"), description = field("description");
  return name && description ? { name, description } : undefined;
}

/** The installed SKILL.md: the frontmatter name replaced by the library id, so two published skills with one name cannot collide. */
export const renameSkill = (text: string, id: string) => text.replace(/^(\uFEFF?---\r?\n[\s\S]*?^name:\s*).*$/m, `$1${id}`);

/** Terms of a text for overlap: CJK pairs and Latin words. */
export const textTerms = (text: string) => terms(text);
/** Characters of overlap between what a skill says it does and a task: CJK pairs and Latin words. */
const terms = (text: string) => {
  const lower = text.toLowerCase();
  const words = lower.match(/[a-z][a-z0-9-]{2,}/g) ?? [];
  const han = [...lower.matchAll(/[\u4e00-\u9fff]+/g)].flatMap((run) => [...run[0]].slice(0, -1).map((char, index) => char + run[0][index + 1]));
  return new Set([...words, ...han]);
};
/** How well a library skill (public or grown) fits a task on a line: 0 when it is for other lines or shares nothing with the task. */
export function publicSkillRelevance(record: { name: string; description: string; category: string; lines: string[] }, lineId: string, task: string): number {
  if (record.lines.length && !record.lines.includes(lineId)) return 0;
  const wanted = terms(task);
  const have = terms(`${record.name} ${record.description} ${PUBLIC_SKILL_CATEGORY_LABEL[record.category as PublicSkillCategory] ?? ""} ${record.category}`);
  let shared = 0;
  for (const term of have) if (wanted.has(term)) shared += 1;
  return shared;
}
