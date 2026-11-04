import { expireAgentQuestion, type CrosslineStore } from "@crossline/db";
import { tOfWorkspace } from "./locale";
import type { Probe } from "./self-check";

/** Longer than the ten minutes a run waits (`ledgerQuestion`) and the quarter hour 待确认 shows a question for. */
const STUCK_AFTER_MS = 15 * 60_000;

/**
 * 助手中途提问 (the self-check's `assistant` probe): a question the assistant asked mid-run that is still open long after the run's wait,
 * or whose run has already ended, waits for nobody. It is expired, as the run's own wait would have done. Skipped when no question was
 * ever asked here.
 */
export function agentQuestionsProbe(store: CrosslineStore): Probe {
  return { id: "assistant", run: (workspaceId, now) => {
    const asked = store.listEvents(workspaceId, { type: "agent.question.requested" });
    if (!asked.length) return { status: "skipped", code: "", detail: "" };
    const closed = new Set(store.listEvents(workspaceId, { type: ["agent.question.answered", "agent.question.expired"] }).map((event) => event.entityId));
    const ended = new Set(store.listEvents(workspaceId, { type: ["agent.task.completed", "agent.task.blocked"] }).map((event) => event.entityId));
    let stuck = 0, orphaned = 0;
    for (const event of asked) {
      if (closed.has(event.entityId)) continue;
      const taskId = String((event.payload as { taskId?: unknown }).taskId ?? "");
      const orphan = ended.has(taskId);
      if (!orphan && now.getTime() - Date.parse(event.createdAt) <= STUCK_AFTER_MS) continue;
      if (!expireAgentQuestion(store, workspaceId, event.entityId)) continue;
      if (orphan) orphaned++; else stuck++;
    }
    if (!stuck && !orphaned) return { status: "ok", code: "", detail: "" };
    return { status: "repaired", code: orphaned ? "QUESTION_ORPHANED" : "QUESTION_STUCK",
      detail: tOfWorkspace(store, workspaceId)("{{orphaned}} 个提问的运行已结束、{{stuck}} 个提问等待超过 15 分钟，已把它们关闭", { orphaned, stuck }) };
  } };
}
