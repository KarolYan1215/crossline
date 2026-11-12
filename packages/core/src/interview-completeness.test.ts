import { describe, expect, it } from "vitest";
import { COMPLETENESS_PARTS, HYPOTHESES_WANTED, interviewCompleteness } from "./interview-completeness";

const allDimensions = ["D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9"].map((id) => ({ id, evidenced: true }));

describe("interviewCompleteness", () => {
  it("is off below the lower bound and says what the start standard lacks", () => {
    const result = interviewCompleteness({ lowerBound: false, lowerMissing: ["学生线的每周可用时间"], stagesSeen: [...COMPLETENESS_PARTS], dimensions: allDimensions });
    expect(result).toEqual({ lowerBound: false, score: 0, full: false, missing: ["学生线的每周可用时间"] });
  });

  it("fills with parts walked, dimensions evidenced, hypotheses settled and a career with a trial, and is full only when all are", () => {
    const partial = interviewCompleteness({ lowerBound: true, stagesSeen: ["narrative", "compass"], dimensions: allDimensions.slice(0, 5),
      hypotheses: [{ status: "open" }, { status: "supported" }] });
    expect(partial.full).toBe(false);
    expect(partial.score).toBeGreaterThan(0);
    expect(partial.score).toBeLessThan(1);
    expect(partial.missing).toContain("还没谈到「能量」");
    expect(partial.missing).toContain("还有 1 条推断没有验证或推翻");
    expect(partial.missing).toContain("还没有带试做的职业方向");

    const full = interviewCompleteness({ lowerBound: true, stagesSeen: [...COMPLETENESS_PARTS], dimensions: allDimensions,
      hypotheses: Array.from({ length: HYPOTHESES_WANTED }, (_, index) => ({ status: index % 2 ? "refuted" : "undecided" })),
      careers: [{ trial: { task: "四周内复现一篇论文的性能模型" } }] });
    expect(full).toEqual({ lowerBound: true, score: 1, full: true, missing: [] });
  });

  it("never reads full on the lower bound alone", () => {
    const result = interviewCompleteness({ lowerBound: true, stagesSeen: [] });
    expect(result.full).toBe(false);
    expect(result.score).toBe(0);
  });
});
