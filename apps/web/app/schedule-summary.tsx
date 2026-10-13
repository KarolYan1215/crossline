"use client";

import { useState } from "react";
import type { ScheduleChange } from "../lib/crossline";

/**
 * 「作业 3 因 11:30 会议后移 30 分钟」 above Today's timeline (docs/loop-and-scout.md §1): what a calendar change moved, one line each.
 * The re-plan is derived and has nothing to undo, so the way back is 「钉回原位」 — lock that block at its old time and accept the
 * overlap.
 */
export function ScheduleSummary({ changes }: { changes: ScheduleChange[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  if (!changes.length) return null;
  const pinBack = async (change: ScheduleChange) => {
    setBusy(change.blockId); setFailed(null);
    const response = await fetch("/api/plan/pin", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ blockId: change.blockId, day: change.day, start: change.from.start, end: change.from.end, reason: "locked", overlapOk: true }) }).catch(() => null);
    if (response?.ok) { window.location.reload(); return; }
    setBusy(null); setFailed(change.blockId);
  };
  const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  const shift = (change: ScheduleChange) => {
    if (change.to.day !== change.day) return `改到 ${Number(change.to.day.slice(5, 7))}/${Number(change.to.day.slice(8, 10))} ${change.to.start}`;
    const delta = minutes(change.to.start) - minutes(change.from.start);
    return delta > 0 ? `后移 ${delta} 分钟` : `提前 ${-delta} 分钟`;
  };
  return <ul className="schedule-summary" aria-label="排程变化">
    {changes.map((change) => <li key={change.blockId}>
      <span>「{change.title}」因 {change.cause} {shift(change)}</span>
      <button type="button" className="secondary" disabled={busy === change.blockId} onClick={() => void pinBack(change)}>钉回原位</button>
      {failed === change.blockId && <small role="status">未能钉回，请重试</small>}
    </li>)}
  </ul>;
}
