/**
 * The words a work order's state and risk are shown with — one table, read by Workbench, the task
 * detail view and the approvals page. Three private copies drifted, and all three printed `riskTier`
 * "milestone" as 「里程碑」 under the heading 「风险等级」, which read as the milestone it belongs to rather
 * than how much is at stake.
 */
export const stateLabel: Record<string, string> = {
  captured: "已收集", analyzing: "分析中", awaiting_plan_approval: "等待计划批准",
  approved: "已批准", preparing: "材料准备中", ready_for_human: "可开始",
  active: "执行中", evidence_review: "证据审查中", accepted: "已验收", blocked: "已阻塞", archived: "已归档"
};

/** A paused execution is not 「执行中」: the card used to say both at once. */
export const stateLabelFor = (state: string, paused: boolean): string =>
  state === "active" && paused ? "已暂停" : stateLabel[state] ?? "未知状态";

export const riskLabel: Record<string, string> = { routine: "常规", milestone: "中（影响里程碑）", high_risk: "高风险" };
