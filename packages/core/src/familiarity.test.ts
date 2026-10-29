import "@crossline/i18n/catalog/worker";
import { describe, expect, test } from "vitest";
import { familiarityKey, familiarityLabel, familiarityOf, familiarityOverride, type FamiliarityInput } from "./familiarity";
import { taskPreparation, tutorialSteps } from "./tutorial-worth";

const base = (extra: Partial<FamiliarityInput> = {}): FamiliarityInput => ({
  task: { title: "界定评审机制决策项", intent: "为 sleep replay 器件评审界定三个决策项" }, lineId: "research",
  facts: [], sameKindDone: 0, lineDone: 3, ...extra });
const fact = (identityId: string, slot: string, value: string, status = "confirmed") => ({ identityId, slot, value, status });

describe("how close a task is to what the person knows (W-154)", () => {
  test("the person's own field and work of this kind done before read as near", () => {
    const near = familiarityOf(base({ sameKindDone: 2, facts: [fact("person", "background", "电子工程博士，研究方向为忆阻器件与 sleep replay")] }));
    expect(near).toMatchObject({ level: "near", by: "rules" });
    expect(near.basis.join(" ")).toContain("sleep");
  });

  test("a line the person is new to, with nothing in their background about it, reads as far", () => {
    const task = { title: "选定首轮选题", intent: "为小红书账号选定首轮内容选题" };
    expect(familiarityOf(base({ task, lineId: "media", lineDone: 0, facts: [fact("person", "background", "电子工程博士")] })).level).toBe("far");
    expect(familiarityOf(base({ task, lineId: "media", lineDone: 4, facts: [fact("media", "stage", "完全是新手，第一次做内容")] })).level).toBe("far");
    // A domain line (money) with nothing in the background about it.
    expect(familiarityOf(base({ task: { title: "确认核心持仓标的", intent: "看月末持仓里市值最高的一行" }, lineId: "line-wealth", lineDomain: "wealth",
      lineDone: 0 })).level).toBe("far");
  });

  test("without anything on record either way it stays mid; guesses and other lines' facts do not count", () => {
    expect(familiarityOf(base())).toMatchObject({ level: "mid", basis: ["nothing on record either way"] });
    expect(familiarityOf(base({ facts: [fact("person", "background", "假设：器件评审经验多年"), fact("startup", "background", "器件 sleep replay 评审专家")] })).level).toBe("mid");
  });

  test("generic task verbs say nothing about the domain", () => {
    expect(familiarityOf(base({ task: { title: "确认时间", intent: "确认评审时间" }, facts: [fact("person", "skill", "擅长确认时间安排")] })).level).toBe("mid");
  });

  test("the person's own choice wins, by line and kind first, then the whole line", () => {
    const raw = JSON.stringify({ [familiarityKey("media", "content")]: "near", [familiarityKey("research", undefined)]: "far" });
    expect(familiarityOverride(raw, "media", "content")).toBe("near");
    expect(familiarityOverride(raw, "media", "writing")).toBeUndefined();
    expect(familiarityOverride(raw, "research", "build")).toBe("far");
    expect(familiarityOverride("not json", "media", "content")).toBeUndefined();
    expect(familiarityOf(base({ sameKindDone: 2, override: "far" }))).toMatchObject({ level: "far", by: "person" });
  });

  test("labels in both languages", () => {
    expect(familiarityLabel("near")).toBe("熟悉领域·从简");
    expect(familiarityLabel("far", "en")).toBe("New field · explained");
  });
});

describe("preparation follows familiarity", () => {
  const step = (minutes: number, extra: Record<string, unknown> = {}) => ({ executor: "human", schedulable: true, status: "planned", role: "decide",
    estimate: { p50Minutes: minutes }, ...extra });
  const task = { title: "选定首轮选题", intent: "选定首轮选题", p50Minutes: 30, archetypeId: "content" };

  test("far work gets a tutorial even when the person's part is short; near work never does", () => {
    expect(taskPreparation(task, [step(30)]).level).toBe("steps");
    expect(taskPreparation(task, [step(30)], { familiarity: "far" })).toMatchObject({ level: "tutorial", reason: expect.stringContaining("新领域") });
    expect(taskPreparation(task, [step(10)], { familiarity: "far" }).level).toBe("steps");
    const long = { title: "完成作业 3", intent: "完成作业 3", p50Minutes: 240, archetypeId: "problem_set" };
    expect(taskPreparation(long, [step(240, { role: "solve" })]).level).toBe("tutorial");
    expect(taskPreparation(long, [step(240, { role: "solve" })], { familiarity: "near" })).toMatchObject({ level: "steps", reason: expect.stringContaining("熟悉") });
    // Nothing for the person to do stays nothing, however unfamiliar.
    expect(taskPreparation(task, [step(30, { executor: "agent" })], { familiarity: "far" }).level).toBe("none");
  });

  test("far work gets a section for every step of the person's, not only the ability ones", () => {
    const steps = [{ executor: "human", product: "output" }, { executor: "human", product: "ability" }, { executor: "agent", product: "material" }];
    expect(tutorialSteps(steps)).toHaveLength(1);
    expect(tutorialSteps(steps, "far")).toHaveLength(2);
  });
});
