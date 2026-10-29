"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { Ask, AskOption } from "@crossline/core";
import { AlarmClock, CalendarClock, Check, ChevronDown, ChevronRight, Flag, Infinity as Loop } from "lucide-react";
import type { TaskDetail } from "../../lib/task-detail";
import { AskCard } from "../asks/ask-card";
import { useAskList } from "../asks/ask-drawer";
import { answerBody, answerProblem } from "../asks/model";
import type { AskPreviews } from "../asks/types";
import { AnswerAll } from "../asks/answer-all";
import { PendingTotalLink } from "../pending-badge";
import { TaskActions } from "../task/task-actions";
import { TaskCard, type TaskSlot } from "../task/task-card";
import { TaskDialog } from "../task/task-dialog";
import { currentStep, dueDistance } from "../task/card-model";
import { ImpactCard, useImpact } from "../task/impact";
import { CompleteDialog } from "../timeline/complete-dialog";
import { otherOpenSteps } from "../timeline/panel-model";
import { shiftDay } from "../timeline/model";
import type { LineLabels } from "../timeline/views";
import type { Reminder } from "../../lib/reminders";
import { LineTag } from "../ui/tag";
import { useReturnState } from "../ui/return-state";
import { ICON, IconButton } from "../ui/icon-button";
import { useLocale, useT } from "../locale-context";

/** A task Today puts forward: the recommended next one (`label` 下一步) and its alternatives, each with the words that say why. */
export type NeedTask = { detail: TaskDetail; label: string; reason?: string | undefined; slot?: TaskSlot | undefined; hero?: boolean };
export type NeedRow =
  | { kind: "ask"; key: string; ask: Ask }
  | { kind: "task"; key: string; task: NeedTask }
  | { kind: "reminder"; key: string; reminder: Reminder };

/**
 * One list of what needs the person today, in the order it should be dealt with: questions due today, then the work put forward, then
 * the week's other questions, then what other pages flag (reminders). Pure, for its test.
 */
export function needRows({ asks, tasks, reminders }: { asks: Ask[]; tasks: NeedTask[]; reminders: Reminder[] }): NeedRow[] {
  const ask = (item: Ask): NeedRow => ({ kind: "ask", key: `ask:${item.id}`, ask: item });
  return [
    ...asks.filter((item) => item.urgency === "now").map(ask),
    ...tasks.map((task): NeedRow => ({ kind: "task", key: `task:${task.detail.id}`, task })),
    ...asks.filter((item) => item.urgency !== "now").map(ask),
    ...reminders.map((reminder): NeedRow => ({ kind: "reminder", key: `reminder:${reminder.id}`, reminder }))
  ];
}

/** The option a row may settle in one press: the recommended one, when it needs no follow-up, no words and is not a link. */
export function quickOption(ask: Ask): AskOption | undefined {
  if (ask.select === "many") return undefined;
  const option = ask.options.find((item) => item.recommended && !item.href);
  if (!option || option.needsNote) return undefined;
  const fields = option.fields ?? [];
  if (fields.length && (fields.some((field) => field.required) || !ask.freeText)) return undefined;
  return option;
}

async function post(path: string, body: Record<string, unknown>): Promise<{ ok?: boolean; code?: string } | null> {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  return await response?.json().catch(() => null) as { ok?: boolean; code?: string } | null;
}

/**
 * 「N 件需要处理」 (2026-10-28, the owner's reference design): the reminder chips, the stack of decisions and the 「下一步」 card in one list.
 * Each row is the line's tag, one sentence, a red flag when it is due today, and the presses it is usually given — a task's start,
 * complete, postpone and open; a question's recommended answer, the full card and 「明天再问」. Opening a row shows the full task card or
 * question card in place, nothing left out. ← → open the previous or next row (not while typing, in a dialog or on a slider).
 */
export function NeedsCard({ asks: initialAsks, previews, tasks, reminders, labels, today, notes, empty }: {
  asks: Ask[]; previews?: AskPreviews | undefined; tasks: NeedTask[]; reminders: Reminder[]; labels: LineLabels; today: string;
  /** Lines above the list (a proposal due within a week, the demo-work note). */
  notes?: ReactNode;
  /** What to say when no work is put forward: which step comes next (drafts, backplanning, the interview). */
  empty?: ReactNode;
}) {
  const t = useT();
  const { asks, onDone } = useAskList(initialAsks, (ask) => !ask.entersOn);
  const rows = needRows({ asks, tasks, reminders });
  const [open, setOpen] = useState<string | null>(null);
  // Back from a task's page, the row it was opened from is open again (and its card reopens its dialog).
  useReturnState("needs-open", open, (value) => setOpen(value));
  const keys = rows.map((row) => row.key);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable || target.closest('[role="slider"],[role="dialog"],dialog,[role="tablist"]'))) return;
      if (document.querySelector("dialog[open],[role=dialog]") || !keys.length) return;
      event.preventDefault();
      const at = open ? keys.indexOf(open) : -1;
      const next = keys[Math.max(0, Math.min(keys.length - 1, at + (event.key === "ArrowRight" ? 1 : -1)))];
      if (next) setOpen(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const toggle = (key: string) => setOpen((current) => current === key ? null : key);
  return <section className="td-card nd" id="asks" aria-labelledby="needs-title">
    <Loop className="nd-loop" size={64} strokeWidth={1} aria-hidden="true" />
    <header className="td-card-head">
      <h2 id="needs-title" className="ds-serif">{t("{{count}} 件需要处理", { count: rows.length })}</h2>
      <span className="nd-head-links"><PendingTotalLink href="/approvals#asks" /></span>
    </header>
    <AnswerAll />
    {notes}
    {rows.length > 0 && <ol className="nd-list">{rows.map((row) => row.kind === "ask"
      ? <AskRow key={row.key} ask={row.ask} labels={labels} preview={previews?.[row.ask.id]} open={open === row.key} onToggle={() => toggle(row.key)} onDone={onDone} />
      : row.kind === "task"
        ? <TaskRow key={row.key} task={row.task} today={today} open={open === row.key} onToggle={() => toggle(row.key)} />
        : <li key={row.key} className="nd-row" data-kind="reminder" {...(row.reminder.line ? { "data-line": row.reminder.line } : {})}>
          <div className="nd-line">
            {row.reminder.line && labels[row.reminder.line] && <LineTag line={row.reminder.line}>{labels[row.reminder.line]}</LineTag>}
            <a className="nd-title" href={row.reminder.href} title={row.reminder.text}>{row.reminder.text}</a>
            <ChevronRight {...ICON} className="nd-go" />
          </div>
        </li>)}</ol>}
    {!tasks.length && empty && <p className="nd-note">{empty}</p>}
  </section>;
}

function UrgentFlag({ label }: { label: string }) {
  return <span className="nd-flag" title={label}><Flag {...ICON} /><span className="sr-only">{label}</span></span>;
}

function AskRow({ ask, labels, preview, open, onToggle, onDone }: {
  ask: Ask; labels: LineLabels; preview: AskPreviews[string] | undefined; open: boolean; onToggle: () => void; onDone: (id: string) => void;
}) {
  const t = useT(), locale = useLocale();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const quick = quickOption(ask);
  const send = async (path: string, body: Record<string, unknown>) => {
    setBusy(true); setStatus("");
    const result = await post(path, body);
    setBusy(false);
    if (result?.ok) { onDone(ask.id); return; }
    setStatus(answerProblem(result?.code, locale));
  };
  const line = ask.line ? labels[ask.line] : undefined;
  return <li className="nd-row" data-kind="ask" data-urgency={ask.urgency} data-open={open || undefined} {...(ask.line ? { "data-line": ask.line } : {})}>
    <div className="nd-line">
      {line && <LineTag line={ask.line}>{line}</LineTag>}
      <button type="button" className="nd-title" aria-expanded={open} onClick={onToggle}>{ask.title}</button>
      {ask.urgency === "now" && <UrgentFlag label={t("今天要答")} />}
    </div>
    <div className="nd-actions">
      {quick && <button type="button" className="nd-quick" disabled={busy} title={t("按推荐：{{label}}", { label: quick.label })}
        onClick={() => void send("/api/asks/answer", answerBody(ask.id, [quick.id], {}, ""))}><Check {...ICON} /><span>{quick.label}</span></button>}
      <IconButton label={open ? t("收起") : t("展开作答")} icon={<ChevronDown {...ICON} />} aria-expanded={open} data-open={open || undefined} onClick={onToggle} />
      <IconButton label={t("明天再问")} icon={<AlarmClock {...ICON} />} disabled={busy} onClick={() => void send("/api/asks/snooze", { askId: ask.id, choice: "tomorrow" })} />
      {status && <small role="status">{status}</small>}
    </div>
    {open && <ol className="ask-deck nd-expand"><AskCard ask={ask} preview={preview} onDone={onDone} /></ol>}
  </li>;
}

const FINISHED = ["accepted", "archived", "evidence_review"];

function TaskRow({ task, today, open, onToggle }: { task: NeedTask; today: string; open: boolean; onToggle: () => void }) {
  const t = useT(), locale = useLocale();
  const { detail } = task;
  const [dialog, setDialog] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [postponing, setPostponing] = useState(false);
  const [deferDay, setDeferDay] = useState(shiftDay(today, 1));
  const impact = useImpact();
  const step = currentStep(detail);
  const due = detail.window.dueBy;
  const distance = due ? dueDistance(due, today, locale) : undefined;
  const urgent = Boolean(due && (due <= today || distance?.overdue));
  const live = !FINISHED.includes(detail.state);
  const sub = [t(task.label), step ? t("当前：{{step}}", { step: step.title }) : task.reason].filter(Boolean).join(" · ");
  return <li className="nd-row" data-kind="task" data-line={detail.identityId} data-open={open || undefined}>
    <div className="nd-line">
      <LineTag line={detail.identityId}>{detail.identityLabel}</LineTag>
      <button type="button" className="nd-title" aria-expanded={open} onClick={onToggle}>{detail.title}</button>
      {urgent && <UrgentFlag label={distance?.text ?? t("今天到期")} />}
    </div>
    <p className="nd-sub">{sub}{due && distance && <> · <span className="mono">{distance.text}</span></>}</p>
    <TaskActions iconic workOrderId={detail.id} state={detail.state} approvable={!detail.preparing} paused={detail.paused}
      agentReady={detail.agentSteps.length > 0} agentStepId={detail.agentSteps[0]?.id} onOpen={() => setDialog(true)}
      offline={{ ownerId: detail.viewerId, workspaceId: detail.workspaceId, intent: detail.intent }}>
      {["approved", "ready_for_human", "active"].includes(detail.state) && <IconButton label={t("完成并提交材料")} icon={<Check {...ICON} />} onClick={() => setCompleting(true)} />}
      {live && <IconButton label={t("推迟")} icon={<CalendarClock {...ICON} />} aria-expanded={postponing} onClick={() => setPostponing((value) => !value)} />}
      <IconButton label={open ? t("收起") : t("展开任务卡")} icon={<ChevronDown {...ICON} />} aria-expanded={open} data-open={open || undefined} onClick={onToggle} />
    </TaskActions>
    {postponing && <div className="dq-defer" role="group" aria-label={t("推迟到")}>
      <button type="button" disabled={impact.busy} onClick={() => void impact.propose({ kind: "defer", workOrderId: detail.id, date: shiftDay(today, 1) })}>{t("明天")}</button>
      <label><span>{t("选一天")}</span><input type="date" value={deferDay} min={shiftDay(today, 1)} onChange={(event) => setDeferDay(event.target.value)} /></label>
      <button type="button" disabled={impact.busy || !deferDay} onClick={() => void impact.propose({ kind: "defer", workOrderId: detail.id, date: deferDay })}>{t("预览")}</button>
      {impact.busy && !impact.pending && <small role="status">{t("计算影响…")}</small>}
      {impact.error && <small role="status">{impact.error}</small>}
    </div>}
    {impact.pending && <ImpactCard impact={impact.pending.impact} busy={impact.busy} onApply={() => void impact.apply()} onCancel={impact.cancel} />}
    {open && <div className="nd-expand"><TaskCard variant={task.hero ? "hero" : "compact"} detail={detail} {...(task.reason ? { reason: task.reason } : {})} slot={task.slot} today={today} /></div>}
    <TaskDialog detail={detail} open={dialog} onOpenChange={setDialog} />
    {completing && <CompleteDialog open={completing} onOpenChange={setCompleting} workOrderId={detail.id} title={detail.title} state={detail.state}
      stepId={step?.id} stepTitle={step?.title} otherSteps={otherOpenSteps(step?.id, detail.stepPlan?.steps ?? [])} />}
  </li>;
}
