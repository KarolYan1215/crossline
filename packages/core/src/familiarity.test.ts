import "@crossline/i18n/catalog/worker";
import { describe, expect, test } from "vitest";
import { familiarityKey, familiarityLabel, familiarityOf, familiarityOverride, readModelFamiliarity } from "./familiarity";
import { taskPreparation, tutorialSteps } from "./tutorial-worth";

describe("how close a task is to what the person knows (W-154)", () => {
  test("the planner's judgement is the level; no rule scores the person's background any more", () => {
    expect(familiarityOf({ planned: { level: "near", why: "本人为器件方向博士生，做过同类评审" } }))
      .toEqual({ level: "near", by: "model", basis: ["本人为器件方向博士生，做过同类评审"] });
    expect(familiarityOf({ planned: { level: "far", why: "" } })).toMatchObject({ level: "far", by: "model", basis: [] });
  });

  test("before any plan it stays mid", () => {
    expect(familiarityOf({})).toMatchObject({ level: "mid", by: "none" });
  });

  test("only a known level is read from a plan; plans from before the field have none", () => {
    expect(readModelFamiliarity({ level: "far", why: "第一次做内容" })).toEqual({ level: "far", why: "第一次做内容" });
    expect(readModelFamiliarity({ level: "expert", why: "" })).toBeUndefined();
    expect(readModelFamiliarity(undefined)).toBeUndefined();
  });

  test("the person's own choice wins, by line and kind first, then the whole line", () => {
    const raw = JSON.stringify({ [familiarityKey("media", "content")]: "near", [familiarityKey("research", undefined)]: "far" });
    expect(familiarityOverride(raw, "media", "content")).toBe("near");
    expect(familiarityOverride(raw, "media", "writing")).toBeUndefined();
    expect(familiarityOverride(raw, "research", "build")).toBe("far");
    expect(familiarityOverride("not json", "media", "content")).toBeUndefined();
    expect(familiarityOf({ override: "far", planned: { level: "near", why: "" } })).toMatchObject({ level: "far", by: "person" });
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
