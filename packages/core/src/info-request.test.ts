import { describe, expect, test } from "vitest";
import { foldInfoRequests, infoRequestSteps, infoRequestTraits, isInfoRequest } from "./info-request";
import { normalizeStepPlan, stepPlanWarnings, type StepPlan } from "./steps";
import type { BackplanStep } from "./backplan-schema";

describe("what a request for a fact is", () => {
  test("the real board's standalone requests are recognised, with who answers them", () => {
    const scope = infoRequestTraits({ title: "确认 ECE 548 期中考查范围", intent: "形成期中考试 1 考查主题、章节与重点清单。", p50Minutes: 45 });
    expect(scope.match).toBe(true);
    expect(scope.request).toEqual({ kind: "ask_person", what: "ECE 548 期中考查范围", who: "助教或任课老师" });
    expect(infoRequestTraits({ title: "ECE 555 确认课程项目要求", p50Minutes: 30 }).request?.what).toBe("ECE 555 课程项目要求");
    expect(infoRequestTraits({ title: "确认课程项目评分标准", p50Minutes: 35 }).request?.kind).toBe("ask_person");
    expect(infoRequestTraits({ title: "向师兄确认 NeuroSim 输入格式" }).request).toMatchObject({ kind: "ask_person", who: "师兄" });
    // Where the answer sits in a document or the person's own account, nobody is emailed.
    expect(infoRequestTraits({ title: "确认 NeuroSim 版本", p50Minutes: 30 }).request?.kind).toBe("look_up");
    expect(infoRequestTraits({ title: "取得10月券商结单", p50Minutes: 45 }).request?.kind).toBe("look_up");
  });

  test("work that also produces something, or is longer than a message, is not one", () => {
    expect(isInfoRequest({ title: "完成 ECE 555 作业 2", intent: "需要时询问助教" })).toBe(false);
    expect(isInfoRequest({ title: "汇集 ECE 548 复习材料" })).toBe(false);
    expect(isInfoRequest({ title: "确认 sleep replay 评审时间", intent: "确认评审时间，并定稿评审材料清单。" })).toBe(false);
    expect(isInfoRequest({ title: "确认实验方案并撰写方法部分" })).toBe(false);
    expect(isInfoRequest({ title: "确认核心持仓标的" })).toBe(false);
    expect(isInfoRequest({ title: "确认 ECE 548 考试说明", p50Minutes: 120 })).toBe(false);
  });

  test("a request becomes a drafted email (assistant, never sent) and a send (the person's, 15 minutes at most)", () => {
    const [draft, send] = infoRequestSteps({ kind: "ask_person", what: "期中考查范围", who: "助教" }, { draft: "d", send: "s" });
    expect(draft).toMatchObject({ executor: "agent", schedulable: false, role: "prepare" });
    expect(draft!.deliverable).toContain("不发送");
    expect(send).toMatchObject({ executor: "human", role: "contact", dependsOn: ["d"], title: "向助教确认期中考查范围" });
    expect(send!.estimate.p85Minutes).toBeLessThanOrEqual(15);
    expect(infoRequestSteps({ kind: "look_up", what: "NeuroSim 版本", who: "" }, { draft: "d", send: "s" })).toHaveLength(1);
  });

  test("normalization keeps the send with the person and does not call a quarter-hour request too short", () => {
    const step = (id: string, title: string, executor: "human" | "agent", p50: number) => ({ id, role: "contact" as const, title, deliverable: "", doneCriterion: "x",
      share: 0.5, estimate: { p25Minutes: p50, p50Minutes: p50, p85Minutes: p50 * 2 }, dependsOn: [], notBefore: "", dueBy: "", schedulable: true, executor,
      tickOutcome: "", covers: [], why: "", aiAssist: { tool: "", how: "", minutesSaved: 0 }, firstAction: "" });
    const plan: StepPlan = { archetypeId: "problem_set", quantity: { basis: "", amount: 0, unit: "" }, rationale: "", units: [], questions: [],
      steps: [step("a", "向助教确认作业 3 的提交格式", "agent", 10), step("b", "完成第 1 题", "human", 60)] };
    const { plan: normalized, warnings } = normalizeStepPlan(plan);
    expect(normalized.steps[0]).toMatchObject({ executor: "human", schedulable: true });
    expect(warnings.map((item) => item.code)).toContain("STEP_INFO_REQUEST_PERSON");
    expect(stepPlanWarnings(normalized).some((item) => item.code === "STEP_TOO_SHORT")).toBe(false);
  });
});

describe("the backplanner's answer", () => {
  const base = (id: string, title: string, dependsOn: string[] = [], p50 = 45): BackplanStep => ({ id, title, intent: title, sourceQuote: "q", rationale: "r", dependsOn,
    estimate: { p25Minutes: p50 - 10, p50Minutes: p50, p85Minutes: p50 * 2 }, energy: "low", interruptible: true, family: "preparation", riskTier: "routine",
    evidence: "e", acquires: "", produces: "", uses: [] });

  test("a request another task needs is folded into that task as its first part", () => {
    const steps = [{ ...base("ask", "确认 ECE 548 期中考查范围"), acquires: "m1" }, base("mat", "汇集 ECE 548 复习材料", ["ask"], 60), base("prep", "完成期中模拟测验", ["ask", "mat"], 120)];
    const { steps: out, folded } = foldInfoRequests(steps);
    expect(out.map((step) => step.id)).toEqual(["mat", "prep"]);
    expect(folded).toEqual([{ title: "确认 ECE 548 期中考查范围", into: "mat" }]);
    expect(out[0]).toMatchObject({ acquires: "m1", dependsOn: [], estimate: { p50Minutes: 70 } });
    expect(out[0]!.infoRequests).toEqual([{ kind: "ask_person", what: "ECE 548 期中考查范围", who: "助教或任课老师" }]);
    // Whatever else waited for the answer now waits for the task that gets it.
    expect(out[1]!.dependsOn).toEqual(["mat"]);
  });

  test("a request nothing depends on stays for the daily merge to place", () => {
    expect(foldInfoRequests([base("ask", "确认课程项目评分标准", [], 35)]).steps).toHaveLength(1);
  });
});

describe("requests written in English", () => {
  test("are recognised by the same traits", async () => {
    await import("@crossline/i18n/catalog/worker");
    const scope = infoRequestTraits({ title: "Confirm the ECE 548 midterm scope", p50Minutes: 45, locale: "en" });
    expect(scope.request).toEqual({ kind: "ask_person", what: "the ECE 548 midterm scope", who: "the TA or instructor" });
    expect(infoRequestTraits({ title: "Ask the TA about the homework 3 format" }).request).toMatchObject({ kind: "ask_person", who: "TA" });
    expect(infoRequestTraits({ title: "Confirm the NeuroSim version", p50Minutes: 30 }).request?.kind).toBe("look_up");
    expect(isInfoRequest({ title: "Confirm the experiment plan and write the methods section" })).toBe(false);
    expect(isInfoRequest({ title: "Confirm review time", intent: "Confirm the time and finalize the review materials" })).toBe(false);
    expect(isInfoRequest({ title: "Finish ECE 555 homework 2" })).toBe(false);
    // "data" is not a teaching assistant.
    expect(infoRequestTraits({ title: "Confirm the data format" }).request?.who).toBe("");
  });

  test("the drafted email and the send are written in English", async () => {
    await import("@crossline/i18n/catalog/worker");
    const [draft, send] = infoRequestSteps({ kind: "ask_person", what: "the midterm scope", who: "the TA" }, { draft: "d", send: "s" }, [], "en");
    expect(draft!.title).toBe("Draft an email to the TA: confirm the midterm scope");
    expect(send!.title).toBe("Confirm the midterm scope with the TA");
    expect(send!.firstAction).toBe("Open the email the assistant drafted, check the recipient and body, then send it");
    expect(infoRequestSteps({ kind: "look_up", what: "NeuroSim version", who: "" }, { draft: "d", send: "s" }, [], "en")[0]!.title).toBe("Look up NeuroSim version");
  });
});
