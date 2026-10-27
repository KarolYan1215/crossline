import { expect, test } from "vitest";
import { PLANNING_PROFILE_MAX_LINES, planningProfile } from "./planning-profile";

test("the interview's working facts and profile reach planning in a few lines, without appearance or meal times", () => {
  // Shaped like the owner's real interview (2026-10-20).
  const facts = [
    { identityId: "person", slot: "appearance", value: "狼尾长发男性，偏好全黑穿搭", status: "confirmed" },
    { identityId: "person", slot: "lunch_time", value: "12:00–14:00 午饭。", status: "confirmed" },
    { identityId: "person", slot: "behavior_pattern", value: "快速启动后，遇到批评或摩擦时减少沟通并转向新想法。", status: "confirmed" },
    { identityId: "person", slot: "peak_work_time", value: "上午 9–12 点效率最高。", status: "confirmed" },
    { identityId: "person", slot: "energy_drain", value: "程序性沟通事务。", status: "confirmed" },
    { identityId: "person", slot: "work_window", value: "假设：可工作到 23:00", status: "inferred" },
    { identityId: "research", slot: "deadline", value: "12 月投稿", status: "confirmed" }];
  const model = { trueNorth: "外推知识边界", coreConflict: "价值优先与日历优先不同", allocation: "研究者为日历底座",
    energyMap: [{ activity: "跨学科系统化分析", skill: "high", love: "high", charge: "charge" }, { activity: "程序性沟通", skill: "medium", love: "low", charge: "drain" }],
    values: [{ value: "安全", score: 35 }, { value: "自主", score: 95 }, { value: "成就", score: 95 }, { value: "刺激", score: 85 }] };
  const lines = planningProfile(facts, model);
  expect(lines[0]).toBe("工作方式（peak_work_time）：上午 9–12 点效率最高。");
  expect(lines.join("\n")).not.toMatch(/狼尾|午饭|12 月投稿|23:00/);
  expect(lines).toContain("擅长又投入：跨学科系统化分析");
  expect(lines).toContain("耗能：程序性沟通");
  expect(lines).toContain("最看重：自主、成就、刺激");
  expect(lines.at(-1)).toBe("方向：外推知识边界");
  expect(planningProfile([], undefined)).toEqual([]);
  expect(planningProfile(Array.from({ length: 40 }, (_, i) => ({ identityId: "person", slot: `flow_${i}`, value: "x".repeat(400), status: "confirmed" })), model).length)
    .toBe(PLANNING_PROFILE_MAX_LINES);
});
