import { describe, expect, it } from "vitest";
import { isPreparationOnlyCriterion, onPersonsBoard, workOwner, type WorkOwner } from "./work-owner";
import { assignBackplanOwners, rollingBackplan, validateBackplan } from "./backplan-schema";

/** [title, the model's owner, the owner workOwner must give]: one table per kind of line, none of them special-cased in the rules. */
const cases: Array<[string, WorkOwner, WorkOwner]> = [
  // Research
  ["汇集三篇对照论文的实验参数", "person", "assistant"],
  ["整理 MoS2 器件文献的方法对照表", "person", "assistant"],
  ["按已定参数跑 NeuroSim 仿真", "person", "assistant"],
  ["判断要补哪些实验以及用什么工具", "person", "person"],
  ["设计补充实验的对照组", "person", "person"],
  ["撰写论文方法部分初稿", "person", "person"],
  ["向导师发送方法部分草稿", "assistant", "person"],
  // Coursework
  ["汇集期中考试规则与往年卷", "person", "assistant"],
  ["根据已汇集的规则和往年卷规划复习", "person", "person"],
  ["完成 HW3 第 1–4 题", "assistant", "person"],
  ["做 2 套往年卷并订正", "assistant", "person"],
  ["整理复习提纲", "person", "assistant"],
  ["整理本学期已出成绩", "person", "ask"],
  ["确认期中复习范围", "person", "ask"],
  // Startup
  ["收集 5 家门店的联系方式与营业时间", "person", "assistant"],
  ["约见 3 家门店店长做试用访谈", "assistant", "person"],
  ["排出 5 份访谈的前 3 个痛点", "person", "person"],
  ["起草给门店店长的试用邀请邮件", "assistant", "assistant"],
  ["选定首轮试用的两家门店", "assistant", "person"],
  // Media
  ["汇总 20 条收藏笔记的开头句式", "person", "assistant"],
  ["写第 2 版视频脚本开头 3 句", "person", "person"],
  ["发布第一条科普视频", "assistant", "person"],
  ["取得素材样本包", "person", "assistant"],
  // Health
  ["整理近 30 天的体检报告指标", "person", "ask"],
  ["练习 20 分钟间歇跑", "assistant", "person"],
  ["预约复查", "assistant", "person"],
  // Finance
  ["整理券商导出的持仓明细", "person", "ask"],
  ["汇总三只基金的公开费率与回撤", "person", "assistant"],
  ["卖出一半仓位", "assistant", "person"],
  ["决定下季度的定投比例", "ask", "person"],
  // Someone not studying: a nurse planning a career move, a parent running a household
  ["整理三家医院的招聘要求对照表", "person", "assistant"],
  ["演练面试自我介绍", "assistant", "person"],
  ["登录医院人事系统查看排班", "person", "ask"],
  ["汇总本月家庭开支账单", "person", "ask"],
  ["提交护士执业注册申请", "assistant", "person"],
  // Acceptance checklists and reviewing the assistant's output are not the person's tasks
  ["制定验收清单", "person", "assistant"],
  ["验收助手整理的材料目录", "person", "assistant"],
  // Unrecognised: the model's word stands
  ["优化落地页首屏", "person", "person"],
  ["生成 10 道同难度练习题", "assistant", "assistant"]
];

describe("workOwner", () => {
  it.each(cases)("%s (%s → %s)", (title, owner, expected) => {
    expect(workOwner({ title, owner }).owner).toBe(expected);
  });

  it("never gives the assistant sending, submitting, logging in, paying, graded answers or a consequential choice", () => {
    for (const title of ["发送周报给导师", "提交报名表", "付款购买课程", "签署合作协议", "完成期末考试第 2 题", "拍板产品定价", "登录教务系统提交作业"])
      expect(workOwner({ title, owner: "assistant" }).owner, title).toBe("person");
  });

  it("only moves work away from the person: a compiling word inside a person's core work does not move it", () => {
    expect(workOwner({ title: "分析已整理的访谈记录并写出结论", owner: "person" }).owner).toBe("person");
    expect(workOwner({ title: "复习并整理第 3 讲笔记", owner: "person" }).owner).toBe("person");
  });

  it("reads a purpose clause as what the work is for, not what it does", () => {
    expect(workOwner({ title: "整理三个候选方案的对比表", intent: "整理三个候选方案的对比表，供本人决定", owner: "person" }).owner).toBe("assistant");
    expect(workOwner({ title: "整理投稿要求", intent: "整理目标期刊的投稿要求与格式", owner: "person" }).owner).toBe("assistant");
  });

  it("reads a stored work order: its title, intent and payload owner", () => {
    const order = { intent: "汇集 ECE 555 期中考试规则与往年卷", payload: { title: "ECE 555 汇集期中规则" } };
    expect(workOwner(order)).toMatchObject({ owner: "assistant", code: "static_artifact" });
    expect(workOwner({ intent: "整理账户导出的交易记录", payload: { owner: "assistant" } })).toMatchObject({ owner: "ask" });
  });

  it("an ask carries a question: the model's, else one made from the work's name", () => {
    expect(workOwner({ title: "确认期中复习范围", owner: "ask", question: "期中考到第几讲？" }).question).toBe("期中考到第几讲？");
    expect(workOwner({ title: "整理本学期已出成绩" }).question).toContain("整理本学期已出成绩");
    expect(workOwner({ title: "汇集规则" }).question).toBeUndefined();
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

describe("isPreparationOnlyCriterion", () => {
  it("is true for readiness alone, in any line", () => {
    for (const statement of ["往年卷与考试规则已汇集", "5 家门店资料清单建立", "素材样本包已取得", "三只基金的公开资料齐备", "招聘要求对照表就绪"])
      expect(isPreparationOnlyCriterion({ statement }), statement).toBe(true);
  });
  it("is false for a result of the person's own, and for a number reached", () => {
    for (const statement of ["期中成绩 ≥ 88/100", "考前完成 2 套往年卷（计时）并订正", "至少 3 家店长表示愿意继续试用", "方法部分初稿交给导师", "首条视频发布"])
      expect(isPreparationOnlyCriterion({ statement }), statement).toBe(false);
    expect(isPreparationOnlyCriterion({ statement: "资料整理完成率", measure: { kind: "threshold" } })).toBe(false);
  });
});

describe("backplan owners", () => {
  const item = (id: string, title: string, over: Record<string, unknown> = {}) => ({ id, title, intent: title, sourceQuote: "q", rationale: "r", dependsOn: [] as string[],
    estimate: { p25Minutes: 30, p50Minutes: 60, p85Minutes: 90 }, energy: "medium" as const, interruptible: true, family: "preparation" as const,
    riskTier: "routine" as const, evidence: "e", acquires: "", produces: "", uses: [] as string[], owner: "person" as const, prepares: "", question: "", ...over });

  it("corrects owners, drops a review-only item and points the preparation at the core task it serves", () => {
    const { steps, dropped } = assignBackplanOwners([
      item("a", "汇总 20 条收藏笔记的开头句式"),
      item("r", "验收助手整理的句式清单", { dependsOn: ["a"] }),
      item("c", "写第 2 版视频脚本开头 3 句", { dependsOn: ["r"] }),
      item("q", "整理近 30 天的后台播放数据", { owner: "assistant" }),
      item("p", "发布第一条视频", { dependsOn: ["c", "q"], owner: "assistant" })]);
    expect(dropped.map((entry) => entry.id)).toEqual(["r"]);
    expect(steps.map((step) => [step.id, step.owner, step.prepares])).toEqual([["a", "assistant", "c"], ["c", "person", ""], ["q", "ask", "p"], ["p", "person", ""]]);
    expect(steps.find((step) => step.id === "c")!.dependsOn).toEqual(["a"]);
    expect(steps.find((step) => step.id === "q")!.question).toContain("整理近 30 天的后台播放数据");
  });

  it("an assistant item holding a request for a fact becomes a question", () => {
    const { steps } = assignBackplanOwners([item("a", "汇集门店营业数据", { infoRequests: [{ kind: "ask_person", what: "门店上月营业额", who: "店长" }] }),
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
    const answer = () => ({ steps: [item("a", "汇集期中考试规则与往年卷", { sourceQuote: "期中" })], dateCandidates: [], blockers: [] });
    expect(() => validateBackplan(answer(), ["期中"])).toThrow("BACKPLAN_NO_PERSON_CORE");
    expect(validateBackplan(answer(), ["期中"], undefined, [], undefined, [], { requireCore: false }).steps).toHaveLength(1);
  });
});
