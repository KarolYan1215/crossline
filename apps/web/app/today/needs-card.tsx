"use client";

import { useState, type ReactNode } from "react";
import type { Ask, AskOption } from "@crossline/core";
import { AlarmClock, Check, ChevronRight, Flag, Infinity as Loop } from "lucide-react";
import { useAskList } from "../asks/ask-drawer";
import { answerBody, answerProblem } from "../asks/model";
import { PendingTotalLink } from "../pending-badge";
import { shiftDay } from "../timeline/model";
import type { LineLabels } from "../timeline/views";
import type { Reminder } from "../../lib/reminders";
import { LineTag } from "../ui/tag";
import { ICON, IconButton } from "../ui/icon-button";
import { useLocale, useT } from "../locale-context";

/** How many of the week's urgent decisions Today lists; the rest are on 待确认 (scenarios.md §3.1). */
export const TODAY_ASKS = 4;

export type NeedRow =
  | { kind: "ask"; key: string; ask: Ask }
  | { kind: "missed"; key: string; ask: Ask; count: number }
  | { kind: "reminder"; key: string; reminder: Reminder };

/**
 * What Today lists under 「N 件需要处理」 (scenarios.md §3.1 and §4, 2026-10-29), pure for its test: yesterday's work that did not start as
 * one row, then the week's urgent decisions — due today first, then this week's — at most `TODAY_ASKS`, then what other pages flag, as
 * links. A decision that can wait (`urgency: "later"`) or comes into the week later is only counted, on 待确认.
 */
export function needRows({ asks, reminders }: { asks: Ask[]; reminders: Reminder[] }): NeedRow[] {
  const week = asks.filter((ask) => !ask.entersOn);
  const missed = week.filter((ask) => ask.kind === "missed_block");
  const urgent = week.filter((ask) => ask.kind !== "missed_block" && ask.urgency !== "later");
  const ordered = [...urgent.filter((ask) => ask.urgency === "now"), ...urgent.filter((ask) => ask.urgency !== "now")].slice(0, TODAY_ASKS);
  // A folded card stands for every block of yesterday's; split into one card each, they are counted on one row again.
  const batch = missed.find((ask) => ask.entityId === "batch") ?? missed[0];
  const count = batch?.entityId === "batch" ? batch.items?.length ?? missed.length : missed.length;
  return [
    ...(batch ? [{ kind: "missed" as const, key: `missed:${batch.id}`, ask: batch, count }] : []),
    ...ordered.map((ask): NeedRow => ({ kind: "ask", key: `ask:${ask.id}`, ask })),
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

/** Where a row's 「打开」 leads: the card on 待确认, or — for yesterday's blocks — the wrap-up of yesterday, where each is settled. */
export function openHref(row: Extract<NeedRow, { kind: "ask" | "missed" }>, today: string): string {
  return row.kind === "missed" ? `/wrap?day=${shiftDay(today, -1)}` : `/approvals?ask=${encodeURIComponent(row.ask.id)}#asks`;
}

async function post(path: string, body: Record<string, unknown>): Promise<{ ok?: boolean; code?: string } | null> {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  return await response?.json().catch(() => null) as { ok?: boolean; code?: string } | null;
}

/**
 * 「N 件需要处理」 (2026-10-28 reference design, narrowed 2026-10-29 by scenarios.md): an entry to 待确认, not a second place to answer. Each
 * row is the line's tag, one sentence and a red flag when it is due today, with three presses — the recommended answer in one tap
 * (undoable like any answer), 「明天再问」 and 「打开」 (the card on 待确认). Yesterday's blocks that did not start are one row whose 「打开」
 * is the wrap-up of yesterday; what other pages flag (overdue, unplaced, clashes) are rows that only link. 「全部按推荐」 is not here: a
 * batch needs its kinds listed first, which is 待确认's.
 */
export function NeedsCard({ asks: initialAsks, reminders, labels, today, notes }: {
  asks: Ask[]; reminders: Reminder[]; labels: LineLabels; today: string;
  /** Lines above the list (a proposal due within a week). */
  notes?: ReactNode;
}) {
  const t = useT();
  const { asks, onDone } = useAskList(initialAsks, (ask) => !ask.entersOn);
  const rows = needRows({ asks, reminders });
  return <section className="td-card nd" id="asks" aria-labelledby="needs-title">
    <Loop className="nd-loop" size={64} strokeWidth={1} aria-hidden="true" />
    <header className="td-card-head">
      <h2 id="needs-title" className="ds-serif">{t("{{count}} 件需要处理", { count: rows.length })}</h2>
      <small>{t("本周紧急")}</small>
    </header>
    {notes}
    {rows.length > 0 ? <ol className="nd-list">{rows.map((row) => row.kind === "reminder"
      ? <li key={row.key} className="nd-row" data-kind="reminder" {...(row.reminder.line ? { "data-line": row.reminder.line } : {})}>
        <div className="nd-line">
          {row.reminder.line && labels[row.reminder.line] && <LineTag line={row.reminder.line}>{labels[row.reminder.line]}</LineTag>}
          <a className="nd-title" href={row.reminder.href} title={row.reminder.text}>{row.reminder.text}</a>
          <ChevronRight {...ICON} className="nd-go" />
        </div>
      </li>
      : <AskRow key={row.key} row={row} labels={labels} today={today} onDone={onDone} />)}</ol>
      : <p className="nd-note">{t("本周没有紧急的待决事项。")}</p>}
    <p className="nd-foot"><PendingTotalLink href="/approvals#asks" /></p>
  </section>;
}

function UrgentFlag({ label }: { label: string }) {
  return <span className="nd-flag" title={label}><Flag {...ICON} /><span className="sr-only">{label}</span></span>;
}

function AskRow({ row, labels, today, onDone }: { row: Extract<NeedRow, { kind: "ask" | "missed" }>; labels: LineLabels; today: string; onDone: (id: string) => void }) {
  const t = useT(), locale = useLocale();
  const { ask } = row;
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
  const title = row.kind === "missed" && row.count > 1 ? t("昨天 {{count}} 块没开始", { count: row.count }) : ask.title;
  const href = openHref(row, today);
  return <li className="nd-row" data-kind={row.kind === "missed" ? "missed" : "ask"} data-urgency={ask.urgency} {...(ask.line ? { "data-line": ask.line } : {})}>
    <div className="nd-line">
      {line && <LineTag line={ask.line}>{line}</LineTag>}
      <a className="nd-title" href={href} title={ask.title}>{title}</a>
      {ask.urgency === "now" && <UrgentFlag label={t("今天要答")} />}
    </div>
    <div className="nd-actions">
      {quick && <button type="button" className="nd-quick" disabled={busy} title={t("按推荐：{{label}}", { label: quick.label })}
        onClick={() => void send("/api/asks/answer", answerBody(ask.id, [quick.id], {}, ""))}><Check {...ICON} /><span>{quick.label}</span></button>}
      <IconButton label={t("明天再问")} icon={<AlarmClock {...ICON} />} disabled={busy} onClick={() => void send("/api/asks/snooze", { askId: ask.id, choice: "tomorrow" })} />
      <a className="ds-icon nd-open" href={href} aria-label={row.kind === "missed" ? t("逐个处理") : t("在待确认打开")} title={row.kind === "missed" ? t("逐个处理") : t("在待确认打开")}>
        <ChevronRight {...ICON} /></a>
      {status && <small role="status">{status}</small>}
    </div>
  </li>;
}
