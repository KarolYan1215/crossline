import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INTERVIEW_RULES } from "@crossline/core";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");
const count = (text: string, needle: string) => text.split(needle).length - 1;

describe("the interview's rule register", () => {
  it("gives every rule one id and a layer that matches where it lives", () => {
    const ids = INTERVIEW_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of INTERVIEW_RULES) {
      expect(rule.id).toMatch(/^IR-\d{3}$/);
      expect(rule.rule.trim()).not.toBe("");
      if (rule.status === "retired") continue;
      if (rule.layer === "L0") expect(rule.code, rule.id).toBeDefined();
      else expect(rule.text, rule.id).toBeDefined();
    }
  });

  it("says which code rules no test covers, and why", () => {
    for (const rule of INTERVIEW_RULES.filter((item) => item.code && !item.code.test)) expect(rule.code!.untested?.trim(), rule.id).toBeTruthy();
  });

  it("finds every active code rule in its file and in the test file that covers it", () => {
    const missing: string[] = [];
    for (const rule of INTERVIEW_RULES.filter((item) => item.status === "active" && item.code)) {
      const { file, symbol, test, by = symbol, untested } = rule.code!;
      if (!existsSync(join(ROOT, file)) || !read(file).includes(symbol)) missing.push(`${rule.id}: ${symbol} not in ${file}`);
      if (untested) continue;
      if (!test || !existsSync(join(ROOT, test)) || !read(test).includes(by)) missing.push(`${rule.id}: ${by} not in ${test}`);
    }
    expect(missing).toEqual([]);
  });

  it("finds every active text rule stated exactly once in its file", () => {
    const wrong = INTERVIEW_RULES.filter((item) => item.status === "active" && item.text)
      .map((rule) => ({ id: rule.id, times: count(read(rule.text!.file), rule.text!.anchor) })).filter((item) => item.times !== 1);
    expect(wrong).toEqual([]);
  });

  it("says why every retired rule went, and names only registered rules as its successor", () => {
    const ids = new Set(INTERVIEW_RULES.map((rule) => rule.id));
    for (const rule of INTERVIEW_RULES.filter((item) => item.status === "retired")) {
      expect(rule.reason?.trim(), rule.id).toBeTruthy();
      if (rule.replacedBy) expect(ids.has(rule.replacedBy), `${rule.id} → ${rule.replacedBy}`).toBe(true);
    }
  });

  it("keeps a retired code rule's symbol out of its file", () => {
    // Retiring a rule while its code still runs would be a rule nobody accounts for.
    for (const rule of INTERVIEW_RULES.filter((item) => item.status === "retired" && item.code)) {
      const { file, symbol } = rule.code!;
      if (!existsSync(join(ROOT, file))) continue;
      expect(new RegExp(`\b${symbol}\b`).test(read(file)), `${rule.id}: ${symbol} still in ${file}`).toBe(false);
    }
  });
});
