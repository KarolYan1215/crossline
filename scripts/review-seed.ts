import path from "node:path";
import { tmpdir } from "node:os";
import { CrosslineStore } from "../packages/db/src/index";

/**
 * Gives the review server's example tasks (scripts/review-server.ts) step plans, as the step planner would, so the task card, the
 * dialog and the step-by-step calendar can be looked at without a model run. Only ever opens the review data directory.
 *
 *   pnpm exec tsx scripts/review-seed.ts
 */
const store = new CrosslineStore(path.join(tmpdir(), "crossline-review", "crossline.db"));
const step = (id: string, role: string, title: string, minutes: number, share: number, dependsOn: string[], extra: Record<string, unknown> = {}) => ({
  id, role, title, deliverable: `${title}的产出`, doneCriterion: `${title}：完成并记录结果`, share,
  estimate: { p25Minutes: Math.round(minutes * 0.7), p50Minutes: minutes, p85Minutes: Math.round(minutes * 1.6) }, dependsOn, notBefore: "", dueBy: "",
  schedulable: role !== "wait", executor: "human" as const, tickOutcome: "", ...extra });
for (const workspace of store.listWorkspaces()) {
  const orders = store.listWorkOrders(workspace.id).filter((order) => !["accepted", "archived"].includes(order.state));
  for (const [index, order] of orders.entries()) {
    if (store.getStepPlan(workspace.id, order.id)) continue;
    if (order.state === "awaiting_plan_approval" || order.state === "captured") store.saveWorkOrder({ ...order, state: index === 0 ? "ready_for_human" : "approved" });
    store.saveStepPlan(workspace.id, order.id, { archetypeId: index % 2 ? "writing" : "research_decision", quantity: { basis: "目标字数", amount: 2, unit: "千字" },
      rationale: "按目标产出倒推：先收集资料，再分两段撰写，最后检查。", steps: [
        step("s1", "gather", "收集并筛选资料", 45, 0.2, [], { executor: "agent", tickOutcome: "资料清单完成" }),
        step("s2", "draft", "撰写第一部分", 60, 0.3, ["s1"], { tickOutcome: "第一部分初稿 1000 字" }),
        step("s3", "draft", "撰写第二部分", 60, 0.3, ["s2"]),
        step("s4", "check", "检查并修订", 30, 0.2, ["s3"], { tickOutcome: "定稿" })
      ] }, workspace.id, "review");
  }
  console.log(`${workspace.id}: ${orders.length} tasks planned`);
}
store.close();
