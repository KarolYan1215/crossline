/**
 * What a 「收集」 card says now, from where its capture has got to. The card used to keep the words it was written with — 「已收集，正在分析
 * 估时与步骤」 — after the task had been analysed, done and accepted (walkthrough W-16). The capture and the task it becomes share one id.
 */
import { tFor, type Translate } from "./i18n";

export type CaptureProgress = { message: string; href?: string };

export function captureProgress(capture: { state: string } | undefined, order: { id: string; state: string; title: string } | undefined,
  t: Translate = tFor(undefined)): CaptureProgress | undefined {
  if (order) {
    const href = `/workbench/${encodeURIComponent(order.id)}`;
    const title = order.title;
    switch (order.state) {
      case "awaiting_plan_approval": return { message: t("已生成任务「{{title}}」，等本人批准", { title }), href };
      case "evidence_review": return { message: t("任务「{{title}}」已提交，等待验收", { title }), href };
      case "accepted": return { message: t("任务「{{title}}」已完成", { title }), href };
      case "archived": return { message: t("任务「{{title}}」已归档", { title }), href };
      case "blocked": return { message: t("任务「{{title}}」受阻，见任务页", { title }), href };
      default: return { message: t("已生成任务「{{title}}」", { title }), href };
    }
  }
  if (!capture) return undefined;
  if (capture.state === "blocked") return { message: t("分析没有完成，原因在待决事项里"), href: "/approvals" };
  if (capture.state === "discarded") return { message: t("已丢弃") };
  return undefined;
}
