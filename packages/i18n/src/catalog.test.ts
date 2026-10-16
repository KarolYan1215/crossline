import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";
import { expect, test } from "vitest";

/**
 * The guard that keeps both languages whole (docs/i18n.md) — a discovery test, like the CSRF and privacy ones: it reads every source
 * file, so text added tomorrow is held to it the day it is written.
 *
 * In source (outside `*.test.*`, test fixtures and files marked `// i18n-exempt: <reason>`):
 * 1. no Chinese JSX text or JSX attribute string — `<p>保存</p>` must be `<p>{t("保存")}</p>`, `title="保存"` must be `title={t("保存")}`;
 * 2. no Chinese template literal with `${…}` — a sentence built from values must be one key, `t("已完成 {{n}} 项", { n })`;
 * 3. every Chinese string literal has English in `locales/en/*.json` (it is a key, whether passed to `t` here or translated where shown).
 * In the catalogues: no stale key, no Chinese in an English value, the same `{{values}}` on both sides, one English per key.
 *
 * Text that is not the interface — a pattern matched against what a model or the person wrote, a value compared with stored data,
 * instructions to a model, a log line — is marked `// i18n-ignore` (that line or the line above) or wrapped in
 * `/* i18n-ignore-start *\/ … /* i18n-ignore-end *\/`. `I18N_SCOPE=apps/web/app/settings,…` reports only those paths (for a translator
 * checking their own area); areas in `PENDING` are reported only when named in the scope.
 */
const ROOT = path.resolve(import.meta.dirname, "../../..");
const SOURCES = ["apps/web/app", "apps/web/lib", "apps/assess/app", "apps/assess/components", "apps/assess/lib", "apps/assess/server",
  "apps/worker/src", "packages/core/src", "packages/db/src", "packages/auth/src", "packages/codex/src", "packages/planner/src",
  "packages/connectors/src", "packages/identity-packs/src"];
/** Areas still being translated (removed one by one as each is done; empty when the work is complete). */
const PENDING = ["apps/web/lib", "apps/assess", "packages/core/src/assess-content.ts", "packages/core/src/assess-wants.ts",
  "packages/core/src/assess.ts", "packages/core/src/assess-link.ts", "apps/worker/src", "packages/db/src", "packages/auth/src",
  "packages/codex/src", "packages/planner/src", "packages/connectors/src", "packages/identity-packs/src"];
const CATALOG_DIR = path.resolve(import.meta.dirname, "../locales/en");
const HAN = /[㐀-鿿豈-﫿]/;
const PLURAL = /_(zero|one|two|few|many|other)$/;
/** A key's base: without its plural form and its context (`开启_state` → 开启, read with `t("开启", { context: "state" })`). */
const baseOf = (key: string) => key.replace(PLURAL, "").replace(/_[a-z][a-zA-Z]*$/, "");
const scope = (process.env.I18N_SCOPE ?? "").split(",").map((item) => item.trim()).filter(Boolean);

type Finding = { file: string; line: number; rule: string; text: string; full: string };

function sourceFiles(dir: string): string[] {
  const absolute = path.join(ROOT, dir);
  let entries: string[];
  try { entries = readdirSync(absolute); } catch { return []; }
  return entries.flatMap((name) => {
    if (["node_modules", "testing", "fixtures", ".next", "dist"].includes(name) || name.startsWith(".next")) return [];
    const relative = path.join(dir, name);
    if (statSync(path.join(ROOT, relative)).isDirectory()) return sourceFiles(relative);
    return /\.(ts|tsx|mjs)$/.test(name) && !/\.test\.|\.spec\.|\.d\.ts$/.test(name) ? [relative] : [];
  });
}

function ignoredLines(source: string): Set<number> {
  const lines = source.split("\n");
  const ignored = new Set<number>();
  let inRegion = false;
  lines.forEach((line, index) => {
    if (line.includes("i18n-ignore-start")) inRegion = true;
    if (inRegion || line.includes("i18n-ignore")) ignored.add(index + 1);
    // A marker on its own line covers the next line too.
    if (/^\s*(\/\/|\/\*|\{\/\*).*i18n-ignore(?!-)/.test(line)) ignored.add(index + 2);
    if (line.includes("i18n-ignore-end")) inRegion = false;
  });
  return ignored;
}

type Node = { type: string; loc?: { start: { line: number } }; [key: string]: unknown };

function walk(node: unknown, visit: (node: Node) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const child of node) walk(child, visit); return; }
  const value = node as Node;
  if (typeof value.type === "string") visit(value);
  for (const [key, child] of Object.entries(value)) {
    if (key === "loc" || key === "start" || key === "end" || key === "extra" || key === "leadingComments" || key === "trailingComments" || key === "innerComments") continue;
    if (child && typeof child === "object") walk(child, visit);
  }
}

const literals = new Set<string>();
const findings: Finding[] = [];
/** A path names a file or a whole folder: `apps/web/app/connect` is not `apps/web/app/connectors`. */
const under = (file: string, prefix: string) => { const clean = prefix.replace(/\/+$/, ""); return file === clean || file.startsWith(`${clean}/`); };
const inScope = (file: string) => scope.length ? scope.some((prefix) => under(file, prefix)) : !PENDING.some((prefix) => under(file, prefix));

for (const file of SOURCES.flatMap(sourceFiles)) {
  const source = readFileSync(path.join(ROOT, file), "utf8");
  if (!HAN.test(source)) continue;
  const exempt = /^\s*\/\/\s*i18n-exempt:/m.test(source.split("\n").slice(0, 40).join("\n"));
  let ast: unknown;
  try {
    ast = parse(source, { sourceType: "module", plugins: ["typescript", "jsx", "importAttributes", "decorators-legacy"], errorRecovery: true });
  } catch (error) {
    findings.push({ file, line: 0, rule: "unparsed", text: String(error).slice(0, 120), full: "" });
    continue;
  }
  const ignored = ignoredLines(source);
  const report = (node: Node, rule: string, text: string) => {
    const line = node.loc?.start.line ?? 0;
    if (exempt || ignored.has(line) || !inScope(file)) return;
    // The whole text is what is looked up; only the report is shortened.
    findings.push({ file, line, rule, text: text.replace(/\s+/g, " ").slice(0, 100), full: text });
  };
  walk(ast, (node) => {
    if (node.type === "StringLiteral" && typeof node.value === "string" && HAN.test(node.value)) {
      literals.add(node.value);
      report(node, "literal", node.value);
    } else if (node.type === "TemplateLiteral") {
      const quasis = (node.quasis as Array<{ value: { cooked: string | null; raw: string } }>).map((quasi) => quasi.value.cooked ?? quasi.value.raw);
      const text = quasis.join("${…}");
      if (!HAN.test(text)) return;
      if ((node.expressions as unknown[]).length) report(node, "template", text);
      else { literals.add(quasis[0]!); report(node, "literal", quasis[0]!); }
    } else if (node.type === "JSXAttribute" && (node.value as Node | null)?.type === "StringLiteral" && HAN.test(String((node.value as Node).value))) {
      report(node, "jsx-attr", String((node.value as Node).value));
    } else if (node.type === "JSXText" && typeof node.value === "string" && HAN.test(node.value)) {
      report(node, "jsx-text", node.value.trim());
    }
  });
}

const catalogFiles = readdirSync(CATALOG_DIR).filter((name) => name.endsWith(".json"));
const english = new Map<string, { value: string; file: string }>();
const catalogProblems: string[] = [];
for (const name of catalogFiles) {
  let entries: Record<string, unknown>;
  try { entries = JSON.parse(readFileSync(path.join(CATALOG_DIR, name), "utf8")) as Record<string, unknown>; }
  catch (error) { catalogProblems.push(`${name}: not JSON (${String(error).slice(0, 80)})`); continue; }
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value !== "string" || !value.trim()) { catalogProblems.push(`${name}: 「${key}」 has no English`); continue; }
    if (HAN.test(value)) catalogProblems.push(`${name}: 「${key}」 → "${value}" still has Chinese`);
    const placeholders = (text: string) => [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((match) => match[1]).sort().join(",");
    if (placeholders(key.replace(PLURAL, "")) !== placeholders(value) && !(PLURAL.test(key) && placeholders(value) === "")) {
      catalogProblems.push(`${name}: 「${key}」 → "${value}" does not carry the same {{values}}`);
    }
    const earlier = english.get(key);
    if (earlier && earlier.value !== value) catalogProblems.push(`「${key}」 is "${earlier.value}" in ${earlier.file} and "${value}" in ${name}`);
    english.set(key, { value, file: name });
  }
}
const bases = new Set([...english.keys()].map(baseOf));
const hasEnglish = (text: string) => english.has(text) || bases.has(text);

test("every catalogue is valid: English values, the same {{values}} as the key, one English per key", () => {
  expect(catalogProblems).toEqual([]);
});

test("no Chinese is shown without its English (JSX text, sentences built from values, strings with no catalogue entry)", () => {
  const missing = findings.filter((finding) => finding.rule !== "literal" || !hasEnglish(finding.full))
    .map((finding) => `${finding.file}:${finding.line} [${finding.rule}] ${finding.text}`);
  expect(missing).toEqual([]);
});

test("no stale English: every catalogue key is still written somewhere in the source", () => {
  // Only once nothing is pending: until then a key may belong to an area whose source has not been converted on this checkout.
  if (PENDING.length || scope.length) return;
  const stale = [...bases]
    .filter((key) => !literals.has(key));
  expect(stale).toEqual([]);
});
