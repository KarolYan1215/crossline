/**
 * What a 「收集」 card says now, from where its capture has got to. The card used to keep the words it was written with — 「已收集，正在分析
 * 估时与步骤」 — after the task had been analysed, done and accepted (walkthrough W-16). The capture and the task it becomes share one id.
 */
export type CaptureProgress = { message: string; href?: string };

export function captureProgress(capture: { state: string } | undefined, order: { id: string; state: string; title: string } | undefined): CaptureProgress | undefined {
  if (order) {
    const href = `/workbench/${encodeURIComponent(order.id)}`;
    const title = `「${order.title}」`;
    switch (order.state) {
      case "awaiting_plan_approval": return { message: `已生成任务${title}，等本人批准`, href };
      case "evidence_review": return { message: `任务${title}已提交，等待验收`, href };
      case "accepted": return { message: `任务${title}已完成`, href };
      case "archived": return { message: `任务${title}已归档`, href };
      case "blocked": return { message: `任务${title}受阻，见任务页`, href };
      default: return { message: `已生成任务${title}`, href };
    }
  }
  if (!capture) return undefined;
  if (capture.state === "blocked") return { message: "分析没有完成，原因在待决事项里", href: "/approvals" };
  if (capture.state === "discarded") return { message: "已丢弃" };
  return undefined;
}
