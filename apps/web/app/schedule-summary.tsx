"use client";

import { Fragment, useState, type ReactNode } from "react";
import type { FinerSplitNote, ScheduleChange } from "../lib/crossline";
import { useLocale, useT } from "./locale-context";
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

/**
 * A translated sentence with parts drawn as elements (a name with its ellipsis): the sentence stays one key (docs/i18n.md) and is
 * translated with a marker in each such value's place, then split around the markers.
 */
const MARK = "\u0000";
const slot = (name: string) => `${MARK}${name}${MARK}`;
function withNodes(text: string, nodes: Record<string, ReactNode>): ReactNode {
  return text.split(MARK).map((part, index) => <Fragment key={index}>{index % 2 ? nodes[part] : part}</Fragment>);
}

export function ScheduleSummary({ changes, splits = [] }: { changes: ScheduleChange[];
  /** Steps planned again smaller after two days of not getting done: one line, nothing to answer. */
  splits?: FinerSplitNote[] }) {
  const t = useT();
  const locale = useLocale();
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
  // A list of names inside one sentence: each quoted the way the language quotes, joined the way it lists.
  const nameList = (names: string[]) => names.map((name, index) => <span key={name}>{index > 0 && (locale === "en" ? ", " : "、")}{withNodes(t("「{{name}}」", { name: slot("name") }), { name: <Name text={name} /> })}</span>);
  return <ul className="schedule-summary" aria-label={t("排程变化")}>
    {groupChanges(changes, locale).map((group) => {
      const count = group.changes.length;
      const key = count > 1 ? "「{{title}}」{{count}} 段因 {{cause}} {{shift}}" : "「{{title}}」因 {{cause}} {{shift}}";
      const counted = count > 1 ? { count } : {};
      const sentence = t(key, { title: group.title, cause: group.cause, shift: group.shift, ...counted });
      return <li key={group.key}>
        <span className="ss-text" title={sentence}>{withNodes(t(key, { title: slot("title"), cause: slot("cause"), shift: group.shift, ...counted }),
          { title: <Name text={group.title} />, cause: <Name text={group.cause} /> })}</span>
        <button type="button" className="secondary" disabled={busy === group.key} onClick={() => void pinBack(group)}>{t("钉回原位")}</button>
        {failed === group.key && <small role="status">{t("未能钉回，请重试")}</small>}
      </li>;
    })}
    {groupSplits(splits).map((group) => {
      if (group.names.length === 1) return <li key={`split:${group.days}`}>
        <span className="ss-text" title={group.names[0]}>{withNodes(t("「{{title}}」{{count}} 天没做成，已拆成更小的步骤，第一步不超过 15 分钟", { title: slot("title"), count: group.days }),
          { title: <Name text={group.names[0]!} /> })}</span>
      </li>;
      const shown = group.names.slice(0, NAMES_SHOWN);
      const rest = group.names.length - shown.length;
      const key = rest > 0
        ? "{{n}} 个步骤 {{count}} 天没做成，已拆成更小的步骤，第一步不超过 15 分钟：{{names}} 等 {{n}} 个"
        : "{{n}} 个步骤 {{count}} 天没做成，已拆成更小的步骤，第一步不超过 15 分钟：{{names}}";
      return <li key={`split:${group.days}`}>
        <span className="ss-text" title={group.names.join("\n")}>{withNodes(t(key, { n: group.names.length, count: group.days, names: slot("names") }), { names: nameList(shown) })}</span>
      </li>;
    })}
  </ul>;
}
