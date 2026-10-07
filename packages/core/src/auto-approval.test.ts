import { expect, test } from "vitest";
import { autoApprovalEligible } from "./auto-approval";

const base = { state: "awaiting_plan_approval", riskTier: "routine", intent: "整理 ECE 548 前几章的复习提纲",
  payload: { family: "preparation", humanCore: [{ intent: "确认章节范围" }], materialContract: [{ kind: "file" }] } };

test("routine, internal preparation goes ahead by default — a contract of kind 'file' no longer disqualifies it", () => {
  expect(autoApprovalEligible(base).eligible).toBe(true);
});

test("anything that commits the person or leaves the machine waits for a click", () => {
  expect(autoApprovalEligible({ ...base, riskTier: "milestone" }).eligible).toBe(false);
  expect(autoApprovalEligible({ ...base, payload: { ...base.payload, family: "deep_work" } }).eligible).toBe(false);
  expect(autoApprovalEligible({ ...base, intent: "把图表和数据发送给师兄" }).eligible).toBe(false);
  expect(autoApprovalEligible({ ...base, payload: { ...base.payload, humanCore: [{ intent: "提交作业" }] } }).eligible).toBe(false);
  expect(autoApprovalEligible({ ...base, state: "approved" }).eligible).toBe(false);
});

test("a byproduct's landing work counts as internal even when it is not preparation", () => {
  expect(autoApprovalEligible({ ...base, payload: { family: "deep_work", byproductOf: "wo-1", humanCore: [] } }).eligible).toBe(true);
});

test("a step worked back from an approved milestone takes effect unless it reaches outside or is high risk", () => {
  const step = { state: "awaiting_plan_approval", riskTier: "milestone", intent: "确认目标 NeuroSim 版本并取得输入规范",
    payload: { family: "preparation", backplan: { milestoneVersion: 2 }, humanCore: [{ intent: "确认目标 NeuroSim 版本并取得输入规范" }] } };
  expect(autoApprovalEligible(step).eligible).toBe(true);
  expect(autoApprovalEligible({ ...step, payload: { ...step.payload, family: "deep_work" } }).eligible).toBe(true);
  expect(autoApprovalEligible({ ...step, riskTier: "high_risk" }).eligible).toBe(false);
  expect(autoApprovalEligible({ ...step, intent: "给师兄发邮件要数据" }).eligible).toBe(false);
});
