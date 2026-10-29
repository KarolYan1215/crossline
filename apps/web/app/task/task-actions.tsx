"use client";

import { useState, type ReactNode } from "react";
import { MenuButton } from "../ui/controls";
import { createCommand, enqueue, nextSequence, type OfflineCommandType } from "../offline-queue";
import { useT } from "../locale-context";
import { BadgeCheck, Bot, Maximize2, MoreHorizontal, Pause, Play, RotateCcw } from "lucide-react";
import { ICON, IconButton } from "../ui/icon-button";

const OFFLINE_TYPES: Record<string, OfflineCommandType> = { start: "work_order.start", pause: "work_order.pause", resume: "work_order.resume" };

const FAILURE: Record<string, string> = {
  MATERIALS_PREPARING: "已转入材料准备，准备完成后即可开始。",
  EXECUTION_NOT_STARTABLE: "当前状态不能开始计时，请刷新。",
  NO_ACTIVE_EXECUTION: "没有进行中的计时，请刷新。",
  WORK_ORDER_ALREADY_ACCEPTED: "已验收的任务不能归档。"
};
const PAUSE_REASONS = ["被打断", "切换任务", "休息", "等待他人"];

async function post(path: string, body: unknown): Promise<{ ok: boolean; code?: string; state?: string; message?: string }> {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  const result = await response?.json().catch(() => ({})) as { ok?: boolean; code?: string; state?: string; message?: string } | undefined;
  return { ok: Boolean(response?.ok) && result?.ok !== false, ...(result ?? {}) } as { ok: boolean; code?: string; state?: string; message?: string };
}

/**
 * The card's own actions, one primary per state: 批准 (a proposal), 开始计时 (approved work; opens the task and starts the floating
 * countdown), 暂停 with a reason / 继续计时 (a running session), and 交给 Agent when the system can do the work or one of its steps.
 * Archiving sits in the overflow menu. Completion and evidence are in the task dialog, where the person can see what is being handed in.
 */
export function TaskActions({ workOrderId, state, approvable = true, paused, agentReady, agentStepId, onOpen, offline, beforeStart, iconic = false, children }: {
  /** Icons in place of the buttons' words (a row on Today); the words stay as each button's name and tip. */
  iconic?: boolean;
  workOrderId: string; state: string; paused: boolean; agentReady: boolean; onOpen?: (() => void) | undefined;
  /** False for a proposal whose steps are still being planned: there is nothing to approve yet (W-31). */
  approvable?: boolean;
  /** The step 「交给 Agent」 hands over (the first one the system can do); without it, the whole task. */
  agentStepId?: string | undefined;
  /** Who and which workspace a command queued offline belongs to, and the title the offline list shows. */
  offline?: { ownerId: string; workspaceId: string; intent: string };
  /**
   * Runs before the timer starts; a message stops the start and is shown. A pencilled-in block on the day view becomes formal here
   * (`lockOnStart`), so starting from a block and starting from a card are the same path.
   */
  beforeStart?: (() => Promise<string | null>) | undefined;
  /** More buttons beside the primary one (the day panel's 完成并提交材料 and 推迟), before the overflow menu. */
  children?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [pausing, setPausing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [reason, setReason] = useState("");
  const t = useT();
  // Start, pause and resume survive a dead connection: queued on the device and replayed when it is back, as the offline workbench
  // promises. Everything else here (approve, archive, hand over) needs the server.
  const execution = async (body: Record<string, unknown>) => {
    const type = OFFLINE_TYPES[String(body.action)];
    const queue = async () => {
      if (!offline || !type) return undefined;
      const command = createCommand(offline.ownerId, offline.workspaceId, await nextSequence(offline.workspaceId), type,
        { workOrderId, title: offline.intent, ...(body.reason ? { reason: body.reason } : {}) });
      await enqueue(offline.workspaceId, command);
      return { ok: false, message: t("已离线保存，联网后自动同步") };
    };
    if (!navigator.onLine) return (await queue()) ?? { ok: false, message: t("网络不可用") };
    const result = await post(`/api/work-orders/${encodeURIComponent(workOrderId)}/execution`, body);
    if (!result.ok && !result.code && !result.message) return (await queue()) ?? result;
    return result;
  };
  const run = async (action: () => Promise<{ ok: boolean; code?: string; message?: string; state?: string }>, then?: () => void) => {
    setBusy(true); setStatus("");
    const result = await action();
    setBusy(false);
    if (result.ok) { if (then) then(); else location.reload(); return; }
    const known = FAILURE[result.code ?? ""];
    setStatus(known ? t(known) : result.message ?? t("操作未生效，请刷新。"));
  };
  const start = () => {
    // The countdown notifies when the usual duration is up; the browser asks once, on the first start.
    try { if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission(); } catch { /* unsupported */ }
    void run(async () => {
      const refused = beforeStart ? await beforeStart() : null;
      return refused ? { ok: false, message: refused } : execution({ action: "start" });
    }, () => { location.href = `/workbench/${encodeURIComponent(workOrderId)}`; });
  };
  const delegate = () => void run(async () => {
    const result = await post("/api/agent/dispatch", { workOrderId, ...(agentStepId ? { stepId: agentStepId } : {}) });
    if (result.state === "started") return { ok: true };
    if (result.state === "needs_category_approval") return { ok: false, message: t("这类工作尚未允许 Agent 执行，已加入待决事项。") };
    return { ok: false, message: result.message ?? t("未能交给 Agent。") };
  }, () => setStatus(t("已交给 Agent，产出完成后进入待审阅。")));

  // Iconic (a row on Today, 2026-10-28): the same buttons drawn as icons, their words kept as the name and the hover tip.
  const action = (label: string, icon: ReactNode, onClick: () => void, primary = false) => iconic
    ? <IconButton label={label} icon={icon} tone={primary ? "primary" : "plain"} disabled={busy} onClick={onClick} />
    : <button type="button" className={primary ? "primary-button" : undefined} disabled={busy} onClick={onClick}>{label}</button>;
  const approve = () => void run(() => post(`/api/work-orders/${encodeURIComponent(workOrderId)}/approve`, {}));

  return <div className="task-actions" data-iconic={iconic || undefined}>
    {state === "awaiting_plan_approval" && approvable && action(t("批准"), <BadgeCheck {...ICON} />, approve, true)}
    {state === "blocked" && action(t("恢复"), <RotateCcw {...ICON} />, approve, true)}
    {(state === "approved" || state === "ready_for_human") && action(t("开始计时"), <Play {...ICON} />, start, true)}
    {state === "active" && !paused && !pausing && action(t("暂停"), <Pause {...ICON} />, () => setPausing(true))}
    {state === "active" && paused && action(t("继续计时"), <Play {...ICON} />, () => void run(() => execution({ action: "resume" })), true)}
    {pausing && <span className="task-actions-choices" role="group" aria-label={t("暂停原因")}>
      {/* The reason is kept in the person's language, like anything they say about their own work. */}
      {PAUSE_REASONS.map((item) => <button key={item} type="button" disabled={busy} onClick={() => void run(() => execution({ action: "pause", reason: t(item) }))}>{t(item)}</button>)}
      <button type="button" onClick={() => setPausing(false)} aria-label={t("取消暂停")}>×</button>
    </span>}
    {agentReady && !["accepted", "archived", "evidence_review"].includes(state) && action(t("交给 Agent"), <Bot {...ICON} />, delegate)}
    {children}
    {onOpen && (iconic ? <IconButton label={t("打开")} icon={<Maximize2 {...ICON} />} onClick={onOpen} /> : <button type="button" onClick={onOpen}>{t("打开")}</button>)}
    {!["accepted", "archived"].includes(state) && <MenuButton label={t("更多操作")} icon={iconic ? <MoreHorizontal {...ICON} /> : "⋯"} items={[{ label: t("归档"), hint: t("可在已归档中恢复"), onSelect: () => setArchiving(true) }]} />}
    {archiving && <span className="task-actions-choices">
      <input value={reason} maxLength={200} placeholder={t("归档原因（选填）")} aria-label={t("归档原因（选填）")} onChange={(event) => setReason(event.target.value)} />
      <button type="button" disabled={busy} onClick={() => void run(() => execution({ action: "archive", reason }))}>{t("归档")}</button>
      <button type="button" onClick={() => setArchiving(false)} aria-label={t("取消归档")}>×</button>
    </span>}
    {status && <small role="status" className="task-actions-status">{status}</small>}
  </div>;
}
