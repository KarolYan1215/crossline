import type { TaskDetail } from "../../lib/task-detail";
import { stepSegments } from "./card-model";
import { useT } from "../locale-context";

const KIND_LABEL = { done: "已完成", current: "当前", waiting: "等待中", agent: "助手准备", open: "未开始" } as const;

/**
 * A task's progress as a picture: one segment per step, as wide as its share of the work, filled as far as it is done — the current step
 * outlined, a step that waits dashed, the assistant's preparation hatched. Hovering a segment names the step; the exact figure is in the
 * accessible name, not printed.
 */
export function StepStrip({ detail, size = "card" }: { detail: Pick<TaskDetail, "stepPlan">; size?: "card" | "page" }) {
  const t = useT();
  const segments = stepSegments(detail);
  if (!segments.length) return null;
  const done = segments.filter((segment) => segment.kind === "done").length;
  const percent = Math.round((detail.stepPlan?.progress ?? 0) * 100);
  return <div className="step-strip" data-size={size} role="img" aria-label={t("进度 {{percent}}%，{{done}}/{{total}} 步完成", { percent, done, total: segments.length })}>
    {segments.map((segment) => <span key={segment.id} className="step-seg" data-kind={segment.kind} style={{ flexGrow: segment.weight }}
      title={`${segment.title} · ${t(KIND_LABEL[segment.kind])}`}>
      <i style={{ width: `${Math.round(segment.fill * 100)}%` }} />
    </span>)}
  </div>;
}
