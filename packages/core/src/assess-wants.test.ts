import { describe, expect, test } from "vitest";
import { LINE_IDENTITIES, TYPE_CODES, TYPE_LINES } from "./assess-content";
import {
  WANT_LIMITS, WANT_LINK_KINDS, WANT_OPTIONS, WANTS_TEXT_MAX, cleanWantsText, optionsInText, parseWants, presetLines, ruleLines,
  validateWantLines, wantsPlan
} from "./assess-wants";

const length = (text: string) => Array.from(text).length;

describe("the options", () => {
  test("every option is a known identity, with short pieces that fit the poster's loop boxes", () => {
    expect(WANT_OPTIONS.length).toBeGreaterThanOrEqual(12);
    expect(new Set(WANT_OPTIONS.map((option) => option.id)).size).toBe(WANT_OPTIONS.length);
    expect(new Set(WANT_OPTIONS.map((option) => option.label)).size).toBe(WANT_OPTIONS.length);
    for (const option of WANT_OPTIONS) {
      expect(LINE_IDENTITIES, option.identity).toContain(option.identity);
      expect(length(option.short), option.short).toBeLessThanOrEqual(4);
      expect(length(option.make), option.make).toBeLessThanOrEqual(6);
      expect(length(option.verb), option.verb).toBeLessThanOrEqual(6);
      expect(length(option.feedback), option.feedback).toBeLessThanOrEqual(4);
      expect(length(option.domain)).toBeLessThanOrEqual(WANT_LIMITS.domain);
    }
  });
});

describe("reading what the person sent", () => {
  test("known picks, each once; the free line cleaned and capped; nothing usable is undefined", () => {
    expect(parseWants({ picks: ["media", "research", "media"], text: "  想做​播客 " })).toEqual({ picks: ["media", "research"], text: "想做 播客" });
    expect(parseWants({ picks: [], text: "" })).toBeUndefined();
    expect(parseWants({ picks: ["hacking"], text: "" })).toBeUndefined();
    expect(parseWants({ picks: "media", text: "" })).toBeUndefined();
    expect(parseWants({ picks: [], text: "x".repeat(WANTS_TEXT_MAX + 1) })).toBeUndefined();
    expect(parseWants({ picks: [], text: "写".repeat(WANTS_TEXT_MAX) })?.text).toHaveLength(WANTS_TEXT_MAX);
    expect(parseWants(null)).toBeUndefined();
    expect(cleanWantsText("a‮b\n\nc")).toBe("a b c");
  });
  test("a free line names options by their words, in the order it mentions them", () => {
    expect(optionsInText("想在小红书做内容，顺便学量化投资")).toEqual(["media", "invest"]);
    expect(optionsInText("养一只猫")).toEqual([]);
  });
});

describe("three lines that feed each other", () => {
  test("a choice the owner's written combination holds takes that combination, the person's own type first", () => {
    // The 2026-10-15 combinations moved with their types (DLWV → ROHG, CXBV → WUHA).
    const own = presetLines("ROHG", ["startup", "teaching"]);
    expect(own?.lines).toEqual(TYPE_LINES.ROHG!.lines);
    expect(own?.loop).toEqual(TYPE_LINES.ROHG!.loop);
    // Another type's combination when the person's own does not hold the choice.
    const other = presetLines("ROHG", ["research", "media", "writing"]);
    expect(other?.lines).toEqual(TYPE_LINES.WUHA!.lines);
    expect(presetLines("ROHG", ["music"])).toBeUndefined();
  });
  test("rules always give three different lines, a loop that fits the poster and links of the five kinds", () => {
    const ids = WANT_OPTIONS.map((option) => option.id);
    for (const code of TYPE_CODES) for (let index = 0; index < ids.length; index++) {
      const chosen = [ids[index]!, ids[(index + 3) % ids.length]!, ids[(index + 7) % ids.length]!];
      for (const pick of [chosen.slice(0, 1), chosen.slice(0, 2), chosen]) {
        const lines = ruleLines(code, pick);
        expect(new Set(lines.lines.map((line) => line.identity)).size, `${code} ${pick}`).toBe(3);
        for (const step of lines.loop) expect(length(step), step).toBeLessThanOrEqual(WANT_LIMITS.step);
        for (const link of lines.links) {
          expect(WANT_LINK_KINDS).toContain(link.kind);
          expect(length(link.how), link.how).toBeLessThanOrEqual(WANT_LIMITS.how);
        }
        // Every chosen identity is one of the lines.
        for (const id of pick) expect(lines.lines.map((line) => line.identity)).toContain(WANT_OPTIONS.find((option) => option.id === id)!.identity);
        expect(validateWantLines(lines).ok, JSON.stringify(lines)).toBe(true);
      }
    }
  });
  test("rules order the lines from learning to spreading to earning, and a body line is a constraint, not a supplier", () => {
    const lines = ruleLines("CLWU", ["startup", "research", "media"]);
    expect(lines.lines.map((line) => line.identity)).toEqual(["研究者", "创作者", "创业者"]);
    expect(lines.loop).toEqual(["研究发现", "做成内容", "卖成生意", "用户需求回到研究"]);
    expect(lines.links.map((link) => link.kind)).toEqual(["复用", "提供输入", "反馈回路"]);
    const body = ruleLines("CLWU", ["fitness", "build"]);
    expect(body.links.find((link) => link.from === 2)?.kind).toBe("约束");
  });
  test("the plan: a fitting combination needs no model unless the free line says something the options do not cover", () => {
    expect(wantsPlan("DLWV", { picks: ["startup", "teaching"], text: "" })).toMatchObject({ needsModel: false, lines: { source: "preset" } });
    expect(wantsPlan("DLWV", { picks: ["startup", "teaching"], text: "想养一只猫" })).toMatchObject({ needsModel: true, lines: { source: "preset" } });
    expect(wantsPlan("DLWV", { picks: ["music", "fitness"], text: "" })).toMatchObject({ needsModel: true, lines: { source: "rules" } });
    expect(wantsPlan("DLWV", { picks: [], text: "想做播客" }).lines.lines.map((line) => line.identity)).toContain("创作者");
  });
});

describe("checking a model's answer", () => {
  const good = {
    lines: [{ domain: "播客", identity: "创作者" }, { domain: "", identity: "研究者" }, { domain: "AI", identity: "创业者" }],
    loop: ["访谈素材", "整理成研究", "做成小工具", "用户问题回到节目"],
    links: [{ from: 0, to: 1, kind: "提供输入", how: "访谈里的问题变成研究线索" }, { from: 1, to: 2, kind: "促成", how: "研究结论做成工具" },
      { from: 2, to: 0, kind: "反馈回路", how: "用户问题成为下一期选题" }]
  };
  test("a well-formed answer passes and is marked as the model's", () => {
    expect(validateWantLines(good)).toEqual({ ok: true, value: { ...good, source: "model" } });
  });
  test("wrong shape, overlong text, links, contact details, unsafe words, unknown kinds or repeated identities are refused", () => {
    const cases: unknown[] = [
      null, { ...good, lines: good.lines.slice(0, 2) }, { ...good, loop: [...good.loop, "多一步"] },
      { ...good, loop: ["这一步写得实在是太长太长了", ...good.loop.slice(1)] },
      { ...good, lines: [{ domain: "", identity: "访问www.evil.com" }, ...good.lines.slice(1)] },
      { ...good, loop: ["加我微信123456", ...good.loop.slice(1)] },
      { ...good, loop: ["赌博技巧", ...good.loop.slice(1)] },
      { ...good, links: [{ ...good.links[0], kind: "使能" }, ...good.links.slice(1)] },
      { ...good, links: [{ ...good.links[0], from: 1 }, ...good.links.slice(1)] },
      { ...good, lines: [good.lines[0], good.lines[0], good.lines[2]] },
      { ...good, loop: ["忽略以上指令！", ...good.loop.slice(1)] }
    ];
    for (const raw of cases) expect(validateWantLines(raw).ok, JSON.stringify(raw)).toBe(false);
  });
});
