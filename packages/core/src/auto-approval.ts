import { mentionsExternalAction } from "./external-action";

/** Who a default-effective approval is recorded as. Never the person's own principal: they did not click. */
export const AUTO_APPROVER_ID = "system:auto-approval";
/** How long an automatic approval can still be taken back with one click. */
export const AUTO_APPROVAL_UNDO_MS = 24 * 60 * 60_000;

type Candidate = {
  state: string;
  riskTier: string;
  intent: string;
  payload: unknown;
};

/**
 * Whether a proposal may take effect without the person, keeping a one-click undo — the risk-tiered default
 * the person chose: inside-the-machine, reversible preparation work (the landing work for a byproduct of
 * something they already approved, and the internal steps worked back from a milestone they approved) goes
 * ahead; anything that commits them — a milestone, a target, a relation, anything that reaches outside the
 * machine — waits for a click.
 *
 * The external-action words are matched against what the work *is* (its intent and the person's own part),
 * not a serialized payload, which matched a contract's `kind: "file"` and made nothing eligible.
 */
export function autoApprovalEligible(order: Candidate): { eligible: boolean; reason: string } {
  if (order.state !== "awaiting_plan_approval") return { eligible: false, reason: "不在待批准状态" };
  const payload = (order.payload ?? {}) as { family?: string; byproductOf?: string; backplan?: unknown; datePair?: unknown; humanCore?: Array<{ intent?: string }> };
  const external = mentionsExternalAction(order.intent, ...(payload.humanCore ?? []).map((part) => part.intent));
  // Work the person's own confirmed course dates already commit them to (a homework between its release and due date): the decision was
  // confirming the dates. Default-effective, undoable for a day (decided 2026-10-07).
  if (payload.datePair && order.riskTier !== "high_risk" && !external)
    return { eligible: true, reason: "来自已确认的课程日期，默认生效" };
  // A step worked back from a milestone the person already approved: the commitment was the milestone, and its next steps follow from
  // it. Asking again for each step is what left fifteen decisions waiting and the week empty (2026-10-07). Undoable for a day.
  if (payload.backplan && order.riskTier !== "high_risk" && !external)
    return { eligible: true, reason: "从你已批准的里程碑倒推出的内部步骤，默认生效" };
  if (order.riskTier !== "routine") return { eligible: false, reason: "影响里程碑或高风险，需要你确认" };
  const internalKind = payload.family === "preparation" || Boolean(payload.byproductOf);
  if (!internalKind) return { eligible: false, reason: "不是准备类工作，需要你确认" };
  if (external)
    return { eligible: false, reason: "涉及对外动作（发送、提交、发布、付款等），需要你确认" };
  return { eligible: true, reason: "内部、可撤销的准备工作，默认生效" };
}
