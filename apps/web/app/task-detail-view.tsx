"use client";
// A client component so its labels follow the page's language (docs/i18n.md); its props are plain data.
import type { TaskDetail, MilestoneDetail } from "../lib/task-detail";
import { stateLabel } from "../lib/labels";
import { useT } from "./locale-context";

const milestoneStatusLabel: Record<string, string> = { draft: "草稿", approved: "已批准", archived: "已归档" };
const criterionKindLabel: Record<string, string> = { count: "计数", artifact: "产出物", threshold: "阈值", judgement: "判断" };

/** Real background facts once the compaction pipeline (onboarding + per-capture extraction) has found
 * some for this identity; a placeholder otherwise, so the layout does not shift between the two states. */
function BackgroundFactsSection({ background }: { background: TaskDetail["background"] }) {
  const t = useT();
  if (!background || !background.length) {
    return <p className="task-detail-background-empty">{t("暂无背景资料；在访谈或收集中补充后显示")}</p>;
  }
  return <ul className="task-detail-background-facts">{background.map((fact) => <li key={fact.key}>
    <strong>{fact.value}</strong>
    <small>{fact.why}</small>
  </li>)}</ul>;
}

function FlywheelList({ items }: { items: TaskDetail["relatedFlywheel"] }) {
  const t = useT();
  if (!items.length) return null;
  return <div className="task-detail-flywheel">
    <h3>{t("相关飞轮关系")}</h3>
    {items.map((item) => <p key={item.id}>
      <span>{t(item.kindLabel)}</span> {item.fromTitle} → {item.toTitle}
      {item.pending ? t(" · 待周复盘确认") : ""}
      {item.explanation && <small> · {item.explanation}</small>}
    </p>)}
  </div>;
}

/** The display for one milestone: the preview drawer and the standalone `/milestones/[id]` page render the same view. */
export function MilestoneDetailView({ detail }: { detail: MilestoneDetail }) {
  const t = useT();
  const status = milestoneStatusLabel[detail.status];
  return <div className="task-detail-view">
    <header className="task-detail-header">
      <span className="mono-label">{detail.identityLabel.toUpperCase()}</span>
      <b>{status ? t(status) : detail.status}</b>
    </header>
    <h2>{detail.title}</h2>
    {detail.rationale && <p className="milestone-rationale">{t("提议理由：{{text}}", { text: detail.rationale })}</p>}

    <section className="task-detail-background">
      <h3>{t("背景资料")}</h3>
      <BackgroundFactsSection background={detail.background} />
    </section>

    {detail.successCriteria.length > 0 && <section>
      <h3>{t("达成标准")}</h3>
      <ul className="criterion-view">{detail.successCriteria.map((criterion) => <li key={criterion.id}>
        <span className="criterion-tag" data-evidence={criterion.evidenceOf ?? "unlabelled"}>
          {t(criterion.evidenceOf === "outcome" ? "结果" : criterion.evidenceOf === "output" ? "产出物" : "未标注")}
        </span>
        <span>[{t(criterionKindLabel[criterion.measure.kind] ?? "")}] {criterion.statement}</span>
        {criterion.measure.kind === "judgement" && <small>{t("判不过的条件：{{text}}", { text: criterion.measure.failsWhen })}</small>}
        {criterion.measure.kind === "threshold" && criterion.measure.bareLine !== undefined
          && <small>{t("从结果倒推，刚好够的最低线是 {{bare}}{{unit}}；定在 {{value}}{{unit}}，中间是留的余量", { bare: criterion.measure.bareLine, value: criterion.measure.value, unit: criterion.measure.unit ?? "" })}</small>}
      </li>)}</ul>
    </section>}

    {detail.relatedWorkOrders.length > 0 && <section>
      <h3>{t("相关任务")}</h3>
      <ul className="task-detail-related-orders">{detail.relatedWorkOrders.map((order) => <li key={order.id}>
        <a href={`/workbench/${encodeURIComponent(order.id)}`}>{order.intent}</a>
        <small>{stateLabel[order.state] ? t(stateLabel[order.state]!) : order.state}</small>
      </li>)}</ul>
    </section>}

    <FlywheelList items={detail.relatedFlywheel} />
  </div>;
}
