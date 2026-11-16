import { expect, test } from "vitest";
import { standingLines, type StandingRound } from "./onboarding-standing";

const ORDER = ["narrative", "compass", "energy", "situation", "orientation", "lines"];
const round = (stage: string, questions = 2, cards = 0, verdicts: StandingRound["verdicts"] = []): StandingRound => ({ stage, questions, cards, verdicts });
const evidenced = Array.from({ length: 10 }, (_, index) => ({ id: `D${index}`, evidenced: true }));

test("before the start standard stands the header says what it lacks and nothing about ready_for_milestones", () => {
  const lines = standingLines({ rounds: [], stage: "narrative", stageOrder: ORDER, startMetRound: null, startMissing: ["每周可用时间"], profile: {} });
  expect(lines).toEqual([
    "这是第 1 轮；当前阶段 narrative 连这一轮已经 1 轮。",
    "阶段：走过 narrative；还没走 compass、energy、situation、orientation、lines。",
    "开始标准：还没齐，缺 每周可用时间。"
  ]);
});

test("replay 15's round 45: the rounds in the part, the part never walked, what ready still lacks and the latest cards", () => {
  const rounds = [round("narrative"), round("compass"), round("energy"), round("situation"),
    ...Array.from({ length: 28 }, () => round("lines")), round("lines", 1, 1, ["partial"]), round("lines", 1, 2, ["fits"]), round("lines", 1, 1, ["off"])];
  const lines = standingLines({ rounds, stage: "lines", stageOrder: ORDER, startMetRound: 8, startMissing: [],
    profile: { dimensions: evidenced, hypotheses: Array.from({ length: 5 }, () => ({ status: "supported" })), careers: [{ trial: { task: "投一份运营实习" } }] } });
  expect(lines[0]).toBe("这是第 36 轮；当前阶段 lines 连这一轮已经 32 轮。");
  expect(lines[1]).toBe("阶段：走过 narrative、compass、energy、situation、lines；还没走 orientation。");
  expect(lines[2]).toBe("开始标准：从第 8 轮起已齐，本人可以按「结束并出报告」。");
  expect(lines[3]).toBe("ready_for_milestones 还差：还没谈到「主线」。");
  expect(lines[4]).toBe("最近 3 轮：每轮题数 1、1、1；出卡 4 张（本人评：准 1、部分对 1、不准 1、未评 1）。");
});

test("with every condition met the header says so", () => {
  const lines = standingLines({ rounds: ORDER.map((stage) => round(stage)), stage: "lines", stageOrder: ORDER, startMetRound: 3, startMissing: [],
    profile: { dimensions: evidenced, hypotheses: Array.from({ length: 5 }, () => ({ status: "refuted" })), careers: [{ trial: { task: "试写一篇" } }] } });
  expect(lines).toContain("阶段：走过 narrative、compass、energy、situation、orientation、lines；全部走过。");
  expect(lines).toContain("ready_for_milestones 的条件全部齐了。");
  expect(lines.at(-1)).toBe("最近 3 轮：每轮题数 2、2、2；出卡 0 张。");
});

test("days the person said are not set are listed, so the dialogue keeps their names and does not ask them again (2026-11-15)", () => {
  const lines = standingLines({ rounds: [round("lines")], stage: "lines", stageOrder: ORDER, startMetRound: null, startMissing: [], undecided: ["恢复投递", "开始写论文"], profile: {} });
  expect(lines).toContain("本人说还没定的日子（不再问，沿用这些叫法）：恢复投递；开始写论文。");
});
