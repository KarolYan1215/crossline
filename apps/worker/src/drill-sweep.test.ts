import { expect, test } from "vitest";
import { CrosslineStore, type StepPlanInput } from "@crossline/db";
import { DRILL_ARCHIVE_REASON, sweepLegacyDrills } from "./drill-sweep";

const estimate = { p25Minutes: 30, p50Minutes: 45, p85Minutes: 90, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const };
const order = (id: string, title: string, intent: string) => ({
  id, ownerId: "o", workspaceId: "w", identityId: "research", projectId: "p", milestoneId: "", intent,
  state: "approved" as const, riskTier: "routine" as const, estimate, payload: { title } });
const step = (id: string, title: string, extra: Partial<StepPlanInput["steps"][number]> = {}): StepPlanInput["steps"][number] => ({
  id, role: "practice", title, deliverable: "", doneCriterion: "", share: 0.5, estimate: { p25Minutes: 30, p50Minutes: 45, p85Minutes: 90 },
  dependsOn: [], notBefore: "2026-11-20", dueBy: "2026-11-25", schedulable: true, executor: "human", tickOutcome: "", ...extra });
const plan = (steps: StepPlanInput["steps"]): StepPlanInput =>
  ({ archetypeId: "exam_prep", quantity: { basis: "讲", amount: 1, unit: "讲" }, rationale: "按往年卷练。康奈尔建议先做再订正。", steps });

test("legacy drill tasks are archived, drill steps skipped and drill clauses cut, once", () => {
  const store = new CrosslineStore(":memory:");
  store.saveWorkOrder(order("drill", "完成 ECE 548 作业 1、2 订正", "独立重做代表题"));
  store.saveWorkOrder(order("mock", "完成期中一模拟卷", "完成一套限时模拟题，订正并形成错题记录。"));
  store.saveWorkOrder(order("clean", "写报告", "写完报告"));
  store.saveStepPlan("w", "mock", plan([
    step("a", "限时做模拟卷", { deliverable: "答卷" }),
    step("b", "订正模拟卷", { dependsOn: ["a"], deliverable: "错题订正记录" }),
    step("c", "限时复解并归因订正", { dependsOn: ["b"], doneCriterion: "复解 3 题，订正全部错误" })]), "o", "planned");
  const before = store.getStepPlan("w", "mock")!;

  const result = sweepLegacyDrills(store, "w")!;
  expect(result.archived).toEqual(["drill"]);
  expect(result.skippedSteps).toBe(1);
  expect(result.rewrittenOrders).toEqual(["mock"]);

  const orders = Object.fromEntries(store.listWorkOrders("w").map((item) => [item.id, item]));
  expect(orders.drill!.state).toBe("archived");
  expect(store.listEvents("w", { type: "work_order.changed", change: "archived", entityId: "drill" })[0]!.payload)
    .toMatchObject({ reason: DRILL_ARCHIVE_REASON, from: "approved" });
  expect(orders.mock!.intent).toBe("完成一套限时模拟题");
  expect(orders.clean!.intent).toBe("写完报告");

  const after = store.getStepPlan("w", "mock")!;
  expect(after.version).toBe(before.version + 1);
  expect(after.rationale).toBe("按往年卷练。");
  const texts = after.steps.filter((item) => item.status === "planned").flatMap((item) => [item.title, item.deliverable, item.doneCriterion]).join("|");
  expect(texts).not.toMatch(/订正|错题/);
  expect(after.steps.find((item) => item.title === "订正模拟卷")!.status).toBe("skipped");
  expect(after.steps.some((item) => item.title === "限时复解" && item.status === "planned")).toBe(true);

  // Once per workspace: a later run does nothing.
  expect(sweepLegacyDrills(store, "w")).toBeUndefined();
  store.close();
});

test("a drill the person's own words back is kept", () => {
  const store = new CrosslineStore(":memory:");
  store.saveWorkOrder(order("mine", "整理错题本", "整理错题本"));
  store.upsertProfileFact({ workspaceId: "w", identityId: "research", projectId: "", slot: "method_exam_prep", value: "考前我会整理错题本",
    status: "confirmed", sourceRef: "interview", sourceQuote: "", updatedAt: "2026-11-01T00:00:00Z" });
  expect(sweepLegacyDrills(store, "w")!.archived).toEqual([]);
  expect(store.listWorkOrders("w")[0]!.state).toBe("approved");
  store.close();
});
