import { describe, expect, test } from "vitest";
import * as core from "./index";
import {
  advanceWorkOrder,
  budgetPolicy,
  evidenceRequiredFor,
  notificationForTransition,
  requiredApproval,
  skipRecurringWorkOrder,
  tombstoneWorkOrder,
  validateCommandEnvelope,
  type WorkOrder
} from "./index";

const gateCriteria: core.SuccessCriterion[] = [
  { id: "count", statement: "three records", required: true, measure: { kind: "count", unit: "records", atLeast: 3 } },
  { id: "quality", statement: "explains anomalies", required: true,
    measure: { kind: "judgement", rubric: "causal account", failsWhen: "no counterexample" } }
];
const gateResult: core.MilestoneGateResult = {
  verdict: "pass",
  criteriaVerdict: [
    { criterionId: "count", met: "met", observed: "3", evidenceQuote: "three records", shortfall: null },
    { criterionId: "quality", met: "unverifiable", observed: "needs judgement", evidenceQuote: "causal account", shortfall: null }
  ],
  contractCoverage: [], unplannedGains: [], improvements: [], incomplete: [], flywheelAssessment: [],
  gaps: [], proposedNextMilestones: [], blockers: []
};

test("milestone gate derives pass from per-criterion facts and exact evidence quotes", () => {
  expect(core.validateMilestoneGateResult(gateResult, gateCriteria, ["three records; causal account"])).toBe(gateResult);
  for (const inconsistent of [
    { ...gateResult, verdict: "insufficient" as const },
    { ...gateResult, criteriaVerdict: gateResult.criteriaVerdict.slice(0, 1) },
    { ...gateResult, criteriaVerdict: gateResult.criteriaVerdict.map((item) => ({ ...item, evidenceQuote: "invented" })) }
  ]) expect(() => core.validateMilestoneGateResult(inconsistent, gateCriteria, ["three records; causal account"]))
    .toThrow("GATE_VERDICT_INCONSISTENT");
});

test("a blocking incomplete item mechanically prevents a pass verdict", () => {
  expect(() => core.validateMilestoneGateResult({ ...gateResult,
    incomplete: [{ what: "missing trace", blocksWhich: ["count"], isBlockingPass: true }] }, gateCriteria,
  ["three records; causal account"])).toThrow("GATE_VERDICT_INCONSISTENT");
});

const workOrder = (): WorkOrder => ({
  id: "work-1",
  ownerId: "owner-1",
  workspaceId: "workspace-1",
  identityId: "research",
  projectId: "research-project",
  milestoneId: "milestone-1",
  intent: "形成可复现实验结论",
  automationParts: [{ id: "auto-1", intent: "整理原始数据", reversibility: "local" }],
  humanCore: [{ id: "human-1", intent: "判断异常样本", energy: "high", interruptible: false }],
  materialContract: [{ why: "测试用", kind: "file", description: "实验数据摘要", required: true }],
  evidenceContract: [{ why: "测试用", kind: "file", description: "带时间戳的实验记录", required: true }],
  estimate: {
    p25Minutes: 45,
    p50Minutes: 60,
    p85Minutes: 90,
    source: "identity_prior",
    observationCount: 0,
    confidence: "low"
  },
  family: "deep_work",
  riskTier: "milestone",
  state: "captured"
});

describe("work order domain rules", () => {
  test("a milestone-bound work order is the one that owes evidence", () => {
    expect(evidenceRequiredFor(workOrder())).toBe(true);
    expect(evidenceRequiredFor({ ...workOrder(), milestoneId: "" })).toBe(false);
  });

  test("skipping a recurring commitment requires a written reason", () => {
    const recurring = { ...workOrder(), recurrence: { fullMinutes: 60, minimumMinutes: 20 } };
    expect(skipRecurringWorkOrder(recurring, "")).toMatchObject({ ok: false, blocker: { code: "SKIP_REASON_REQUIRED" } });
    expect(skipRecurringWorkOrder(workOrder(), "any")).toMatchObject({ ok: false, blocker: { code: "NOT_RECURRING" } });
    expect(skipRecurringWorkOrder(recurring, " 今天只做最低档 ")).toMatchObject({ ok: true, reason: "今天只做最低档" });
  });

  test("delete first creates a recoverable tombstone", () => {
    const result = tombstoneWorkOrder(workOrder(), "duplicate");
    expect(result.state).toBe("archived");
    expect(result.tombstone.reason).toBe("duplicate");
  });

  test("external communication always needs per-item approval", () => {
    expect(requiredApproval("send_outreach_email")).toBe("per_item");
    expect(requiredApproval("publish_content")).toBe("per_item");
    expect(requiredApproval("write_focus_block")).toBe("batch");
    expect(requiredApproval("read_sync")).toBe("automatic");
    // Fail closed. The old shape ended in `return "automatic"`, so one mistyped action name at a call
    // site quietly became the weakest tier in the function everything else is told to defer to.
    expect(requiredApproval("publish_contents" as never)).toBe("per_item");
    expect(requiredApproval("" as never)).toBe("per_item");
  });

  test("notification is emitted only for a real state transition", () => {
    expect(notificationForTransition("running", "running", "task-1")).toBeNull();
    expect(notificationForTransition("running", "blocked", "task-1")).toEqual({
      entityId: "task-1",
      from: "running",
      to: "blocked",
      title: "任务已阻塞"
    });
  });

  test("budget policy pauses low-value work at 85 percent and gates core work at 100 percent", () => {
    expect(budgetPolicy(84)).toEqual({ mode: "normal", warning: true });
    expect(budgetPolicy(85)).toEqual({ mode: "economy", warning: true });
    expect(budgetPolicy(100)).toEqual({ mode: "manual_core_only", warning: true });
  });

  test("offline command envelope rejects missing identity fields", () => {
    expect(validateCommandEnvelope({ clientCommandId: "c-1", type: "task.capture" })).toEqual({
      ok: false,
      blocker: { code: "INVALID_COMMAND_ENVELOPE", message: "离线命令缺少必填字段" }
    });
    expect(validateCommandEnvelope({
      ownerId: "owner-1", workspaceId: "workspace-1", clientCommandId: "c-1",
      clientSequence: 1, type: "task.capture", payload: { title: "Read paper" },
      createdAt: "2026-09-13T20:00:00.000Z"
    }).ok).toBe(true);
  });

  test("only deterministic transitions can advance a work order", () => {
    const analyzed = advanceWorkOrder(workOrder(), { type: "analysis.proposed", proposalId: "p-1" });
    expect(analyzed.ok).toBe(true);
    if (!analyzed.ok) return;
    expect(analyzed.workOrder.state).toBe("analyzing");

    const invalid = advanceWorkOrder(analyzed.workOrder, { type: "human.started" });
    expect(invalid).toEqual({
      ok: false,
      blocker: {
        code: "INVALID_WORK_ORDER_TRANSITION",
        message: "不能从 analyzing 通过 human.started 转换状态"
      }
    });
  });

  test("milestone work requires plan approval before AI preparation", () => {
    const initial = workOrder();
    const analyzing = advanceWorkOrder(initial, { type: "analysis.proposed", proposalId: "p-1" });
    if (!analyzing.ok) throw new Error("expected analyzing state");
    const awaiting = advanceWorkOrder(analyzing.workOrder, { type: "analysis.accepted", approvalId: "a-1" });
    if (!awaiting.ok) throw new Error("expected awaiting approval state");
    expect(awaiting.workOrder.state).toBe("awaiting_plan_approval");

    const blocked = advanceWorkOrder(awaiting.workOrder, { type: "automation.started" });
    expect(blocked.ok).toBe(false);
    const approved = advanceWorkOrder(awaiting.workOrder, { type: "plan.approved", approvalId: "a-2" });
    expect(approved.ok).toBe(true);
    if (approved.ok) expect(approved.workOrder.state).toBe("approved");
  });
});

test("a judgement criterion must say what would fail it, or the milestone can never be judged short", () => {
  const base = { id: "c1", statement: "想清楚这条路要不要走", required: true };
  expect(core.validateSuccessCriteria([{ ...base, measure: { kind: "judgement", rubric: "有结论", failsWhen: "" } }]))
    .toMatchObject({ ok: false, blocker: { code: "CRITERION_NOT_FALSIFIABLE" } });
  // All-judgement is allowed, but it is labelled so the weekly review can look harder at it.
  expect(core.validateSuccessCriteria([{ ...base, measure: { kind: "judgement", rubric: "有结论", failsWhen: "没有给出任何反例检验" } }]))
    .toEqual({ ok: true, verifiability: "judgement_only" });
  expect(core.validateSuccessCriteria([
    { ...base, measure: { kind: "count", unit: "门课程", atLeast: 3 } },
    { id: "c2", statement: "留下成绩单", required: true, measure: { kind: "artifact", mustExist: "transcript.pdf" } }
  ])).toEqual({ ok: true, verifiability: "measurable" });
  expect(core.validateSuccessCriteria([])).toMatchObject({ ok: false, blocker: { code: "MILESTONE_NEEDS_CRITERIA" } });
});
