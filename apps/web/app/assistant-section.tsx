import type { AccessContext } from "@crossline/core";
import { listAgentTasks } from "@crossline/db";
import { assistantOffer } from "../lib/agent";
import { getStore } from "../lib/crossline";
import { HandOver } from "./assistant/assistant-controls";

const STATUS: Record<string, string> = { running: "进行中", stale: "没有结果", blocked: "没做成", needs_review: "等你过目", accepted: "已采纳", rejected: "已退回" };

/**
 * On a work order: what the assistant could do for it, with the button to hand it over, and what it already did. The split comes from
 * the analysis the person approved — the machine part goes over, the human core stays — and the section says both, so handing over
 * never reads as handing over the whole thing.
 */
export function AssistantSection({ ctx, workOrderId }: { ctx: AccessContext; workOrderId: string }) {
  const offer = assistantOffer(ctx, workOrderId);
  const tasks = listAgentTasks(getStore(), ctx.workspaceId).filter((task) => task.workOrderId === workOrderId);
  if (!offer.available && !tasks.length) return null;
  return <section className="review-block assistant-section" aria-label="助手">
    <h2>助手</h2>
    {offer.available
      ? <>
          <p>{offer.why} 交过去的只有分析里属于 AI 的那部分；<strong>你自己做的：</strong>{offer.humanPart}。</p>
          {offer.graded && <p role="note" className="seed-notice">这是带评分的课程工作，助手只做学习辅助（讲解、你自己设计的练习、检查你写的、整理资料），不会写可提交的答案。</p>}
          {!offer.categoryAllowed && offer.category && <p className="muted">你还没同意助手做「{offer.categoryLabel}」这类工作；点下面的按钮会向你请求同意。</p>}
          <HandOver workOrderId={workOrderId} category={offer.category ?? ""} categoryLabel={offer.categoryLabel} />
        </>
      : <p className="muted">{offer.reason}</p>}
    {tasks.length > 0 && <ul>{tasks.map((task) => <li key={task.taskId}>{STATUS[task.status] ?? task.status} · {task.title} <a href="/assistant">在「助手」页查看 →</a></li>)}</ul>}
  </section>;
}
