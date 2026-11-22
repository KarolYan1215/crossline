import { describe, expect, test } from "vitest";
import { PROFILE_ITEMS, type InstrumentAnswers } from "./profile-instruments";
import {
  readScaleAnalysis, readScaleSession, scaleAnalysisDue, scaleAnalysisInput, scaleBeforeInterview, scaleLedgerLines, scaleStatus, SCALE_PAGES,
  SELF_REPORTS_MAX
} from "./profile-scale";

const at = "2026-11-22T10:00:00.000Z";
const tapAll = (score: number) => Object.fromEntries(PROFILE_ITEMS.map((item) => [item.id, { itemId: item.id, score, by: "tapped" as const, at }])) as InstrumentAnswers;

describe("the scale page", () => {
  test("seven pages: six of the IPIP-NEO, one of TwIVI", () => {
    expect(SCALE_PAGES).toHaveLength(7);
    expect(SCALE_PAGES.slice(0, 6).every((page) => page.length === 20 && page.every((item) => item.instrument === "ipip_neo_120"))).toBe(true);
    expect(SCALE_PAGES[6]!.every((item) => item.instrument === "twivi")).toBe(true);
  });

  test("a stored session is read defensively: a page out of range opens the first, self-reports need a test and a result", () => {
    expect(readScaleSession("nonsense")).toEqual({ page: 0, supplement: "", selfReports: [] });
    const session = readScaleSession(JSON.stringify({ page: 3, supplement: "  我做题时很困  ", startedAt: at,
      selfReports: [{ test: "MBTI", result: "INTJ" }, { test: "", result: "x" }, ...Array.from({ length: 12 }, () => ({ test: "t", result: "r" }))] }));
    expect(session).toMatchObject({ page: 3, supplement: "我做题时很困", startedAt: at });
    expect(session.selfReports[0]).toEqual({ test: "MBTI", result: "INTJ" });
    expect(session.selfReports).toHaveLength(SELF_REPORTS_MAX);
    expect(readScaleSession(JSON.stringify({ page: 40 })).page).toBe(0);
  });

  test("the status, and whether the page comes before the interview: not when done, not when the person put it off", () => {
    expect(scaleStatus(readScaleSession(null), {})).toMatchObject({ state: "todo", answered: 0, total: 140, deferred: false });
    const deferred = readScaleSession(JSON.stringify({ deferredAt: at, startedAt: at }));
    expect(scaleStatus(deferred, {})).toMatchObject({ state: "in_progress", deferred: true });
    expect(scaleBeforeInterview(readScaleSession(null))).toBe(true);
    expect(scaleBeforeInterview(deferred)).toBe(false);
    const done = readScaleSession(JSON.stringify({ completedAt: at }));
    expect(scaleStatus(done, tapAll(3))).toMatchObject({ state: "done", answered: 140 });
    expect(scaleBeforeInterview(done)).toBe(false);
  });

  test("the analysis is owed once per completion, and the dialogue's lines carry scores, the box, self-reports and the analysis — never a type the system made", () => {
    const session = readScaleSession(JSON.stringify({ completedAt: at, supplement: "最近睡得少", selfReports: [{ test: "16 型人格", result: "INFP" }] }));
    expect(scaleAnalysisDue(session, undefined)).toBe(true);
    const analysis = readScaleAnalysis(JSON.stringify({ at, basedOn: at, text: "分析正文", hypotheses: [{ statement: "做事有计划", check: "看本周日程" }, { bad: 1 }] }));
    expect(analysis!.hypotheses).toEqual([{ id: "s1", statement: "做事有计划", check: "看本周日程" }]);
    expect(scaleAnalysisDue(session, analysis)).toBe(false);
    expect(scaleAnalysisDue({ ...session, completedAt: "2026-11-23T10:00:00.000Z" }, analysis)).toBe(true);
    const lines = scaleLedgerLines(tapAll(3), session, analysis);
    expect(lines[0]).toBe("量表：已做完（140/140 题）");
    expect(lines.some((line) => /^神经质|^情绪/.test(line) || line.includes("百分位"))).toBe(true);
    expect(lines).toContain("本人补充：最近睡得少");
    expect(lines).toContain("本人自述的其他测试结果：16 型人格 = INFP");
    expect(lines).toContain("待访谈验证 s1：做事有计划；看什么：看本周日程");
    const input = scaleAnalysisInput(tapAll(3), session);
    expect(input.domains).toHaveLength(5);
    expect(input.facets).toHaveLength(30);
    expect(input.values).toHaveLength(10);
    expect(input.selfReports).toEqual([{ test: "16 型人格", result: "INFP" }]);
  });
});
