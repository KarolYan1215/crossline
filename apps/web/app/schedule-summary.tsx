"use client";

import { useState } from "react";
import type { FinerSplitNote, ScheduleChange } from "../lib/crossline";
import { groupChanges, groupSplits, type ChangeGroup } from "./schedule-summary-model";

/**
 * 「作业 3 因 11:30 会议后移 30 分钟」 above Today's timeline (docs/loop-and-scout.md §1): what a calendar change moved, one line per task
 * and cause (`groupChanges`: a task's several blocks moved the same way are one line with one button). The re-plan is derived and has
 * nothing to undo, so the way back is 「钉回原位」 — lock those blocks at their old times and accept the overlap. Below them, steps planned
 * again smaller after days of not getting done (adaptive granularity), one line for all of them.
 *
 * Names are cut by CSS (an ellipsis at the column's edge, the whole name on hover), not in the middle of a word by a character count.
 */
const NAMES_SHOWN = 3;

function Name({ text }: { text: string }) {
  return <span className="ss-name" title={text}>{text}</span>;
}

export function ScheduleSummary({ changes, splits = [] }: { changes: ScheduleChange[];
  /** Steps planned again smaller after two days of not getting done: one line, nothing to answer. */
  splits?: FinerSplitNote[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  if (!changes.length && !splits.length) return null;
  const pinBack = async (group: ChangeGroup) => {
    setBusy(group.key); setFailed(null);
    for (const change of group.changes) {
      const response = await fetch("/api/plan/pin", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ blockId: change.blockId, day: change.day, start: change.from.start, end: change.from.end, reason: "locked", overlapOk: true }) }).catch(() => null);
      if (!response?.ok) { setBusy(null); setFailed(group.key); return; }
    }
    window.location.reload();
  };
  return <ul className="schedule-summary" aria-label="排程变化">
    {groupChanges(changes).map((group) => {
      const count = group.changes.length;
      const sentence = `「${group.title}」${count > 1 ? `${count} 段` : ""}因 ${group.cause} ${group.shift}`;
      return <li key={group.key}>
        <span className="ss-text" title={sentence}>「<Name text={group.title} />」{count > 1 && `${count} 段`}因 <Name text={group.cause} /> {group.shift}</span>
        <button type="button" className="secondary" disabled={busy === group.key} onClick={() => void pinBack(group)}>钉回原位</button>
        {failed === group.key && <small role="status">未能钉回，请重试</small>}
      </li>;
    })}
    {groupSplits(splits).map((group) => {
      const tail = "第一步不超过 15 分钟";
      if (group.names.length === 1) return <li key={`split:${group.days}`}>
        <span className="ss-text" title={group.names[0]}>「<Name text={group.names[0]!} />」{group.days} 天没做成，已拆成更小的步骤，{tail}</span>
      </li>;
      const shown = group.names.slice(0, NAMES_SHOWN);
      const rest = group.names.length - shown.length;
      return <li key={`split:${group.days}`}>
        <span className="ss-text" title={group.names.join("\n")}>{group.names.length} 个步骤 {group.days} 天没做成，已拆成更小的步骤，{tail}：
          {shown.map((name, index) => <span key={name}>{index > 0 && "、"}「<Name text={name} />」</span>)}{rest > 0 && ` 等 ${group.names.length} 个`}</span>
      </li>;
    })}
  </ul>;
}
