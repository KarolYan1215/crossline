import { expect, test } from "vitest";
import { autoApprovalEligible, needsPersonProblem, proposalReady, readNeedsPerson } from "./auto-approval";

const base = { state: "awaiting_plan_approval", riskTier: "routine", intent: "整理 ECE 548 前几章的复习提纲",
  payload: { family: "preparation", humanCore: [{ intent: "确认章节范围" }], materialContract: [{ kind: "file" }], needsPerson: { kind: "none", quote: "" } } };

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

// Whether approving is the person's call is the model's `needsPerson` (2026-11-22), in any language; the word lists are gone.
const needs = (kind: string, quote: string) => ({ ...base, payload: { ...base.payload, needsPerson: { kind, quote } } });

test("the person's own choice or decision waits for them", () => {
  expect(autoApprovalEligible(needs("decision", "选出四个首轮选题")).eligible).toBe(false);
  expect(autoApprovalEligible(needs("decision", "Pick four topics")).eligible).toBe(false);
  // Nothing named: no reason to hold it, whatever the words.
  expect(autoApprovalEligible(needs("none", "")).eligible).toBe(true);
  expect(autoApprovalEligible({ ...base, intent: "从素材库选出四个首轮选题" }).eligible).toBe(true);
  // Work written before the field was never judged by a model: it waits rather than taking effect unread (the old word lists that
  // held such work are gone, and the worker's sweep would otherwise approve what they had held).
  const { needsPerson: _dropped, ...legacy } = base.payload;
  expect(autoApprovalEligible({ ...base, payload: legacy })).toMatchObject({ eligible: false });
});

test("access only the person can grant waits for them", () => {
  expect(autoApprovalEligible(needs("access", "导出券商结单")).eligible).toBe(false);
  expect(autoApprovalEligible(needs("access", "Export the brokerage account statement")).eligible).toBe(false);
});

test("needsPerson quotes the work's own words, verbatim; a malformed one reads as nothing named", () => {
  const texts = ["从素材库选出四个首轮选题", "整理选题"];
  expect(needsPersonProblem({ kind: "decision", quote: "选出四个  首轮选题" }, texts)).toBeNull();
  expect(needsPersonProblem({ kind: "none", quote: "" }, texts)).toBeNull();
  expect(needsPersonProblem({ kind: "decision", quote: "" }, texts)).toContain("quote");
  expect(needsPersonProblem({ kind: "decision", quote: "决定投资方向" }, texts)).toContain("决定投资方向");
  expect(needsPersonProblem({ kind: "maybe", quote: "" }, texts)).not.toBeNull();
  expect(readNeedsPerson({ kind: "access", quote: " 券商 " })).toEqual({ kind: "access", quote: "券商" });
  expect(readNeedsPerson(undefined)).toBeUndefined();
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
  expect(autoApprovalEligible({ ...en, intent: "Send the charts and data to the senior student" }).eligible).toBe(true);
  expect(autoApprovalEligible({ ...en, intent: "Email the advisor about next week" }).eligible).toBe(true);
  expect(autoApprovalEligible({ ...en, intent: "Hand the draft over to the lab manager" }).eligible).toBe(true);
  expect(autoApprovalEligible({ ...en, intent: "Hand the literature search over to the assistant" }).eligible).toBe(true);
  expect(autoApprovalEligible({ ...en, intent: "Collect the report structure and submission guidelines into a checklist" }).eligible).toBe(true);
});

test("the reason is written in the person's language", async () => {
  await import("@crossline/i18n/catalog/worker");
  expect(autoApprovalEligible(base).reason).toBe("无需本人选择或授权，默认生效；对外的那一步由本人自己做");
  expect(autoApprovalEligible(base, { locale: "en" }).reason).toBe("Needs no choice or permission from you, so it takes effect; the step that leaves this computer is yours to do");
  expect(autoApprovalEligible({ ...base, payload: { ...base.payload, seeded: true } }, { locale: "en" }).reason).toMatch(/^Example task/);
});
