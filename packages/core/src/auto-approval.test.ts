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
