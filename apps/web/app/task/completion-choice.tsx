"use client";

import { useState } from "react";
import type { TaskDetail } from "../../lib/task-detail";
import { SegmentedControl } from "../ui/controls";

type Mode = NonNullable<TaskDetail["completion"]>["mode"];
const OPTIONS: ReadonlyArray<{ value: Mode; label: string; title: string }> = [
  { value: "self_evident", label: "点完成即验收", title: "按下完成即算完成，之后不再询问" },
  { value: "needs_assessment", label: "完成后再问结果", title: "完成后，小帮手在空闲时询问结果或完成情况" }
];

/**
 * How finishing this task is taken, in one line with a switch: the model's judgement (or the person's earlier choice) with its reason,
 * changed in one click (`/api/work-orders/[id]/completion-mode`, which overrides the model's). Hidden once the task is finished.
 */
export function CompletionChoice({ detail }: { detail: TaskDetail }) {
  const [mode, setMode] = useState<Mode | undefined>(detail.completion?.mode);
  const [status, setStatus] = useState("");
  if (!detail.completion || !mode || ["accepted", "archived", "evidence_review"].includes(detail.state)) return null;
  const why = mode === detail.completion.mode ? detail.completion.why : "本人选定";
  const choose = (next: Mode) => {
    const before = mode;
    setMode(next);
    void fetch(`/api/work-orders/${encodeURIComponent(detail.id)}/completion-mode`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: next }) }).then((response) => response.ok).catch(() => false)
      .then((ok) => { if (!ok) { setMode(before); setStatus("未保存，请重试"); } else setStatus(""); });
  };
  return <div className="task-completion-choice">
    <small>完成方式</small>
    <SegmentedControl value={mode} options={OPTIONS} onChange={choose} label="完成方式" />
    {why && <small className={detail.completion.by === "model" && mode === detail.completion.mode ? "gen" : undefined}>{why}</small>}
    {status && <small role="status">{status}</small>}
  </div>;
}
