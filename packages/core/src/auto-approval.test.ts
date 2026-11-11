import { expect, test } from "vitest";
import { autoApprovalEligible, proposalReady } from "./auto-approval";

const base = { state: "awaiting_plan_approval", riskTier: "routine", intent: "整理 ECE 548 前几章的复习提纲",
  payload: { family: "preparation", humanCore: [{ intent: "确认章节范围" }], materialContract: [{ kind: "file" }] } };

test("internal work takes effect by default — preparation, deep work, milestone-tier and high-risk alike", () => {
  expect(autoApprovalEligible(base).eligible).toBe(true);
  expect(autoApprovalEligible({ ...base, riskTier: "milestone" }).eligible).toBe(true);
  expect(autoApprovalEligible({ ...base, riskTier: "high_risk" }).eligible).toBe(true);
  expect(autoApprovalEligible({ ...base, payload: { ...base.payload, family: "deep_work" } }).eligible).toBe(true);
  expect(autoApprovalEligible({ ...base, state: "approved" }).eligible).toBe(false);
});

test("the assistant's own item takes effect (it needs no decision of the person's); a question never does; one naming the person's act waits", () => {
  const owned = (intent: string, owner: string) => ({ ...base, intent, payload: { owner, title: intent } });
  expect(autoApprovalEligible(owned("整理三个候选方案的对比表，供本人决定", "assistant"))).toMatchObject({ eligible: true });
  expect(autoApprovalEligible(owned("整理本学期已出成绩", "ask")).eligible).toBe(false);
  expect(autoApprovalEligible(owned("把方法部分发送给导师", "assistant")).eligible).toBe(false);
});

test("the person's own choice or decision waits for them", () => {
  expect(autoApprovalEligible({ ...base, intent: "从素材库选出四个首轮选题" }).eligible).toBe(false);
  expect(autoApprovalEligible({ ...base, intent: "在10月23日前由本人确认评审时间" }).eligible).toBe(false);
  expect(autoApprovalEligible({ ...base, intent: "整理选题", payload: { ...base.payload, title: "确认 sleep replay 评审时间" } }).eligible).toBe(false);
  // Judgement inside doing the work (the person's parts) is not a reason: every task has some.
  expect(autoApprovalEligible({ ...base, payload: { ...base.payload, humanCore: [{ intent: "核验仿真结果并决定图表结论" }] } }).eligible).toBe(true);
});

test("what the person sends, submits or publishes themselves takes effect: only the assistant's own final send waits (2026-11-11)", () => {
  // The person's decision of 2026-11-11 (W-257): 「完成 ECE 548 作业 4」 waited from 11/1 to the day before it was due because its last
  // step was 「提交」. Approving only puts the work on the person's week; the person still presses submit.
  expect(autoApprovalEligible({ ...base, intent: "完成 ECE 548 作业 4 并提交" }).eligible).toBe(true);
  expect(autoApprovalEligible({ ...base, intent: "发布小红书首轮科研内容" }).eligible).toBe(true);
  expect(autoApprovalEligible({ ...base, intent: "把图表和数据发送给师兄" }).eligible).toBe(true);
  expect(autoApprovalEligible({ ...base, payload: { ...base.payload, humanCore: [{ intent: "提交作业" }] } }).eligible).toBe(true);
  expect(autoApprovalEligible({ ...base, intent: "支付会议注册费" }).eligible).toBe(true);
  // The assistant sending it is still held.
  expect(autoApprovalEligible({ ...base, intent: "把方法部分发送给导师", payload: { owner: "assistant", title: "把方法部分发送给导师" } }).eligible).toBe(false);
  expect(autoApprovalEligible({ ...base, intent: "把资料检索交给助手" }).eligible).toBe(true);
});

test("document nouns built on the action words are not the act", () => {
  expect(autoApprovalEligible({ ...base, intent: "取得并确认报告结构、附件范围、格式限制与提交方式，形成要求清单。" }).eligible).toBe(true);
  expect(autoApprovalEligible({ ...base, intent: "目标投稿渠道、稿件类型、格式要求与提交规则清单" }).eligible).toBe(true);
  expect(autoApprovalEligible({ ...base, intent: "整理发布前核对清单" }).eligible).toBe(true);
});

test("access only the person can grant waits for them", () => {
  expect(autoApprovalEligible({ ...base, intent: "导出并确认最后交易日账户净值、持仓及现金数据" }).eligible).toBe(false);
  expect(autoApprovalEligible({ ...base, intent: "定位并确认10月券商结单" }).eligible).toBe(false);
  expect(autoApprovalEligible({ ...base, payload: { ...base.payload, materialContract: [{ description: "Cadence 访问权限", required: true }] } }).eligible).toBe(false);
  // A permission that would only help is not a reason to hold the work.
  expect(autoApprovalEligible({ ...base, payload: { ...base.payload, materialContract: [{ description: "Cadence 访问权限", required: false }] } }).eligible).toBe(true);
});

test("a revoked automatic approval and example work never take effect by themselves", () => {
  expect(autoApprovalEligible(base, { revoked: true }).eligible).toBe(false);
  expect(autoApprovalEligible({ ...base, payload: { ...base.payload, seeded: true } }).eligible).toBe(false);
});

test("a proposal is shown once its steps are planned, or when they cannot be", () => {
  const proposal = { state: "awaiting_plan_approval", payload: {} };
  expect(proposalReady(proposal, undefined)).toBe(false);
  expect(proposalReady(proposal, { steps: [] })).toBe(false);
  expect(proposalReady(proposal, { steps: [{}] })).toBe(true);
  expect(proposalReady(proposal, undefined, { planBlocked: true })).toBe(true);
  expect(proposalReady(proposal, undefined, { exempt: true })).toBe(true);
  expect(proposalReady({ state: "approved" }, undefined)).toBe(true);
  expect(proposalReady({ ...proposal, payload: { seeded: true } }, undefined)).toBe(true);
});

test("English wording is read by the same rules (English users write English)", () => {
  const en = { ...base, intent: "Outline chapters 1-3 of ECE 548 for revision" };
  expect(autoApprovalEligible(en).eligible).toBe(true);
  expect(autoApprovalEligible({ ...en, intent: "Pick four topics for the first round" }).eligible).toBe(false);
  expect(autoApprovalEligible({ ...en, intent: "Confirm the review meeting time with the advisor" }).eligible).toBe(false);
  expect(autoApprovalEligible({ ...en, intent: "Send the charts and data to the senior student" }).eligible).toBe(true);
  expect(autoApprovalEligible({ ...en, intent: "Email the advisor about next week" }).eligible).toBe(true);
  expect(autoApprovalEligible({ ...en, intent: "Hand the draft over to the lab manager" }).eligible).toBe(true);
  expect(autoApprovalEligible({ ...en, intent: "Hand the literature search over to the assistant" }).eligible).toBe(true);
  expect(autoApprovalEligible({ ...en, intent: "Export the brokerage account statement for October" }).eligible).toBe(false);
  expect(autoApprovalEligible({ ...en, intent: "Collect the report structure and submission guidelines into a checklist" }).eligible).toBe(true);
});

test("the reason is written in the person's language", async () => {
  await import("@crossline/i18n/catalog/worker");
  expect(autoApprovalEligible(base).reason).toBe("无需本人选择或授权，默认生效；对外的那一步由本人自己做");
  expect(autoApprovalEligible(base, { locale: "en" }).reason).toBe("Needs no choice or permission from you, so it takes effect; the step that leaves this computer is yours to do");
  expect(autoApprovalEligible({ ...base, payload: { ...base.payload, seeded: true } }, { locale: "en" }).reason).toMatch(/^Example task/);
});
