"use client";
import { Prepared } from "../task/prepared";

import { useEffect, useState } from "react";
import type { TaskDetail } from "../../lib/task-detail";
import type { Locale } from "../../lib/i18n";
import { stateLabelFor } from "../../lib/labels";
import { LineTag, Tag } from "../ui/tag";
import { useLocale, useT } from "../locale-context";
import { dayWithWeekday } from "./format";
import { TaskActions } from "../task/task-actions";
import { TaskDialog } from "../task/task-dialog";
import { TaskQuickEdit } from "../task/quick-edit";
import { ImpactCard, useImpact } from "../task/impact";
import { shiftDay, type TimelineItem } from "./model";
import type { LineLabels } from "./views";
import { lockOnStart } from "./block-start";
import { CompleteDialog } from "./complete-dialog";
import { HeldBlock } from "./held-block";
import { useReturnState } from "../ui/return-state";
import { agentStepFor, followingBlock, otherOpenSteps, stepOfBlock } from "./panel-model";

/** Kept in Chinese (they are the keys); translated where shown. */
const KIND_TEXT: Record<TimelineItem["kind"], string> = {
  scheduled: "排程器安排", proposed: "预览：批准后排在这里", optional: "预排：可用时段内放不下，开始后转为正式排程",
  import: "来自导入的文件", calendar: "来自日历", activity: "实际记录"
};
const AGENT_TEXT = { planned: "Agent 将执行", running: "Agent 执行中" } as const;

/**
 * Locks this block at its time, or unlocks it (docs/loop-and-scout.md §1): a locked block is no longer moved by re-planning; one a
 * calendar change lands on is asked about instead of moved.
 */
function LockToggle({ item }: { item: TimelineItem }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (item.kind !== "scheduled" || !item.day) return null;
  // A held block (started or locked) is changed in `HeldBlock`: 改时间, 解锁, 保留重叠, 留言.
  if (item.frozen === "pinned" || item.frozen === "locked") return null;
  const locked = item.tag === "已锁定"; // i18n-ignore: compared with the tag the schedule builds
  const toggle = async () => {
    setBusy(true); setFailed(false);
    const response = await fetch("/api/plan/pin", { method: locked ? "DELETE" : "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(locked ? { blockId: item.id } : { blockId: item.id, day: item.day, start: item.start, end: item.end, reason: "locked" }) }).catch(() => null);
    if (response?.ok) { window.location.reload(); return; }
    setBusy(false); setFailed(true);
  };
  return <>
    <button type="button" className="secondary" aria-pressed={locked} disabled={busy} onClick={() => void toggle()}>{locked ? t("解除锁定") : t("锁定在此时间")}</button>
    {failed && <small role="status">{locked ? t("未能解除锁定，请重试") : t("未能锁定，请重试")}</small>}
  </>;
}
const FINISHED = ["accepted", "archived", "evidence_review"];

/**
 * A task's detail for the panel: the copy read with the page when there is one, otherwise read once from the server (a block on a day
 * outside the coming week). `undefined` while it loads, `null` when the task is gone.
 */
export function useTaskDetail(workOrderId: string | undefined, preloaded: Record<string, TaskDetail> | undefined): TaskDetail | null | undefined {
  const [fetched, setFetched] = useState<Record<string, TaskDetail | null>>({});
  const known = workOrderId ? preloaded?.[workOrderId] ?? fetched[workOrderId] : null;
  useEffect(() => {
    if (!workOrderId || known !== undefined) return;
    let live = true;
    void fetch(`/api/work-orders/${encodeURIComponent(workOrderId)}/detail`).then((response) => response.ok ? response.json() : null)
      .then((body: { detail?: TaskDetail } | null) => { if (live) setFetched((current) => ({ ...current, [workOrderId]: body?.detail ?? null })); })
      .catch(() => { if (live) setFetched((current) => ({ ...current, [workOrderId]: null })); });
    return () => { live = false; };
  }, [workOrderId, known]);
  return known;
}

const slotText = (item: TimelineItem, locale: Locale) => `${dayWithWeekday(locale, item.day)} ${item.start}–${item.end}`;

/**
 * The block the person picked (or, with nothing picked, the next one): where it sits — 主线 · 里程碑, the step and the task's progress,
 * the due date and this step's duration (both edited in place and previewed), what falls to the person, the task's next block — and
 * what can be done from here: start, pause, resume (a pencilled-in block is made formal first), 完成并提交材料, 交给 Agent when the system
 * can do the step, and 推迟 to tomorrow or a chosen day, previewed. `compact` is the 下一项 form: the line, the task, the time, the start.
 */
export function BlockOverview({ item, items, today, labels, details, compact = false, heading, onClose }: {
  item: TimelineItem; items: TimelineItem[]; today: string; labels: LineLabels; details?: Record<string, TaskDetail> | undefined;
  compact?: boolean; heading: string; onClose?: (() => void) | undefined;
}) {
  const t = useT();
  const locale = useLocale();
  const detail = useTaskDetail(item.workOrderId, details);
  const [open, setOpen] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [postponing, setPostponing] = useState(false);
  const [deferDay, setDeferDay] = useState(shiftDay(today, 1));
  const impact = useImpact();
  // Back from a task's page, the block's task dialog is open again if it was.
  useReturnState(`block-overview:${item.id}`, { open }, (saved) => { if (saved.open) setOpen(true); });
  const line = item.identityId ? labels[item.identityId] ?? "" : "";
  const steps = detail?.stepPlan?.steps ?? [];
  const step = item.workOrderId ? stepOfBlock(item, steps) : undefined;
  const following = followingBlock(items, item);
  const agentStepId = detail && item.agent !== "running" ? agentStepFor(item, steps) ?? (item.stepId ? undefined : detail.agentSteps[0]?.id) : undefined;
  const progress = detail?.stepPlan ? Math.round(detail.stepPlan.progress * 100) : undefined;
  const personsPart = detail ? (detail.humanCore.length ? detail.humanCore.map((part) => part.intent)
    : steps.filter((other) => other.status === "planned" && other.executor === "human").map((other) => other.title)).slice(0, 3) : [];
  const live = detail && !["accepted", "archived"].includes(detail.state);

  const head = <header className="dq-focus-head">
    <h3>{heading}</h3>
    {onClose && <button type="button" className="dq-close" onClick={onClose}>{t("返回下一项")}</button>}
  </header>;

  // A calendar event, a file's class meeting, an activity record: what it is and where it came from; nothing to act on here.
  if (!item.workOrderId) return <div className="dq-focus" data-line={item.identityId ?? "none"}>
    {head}
    {line && <p className="dq-where"><LineTag line={item.identityId}>{line}</LineTag></p>}
    <h4 className="dq-title">{item.title}</h4>
    <p className="dq-meta"><span className="mono">{slotText(item, locale)}</span> · {t(KIND_TEXT[item.kind])}</p>
  </div>;

  return <div className="dq-focus" data-line={item.identityId ?? "none"} data-compact={compact || undefined}>
    {head}
    <p className="dq-where">
      {line && <LineTag line={item.identityId}>{line}</LineTag>}
      {item.milestone && <span className="dq-milestone">{item.milestone}</span>}
    </p>
    <h4 className="dq-title">{detail?.title ?? item.title}</h4>
    <p className="dq-meta"><span className="mono">{slotText(item, locale)}</span>{item.tag ? ` · ${t(item.tag)}` : ""}
      {detail && <> · {stateLabelFor(detail.state, detail.paused)}</>}</p>
    {item.agent && <p className="dq-agent"><Tag tone="info">{t(AGENT_TEXT[item.agent])}</Tag></p>}
    {(step || progress !== undefined) && <div className="dq-step">
      <small>{step ? (step.executor === "human" ? t("本步") : t("本步 · 系统可做")) : t("进度")}</small>
      {step && <span className="dq-step-title">{step.title}</span>}
      {step?.firstAction && step.status === "planned" && <span className="dq-first"><small>{t("第一步")}</small> <span className="gen">{step.firstAction}</span></span>}
      {progress !== undefined && <span className="dq-progress"><span className="task-progress-bar" aria-hidden="true"><i style={{ width: `${progress}%` }} /></span>
        <b className="mono">{progress}%</b></span>}
    </div>}
    {detail === undefined && <small className="muted" role="status">{t("读取任务…")}</small>}
    {detail === null && <small className="muted" role="status">{t("任务已不存在，请刷新。")}</small>}
    {!compact && detail && <>
      <TaskQuickEdit workOrderId={detail.id} dueBy={detail.window.dueBy} samples={detail.estimate.observationCount} line={detail.identityId}
        estimate={step?.estimate ?? detail.estimate} stepId={step?.id} editable={Boolean(live)} durationLabel={step ? t("本步时长") : t("时长")} />
      {personsPart.length > 0 && <div className="dq-part"><small>{t("本人负责")}</small>
        <ul>{personsPart.map((text) => <li key={text} className="gen">{text}</li>)}</ul></div>}
      {following && <p className="dq-meta"><small>{t("下一个时段")}</small> <span className="mono">{slotText(following, locale)}</span>{following.step ? ` · ${following.step}` : ""}</p>}
      <Prepared detail={detail} />
    </>}
    {detail && <TaskActions workOrderId={detail.id} state={detail.state} paused={detail.paused} agentReady={Boolean(agentStepId)} agentStepId={agentStepId}
      beforeStart={() => lockOnStart(item, locale)} onOpen={compact ? undefined : () => setOpen(true)}
      offline={{ ownerId: detail.viewerId, workspaceId: detail.workspaceId, intent: detail.intent }}>
      {!compact && ["approved", "ready_for_human", "active"].includes(detail.state) && <button type="button" onClick={() => setCompleting(true)}>{t("完成并提交材料")}</button>}
      {!compact && live && !FINISHED.includes(detail.state) && <button type="button" aria-expanded={postponing} onClick={() => setPostponing((value) => !value)}>{t("推迟")}</button>}
      {!compact && live && !FINISHED.includes(detail.state) && <LockToggle item={item} />}
    </TaskActions>}
    {!compact && live && !FINISHED.includes(detail.state) && <HeldBlock item={item} items={items} title={detail.title} />}
    {postponing && detail && <div className="dq-defer" role="group" aria-label={t("推迟到")}>
      <button type="button" disabled={impact.busy} onClick={() => void impact.propose({ kind: "defer", workOrderId: detail.id, date: shiftDay(today, 1) })}>{t("明天")}</button>
      <label><span>{t("选一天")}</span><input type="date" value={deferDay} min={shiftDay(today, 1)} onChange={(event) => setDeferDay(event.target.value)} /></label>
      <button type="button" disabled={impact.busy || !deferDay} onClick={() => void impact.propose({ kind: "defer", workOrderId: detail.id, date: deferDay })}>{t("预览")}</button>
      {impact.busy && !impact.pending && <small role="status">{t("计算影响…")}</small>}
      {impact.error && <small role="status">{impact.error}</small>}
    </div>}
    {impact.pending && <ImpactCard impact={impact.pending.impact} busy={impact.busy} onApply={() => void impact.apply()} onCancel={impact.cancel} />}
    {detail && !compact && <TaskDialog detail={detail} open={open} onOpenChange={setOpen} />}
    {detail && completing && <CompleteDialog open={completing} onOpenChange={setCompleting} workOrderId={detail.id} title={detail.title} state={detail.state}
      stepId={step?.id} stepTitle={step?.title} otherSteps={otherOpenSteps(step?.id, steps)} />}
  </div>;
}
