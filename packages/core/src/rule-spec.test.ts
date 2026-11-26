import { afterEach, describe, expect, test } from "vitest";
import { completionRule } from "./completion";
import { opportunityCategory } from "./feasibility";
import { moneyEventFromMail, EMPTY_MONEY_READING } from "./money-events";
import { parseRuleModes, ruleFired, ruleMode, setRuleModes, setRuleSink, type RuleFiredLine } from "./rule-spec";

// The register's completeness and the lint over packages/core/src read files: scripts/rule-spec-lint.test.ts.
// packages/core is typechecked without Node's types, so the environment is reached through globalThis, as rule-spec.ts reads it.
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;

describe("modes and firings", () => {
  const lines: RuleFiredLine[] = [];
  afterEach(() => { setRuleModes(undefined); setRuleSink(undefined); lines.length = 0; delete env.CROSSLINE_RULE_MODE; });

  test("an override changes a rule's mode, never a money or invariant rule's", () => {
    expect(parseRuleModes("completion.legacy-title=record, nope=record, money.veto=bogus")).toEqual({ "completion.legacy-title": "record" });
    env.CROSSLINE_RULE_MODE = "completion.legacy-title=record,money.veto=record,activity.private-window=record";
    expect(ruleMode("completion.legacy-title")).toBe("record");
    expect(ruleMode("money.veto")).toBe("enforce");
    expect(ruleMode("activity.private-window")).toBe("enforce");
    setRuleModes({ "completion.legacy-title": "fallback" });
    expect(ruleMode("completion.legacy-title")).toBe("fallback");
  });

  test("a firing with a key is written once per process; without a sink nothing happens", () => {
    ruleFired("rough.starts-words", { key: "a" });
    setRuleSink((line) => lines.push(line));
    ruleFired("rough.starts-words", { key: "a", sample: "x".repeat(300) });
    ruleFired("rough.starts-words", { key: "a" });
    ruleFired("rough.starts-words", { key: "b" });
    expect(lines.map((line) => line.key)).toEqual(["a", "b"]);
    expect(lines[0]).toMatchObject({ type: "rule.fired", id: "rough.starts-words", kind: "semantic", mode: "enforce", applied: true });
    expect(String(lines[0]!.sample)).toHaveLength(120);
  });

  test("the completion fallback fires only without the model's judgement, and under `record` gives the neutral rule", () => {
    setRuleSink((line) => lines.push(line));
    const exam = { intent: "ECE 555 期中考试", payload: { title: "ECE 555 期中考试" } };
    expect(completionRule(exam)).toMatchObject({ mode: "needs_assessment", reason: "result_pending", by: "rule" });
    expect(completionRule({ ...exam, payload: { ...exam.payload, completion: { mode: "self_evident", why: "交付即完成" } } })).toMatchObject({ by: "model" });
    expect(lines.map((line) => [line.id, line.verdict])).toEqual([["completion.legacy-title", "result_pending"]]);
    setRuleModes({ "completion.legacy-title": "record" });
    expect(completionRule({ intent: "ECE 555 期末考试", payload: { title: "ECE 555 期末考试" } })).toMatchObject({ mode: "self_evident", by: "rule" });
    expect(lines.at(-1)).toMatchObject({ id: "completion.legacy-title", verdict: "result_pending", applied: false });
  });

  test("the opportunity category guess is a fallback for a missing `category`", () => {
    setRuleSink((line) => lines.push(line));
    expect(opportunityCategory({ kind: "event", title: "Badger Hacks 黑客松", category: "local_event" })).toBe("local_event");
    expect(opportunityCategory({ kind: "event", title: "Badger Hacks 黑客松" })).toBe("competition");
    setRuleModes({ "opportunity.far-words": "record" });
    expect(opportunityCategory({ kind: "event", title: "IEEE 年会 conference" })).toBe("local_event");
    expect(lines.map((line) => line.verdict)).toEqual(["competition", "conference"]);
  });

  test("the money veto is counted, not changed", () => {
    setRuleSink((line) => lines.push(line));
    env.CROSSLINE_RULE_MODE = "money.veto=record";
    const verdict = moneyEventFromMail({ ...EMPTY_MONEY_READING, event: "charge", amount: 12.5, currency: "USD", merchant: "Shop" },
      { subject: "Payment pending: $12.50", body: "Total: $12.50", date: "2026-11-20T00:00:00Z", fromAddress: "a@shop.com" });
    expect(verdict).toMatchObject({ book: false, reason: "vetoed" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ id: "money.veto", where: "subject", applied: true });
    expect(JSON.stringify(lines[0])).not.toContain("12.5");
  });
});
