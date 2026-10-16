import { describe, expect, test } from "vitest";
import "@crossline/i18n/catalog/assess";
import { LIKERT, QUIZ_ITEMS } from "./assess";
import { RELATIONS, TYPE_LINES, TYPE_SUBTITLE, lineText, localizeLine, localizeRelation } from "./assess-content";
import {
  WANT_LIMITS, WANT_LIMITS_EN, WANT_OPTIONS, WANTS_TEXT_MAX, WANTS_TEXT_MAX_EN, optionsInText, parseWants, presetLines, ruleLines, validateWantLines,
  wantLabel, wantsPlan
} from "./assess-wants";
import { tFor } from "./i18n";

const en = tFor("en");
const HAN = /[㐀-鿿]/;

describe("the quick test in English", () => {
  test("every statement, answer, subtitle, line, loop step and relation has English, and the type tables stay Chinese", () => {
    for (const item of QUIZ_ITEMS) expect(HAN.test(en(item.text)), item.text).toBe(false);
    expect(LIKERT.map((label) => en(label))).toEqual(["Strongly disagree", "Disagree", "Not sure", "Agree", "Strongly agree"]);
    for (const subtitle of Object.values(TYPE_SUBTITLE)) expect(HAN.test(en(subtitle)), subtitle).toBe(false);
    for (const lines of Object.values(TYPE_LINES)) {
      for (const line of [...lines.lines, ...lines.more.flat()]) expect(HAN.test(lineText(line, "en")), lineText(line)).toBe(false);
      for (const step of lines.loop) expect(HAN.test(en(step)), step).toBe(false);
    }
    for (const relation of Object.values(RELATIONS)) expect(HAN.test(JSON.stringify(localizeRelation(relation, "en"))), relation.name).toBe(false);
    expect(TYPE_LINES.SEMP!.lines[0]).toEqual({ domain: "人工智能", identity: "研究者" });
  });

  test("a line reads field-first in English and unchanged in Chinese", () => {
    expect(lineText({ domain: "人工智能", identity: "研究者" }, "en")).toBe("AI researcher");
    expect(lineText({ domain: "人工智能", identity: "研究者" })).toBe("人工智能的研究者");
    expect(lineText({ domain: "二次元", identity: "coser" })).toBe("二次元的 coser");
    expect(lineText({ domain: "", identity: "医生" }, "en")).toBe("Doctor");
    expect(localizeLine({ domain: "马拉松", identity: "跑者" }, "en")).toEqual({ domain: "Marathon", identity: "Runner" });
    expect(wantLabel("media", "en")).toBe("Media");
  });

  test("the rules and the written combinations write English for an English page, and Chinese exactly as before otherwise", () => {
    const zh = ruleLines("GEMA", ["research", "media", "startup"]);
    expect(zh.loop).toEqual(["研究发现", "做成内容", "卖成生意", "用户需求回到研究"]);
    expect(zh.links.map((link) => link.how)).toEqual(["研究发现成为内容的素材", "内容给生意带来输入", "用户需求回到研究"]);
    expect(zh.locale).toBeUndefined();
    const english = ruleLines("GEMA", ["research", "media", "startup"], "en");
    expect(english.locale).toBe("en");
    expect(english.lines.map((line) => line.identity)).toEqual(["Researcher", "Creator", "Entrepreneur"]);
    expect(english.loop).toEqual(["Findings", "Made into content", "Sold as a business", "User needs back to research"]);
    expect(english.links.map((link) => link.how)).toEqual(["Findings as raw material for content", "Content gives business new input", "User needs back to research"]);
    // The relation kind stays the Chinese label every set keeps; it is translated where it is shown.
    expect(english.links.map((link) => link.kind)).toEqual(zh.links.map((link) => link.kind));
    for (const text of [...english.loop, ...english.links.map((link) => link.how)]) expect(HAN.test(text), text).toBe(false);
    const body = ruleLines("SEMP", ["fitness", "writing"], "en");
    expect(body.links.some((link) => /takes time but keeps|Make time for/.test(link.how))).toBe(true);
    const preset = presetLines("SEMP", ["research", "startup"], "en")!;
    expect(preset.lines[0]).toEqual({ domain: "AI", identity: "Researcher" });
    expect(preset.links[0]!.how).toBe("Code from research, then shipped as a tool");
    expect(presetLines("SEMP", ["research", "startup"])!.links[0]!.how).toBe("课题里的代码，接着做成工具上架");
    expect(wantsPlan("GEMA", { picks: ["build"], text: "start a podcast" }, "en").lines.lines.map((line) => line.identity)).toContain("Developer");
  });

  test("a free line in English names options by whole words; Chinese is read as before", () => {
    expect(optionsInText("I want to start a podcast and get into investing")).toEqual(["media", "invest"]);
    expect(optionsInText("build a guide")).toEqual([]);
    expect(optionsInText("learn japanese for my phd")).toEqual(["language", "research"]);
    expect(optionsInText("想做app")).toEqual(["build"]);
    expect(optionsInText("想在小红书做内容，顺便学量化投资")).toEqual(["media", "invest"]);
    expect(WANT_OPTIONS.every((option) => option.keywords.some((word) => /^[a-z]/.test(word)))).toBe(true);
  });

  test("an English line may be twice as long", () => {
    expect(parseWants({ picks: [], text: "x".repeat(WANTS_TEXT_MAX + 1) })).toBeUndefined();
    expect(parseWants({ picks: [], text: "x".repeat(WANTS_TEXT_MAX_EN) }, "en")?.text).toHaveLength(WANTS_TEXT_MAX_EN);
    expect(parseWants({ picks: [], text: "x".repeat(WANTS_TEXT_MAX_EN + 1) }, "en")).toBeUndefined();
  });

  test("a model's English answer is held to English lengths, English kinds are read as the Chinese labels, and English unsafe words are refused", () => {
    const answer = {
      lines: [{ domain: "Climate", identity: "Researcher" }, { domain: "Science", identity: "Creator" }, { domain: "", identity: "Community host" }],
      loop: ["Field notes", "Explainer videos", "Monthly meetups", "Members' questions back"],
      links: [{ from: 0, to: 1, kind: "Reuses", how: "Field notes become scripts" }, { from: 1, to: 2, kind: "informs", how: "Viewers join the meetups" },
        { from: 2, to: 0, kind: "Feedback loop", how: "Questions shape the next study" }]
    };
    const read = validateWantLines(answer, "en");
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value.links.map((link) => link.kind)).toEqual(["复用", "提供输入", "反馈回路"]);
      expect(read.value.locale).toBe("en");
    }
    // The same answer read as Chinese: too long, and the apostrophe is not allowed there.
    expect(validateWantLines(answer).ok).toBe(false);
    expect(WANT_LIMITS_EN.step).toBeGreaterThan(WANT_LIMITS.step);
    const unsafe = { ...answer, loop: ["Field notes", "Online casino", "Monthly meetups", "Questions back"] };
    expect(validateWantLines(unsafe, "en").ok).toBe(false);
    const contact = { ...answer, links: [{ ...answer.links[0], how: "DM me on telegram" }, answer.links[1], answer.links[2]] };
    expect(validateWantLines(contact, "en").ok).toBe(false);
  });
});
