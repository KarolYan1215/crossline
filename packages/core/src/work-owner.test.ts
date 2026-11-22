import { describe, expect, it } from "vitest";
import { isPreparationOnlyCriterion, isPreparationOnlyMilestone, onPersonsBoard, workOwner, type WorkOwner } from "./work-owner";
import { assignBackplanOwners, rollingBackplan, validateBackplan } from "./backplan-schema";

describe("workOwner", () => {
  // Since 2026-11-22 the model's owner stands (its Skill says how to judge it); code keeps one floor, an act that leaves the machine.
  it("keeps the model's owner for work that stays on the machine, in any line", () => {
    for (const [title, owner] of [["汇集三篇对照论文的实验参数", "assistant"], ["判断要补哪些实验以及用什么工具", "person"], ["整理本学期已出成绩", "ask"],
      ["规划下季度的选题方向", "assistant"], ["整理复习提纲", "person"], ["Compile the review notes", "assistant"]] as Array<[string, WorkOwner]>)
      expect(workOwner({ title, owner }), title).toMatchObject({ owner, code: "model" });
  });

  it("never gives the assistant or a question sending, submitting, contacting, attending or paying", () => {
    for (const title of ["发送周报给导师", "提交报名表", "付款购买课程", "签署合作协议", "约见 3 家门店店长做试用访谈", "发布第一条科普视频", "卖出一半仓位",
      "向助教确认期中范围", "Submit the application", "Email the advisor the draft"]) {
      expect(workOwner({ title, owner: "assistant" }), title).toMatchObject({ owner: "person", code: "external" });
      expect(workOwner({ title, owner: "ask" }).owner, title).toBe("person");
    }
  });

  it("does not read an act's noun, a draft or a purpose clause as the act", () => {
    expect(workOwner({ title: "起草给门店店长的试用邀请邮件", owner: "assistant" }).owner).toBe("assistant");
    expect(workOwner({ title: "整理投稿要求", owner: "assistant" }).owner).toBe("assistant");
    expect(workOwner({ title: "整理本月交易记录", owner: "assistant" }).owner).toBe("assistant");
    expect(workOwner({ title: "整理三个候选方案的对比表", intent: "整理对比表，供本人决定后发送给导师", owner: "assistant" }).owner).toBe("assistant");
  });

  it("reads a stored work order: its payload owner, and work written before owners is the person's", () => {
    expect(workOwner({ intent: "汇集 ECE 555 期中考试规则与往年卷", payload: { title: "ECE 555 汇集期中规则", owner: "assistant" } }).owner).toBe("assistant");
    expect(workOwner({ intent: "汇集 ECE 555 期中考试规则与往年卷", payload: { title: "ECE 555 汇集期中规则" } }).owner).toBe("person");
  });

  it("an ask carries a question: the model's, else one made from the work's name", () => {
    expect(workOwner({ title: "确认期中复习范围", owner: "ask", question: "期中考到第几讲？" }).question).toBe("期中考到第几讲？");
    expect(workOwner({ title: "整理本学期已出成绩", owner: "ask" }).question).toContain("整理本学期已出成绩");
    expect(workOwner({ title: "汇集规则", owner: "assistant" }).question).toBeUndefined();
  });

  it("reads a step's executor as the model's owner", () => {
    expect(workOwner({ title: "优化落地页首屏", executor: "agent" }).owner).toBe("assistant");
    expect(workOwner({ title: "优化落地页首屏", executor: "mixed" }).owner).toBe("person");
  });
});
describe("onPersonsBoard", () => {
  it("keeps the person's work and work written before owners, and leaves the assistant's and the questions off", () => {
    expect(onPersonsBoard({ payload: {} })).toBe(true);
    expect(onPersonsBoard({ payload: { owner: "person" } })).toBe(true);
    expect(onPersonsBoard({ payload: { owner: "assistant" } })).toBe(false);
    expect(onPersonsBoard({ payload: { owner: "ask" } })).toBe(false);
    expect(onPersonsBoard({})).toBe(true);
  });
});

describe("isPreparationOnlyMilestone", () => {
  it("is a milestone whose every criterion is readiness or identification, never one with a result of the person's", () => {
    expect(isPreparationOnlyMilestone({ successCriteria: [{ statement: "ECE 548 与 ECE 555 考核缺口已可按 A- 分数线识别" },
      { statement: "两门课的评分规则清单覆盖全部计分组成与权重" }] })).toBe(true);
    expect(isPreparationOnlyMilestone({ successCriteria: [{ statement: "往年卷已汇集" }, { statement: "期中成绩 ≥ 88/100" }] })).toBe(false);
    expect(isPreparationOnlyMilestone({ successCriteria: [] })).toBe(false);
    expect(isPreparationOnlyMilestone({ successCriteria: [{ statement: "5 家门店资料清单建立" }] })).toBe(true);
  });
});

describe("isPreparationOnlyCriterion", () => {
  it("is true for readiness alone, in any line", () => {
    for (const statement of ["往年卷与考试规则已汇集", "5 家门店资料清单建立", "素材样本包已取得", "三只基金的公开资料齐备", "招聘要求对照表就绪"])
      expect(isPreparationOnlyCriterion({ statement }), statement).toBe(true);
  });
  it("is false for a result of the person's own, and for a number reached", () => {
    for (const statement of ["期中成绩 ≥ 88/100", "考前在计时条件下做完 2 套往年卷", "至少 3 家店长表示愿意继续试用", "方法部分初稿交给导师", "首条视频发布"])
      expect(isPreparationOnlyCriterion({ statement }), statement).toBe(false);
    expect(isPreparationOnlyCriterion({ statement: "资料整理完成率", measure: { kind: "threshold" } })).toBe(false);
  });
});

describe("backplan owners", () => {
  const item = (id: string, title: string, over: Record<string, unknown> = {}) => ({ id, title, intent: title, sourceQuote: "q", rationale: "r", dependsOn: [] as string[],
    estimate: { p25Minutes: 30, p50Minutes: 60, p85Minutes: 90 }, energy: "medium" as const, interruptible: true, family: "preparation" as const,
    riskTier: "routine" as const, evidence: "e", acquires: "", produces: "", uses: [] as string[], owner: "person" as const, prepares: "", question: "", ...over });

  it("keeps the model's owners, forces an external act to the person and points the preparation at the core task it serves", () => {
    const { steps } = assignBackplanOwners([
      item("a", "汇总 20 条收藏笔记的开头句式", { owner: "assistant" }),
      item("c", "写第 2 版视频脚本开头 3 句", { dependsOn: ["a"] }),
      item("q", "整理近 30 天的后台播放数据", { owner: "ask" }),
      item("p", "发布第一条视频", { dependsOn: ["c", "q"], owner: "assistant" })]);
    expect(steps.map((step) => [step.id, step.owner, step.prepares])).toEqual([["a", "assistant", "c"], ["c", "person", ""], ["q", "ask", "p"], ["p", "person", ""]]);
    expect(steps.find((step) => step.id === "q")!.question).toContain("整理近 30 天的后台播放数据");
  });
  it("an assistant item holding a request for a fact becomes a question", () => {
    const { steps } = assignBackplanOwners([item("a", "汇集门店营业数据", { owner: "assistant", infoRequests: [{ kind: "ask_person", what: "门店上月营业额", who: "店长" }] }),
      item("c", "排出 5 家门店的试用优先级", { dependsOn: ["a"] })]);
    expect(steps[0]).toMatchObject({ owner: "ask", question: "门店上月营业额（需向店长确认）", prepares: "c" });
  });

  it("rolling keeps the next core task, what it waits on and its preparation; without one, the first two items", () => {
    const owned = [{ id: "a", dependsOn: [], owner: "assistant" as const, prepares: "c" }, { id: "q", dependsOn: [], owner: "ask" as const, prepares: "c" },
      { id: "c", dependsOn: ["a"], owner: "person" as const, prepares: "" }, { id: "b", dependsOn: ["c"], owner: "assistant" as const, prepares: "d" },
      { id: "d", dependsOn: ["b"], owner: "person" as const, prepares: "" }];
    expect(rollingBackplan(owned).map((step) => step.id)).toEqual(["a", "q", "c"]);
    expect(rollingBackplan(owned.filter((step) => step.owner !== "person")).map((step) => step.id)).toEqual(["a", "q"]);
  });

  it("an answer with no core task of the person's is sent back, and kept when asked to", () => {
    const answer = () => ({ steps: [item("a", "汇集期中考试规则与往年卷", { sourceQuote: "期中", owner: "assistant" })], dateCandidates: [], blockers: [] });
    expect(() => validateBackplan(answer(), ["期中"])).toThrow("BACKPLAN_NO_PERSON_CORE");
    expect(validateBackplan(answer(), ["期中"], undefined, [], undefined, [], { requireCore: false }).steps).toHaveLength(1);
  });
});

