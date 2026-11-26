import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { RULE_IDS, RULE_SPEC, isRuleId } from "../packages/core/src/rule-spec";

// In scripts/ (not packages/core) because it reads files: packages/core is typechecked without Node's types.
const repoRoot = path.resolve(import.meta.dirname, "..");
const srcDir = path.join(repoRoot, "packages", "core", "src");
const BASELINE = path.join(srcDir, "rule-spec.baseline.json");

/** Every .ts under packages/core/src except tests, as repo-relative paths with forward slashes. */
function sourceFiles(dir = srcDir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path.relative(repoRoot, full).split(path.sep).join("/")] : [];
  });
}

const TAG = /rule: ([a-z0-9-]+\.[a-z0-9.-]*[a-z0-9])/g;
/** The rule ids a line's `//` comment names (`// rule: a.b`, `// i18n-ignore; rule: a.b`). */
const tagsIn = (line: string) => { const at = line.indexOf("//"); return at < 0 ? [] : [...line.slice(at).matchAll(TAG)].map((match) => match[1]!); };
const CJK = /[㐀-鿿]/u;
// A regex literal: after an operator, a bracket, `return` or the start of a line; classes and escapes may hold a slash.
const LITERAL = /(?:^|[=(,:[!&|?{};>]|\breturn)\s*(\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+\/[dgimsuyv]*)/g;

type Found = { file: string; line: number; literal: string; tagged: boolean };

/** Regex literals that hold a Chinese character and an alternation: the shape of a word list over natural language. */
function chineseAlternations(): Found[] {
  const out: Found[] = [];
  for (const file of sourceFiles()) {
    const lines = readFileSync(path.join(repoRoot, file), "utf8").split(/\r?\n/);
    lines.forEach((text, index) => {
      const trimmed = text.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
      const near = [lines[index - 1] ?? "", text];
      const tagged = near.some((line) => /\/\/.*not-nl:/.test(line) || tagsIn(line).some(isRuleId));
      for (const match of text.matchAll(LITERAL)) {
        const literal = match[1]!;
        if (CJK.test(literal) && literal.includes("|")) out.push({ file, line: index + 1, literal, tagged });
      }
    });
  }
  return out;
}

const keyOf = (found: Pick<Found, "file" | "literal">) => `${found.file}::${found.literal}`;

describe("RULE_SPEC", () => {
  test("every entry is complete, and a fallback says when it goes", () => {
    for (const id of RULE_IDS) {
      const spec = RULE_SPEC[id];
      expect(["invariant", "evidence", "semantic", "style", "money"], id).toContain(spec.kind);
      expect(["enforce", "record", "fallback"], id).toContain(spec.mode);
      expect(spec.what.length, id).toBeGreaterThan(10);
      expect(spec.readers.length, id).toBeGreaterThan(5);
      expect(spec.retire.length, id).toBeGreaterThan(10);
      if (spec.kind === "money" || spec.kind === "invariant") expect(spec.mode, `${id} is never ablated`).toBe("enforce");
    }
  });

  test("every entry is anchored by a `rule: <id>` comment in its own file", () => {
    for (const id of RULE_IDS) {
      const file = path.join(repoRoot, RULE_SPEC[id].file);
      expect(existsSync(file), `${id}: ${RULE_SPEC[id].file}`).toBe(true);
      expect(readFileSync(file, "utf8"), `${id} has no // rule: ${id} in ${RULE_SPEC[id].file}`).toContain(`rule: ${id}`);
    }
  });

  test("every `rule: <id>` comment names a registered rule", () => {
    const stale = sourceFiles().flatMap((file) => readFileSync(path.join(repoRoot, file), "utf8").split(/\r?\n/).flatMap(tagsIn)
      .filter((id) => !isRuleId(id)).map((id) => `${file}: ${id}`));
    expect(stale).toEqual([]);
  });

  /**
   * The lint (docs/claude/operational-scripts.md 「规则登记」): a Chinese alternation regex added to packages/core/src must be registered
   * (`// rule: <id>` on its line or the line above) or say `// not-nl: <why>`. The literals already there on 2026-11-25 are the
   * baseline; regenerate it only when retiring or registering in bulk: `CROSSLINE_RULE_BASELINE=update pnpm vitest run scripts/rule-spec-lint.test.ts`.
   */
  test("no new unregistered Chinese alternation regex in packages/core/src", () => {
    const found = chineseAlternations();
    const untagged = found.filter((item) => !item.tagged);
    if (process.env.CROSSLINE_RULE_BASELINE === "update") {
      writeFileSync(BASELINE, `${JSON.stringify([...new Set(untagged.map(keyOf))].sort(), null, 1)}\n`, "utf8");
    }
    const baseline = new Set(JSON.parse(readFileSync(BASELINE, "utf8")) as string[]);
    const fresh = untagged.filter((item) => !baseline.has(keyOf(item))).map((item) => `${item.file}:${item.line} ${item.literal.slice(0, 80)}`);
    expect(fresh, "register these in RULE_SPEC with // rule: <id>, or mark // not-nl: <why>").toEqual([]);
    // The scanner still sees what it was written for.
    expect(found.some((item) => item.file.endsWith("completion.ts") && item.literal.includes("考试"))).toBe(true);
  });
});
