"use client";

import { useState } from "react";
import type { FinerSplitNote, ScheduleChange } from "../lib/crossline";
import { useT } from "./locale-context";

/**
 * 「作业 3 因 11:30 会议后移 30 分钟」 above Today's timeline (docs/loop-and-scout.md §1): what a calendar change moved, one line each.
 * The re-plan is derived and has nothing to undo, so the way back is 「钉回原位」 — lock that block at its old time and accept the
 * overlap. Below them, steps planned again smaller after two days of not getting done (adaptive granularity), one line each.
 */
/** One line per change: a task's name and an event's title are cut short here; the whole of both is on hover. */
const short = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;

export function ScheduleSummary({ changes, splits = [] }: { changes: ScheduleChange[];
  /** Steps planned again smaller after two days of not getting done: a line each, nothing to answer. */
  splits?: FinerSplitNote[] }) {
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  if (!changes.length && !splits.length) return null;
  const pinBack = async (change: ScheduleChange) => {
    setBusy(change.blockId); setFailed(null);
    const response = await fetch("/api/plan/pin", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ blockId: change.blockId, day: change.day, start: change.from.start, end: change.from.end, reason: "locked", overlapOk: true }) }).catch(() => null);
    if (response?.ok) { window.location.reload(); return; }
    setBusy(null); setFailed(change.blockId);
  };
  const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  const shift = (change: ScheduleChange) => {
    if (change.to.day !== change.day) return t("改到 {{month}}/{{day}} {{time}}", { month: Number(change.to.day.slice(5, 7)), day: Number(change.to.day.slice(8, 10)), time: change.to.start });
    const delta = minutes(change.to.start) - minutes(change.from.start);
    return delta > 0 ? t("后移 {{minutes}} 分钟", { minutes: delta }) : t("提前 {{minutes}} 分钟", { minutes: -delta });
  };
  const line = (title: string, cause: string, change: ScheduleChange) => t("「{{title}}」因 {{cause}} {{shift}}", { title, cause, shift: shift(change) });
  return <ul className="schedule-summary" aria-label={t("排程变化")}>
    {changes.map((change) => <li key={change.blockId}>
      <span title={line(change.title, change.cause, change)}>{line(short(change.title, 18), short(change.cause, 18), change)}</span>
      <button type="button" className="secondary" disabled={busy === change.blockId} onClick={() => void pinBack(change)}>{t("钉回原位")}</button>
      {failed === change.blockId && <small role="status">{t("未能钉回，请重试")}</small>}
    </li>)}
    {splits.map((split) => <li key={`split:${split.orderId}`}>
      <span title={`${split.title}${split.step ? ` · ${split.step}` : ""}`}>{t("「{{title}}」{{count}} 天没做成，已拆成更小的步骤，第一步不超过 15 分钟", { title: short(`${split.title}${split.step ? ` · ${split.step}` : ""}`, 24), count: split.days })}</span>
    </li>)}
  </ul>;
}
